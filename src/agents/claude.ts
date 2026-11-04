import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { NAMES } from '../display.js';
import { killTree, onJsonLines, relPath, stderrTail } from './process.js';
import {
  createQueue,
  ResumeFailedError,
  stepEnd,
  STEP_STOPPED,
  STEP_UNFINISHED,
  truncate,
  patchStats,
  peerLoopHint,
  WORKTREE_HINT,
  type Agent,
  type AgentCommand,
  type AgentModel,
  type AgentStats,
  type AgentTask,
  type AskQuestion,
  type AgentTool,
  type EmitFn,
  type ImageInput,
  type ModelChoice,
  type PeerRequest,
  type PermissionAnswer,
  type PermissionRequest,
  type StepResult,
} from './types.js';

/** A ferramenta que o duo dá ao Claude para falar com o Codex (servidor MCP "duo", hospedado pelo próprio duo). */
const PEER_TOOL = {
  name: 'falar_com_codex',
  description:
    'Manda uma mensagem ao Codex (o Fog), o outro agente na mesma janela do duo, e espera a resposta dele, que volta ' +
    'aqui. O usuário acompanha a conversa na janela. O Codex vê a janela compartilhada como contexto, mas não a sua ' +
    'conversa interna: escreva a mensagem completa (o que fazer, onde está, o que você quer de volta). Pode levar minutos.',
  inputSchema: {
    type: 'object',
    properties: { mensagem: { type: 'string', description: 'o que dizer ao Codex' } },
    required: ['mensagem'],
  },
};

/** O motivo de abortar o que ele espera quando você o para (e não porque o CLI desistiu, ou caiu). */
const STOPPED = 'parado pelo duo';

const PEER_HINT =
  '[duo] Você está no duo, numa janela compartilhada com o usuário e com o Codex (o Fog). Para falar com o Codex ' +
  '(pedir revisão, segunda opinião ou uma tarefa), use a ferramenta mcp__duo__falar_com_codex: a resposta dele ' +
  'volta para você, e o usuário acompanha tudo na janela. ' +
  peerLoopHint('Codex') +
  ' ' +
  WORKTREE_HINT;

export interface ClaudeOptions {
  /** default | acceptEdits | plan | bypassPermissions. Vazio = segue o defaultMode do seu settings.json. */
  permissionMode?: string;
  model?: string;
  cwd?: string;
  /** conversa a retomar (session_id gravado pelo duo) */
  resumeId?: string;
  /** liga o Remote Control em cada processo: a conversa aparece no app e no claude.ai/code, como no terminal */
  remoteControl?: boolean;
  /** comando a executar; padrão ['claude']. Os testes trocam por um claude falso. */
  bin?: string[];
}

/** Um processo `claude -p` vivo. */
interface Running {
  proc: ChildProcess;
  /** session_id passado em --resume ao subir este processo */
  resumedWith?: string;
  sawInit: boolean;
  tail: () => string;
  /** pedidos do CLI esperando resposta (permissão, chamada ao Codex), por request_id */
  asks: Map<string, AbortController>;
  /** tool_use_id do que você negou (ou não quis responder), com a nota do passo: a tela já mostra, não repete como
   * "permissão negada" */
  deniedByYou: Map<string, string>;
  /** task_id dos subagentes rodando */
  subagents: Set<string>;
  /** subagentes e comandos em segundo plano rodando, por task_id (o quadro da janela) */
  tasks: Map<string, AgentTask>;
  /** textos do turno que o CLI abriu sozinho, até o result dele */
  own: string[];
  /** o turno que o CLI abriu sozinho já mandou algo (texto, ferramenta ou o result): o fim dele tem de ser avisado */
  ownOpen: boolean;
  /** task_id de cada tarefa em segundo plano rodando → o modo do turno do duo que a lançou */
  taskShared: Map<string, boolean>;
  /** as tarefas que terminaram e abrem (ou abriram) o turno dele: todas vieram de turnos compartilhados? */
  ownTasksShared?: boolean;
  /** ele leu, fora de um turno do duo, uma mensagem sua pelo app: ela abre (ou entrou n)o turno dele */
  ownFromApp: boolean;
  /** request_id do pedido que liga o Remote Control */
  remoteControlRequest?: string;
  /** request_id do initialize, que traz a lista de comandos */
  initRequest: string;
  /** pedidos de controle do duo esperando a resposta do CLI (o seletor de modelo), por request_id */
  controls: Map<string, { resolve: (response: any) => void; reject: (err: Error) => void }>;
  /** as ferramentas rodando no turno (o da conversa principal), por tool_use_id: o quadro da janela */
  tools: Map<string, AgentTool>;
  /** os passos que a tela mostrou e ainda não terminaram, por tool_use_id: o fim de cada um vai para a tela */
  steps: Map<string, { name: string; file?: string }>;
  /** o que ele espera de você ou do Codex (permissão, a ferramenta do duo): parar o solta */
  waits: Set<AbortController>;
  /** o duo pediu para parar: o result de erro que vem é o da interrupção, não uma falha */
  interrupting: boolean;
}

interface Turn {
  proc: ChildProcess;
  /** uuid da mensagem do duo: o command_lifecycle "started" ou o eco dela marcam onde começa este turno */
  uuid: string;
  /** o CLI já leu a mensagem; antes disso, o que chega é de um turno que ele abriu sozinho */
  started: boolean;
  emit: EmitFn;
  /** o modo do duo em que a mensagem foi: tarefa em segundo plano lançada neste turno o herda */
  shared: boolean;
  texts: string[];
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  /** result de erro antes do init numa retomada: decide no exit, pelo stderr */
  resumeError?: string;
}

