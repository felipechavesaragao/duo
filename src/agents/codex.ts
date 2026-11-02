import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { killTree, onJsonLines, stderrTail } from './process.js';
import { createQueue, ResumeFailedError, truncate, type Agent, type EmitFn } from './types.js';

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
 */
export class CodexAgent implements Agent {
  readonly id = 'codex' as const;
  readonly name = 'Codex';
  onSessionId?: (id: string) => void;
  private threadId?: string;
  private conn?: Connection;
  /** a conversa já foi aberta (thread/start ou thread/resume) no processo atual */
  private opened = false;
  private enqueue = createQueue();

  constructor(private readonly opts: CodexOptions) {
    this.threadId = opts.resumeId;
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
    });
    this.conn = conn;
    await conn.request('initialize', { clientInfo: { name: 'duo', title: 'duo', version: '0.1.0' } });
    conn.notify('initialized');
    return conn;
  }

  private async openThread(conn: Connection): Promise<string> {
    if (this.opened && this.threadId) return this.threadId;
    const resumedWith = this.threadId;
    let result: any;
    try {
      result = resumedWith
        ? await conn.request('thread/resume', { threadId: resumedWith, excludeTurns: true, ...this.threadParams() })
        : await conn.request('thread/start', this.threadParams());
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
    this.opened = true;
    return id;
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
  /** chamado quando o servidor pede algo ao cliente (aprovação, pergunta): o duo recusa */
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
