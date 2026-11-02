import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { killTree, onJsonLines, stderrTail } from './process.js';
import {
  createQueue,
  ResumeFailedError,
  truncate,
  patchStats,
  peerLoopHint,
  type Agent,
  type AgentStats,
  type EmitFn,
  type PeerRequest,
  type PermissionRequest,
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

const PEER_HINT =
  '[duo] Você está no duo, numa janela compartilhada com o usuário e com o Codex (o Fog). Para falar com o Codex ' +
  '(pedir revisão, segunda opinião ou uma tarefa), use a ferramenta mcp__duo__falar_com_codex: a resposta dele ' +
  'volta para você, e o usuário acompanha tudo na janela. ' +
  peerLoopHint('Codex');

export interface ClaudeOptions {
  /** default | acceptEdits | plan | bypassPermissions. Vazio = segue o defaultMode do seu settings.json. */
  permissionMode?: string;
  model?: string;
  cwd?: string;
  /** conversa a retomar (session_id gravado pelo duo) */
  resumeId?: string;
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
  /** tool_use_id do que você negou: a tela já mostra, não repete como "permissão negada" */
  deniedByYou: Set<string>;
  /** task_id dos subagentes rodando */
  subagents: Set<string>;
  /** textos do turno que o CLI abriu sozinho, até o result dele */
  own: string[];
}

interface Turn {
  proc: ChildProcess;
  /** uuid da mensagem do duo: o eco dela marca onde começa este turno */
  uuid: string;
  /** o CLI já leu a mensagem; antes disso, o que chega é de um turno que ele abriu sozinho */
  started: boolean;
  emit: EmitFn;
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
 * com `result` próprio, sem mensagem nenhuma no stdin. Uma mensagem que chega no meio desse turno entra
 * nele: um `result` só para os dois. Com `--replay-user-messages` ele ecoa a mensagem (com o `uuid` que
 * mandamos) no ponto em que a lê; é esse eco que separa o turno dele do turno do duo.
 *
 * Retomada que falha (medido em 02/11/2026, Claude Code 2.1.316): com um id inexistente ele manda
 * um `result` de erro SEM o `system/init`, escreve "No conversation found with session ID" no
 * stderr e sai sozinho ~1,4s depois, mesmo com o stdin aberto.
 */
export class ClaudeAgent implements Agent {
  readonly id = 'claude' as const;
  readonly name = 'Claude';
  onSessionId?: (id: string) => void;
  askPermission?: (req: PermissionRequest) => Promise<boolean>;
  askPeer?: (req: PeerRequest) => Promise<string>;
  onOwnTurnEvent?: EmitFn;
  onOwnTurnReply?: (text: string) => void;
  onStats?: (stats: AgentStats) => void;
  readonly stats: AgentStats;
  private run?: Running;
  private sessionId?: string;
  private turn?: Turn;
  private enqueue = createQueue();

  constructor(private readonly opts: ClaudeOptions) {
    this.sessionId = opts.resumeId;
    this.stats = { model: opts.model, subagents: 0 };
  }

  get resumeId(): string | undefined {
    return this.sessionId;
  }

  send(prompt: string, emit: EmitFn): Promise<string> {
    return this.enqueue(
      () =>
        new Promise<string>((resolve, reject) => {
          const run = this.ensureProcess();
          const uuid = randomUUID();
          this.turn = { proc: run.proc, uuid, started: false, emit, texts: [], resolve, reject };
          const line = JSON.stringify({ type: 'user', uuid, message: { role: 'user', content: prompt } });
          run.proc.stdin?.write(line + '\n');
        }),
    );
  }

  reset(): void {
    this.stop();
    this.sessionId = undefined;
    patchStats(this, { contextTokens: undefined, subagents: 0 });
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
    if (this.opts.model) args.push('--model', this.opts.model);
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
      deniedByYou: new Set(),
      subagents: new Set(),
      own: [],
    };
    onJsonLines(proc, (msg) => this.handle(run, msg));
    proc.on('error', (err) => this.fail(run, new Error(`não consegui iniciar o claude: ${err.message}`)));
    proc.on('exit', (code) => this.onExit(run, code));
    this.run = run;
    return run;
  }

  private onExit(run: Running, code: number | null): void {
    for (const ask of run.asks.values()) ask.abort(); // a pergunta sai da tela: ninguém mais espera a resposta
    if (this.run === run || !this.run) patchStats(this, { subagents: 0 }); // os subagentes morreram junto
    const turn = this.turn;
    if (turn?.proc === run.proc && turn.resumeError !== undefined && /No conversation found/i.test(run.tail())) {
      if (this.sessionId === run.resumedWith) this.sessionId = undefined;
      if (this.run === run) this.run = undefined;
      this.settle(turn, new ResumeFailedError(`a conversa ${run.resumedWith} não existe mais no Claude`));
      return;
    }
    const reason = turn?.resumeError || `o processo do claude encerrou (código ${code ?? '?'})`;
    const extra = run.tail();
    this.fail(run, new Error(extra ? `${reason}\n${extra}` : reason));
  }

  /** O processo morreu: esquece ele e derruba o turno que dependia dele. */
  private fail(run: Running, err: Error): void {
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
    if (msg.type === 'system' && msg.subtype === 'init') run.sawInit = true;
    const resumeFailed = msg.type === 'result' && msg.is_error && run.resumedWith !== undefined && !run.sawInit;

    if (typeof msg.session_id === 'string' && !resumeFailed && msg.session_id !== this.sessionId) {
      this.sessionId = msg.session_id;
      this.onSessionId?.(msg.session_id);
    }
    this.trackStats(run, msg);

    const turn = this.turn?.proc === run.proc ? this.turn : undefined;
    if (msg.type === 'user') {
      // o eco da mensagem do duo: o turno que ele abriu sozinho (se havia) acabou de receber a mensagem
      if (turn && msg.isReplay && msg.uuid === turn.uuid) {
        this.finishOwnTurn(run);
        turn.started = true;
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

    // antes do eco, o que chega é de um turno que o CLI abriu sozinho: vai para a tela do mesmo jeito
    const mine = turn?.started ? turn : undefined;
    const emit: EmitFn = mine ? mine.emit : (ev) => this.onOwnTurnEvent?.(ev);
    const texts = mine ? mine.texts : run.own;

    if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) {
          texts.push(block.text);
          emit({ kind: 'text', text: block.text });
        } else if (block.type === 'tool_use' && !String(block.name).startsWith('mcp__duo__')) {
          // a ferramenta do duo não entra aqui: a tela mostra a mensagem inteira quando ela chega ao Codex
          emit({ kind: 'tool', text: describeTool(block.name, block.input) });
        }
      }
      return;
    }

    if (msg.type === 'result') {
      for (const denial of msg.permission_denials ?? []) {
        if (run.deniedByYou.has(denial.tool_use_id)) continue;
        emit({
          kind: 'error',
          text: `permissão negada: ${describeTool(denial.tool_name, denial.tool_input)} (veja --claude-permission)`,
        });
      }
      if (!mine) {
        if (msg.is_error) emit({ kind: 'error', text: resultError(msg) });
        this.finishOwnTurn(run);
        return;
      }
      this.settle(mine, msg.is_error ? new Error(resultError(msg)) : mine.texts.join('\n\n'));
    }
  }

  /** O turno que o CLI abriu sozinho terminou (ou a mensagem do duo entrou nele): a resposta vai para a janela. */
  private finishOwnTurn(run: Running): void {
    if (!run.own.length) return;
    const text = run.own.join('\n\n');
    run.own = [];
    this.onOwnTurnReply?.(text);
  }

  /** Modelo, contexto e subagentes, para o rodapé. Vale também fora de um turno (subagente em segundo plano). */
  private trackStats(run: Running, msg: any): void {
    if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.model === 'string') {
      patchStats(this, { model: msg.model });
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
      run.asks.set(msg.request_id, ctrl);
      const mcpResponse = await this.answerMcp(req.message ?? {}, ctrl.signal);
      run.asks.delete(msg.request_id);
      if (!ctrl.signal.aborted) reply({ subtype: 'success', response: { mcp_response: mcpResponse } });
      return;
    }
    if (req.subtype !== 'can_use_tool') {
      reply({ subtype: 'error', error: `o duo não trata ${req.subtype}` });
      return;
    }
    const ask = this.askPermission;
    const ctrl = new AbortController();
    run.asks.set(msg.request_id, ctrl);
    const text = toolCall(req.tool_name, req.input);
    const allowed = ask ? await ask({ text, signal: ctrl.signal }).catch(() => false) : false;
    run.asks.delete(msg.request_id);
    if (ctrl.signal.aborted) return;
    if (allowed) {
      reply({ subtype: 'success', response: { behavior: 'allow', updatedInput: req.input } });
      return;
    }
    if (ask) run.deniedByYou.add(req.tool_use_id);
    const message = ask ? 'O usuário negou pela janela do duo.' : 'O duo não tinha como perguntar ao usuário.';
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

function resultError(msg: any): string {
  return typeof msg.result === 'string' && msg.result ? msg.result : String(msg.subtype);
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