/**
 * Claude Code em modo headless documentado:
 *   claude -p --input-format stream-json --output-format stream-json --verbose [--resume <id>]
 * Um único processo fica vivo e recebe cada mensagem como uma linha JSON no stdin. Se ele cair,
 * o próximo turno sobe outro com --resume <session_id>.
 *
 * Pedido de permissão (medido em 02/11/2026, 2.1.316): sem nada, o `-p` nega sozinho o que o terminal
 * perguntaria (uma regra "ask" como `Bash(git push:*)`, mesmo com bypassPermissions). Com
 * `--permission-prompt-tool stdio` ele manda um `control_request` can_use_tool SÓ nesses casos e
 * espera um `control_response` no stdin: "allow" roda o comando, "deny" devolve a mensagem a ele.
 *
 * Rodapé (medido em 02/11/2026, 2.1.316): o modelo vem no `system/init`; o contexto é o `usage` da
 * última mensagem da conversa principal (as dos subagentes trazem `parent_tool_use_id`); a janela vem
 * em `result.modelUsage[modelo].contextWindow`; subagente começa em `system/task_started` (task_type
 * "local_agent") e termina em `system/task_notification`.
 *
 * Turno que ele abre sozinho (medido em 02/11/2026, 2.1.316): quando um subagente ou comando em segundo
 * plano termina depois do `result`, ele manda `task_notification`, um `system/init` novo e um turno inteiro
 * com `result` próprio, sem mensagem nenhuma no stdin. Bash em segundo plano manda `system/task_started` (task_type
 * "local_bash", com `task_id`) ainda no turno que o lançou, e o `task_notification` traz o mesmo `task_id`: é
 * assim que o turno dele sabe de qual turno do duo veio. Uma mensagem que chega no meio desse turno entra
 * nele: um `result` só para os dois. Com `--replay-user-messages` ele ecoa a mensagem (com o `uuid` que
 * mandamos) no ponto em que a lê; é esse eco que separa o turno dele do turno do duo. O `command_lifecycle`
 * "started" com o mesmo uuid marca o mesmo ponto: logo depois do eco na mensagem que entra num turno dele,
 * antes do eco nas outras. Num comando local (/context) a saída vem antes do eco e depois do "started".
 *
 * Remote Control (medido em 02/11/2026, 2.1.316): no `-p` a opção `--remote-control` é ignorada, mas o
 * `control_request` {subtype: "remote_control", enabled: true} liga a ponte (é o que o app desktop usa nas
 * sessões dele): a resposta traz `session_url` e chegam `system/bridge_state` ready e connected. O que você
 * digita no app entra na fila como uma mensagem; o eco dela tem um uuid que não é nosso.
 *
 * Comandos (medido em 02/11/2026, 2.1.316): o `control_request` initialize responde na hora, antes de
 * qualquer mensagem, com `commands` [{name, description, argumentHint}]; `system/commands_changed` traz a
 * lista nova quando ela muda (plugins e MCP carregando). Um "/context" mandado puro roda como comando e a
 * saída vem como resposta. Os `terminal_slash_commands` do `system/init` (doctor, color, focus...) também
 * rodam no `-p` (o /doctor vira um prompt) ou respondem que não estão disponíveis: ficam na lista.
 *
 * Parar (medido em 03/11/2026, 2.1.316): o `control_request` interrupt responde na hora ({still_queued: []}, mesmo
 * sem turno). Com um comando rodando, ~9s depois chegam o tool_result de erro, o texto "[Request interrupted by user
 * for tool use]" e um `result` error_during_execution; a conversa segue, e o turno seguinte sabe que foi parado.
 * Com a ferramenta do duo esperando o Codex, o turno fecha na hora, sem esperar a resposta dela e sem avisar o
 * duo (nenhum control_cancel_request): quem a respondia tem de ser solto pelo próprio duo.
 *
 * Passos (medido em 03/11/2026, 2.1.316): o `tool_use` traz o argumento inteiro (`command` do Bash, `file_path` do
 * Write e do Edit). O fim vem num `user` com o `tool_result` (o mesmo `tool_use_id`): Bash que deu certo tem
 * `is_error` false e nenhum código; o que saiu com 3 tem `is_error` true e o conteúdo começa com "Exit code 3". O
 * `tool_use_result` da mesma mensagem diz o que houve com o arquivo: o do Write tem `type` "create" ou "update"; o do
 * Edit não tem `type`. Dois comandos em paralelo vêm como dois `tool_use` antes dos dois `tool_result`. Com o
 * pedido de permissão, o `tool_use` vem antes do can_use_tool; negado, o `tool_result` tem `is_error` true e a
 * mensagem que o duo mandou.
 *
 * Modelo e esforço (medido em 03/11/2026, 2.1.316): o initialize traz `models` [{value, resolvedModel,
 * displayName, description, supportedEffortLevels, supportsFastMode}]; o `control_request` set_model {model} troca
 * o modelo e responde com o id resolvido, o apply_flag_settings {settings: {effortLevel}} troca o esforço (valor
 * que o modelo não aceita é ignorado sem erro), e o get_settings diz em `applied` {model, effort} o que ficou. Nada
 * disso abre turno, e vale só para o processo: o próximo sobe com --model e --effort. O modo rápido não liga no
 * `-p` (sdk_opt_in_required).
 *
 * Retomada que falha (medido em 02/11/2026, Claude Code 2.1.316): com um id inexistente ele manda
 * um `result` de erro SEM o `system/init`, escreve "No conversation found with session ID" no
 * stderr e sai sozinho ~1,4s depois, mesmo com o stdin aberto.
 */
