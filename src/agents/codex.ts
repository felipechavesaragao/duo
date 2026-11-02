import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { killTree, onJsonLines, stderrTail } from './process.js';
import {
  createQueue,
  patchStats,
  ResumeFailedError,
  truncate,
  type Agent,
  type AgentStats,
  type EmitFn,
  type PeerRequest,
} from './types.js';

/** A ferramenta que o duo dá ao Codex para falar com o Claude (dynamicTools do app-server). */
const PEER_TOOL = {
  type: 'function',
  name: 'falar_com_claude',
  description:
    'Manda uma mensagem ao Claude (o Cla), o outro agente na mesma janela do duo, e espera a resposta dele, que volta ' +
    'aqui. O usuário acompanha a conversa na janela. O Claude vê a janela compartilhada como contexto, mas não a sua ' +
    'conversa interna: escreva a mensagem completa (o que fazer, onde está, o que você quer de volta). Pode levar minutos.',
  inputSchema: {
    type: 'object',
    properties: { mensagem: { type: 'string', description: 'o que dizer ao Claude' } },
    required: ['mensagem'],
  },
};

const PEER_HINT =
  '[duo] Você está no duo, numa janela compartilhada com o usuário e com o Claude (o Cla). Para falar com o Claude ' +
  '(pedir revisão, segunda opinião ou uma tarefa), use a ferramenta falar_com_claude: a resposta dele volta para você, ' +
  'e o usuário acompanha tudo na janela. Se a ferramenta não estiver na sua lista, esta conversa começou antes dela ' +
  'existir: avise o usuário que só uma conversa nova (/novo no duo) a recebe.';

export interface CodexOptions {
  /** read-only | workspace-write | danger-full-access. Vazio = livre: sem sandbox e sem aprovações. */
  sandbox?: string;
  model?: string;
  cwd?: string;
  /** conversa a retomar (thread_id gravado pelo duo) */
  resumeId?: string;
  /** comando a executar; padrão ['codex']. Os testes trocam por um codex falso. */
  bin?: string[];
}

/** Espera máxima por uma resposta de controle (abrir, retomar, começar turno). O turno em si não tem prazo. */
const RPC_TIMEOUT_MS = 120_000;

/**
 * Codex pelo `codex app-server`: UM processo aberto a conversa toda, JSON-RPC por linhas no stdin/stdout,
 * igual ao Claude (que fica vivo no `claude -p`). Sequência: initialize → thread/start ou thread/resume
 * (uma vez por processo) → turn/start a cada mensagem, esperando turn/completed.
 *
 * Medido em 02/11/2026 (codex-cli 0.166.0), comparado ao `codex exec resume` (um processo por mensagem):
 * - "responda só: ok": duo livre em 1,4–3,1s contra ~7,4s (o exec gasta ~1,4s abrindo e ~3s fechando);
 * - approvalPolicy "never" + sandbox "danger-full-access" cria arquivo sem nenhum pedido de aprovação;
 * - id inexistente: erro -32600 "no rollout found for thread id …"; id malformado: "invalid session id: …";
 * - conversa aberta em outro processo: "… already has an active writer". Com o duo aberto, a conversa é
 *   dele: o Codex oficial recebe esse erro até o duo fechar (a escrita é liberada quando o processo sai);
 * - retomar com o histórico inteiro está obsoleto (deprecationNotice): por isso o excludeTurns.
 *
 * Rodapé (medido em 02/11/2026, 0.166.0): o modelo vem na resposta do thread/start e do thread/resume;
 * o contexto em `thread/tokenUsage/updated` (`last.totalTokens` e `modelContextWindow`), que chega
 * também para a conversa de cada subagente; subagente aparece como item `subAgentActivity` na conversa
 * principal, com kind "started" e depois "completed" para o mesmo `agentThreadId`.
 *
 * Falar com o Claude (medido em 02/11/2026, 0.166.0): com `capabilities.experimentalApi` no initialize, o
 * thread/start aceita `dynamicTools`; o Codex chama a ferramenta com o pedido `item/tool/call` e espera
 * `{ contentItems, success }`. A ferramenta fica gravada na conversa e volta no thread/resume, mas só o
 * thread/start a aceita: conversa aberta sem ela (duo antigo) continua sem, mesmo retomada.
 */