export class ClaudeAgent implements Agent {
  readonly id = 'claude' as const;
  readonly name = 'Claude';
  onSessionId?: (id: string) => void;
  askPermission?: (req: PermissionRequest) => Promise<PermissionAnswer>;
  askPeer?: (req: PeerRequest) => Promise<string>;
  onOwnTurnEvent?: EmitFn;
  onOwnTurnReply?: (text: string, tasksShared?: boolean, fromApp?: boolean) => void;
  onRemoteMessage?: (text: string, inDuoTurn?: boolean) => void;
  onNotice?: EmitFn;
  onStats?: (stats: AgentStats) => void;
  onCommands?: (commands: AgentCommand[]) => void;
  onModels?: (models: AgentModel[]) => void;
  onTasks?: (tasks: AgentTask[]) => void;
  onTools?: (tools: AgentTool[]) => void;
  onSignal?: () => void;
  commands: AgentCommand[] = [];
  models: AgentModel[] = [];
  readonly stats: AgentStats;
  /** o modelo e o esforço escolhidos no duo: cada processo novo sobe com eles */
  private choice: { model?: string; effort?: string };
  private run?: Running;
  private sessionId?: string;
  private turn?: Turn;
  private enqueue = createQueue();
  /** o aviso da ANTHROPIC_API_KEY já apareceu (uma vez por duo, não a cada processo) */
  private warnedApiKey = false;

  constructor(private readonly opts: ClaudeOptions) {
    this.sessionId = opts.resumeId;
    this.choice = { model: opts.model };
    this.stats = { model: opts.model, selected: opts.model, subagents: 0 };
  }

  get resumeId(): string | undefined {
    return this.sessionId;
  }

  send(prompt: string, emit: EmitFn, shared = true, images: ImageInput[] = []): Promise<string> {
    return this.enqueue(
      () =>
        new Promise<string>((resolve, reject) => {
          // a imagem vai como bloco base64, como o app manda um print; lida só agora, na vez da mensagem
          let content: string | object[] = prompt;
          if (images.length > 0) {
            try {
              content = [
                ...(prompt ? [{ type: 'text', text: prompt }] : []),
                ...images.map((img) => ({
                  type: 'image',
                  source: { type: 'base64', media_type: img.mediaType, data: fs.readFileSync(img.path).toString('base64') },
                })),
              ];
            } catch (err: any) {
              reject(new Error(`não consegui ler a imagem para o ${NAMES.claude}: ${err?.message ?? err}`));
              return;
            }
          }
          const run = this.ensureProcess();
          const uuid = randomUUID();
          this.turn = { proc: run.proc, uuid, started: false, emit, shared, texts: [], resolve, reject };
          const line = JSON.stringify({ type: 'user', uuid, message: { role: 'user', content } });
          run.proc.stdin?.write(line + '\n');
        }),
    );
  }

  warmUp(): void {
    this.ensureProcess();
  }

  async interrupt(): Promise<void> {
    const run = this.run;
    if (!run) return;
    run.interrupting = true;
    // o CLI fecha o turno sem esperar a ferramenta do duo nem avisar: quem a respondia deixa de ser esperado
    for (const wait of run.waits) wait.abort(STOPPED);
    await this.control(run, { subtype: 'interrupt' });
  }

  async setModel(choice: ModelChoice): Promise<void> {
    const run = this.ensureProcess();
    if (choice.model !== undefined) {
      await this.control(run, { subtype: 'set_model', model: choice.model });
      this.choice.model = choice.model;
    }
    if (choice.effort !== undefined) {
      await this.control(run, { subtype: 'apply_flag_settings', settings: { effortLevel: choice.effort } });
      this.choice.effort = choice.effort;
    }
    this.applySettings(await this.control(run, { subtype: 'get_settings' }));
  }

  /** Um pedido de controle ao processo; resolve com a resposta dele, rejeita se ele recusar ou cair antes. */
  private control(run: Running, request: object): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = `duo-ctl-${randomUUID()}`;
      run.controls.set(id, { resolve, reject });
      run.proc.stdin?.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
    });
  }

  /** O que ficou valendo, pelo get_settings: o modelo resolvido e o esforço (o modelo sem esforço volta null). */
  private applySettings(response: any): void {
    const applied = response?.applied ?? {};
    const effort = typeof applied.effort === 'string' ? applied.effort : undefined;
    // o esforço que o modelo não aceita o CLI ignora: o próximo processo sobe com o que ficou, não com o recusado
    if (this.choice.effort !== undefined && this.choice.effort !== effort) this.choice.effort = effort;
    patchStats(this, {
      ...(typeof applied.model === 'string' ? { model: applied.model } : {}),
      effort,
      selected: this.choice.model,
    });
  }

  reset(): void {
    this.stop();
    this.sessionId = undefined;
    patchStats(this, { contextTokens: undefined, subagents: 0 });
    this.onTasks?.([]);
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    const run = this.run;
    this.run = undefined;
    killTree(run?.proc);
  }

  private ensureProcess(): Running {
    if (this.run) return this.run;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    args.push('--replay-user-messages', '--permission-prompt-tool', 'stdio');
    if (this.askPeer) {
      args.push('--mcp-config', JSON.stringify({ mcpServers: { duo: { type: 'sdk', name: 'duo' } } }));
      args.push('--append-system-prompt', PEER_HINT);
    }
    if (this.opts.permissionMode) args.push('--permission-mode', this.opts.permissionMode);
    if (this.choice.model) args.push('--model', this.choice.model);
    if (this.choice.effort) args.push('--effort', this.choice.effort);
    if (this.sessionId) args.push('--resume', this.sessionId);

    const [cmd, ...pre] = this.opts.bin ?? ['claude'];
    const proc = spawn(cmd, [...pre, ...args], {
      cwd: this.opts.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    proc.stdin?.on('error', () => undefined); // processo que já saiu: o 'exit' explica o motivo
    const run: Running = {
      proc,
      resumedWith: this.sessionId,
      sawInit: false,
      tail: stderrTail(proc),
      asks: new Map(),
      deniedByYou: new Map(),
      subagents: new Set(),
      tasks: new Map(),
      own: [],
      ownOpen: false,
      ownFromApp: false,
      taskShared: new Map(),
      initRequest: `duo-init-${randomUUID()}`,
      controls: new Map(),
      tools: new Map(),
      steps: new Map(),
      waits: new Set(),
      interrupting: false,
    };
    onJsonLines(proc, (msg) => {
      if (this.run === run) this.onSignal?.();
      this.handle(run, msg);
    });
    proc.on('error', (err) => this.fail(run, new Error(`não consegui iniciar o claude: ${err.message}`)));
    proc.on('exit', (code) => this.onExit(run, code));
    this.run = run;
    const init = { type: 'control_request', request_id: run.initRequest, request: { subtype: 'initialize' } };
    proc.stdin?.write(JSON.stringify(init) + '\n');
    if (this.opts.remoteControl) {
      run.remoteControlRequest = `duo-rc-${randomUUID()}`;
      const request = { subtype: 'remote_control', enabled: true };
      proc.stdin?.write(JSON.stringify({ type: 'control_request', request_id: run.remoteControlRequest, request }) + '\n');
    }
    return run;
  }

  private onExit(run: Running, code: number | null): void {
    for (const ask of run.asks.values()) ask.abort(); // a pergunta sai da tela: ninguém mais espera a resposta
    // os passos abertos morreram junto (o de um processo trocado de propósito, pelo /novo, não aparece mais)
    if (this.run === run) this.closeSteps(run, STEP_UNFINISHED);
    else run.steps.clear();
    this.dropControls(run, new Error(`o processo do claude encerrou (código ${code ?? '?'})`));
    if (this.run === run || !this.run) {
      patchStats(this, { subagents: 0 }); // os subagentes morreram junto
      if (run.tasks.size > 0) this.onTasks?.([]);
      if (run.tools.size > 0) this.onTools?.([]);
    }
    const turn = this.turn;
    if (turn?.proc === run.proc && turn.resumeError !== undefined && /No conversation found/i.test(run.tail())) {
      if (this.sessionId === run.resumedWith) this.sessionId = undefined;
      if (this.run === run) this.run = undefined;
      this.settle(turn, new ResumeFailedError(`a conversa ${run.resumedWith} não existe mais no Claude Code`));
      return;
    }
    const reason = turn?.resumeError || `o processo do claude encerrou (código ${code ?? '?'})`;
    const extra = run.tail();
    const err = new Error(extra ? `${reason}\n${extra}` : reason);
    if (this.run === run && run.ownOpen) {
      // o turno que ele abriu sozinho morreu junto: termina aqui (senão fica "rodando"), e a janela fica sabendo, a
      // não ser que uma mensagem do duo esperando por ele já vá mostrar o mesmo erro
      if (turn?.proc !== run.proc) this.onOwnTurnEvent?.({ kind: 'error', text: err.message });
      this.finishOwnTurn(run);
    }
    this.fail(run, err);
  }

  /** Os pedidos de controle esperando este processo não vão ter resposta: rejeita cada um com o motivo. */
  private dropControls(run: Running, err: Error): void {
    for (const ctl of run.controls.values()) ctl.reject(err);
    run.controls.clear();
  }

  /** O processo morreu (ou nem subiu: `error` sem `exit`): esquece ele e derruba o que dependia dele. */
  private fail(run: Running, err: Error): void {
    this.dropControls(run, err);
    if (this.run === run) this.run = undefined;
    if (this.turn?.proc === run.proc) this.settle(this.turn, err);
  }

  private settle(turn: Turn, result: string | Error): void {
    if (this.turn === turn) this.turn = undefined;
    if (result instanceof Error) turn.reject(result);
    else turn.resolve(result);
  }

  private handle(run: Running, msg: any): void {
    if (this.run !== run) return; // mensagem atrasada de um processo antigo
    if (msg.type === 'control_request') {
      void this.answerControl(run, msg);
      return;
    }
    if (msg.type === 'control_cancel_request') {
      run.asks.get(msg.request_id)?.abort();
      return;
    }
    if (msg.type === 'control_response') {
      const res = msg.response ?? {};
      if (res.request_id === run.initRequest) {
        if (res.subtype !== 'success') return;
        this.setCommands(res.response?.commands);
        this.setModels(res.response?.models);
        // o modelo e o esforço que ficaram valendo, já antes da primeira mensagem (o chip da janela)
        this.control(run, { subtype: 'get_settings' }).then((r) => this.run === run && this.applySettings(r), () => undefined);
        return;
      }
      const ctl = run.controls.get(res.request_id);
      if (ctl) {
        run.controls.delete(res.request_id);
        if (res.subtype === 'success') ctl.resolve(res.response ?? {});
        else ctl.reject(new Error(res.error ?? 'o claude recusou sem dizer o motivo'));
        return;
      }
      if (res.request_id !== run.remoteControlRequest) return;
      if (res.subtype === 'success') {
        this.onNotice?.({ kind: 'text', text: `${NAMES.claude} no Remote Control: ${res.response?.session_url ?? '(sem link)'}` });
      } else {
        this.onNotice?.({ kind: 'error', text: `não consegui ligar o Remote Control: ${res.error ?? 'sem motivo'}` });
      }
      return;
    }
    if (msg.type === 'system' && msg.subtype === 'init') {
      run.sawInit = true;
      if (msg.apiKeySource === 'ANTHROPIC_API_KEY' && !this.warnedApiKey) {
        this.warnedApiKey = true;
        this.onNotice?.({
          kind: 'error',
          text:
            'o Claude Code está vendo a ANTHROPIC_API_KEY do seu ambiente: se ela for válida, o uso pode ser cobrado ' +
            'pela API em vez do seu login. Para usar só o login, abra o duo sem essa variável.',
        });
      }
    }
    if (msg.type === 'system' && msg.subtype === 'commands_changed') this.setCommands(msg.commands);
    const resumeFailed = msg.type === 'result' && msg.is_error && run.resumedWith !== undefined && !run.sawInit;

    if (typeof msg.session_id === 'string' && !resumeFailed && msg.session_id !== this.sessionId) {
      this.sessionId = msg.session_id;
      this.onSessionId?.(msg.session_id);
    }
    this.trackStats(run, msg);
    // mensagem de um subagente (traz parent_tool_use_id): é trabalho dele, não a resposta do Claude
    if (msg.type === 'assistant' && msg.parent_tool_use_id) return;

    const turn = this.turn?.proc === run.proc ? this.turn : undefined;
    if (msg.type === 'system' && typeof msg.task_id === 'string') {
      this.trackTask(run, turn, msg);
      this.trackTaskList(run, msg);
    }
    if (msg.type === 'command_lifecycle') {
      if (turn && msg.state === 'started' && msg.command_uuid === turn.uuid) this.startTurn(run, turn);
      return;
    }
    if (msg.type === 'user') {
      if (!msg.isReplay) {
        this.toolsDone(run, msg);
        return;
      }
      if (turn && msg.uuid === turn.uuid) {
        this.startTurn(run, turn);
      } else if (this.opts.remoteControl && !msg.isSynthetic) {
        // outra mensagem lida pelo CLI: só pode ter vindo do app, pelo Remote Control. Lida no meio de um turno do duo,
        // é dele; senão é do turno dele que está aberto ou do próximo (a não ser que o CLI leia a do duo antes de
        // responder: aí entrou no turno do duo, e o startTurn esquece)
        const text = userText(msg.message?.content);
        const inDuoTurn = turn?.started === true;
        if (text && !inDuoTurn) run.ownFromApp = true;
        if (text) this.onRemoteMessage?.(text, inDuoTurn);
      }
      return;
    }
    if (msg.type === 'result' && resumeFailed) {
      if (!turn) return;
      // Pode ser "conversa não existe": quem decide é o stderr, quando o processo sair.
      turn.resumeError = resultError(msg);
      setTimeout(() => killTree(run.proc), 5000).unref(); // ele sai sozinho; se não sair, forçamos
      return;
    }

    // antes de o CLI ler a mensagem, o que chega é de um turno que ele abriu sozinho: vai para a tela do mesmo jeito
    const mine = turn?.started ? turn : undefined;
    const emit: EmitFn = mine ? mine.emit : (ev) => this.onOwnTurnEvent?.(ev);
    const texts = mine ? mine.texts : run.own;
    if (!mine && (msg.type === 'assistant' || msg.type === 'result')) run.ownOpen = true;

    if (msg.type === 'assistant') {
      const before = run.tools.size;
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) {
          texts.push(block.text);
          emit({ kind: 'text', text: block.text });
        } else if (block.type === 'tool_use' && !String(block.name).startsWith('mcp__duo__')) {
          // a ferramenta do duo não entra aqui: a tela mostra a mensagem inteira quando ela chega ao Codex
          const full = this.stepText(block.name, block.input);
          const text = truncate(full);
          if (typeof block.id === 'string') {
            emit({ kind: 'tool', text, step: { id: block.id, full } });
            run.tools.set(block.id, { id: block.id, text, startedAt: Date.now() });
            run.steps.set(block.id, { name: String(block.name), file: this.fileOf(block.input) });
          } else {
            emit({ kind: 'tool', text });
          }
        }
      }
      if (run.tools.size !== before) this.showTools(run);
      return;
    }

    if (msg.type === 'result') {
      const stopped = run.interrupting && msg.subtype === 'error_during_execution';
      run.interrupting = false;
      // o turno parado fechou sem esperar o que ainda estava aberto nele: solta quem respondia
      if (stopped) for (const wait of run.waits) wait.abort(STOPPED);
      if (run.tools.size > 0) {
        run.tools.clear();
        this.showTools(run);
      }
      this.closeSteps(run, stopped ? STEP_STOPPED : STEP_UNFINISHED);
      for (const denial of msg.permission_denials ?? []) {
        if (run.deniedByYou.has(denial.tool_use_id)) continue;
        emit({
          kind: 'error',
          text: `permissão negada: ${describeTool(denial.tool_name, denial.tool_input)} (veja --claude-permission)`,
        });
      }
      if (!mine) {
        if (msg.is_error && !stopped) emit({ kind: 'error', text: resultError(msg) });
        this.finishOwnTurn(run);
        return;
      }
      if (stopped) this.settle(mine, new Error(`você parou o ${NAMES.claude}`));
      else this.settle(mine, msg.is_error ? new Error(resultError(msg)) : mine.texts.join('\n\n'));
    }
  }

  /**
   * As ferramentas que terminaram (os tool_result da conversa principal) saem do quadro, e o fim de cada passo vai para
   * a tela. O tool_use_result só diz de qual passo é quando a mensagem traz um tool_result só (é o que o CLI manda).
   */
  private toolsDone(run: Running, msg: any): void {
    const content = msg.message?.content;
    if (!Array.isArray(content)) return;
    const results = content.filter((b) => b?.type === 'tool_result' && typeof b.tool_use_id === 'string');
    const before = run.tools.size;
    for (const block of results) run.tools.delete(block.tool_use_id);
    if (run.tools.size !== before) this.showTools(run);
    const structured = results.length === 1 ? msg.tool_use_result : undefined;
    for (const block of results) {
      const step = run.steps.get(block.tool_use_id);
      if (!step) continue; // de um subagente, ou a ferramenta do duo
      run.steps.delete(block.tool_use_id);
      this.emitNow(run)(stepEnd(stepResult(run, block, step, structured)));
    }
  }

  /** Os passos que ficaram sem fim (o turno acabou ou o processo caiu sem o tool_result deles). */
  private closeSteps(run: Running, note: string): void {
    if (run.steps.size === 0) return;
    const emit = this.emitNow(run);
    for (const id of run.steps.keys()) emit(stepEnd({ of: id, ok: false, note }));
    run.steps.clear();
  }

  /**
   * Para onde vai o que chega agora: o turno do duo, se o CLI já leu a mensagem dele; senão o turno que ele abriu
   * sozinho (só se já abriu: o fim de um passo nunca abre um turno).
   */
  private emitNow(run: Running): EmitFn {
    const turn = this.turn?.proc === run.proc ? this.turn : undefined;
    if (turn?.started) return turn.emit;
    return (ev) => {
      if (run.ownOpen) this.onOwnTurnEvent?.(ev);
    };
  }

  private get cwd(): string {
    return this.opts.cwd ?? process.cwd();
  }

  /** O passo inteiro: "Bash <o comando todo>", "Write src/x.ts" (o arquivo relativo à pasta do projeto). */
  private stepText(name: string, input: any): string {
    const file = this.fileOf(input);
    return file !== undefined && input?.command === undefined ? `${name} ${file}` : toolCall(name, input);
  }

  /** O arquivo em que a ferramenta mexe, relativo à pasta do projeto quando está dentro dela. */
  private fileOf(input: any): string | undefined {
    const file = input?.file_path ?? input?.notebook_path;
    return typeof file === 'string' && file ? relPath(this.cwd, file) : undefined;
  }

  private showTools(run: Running): void {
    if (this.run === run) this.onTools?.([...run.tools.values()]);
  }

  /** A lista de comandos que o CLI informou. */
  private setCommands(list: unknown): void {
    if (!Array.isArray(list)) return;
    this.commands = list
      .filter((c) => typeof c?.name === 'string')
      .map((c) => ({ name: c.name, description: String(c.description ?? ''), hint: c.argumentHint || undefined }));
    this.onCommands?.(this.commands);
  }

  /** Os modelos do initialize. Avisa só se a lista mudou (cada processo novo manda a mesma). */
  private setModels(list: unknown): void {
    if (!Array.isArray(list)) return;
    const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
    const models: AgentModel[] = list
      .filter((m) => typeof m?.value === 'string')
      .map((m) => ({
        id: m.value,
        resolved: str(m.resolvedModel, m.value),
        name: str(m.displayName, m.value),
        description: str(m.description, ''),
        efforts: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.filter((e: unknown) => typeof e === 'string') : [],
        fast: false, // o supportsFastMode vem, mas o `-p` não liga o modo rápido
      }));
    if (JSON.stringify(models) === JSON.stringify(this.models)) return;
    this.models = models;
    this.onModels?.(models);
  }

  /** O CLI leu a mensagem do duo: o turno que ele abriu sozinho (se havia) termina aqui, e o do duo começa. */
  private startTurn(run: Running, turn: Turn): void {
    if (turn.started) return;
    this.finishOwnTurn(run);
    turn.started = true;
  }

  /**
   * O turno que o CLI abriu sozinho terminou (ou a mensagem do duo entrou nele): a resposta vai para a janela. Turno
   * sem texto (só ferramenta) também avisa, com texto vazio: o modo dele acaba aqui e não passa para o próximo. Sem
   * turno dele aberto (o CLI leu a do duo antes de responder), o que estava guardado para ele entrou no turno do duo.
   */
  private finishOwnTurn(run: Running): void {
    const tasksShared = run.ownTasksShared;
    const fromApp = run.ownFromApp;
    run.ownTasksShared = undefined;
    run.ownFromApp = false;
    if (!run.ownOpen) return;
    const text = run.own.join('\n\n');
    run.own = [];
    run.ownOpen = false;
    this.onOwnTurnReply?.(text, tasksShared, fromApp);
  }

  /**
   * De onde veio cada tarefa em segundo plano: a que começa num turno do duo leva o modo dele; a que começa num
   * turno dele herda o das tarefas que o abriram (sem nenhuma conhecida, conta como privada). Quando ela termina,
   * o modo vai para o turno que ela abre. Se terminar no meio de um turno do duo, não decide nada: o turno dele
   * que vier depois fica sem origem conhecida (o app trata como privado se já houve algo privado com ele).
   */
  private trackTask(run: Running, turn: Turn | undefined, msg: any): void {
    if (msg.subtype === 'task_started') {
      run.taskShared.set(msg.task_id, turn?.started ? turn.shared : (run.ownTasksShared ?? false));
    } else if (msg.subtype === 'task_notification') {
      if (!turn?.started) run.ownTasksShared = (run.ownTasksShared ?? true) && (run.taskShared.get(msg.task_id) ?? false);
      run.taskShared.delete(msg.task_id);
    }
  }

  /**
   * O quadro de segundo plano: cada subagente e comando em segundo plano, do `task_started` (descrição, tipo do
   * subagente) ao `task_notification`, com o último `task_progress` como sinal de vida. Medido em 03/11/2026 no
   * 2.1.316: o progresso traz `description` (o que está fazendo agora) e `last_tool_name`; um `task_updated` com o
   * status final vem logo antes do `task_notification`.
   */
  private trackTaskList(run: Running, msg: any): void {
    const id: string = msg.task_id;
    const now = Date.now();
    const known = run.tasks.get(id);
    if (msg.subtype === 'task_started') {
      run.tasks.set(id, {
        id,
        kind: msg.task_type === 'local_bash' ? 'comando' : 'subagente',
        title: String(msg.description || msg.task_type || 'tarefa'),
        detail: typeof msg.subagent_type === 'string' ? msg.subagent_type : undefined,
        startedAt: now,
        lastAt: now,
      });
    } else if (msg.subtype === 'task_progress' && known) {
      const activity = msg.description || msg.last_tool_name;
      run.tasks.set(id, { ...known, activity: activity ? String(activity) : known.activity, lastAt: now });
    } else if (msg.subtype === 'task_notification' && known) {
      run.tasks.delete(id);
    } else {
      return;
    }
    if (this.run === run) this.onTasks?.([...run.tasks.values()]);
  }

  /** Modelo, contexto e subagentes, para o rodapé. Vale também fora de um turno (subagente em segundo plano). */
  private trackStats(run: Running, msg: any): void {
    if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.model === 'string') {
      const changed = msg.model !== this.stats.model;
      patchStats(this, { model: msg.model });
      // trocado por fora do seletor (um /model mandado como mensagem): o esforço que vale agora só o get_settings diz
      if (changed) this.control(run, { subtype: 'get_settings' }).then((r) => this.run === run && this.applySettings(r), () => undefined);
    } else if (msg.type === 'assistant' && !msg.parent_tool_use_id && msg.message?.usage) {
      const u = msg.message.usage;
      const tokens =
        (u.input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0) +
        (u.output_tokens ?? 0);
      patchStats(this, { contextTokens: tokens });
    } else if (msg.type === 'result' && msg.modelUsage) {
      const usage: any = msg.modelUsage[this.stats.model ?? ''] ?? Object.values(msg.modelUsage)[0];
      if (typeof usage?.contextWindow === 'number') patchStats(this, { contextWindow: usage.contextWindow });
    } else if (msg.type === 'system' && msg.subtype === 'task_started' && /agent/.test(msg.task_type ?? '')) {
      run.subagents.add(msg.task_id);
      patchStats(this, { subagents: run.subagents.size });
    } else if (msg.type === 'system' && msg.subtype === 'task_notification') {
      run.subagents.delete(msg.task_id);
      patchStats(this, { subagents: run.subagents.size });
    }
  }

  /**
   * Pedido do CLI pelo protocolo de controle. O único que ele manda ao duo é can_use_tool: a pergunta
   * que o terminal dele faria. Quem responde é você, pela janela do duo.
   */
  private async answerControl(run: Running, msg: any): Promise<void> {
    const req = msg.request ?? {};
    const reply = (response: object) =>
      run.proc.stdin?.write(
        JSON.stringify({ type: 'control_response', response: { request_id: msg.request_id, ...response } }) + '\n',
      );
    if (req.subtype === 'mcp_message') {
      const ctrl = new AbortController();
      const call = req.message?.method === 'tools/call';
      // chegou com o parar já pedido (estava a caminho): o turno está fechando, então volta na hora sem ir ao Codex
      const late = call && run.interrupting;
      if (late) ctrl.abort(STOPPED);
      else if (call) run.waits.add(ctrl);
      run.asks.set(msg.request_id, ctrl);
      const mcpResponse = await this.answerMcp(req.message ?? {}, ctrl.signal);
      run.asks.delete(msg.request_id);
      run.waits.delete(ctrl);
      if (late || !ctrl.signal.aborted) reply({ subtype: 'success', response: { mcp_response: mcpResponse } });
      return;
    }
    if (req.subtype !== 'can_use_tool') {
      reply({ subtype: 'error', error: `o duo não trata ${req.subtype}` });
      return;
    }
    const ask = this.askPermission;
    const ctrl = new AbortController();
    // chegou com o parar já pedido: nem pergunta, nega
    if (run.interrupting) ctrl.abort(STOPPED);
    run.asks.set(msg.request_id, ctrl);
    run.waits.add(ctrl);
    // A pergunta com opções (AskUserQuestion) chega como um pedido destes: você vê as perguntas e responde. A resposta
    // volta ao CLI em updatedInput.answers, pelo texto de cada pergunta; o "allow" sem ela, ele entende como "não
    // respondeu" (medido em 04/11/2026, 2.1.316).
    const questions = req.tool_name === 'AskUserQuestion' ? parseQuestions(req.input) : undefined;
    // numa forma que o duo não conhece, você ao menos lê as perguntas (e responde negando e escrevendo)
    const text = questions
      ? `AskUserQuestion ${questions.map((q) => q.question).join(' · ')}`
      : req.tool_name === 'AskUserQuestion'
        ? `AskUserQuestion ${JSON.stringify(req.input ?? {})}`
        : toolCall(req.tool_name, req.input);
    const request = { text, signal: ctrl.signal, ...(questions ? { questions } : {}) };
    const answer = ask && !ctrl.signal.aborted ? await ask(request).catch(() => false) : false;
    run.asks.delete(msg.request_id);
    run.waits.delete(ctrl);
    // parado pelo duo: nega, para o CLI não ficar esperando (se ele já desistiu, a resposta não muda nada)
    const stopped = ctrl.signal.reason === STOPPED;
    if (ctrl.signal.aborted && !stopped) return;
    if (answer) {
      const updatedInput = typeof answer === 'object' ? { ...req.input, answers: answer.answers } : req.input;
      reply({ subtype: 'success', response: { behavior: 'allow', updatedInput } });
      return;
    }
    if (ask) run.deniedByYou.set(req.tool_use_id, questions ? 'você não respondeu' : 'você negou');
    const message = stopped
      ? 'O usuário parou o Claude pela janela do duo.'
      : !ask
        ? 'O duo não tinha como perguntar ao usuário.'
        : questions
          ? 'O usuário não quis responder pela janela do duo.'
          : 'O usuário negou pela janela do duo.';
    reply({ subtype: 'success', response: { behavior: 'deny', message } });
  }

  /**
   * O servidor MCP "duo" (medido em 02/11/2026, 2.1.316): com `--mcp-config` de tipo "sdk", o CLI manda o
   * JSON-RPC do MCP dentro de `mcp_message` (initialize, notifications/initialized, tools/list, tools/call)
   * e espera a resposta em `mcp_response`. Só tem uma ferramenta: falar com o Codex.
   */
  private async answerMcp(message: any, signal: AbortSignal): Promise<object> {
    const ok = (result: object) => ({ jsonrpc: '2.0', id: message.id ?? 0, result });
    const toolResult = (text: string, isError = false) => ok({ content: [{ type: 'text', text }], isError });
    switch (message.method) {
      case 'initialize':
        return ok({
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'duo', version: '0.1.0' },
        });
      case 'tools/list':
        return ok({ tools: [PEER_TOOL] });
      case 'tools/call': {
        const text = String(message.params?.arguments?.mensagem ?? '').trim();
        if (message.params?.name !== PEER_TOOL.name || !text || !this.askPeer) {
          return toolResult('chamada inválida: a ferramenta do duo precisa de uma mensagem para o Codex', true);
        }
        if (signal.aborted) return toolResult('o usuário parou o Claude antes de a mensagem ir para o Codex', true);
        try {
          const answer = await this.askPeer({ text, signal });
          return toolResult(`O Codex respondeu:\n\n${answer.trim() || '(sem texto)'}`);
        } catch (e) {
          return toolResult(e instanceof Error ? e.message : String(e), true);
        }
      }
      default:
        // avisos (sem id), como notifications/initialized, só são confirmados
        if (message.id === undefined) return ok({});
        return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `o duo não trata ${message.method}` } };
    }
  }
}