export class CodexAgent implements Agent {
  readonly id = 'codex' as const;
  readonly name = 'Codex';
  onSessionId?: (id: string) => void;
  askPeer?: (req: PeerRequest) => Promise<string>;
  onStats?: (stats: AgentStats) => void;
  readonly stats: AgentStats;
  private threadId?: string;
  private conn?: Connection;
  /** a conversa já foi aberta (thread/start ou thread/resume) no processo atual */
  private opened = false;
  /** agentThreadId dos subagentes rodando */
  private subagents = new Set<string>();
  private enqueue = createQueue();

  constructor(private readonly opts: CodexOptions) {
    this.threadId = opts.resumeId;
    this.stats = { model: opts.model, subagents: 0 };
  }

  get resumeId(): string | undefined {
    return this.threadId;
  }

  send(prompt: string, emit: EmitFn): Promise<string> {
    return this.enqueue(() => this.runTurn(prompt, emit));
  }

  reset(): void {
    this.closeConnection();
    this.threadId = undefined;
    patchStats(this, { contextTokens: undefined });
  }

  dispose(): void {
    this.closeConnection();
  }

  /** Como a conversa roda. Padrão = livre, o equivalente ao --dangerously-bypass-approvals-and-sandbox. */
  threadParams(): Record<string, unknown> {
    return {
      cwd: this.opts.cwd ?? process.cwd(),
      // O duo não tem como responder a pedidos de aprovação: com sandbox escolhido, o Codex fica
      // restrito a ele e não pergunta nada (era assim também no `codex exec --sandbox`).
      approvalPolicy: 'never',
      sandbox: this.opts.sandbox ?? 'danger-full-access',
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.askPeer ? { developerInstructions: PEER_HINT } : {}),
    };
  }

  private closeConnection(): void {
    const conn = this.conn;
    this.conn = undefined;
    this.opened = false;
    conn?.kill();
  }

  private async connect(): Promise<Connection> {
    if (this.conn && !this.conn.closed) return this.conn;
    const conn = new Connection(this.opts.bin ?? ['codex'], this.opts.cwd ?? process.cwd());
    conn.onClose(() => {
      // Caiu (ou foi fechado): a próxima mensagem sobe outro processo e retoma a mesma conversa.
      if (this.conn === conn) {
        this.conn = undefined;
        this.opened = false;
      }
      if (!this.conn) {
        this.subagents.clear(); // os subagentes morreram junto
        patchStats(this, { subagents: 0 });
      }
    });
    conn.on((method, p) => this.trackStats(method, p)); // a conexão toda: subagente pode terminar fora do turno
    conn.handleRequest = (method, p) => (method === 'item/tool/call' ? this.answerTool(conn, p) : undefined);
    this.conn = conn;
    await conn.request('initialize', {
      clientInfo: { name: 'duo', title: 'duo', version: '0.1.0' },
      // dynamicTools (a ferramenta de falar com o Claude) é da API experimental
      ...(this.askPeer ? { capabilities: { experimentalApi: true, requestAttestation: false } } : {}),
    });
    conn.notify('initialized');
    return conn;
  }

  /** O Codex chamou a ferramenta do duo: leva a mensagem ao Claude e devolve a resposta dele. */
  private async answerTool(conn: Connection, p: any): Promise<object> {
    const reply = (text: string, success: boolean) => ({ contentItems: [{ type: 'inputText', text }], success });
    const text = String(p.arguments?.mensagem ?? '').trim();
    if (p.tool !== PEER_TOOL.name || !text || !this.askPeer) {
      return reply('chamada inválida: a ferramenta do duo precisa de uma mensagem para o Claude', false);
    }
    const ctrl = new AbortController();
    const abort = () => ctrl.abort(); // o processo caiu: ninguém mais espera a resposta
    conn.onClose(abort);
    try {
      const answer = await this.askPeer({ text, signal: ctrl.signal });
      return reply(`O Claude respondeu:\n\n${answer.trim() || '(sem texto)'}`, true);
    } catch (e) {
      return reply(e instanceof Error ? e.message : String(e), false);
    } finally {
      conn.offClose(abort);
    }
  }

  private async openThread(conn: Connection): Promise<string> {
    if (this.opened && this.threadId) return this.threadId;
    const resumedWith = this.threadId;
    let result: any;
    try {
      result = resumedWith
        ? await conn.request('thread/resume', { threadId: resumedWith, excludeTurns: true, ...this.threadParams() })
        : await conn.request('thread/start', {
            ...this.threadParams(),
            ...(this.askPeer ? { dynamicTools: [PEER_TOOL] } : {}), // só o thread/start aceita
          });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (resumedWith && /no rollout found|invalid session id/i.test(message)) {
        if (this.threadId === resumedWith) this.threadId = undefined;
        throw new ResumeFailedError(`a conversa ${resumedWith} não existe mais no Codex`);
      }
      if (/active writer/i.test(message)) {
        throw new Error('a conversa do Codex está aberta em outro lugar (outro terminal?). Feche lá e mande de novo.');
      }
      throw e;
    }
    const id = result?.thread?.id;
    if (typeof id !== 'string') throw new Error('o codex abriu a conversa sem devolver o id');
    if (id !== this.threadId) {
      this.threadId = id;
      this.onSessionId?.(id);
    }
    if (typeof result.model === 'string') patchStats(this, { model: result.model });
    this.opened = true;
    return id;
  }

  /** Contexto e subagentes da conversa principal, para o rodapé. */
  private trackStats(method: string, p: any): void {
    if (!this.threadId || p.threadId !== this.threadId) return;
    if (method === 'thread/tokenUsage/updated') {
      const usage = p.tokenUsage ?? {};
      patchStats(this, {
        contextTokens: usage.last?.totalTokens,
        ...(typeof usage.modelContextWindow === 'number' ? { contextWindow: usage.modelContextWindow } : {}),
      });
    } else if ((method === 'item/started' || method === 'item/completed') && p.item?.type === 'subAgentActivity') {
      const { kind, agentThreadId } = p.item;
      if (kind === 'started') this.subagents.add(agentThreadId);
      else if (kind === 'completed' || kind === 'interrupted') this.subagents.delete(agentThreadId);
      patchStats(this, { subagents: this.subagents.size });
    }
  }

  private async runTurn(prompt: string, emit: EmitFn): Promise<string> {
    const conn = await this.connect();
    const threadId = await this.openThread(conn);
    conn.onServerRequest = (method) =>
      emit({ kind: 'error', text: `o Codex pediu "${method}"; o duo não responde a pedidos, então foi recusado` });

    return new Promise<string>((resolve, reject) => {
      const texts: string[] = [];
      let lastError: string | undefined;
      const finish = (settle: () => void) => {
        conn.off(listener);
        conn.offClose(onClose);
        conn.onServerRequest = undefined;
        settle();
      };
      const listener: Listener = (method, p) => {
        if (p.threadId !== undefined && p.threadId !== threadId) return;
        switch (method) {
          case 'item/started':
            if (p.item?.type === 'commandExecution') {
              emit({ kind: 'tool', text: `$ ${shortenCommand(p.item.command ?? '')}` });
            }
            break;
          case 'item/completed':
            handleItem(p.item, texts, emit);
            break;
          case 'warning':
            // Aviso de recurso experimental ligado no config.toml: só ruído.
            if (!/Under-development features/i.test(p.message ?? '')) {
              emit({ kind: 'error', text: truncate(p.message ?? 'aviso do codex', 300) });
            }
            break;
          case 'error': {
            const message = p.error?.message ?? 'erro do codex';
            if (p.willRetry) emit({ kind: 'error', text: truncate(`${message} (o Codex vai tentar de novo)`, 300) });
            else lastError = message;
            break;
          }
          case 'turn/completed': {
            const status = p.turn?.status;
            if (status === 'completed') finish(() => resolve(texts.join('\n\n')));
            else if (status === 'interrupted') finish(() => reject(new Error('o turno do Codex foi interrompido')));
            else finish(() => reject(new Error(p.turn?.error?.message ?? lastError ?? 'o turno do Codex falhou')));
            break;
          }
        }
      };
      const onClose = (why: Error) => finish(() => reject(why));
      conn.on(listener);
      conn.onClose(onClose);
      conn
        .request('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] })
        .catch((e: unknown) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
    });
  }
}

type Listener = (method: string, params: any) => void;

/** Um processo `codex app-server` e o JSON-RPC por linhas com ele. */
class Connection {
  private readonly proc: ChildProcess;
  private next = 0;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly listeners = new Set<Listener>();
  private readonly closeHandlers = new Set<(why: Error) => void>();
  private readonly tail: () => string;
  /** pedido do servidor que o duo atende (a ferramenta do duo); undefined = não atende */
  handleRequest?: (method: string, params: any) => Promise<unknown> | undefined;
  /** chamado quando o servidor pede algo que o duo não atende (aprovação, pergunta): o duo recusa */
  onServerRequest?: (method: string) => void;
  closed = false;

  constructor(bin: string[], cwd: string) {
    const [cmd, ...pre] = bin;
    this.proc = spawn(cmd, [...pre, 'app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.proc.stdin?.on('error', () => undefined); // processo que já saiu: o 'close' explica o motivo
    this.tail = stderrTail(this.proc, 12);
    onJsonLines(this.proc, (msg) => this.dispatch(msg));
    this.proc.on('error', (err) => this.fail(new Error(`não consegui iniciar o codex: ${err.message}`)));
    this.proc.on('close', (code) => {
      const stderr = this.tail();
      this.fail(new Error(`o codex fechou (código ${code ?? '?'})${stderr ? `\n${stderr}` : ''}`));
    });
  }

  request(method: string, params: unknown): Promise<any> {
    if (this.closed) return Promise.reject(new Error('o codex já tinha fechado'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`o codex não respondeu a ${method} em ${RPC_TIMEOUT_MS / 1000}s`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.write({ method, params });
  }

  on(fn: Listener): void {
    this.listeners.add(fn);
  }
  off(fn: Listener): void {
    this.listeners.delete(fn);
  }
  onClose(fn: (why: Error) => void): void {
    this.closeHandlers.add(fn);
  }
  offClose(fn: (why: Error) => void): void {
    this.closeHandlers.delete(fn);
  }

  kill(): void {
    killTree(this.proc);
  }

  private write(msg: unknown): void {
    if (!this.closed) this.proc.stdin?.write(JSON.stringify(msg) + '\n');
  }

  private dispatch(msg: any): void {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined) {
      const handled = this.handleRequest?.(String(msg.method), msg.params ?? {});
      if (handled) {
        handled.then(
          (result) => this.write({ id: msg.id, result }),
          (e: unknown) => this.write({ id: msg.id, error: { code: -32603, message: String(e) } }),
        );
        return;
      }
      // Pedido do servidor. Com approvalPolicy "never" não deveria vir; se vier, recusa para o turno não travar.
      this.onServerRequest?.(String(msg.method));
      this.write({ id: msg.id, error: { code: -32601, message: 'o duo não responde a este pedido' } });
    } else if (typeof msg.method === 'string') {
      for (const fn of [...this.listeners]) fn(msg.method, msg.params ?? {});
    }
  }

  private fail(why: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(why);
    }
    this.pending.clear();
    for (const fn of [...this.closeHandlers]) fn(why);
    this.closeHandlers.clear();
    this.listeners.clear();
  }
}

function handleItem(item: any, texts: string[], emit: EmitFn): void {
  if (!item) return;
  switch (item.type) {
    case 'agentMessage':
      if (item.text?.trim()) {
        texts.push(item.text);
        emit({ kind: 'text', text: item.text });
      }
      break;
    case 'fileChange': {
      const files = (item.changes ?? []).map((c: any) => `${c.kind?.type ?? ''} ${c.path ?? ''}`.trim());
      emit({ kind: 'tool', text: truncate(`arquivos: ${files.join(', ') || '(alteração)'}`) });
      break;
    }
    case 'mcpToolCall':
      emit({ kind: 'tool', text: truncate(`mcp ${item.server ?? ''} ${item.tool ?? ''}`) });
      break;
    case 'webSearch':
      emit({ kind: 'tool', text: truncate(`busca na web: ${item.query ?? ''}`) });
      break;
    case 'commandExecution':
      if (typeof item.exitCode === 'number' && item.exitCode !== 0) {
        emit({ kind: 'tool', text: `  ↳ saiu com código ${item.exitCode}` });
      }
      break;
  }
}

/** Tira o invólucro "powershell.exe -Command '...'" que o Codex põe no Windows. */
export function shortenCommand(command: string): string {
  const m = command.match(/(?:-Command|\/c)\s+(['"])([\s\S]*)\1\s*$/);
  return truncate(m ? m[2] : command);
}