/** O texto de uma mensagem do usuário: string, ou os blocos de texto dela. */
function userText(content: any): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function resultError(msg: any): string {
  return typeof msg.result === 'string' && msg.result ? msg.result : String(msg.subtype);
}

/** As ferramentas que gravam arquivo: o fim delas diz qual arquivo mudou. */
const EDITS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** Como o passo terminou, pelo tool_result e, quando é dele, pelo tool_use_result. */
function stepResult(run: Running, block: any, step: { name: string; file?: string }, structured: any): StepResult {
  const of: string = block.tool_use_id;
  if (block.is_error === true) {
    // parar nega o pedido de permissão aberto (e o marca como seu): o motivo é o parar
    if (run.interrupting) return { of, ok: false, note: STEP_STOPPED };
    const yours = run.deniedByYou.get(of);
    if (yours) return { of, ok: false, note: yours };
    const text = resultText(block.content).replace(/<\/?tool_use_error>/g, '');
    const code = /^Exit code (\d+)/.exec(text);
    if (code) return { of, ok: false, exitCode: Number(code[1]) };
    // o motivo vai inteiro (a primeira linha) para a janela e para o disco; só a linha do terminal corta
    return { of, ok: false, note: `erro: ${text.split('\n')[0].trim() || 'sem detalhe'}` };
  }
  if (step.file === undefined || !EDITS.has(step.name)) return { of, ok: true };
  if (step.name !== 'Write') return { of, ok: true, files: [{ path: step.file, change: 'alterado' }] };
  // o Write cria ou reescreve: só o tool_use_result diz qual; sem ele, a linha do passo já diz o arquivo
  const type = structured?.type;
  if (type !== 'create' && type !== 'update') return { of, ok: true };
  return { of, ok: true, files: [{ path: step.file, change: type === 'create' ? 'criado' : 'alterado' }] };
}

/** O texto de um tool_result (vem como string ou como lista de blocos). */
function resultText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/**
 * As perguntas do AskUserQuestion, no formato do 2.1.316: `questions: [{ question, header, options: [{ label,
 * description }], multiSelect }]`. Fora dele, undefined, e o pedido segue como uma permissão comum, com o input
 * inteiro na tela. Fora dele é: um desses campos com outro tipo (um `multiSelect: "true"` não vira escolha única
 * calado), pergunta ou opção sem texto, ou duas perguntas de mesmo texto (a resposta vai pelo texto e não as separa).
 * Campos que o duo não conhece ficam de fora da tela, sem mudar o sentido dos que ele mostra.
 */
export function parseQuestions(input: any): AskQuestion[] | undefined {
  const list = input?.questions;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  /** ausente, ou do tipo esperado */
  const maybe = (v: unknown, type: 'string' | 'boolean') => v === undefined || typeof v === type;
  const out: AskQuestion[] = [];
  for (const q of list) {
    if (typeof q?.question !== 'string' || q.question.trim() === '' || !Array.isArray(q.options)) return undefined;
    if (!maybe(q.header, 'string') || !maybe(q.multiSelect, 'boolean')) return undefined;
    if (out.some((o) => o.question === q.question)) return undefined;
    const options: AskQuestion['options'] = [];
    for (const o of q.options) {
      if (typeof o?.label !== 'string' || o.label.trim() === '' || !maybe(o.description, 'string')) return undefined;
      options.push({ label: o.label, ...(typeof o.description === 'string' ? { description: o.description } : {}) });
    }
    out.push({
      question: q.question,
      ...(typeof q.header === 'string' ? { header: q.header } : {}),
      options,
      ...(q.multiSelect === true ? { multiSelect: true } : {}),
    });
  }
  return out;
}

/** "Bash git push origin master": a ferramenta e o argumento que importa, inteiro. */
function toolCall(name: string, input: any): string {
  const arg =
    input?.command ?? input?.file_path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description ?? '';
  return `${name}${arg ? ' ' + String(arg) : ''}`;
}

export function describeTool(name: string, input: any): string {
  return truncate(toolCall(name, input));
}
