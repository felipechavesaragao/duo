import spawn from 'cross-spawn';
import type { ChildProcess } from 'node:child_process';
import { killTree, onJsonLines, stderrTail } from './process.js';
import { createQueue, ResumeFailedError, truncate, type Agent, type EmitFn } from './types.js';

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
}

interface Turn {
  proc: ChildProcess;
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
 * Retomada que falha (medido em 02/11/2026, Claude Code 2.1.316): com um id inexistente ele manda
 * um `result` de erro SEM o `system/init`, escreve "No conversation found with session ID" no
 * stderr e sai sozinho ~1,4s depois, mesmo com o stdin aberto.
 */
export class ClaudeAgent implements Agent {
  readonly id = 'claude' as const;
  readonly name = 'Claude';
  onSessionId?: (id: string) => void;
  private run?: Running;
  private sessionId?: string;
  private turn?: Turn;
  private enqueue = createQueue();

  constructor(private readonly opts: ClaudeOptions) {
    this.sessionId = opts.resumeId;
  }

  get resumeId(): string | undefined {
    return this.sessionId;
  }

  send(prompt: string, emit: EmitFn): Promise<string> {
    return this.enqueue(
      () =>
        new Promise<string>((resolve, reject) => {
          const run = this.ensureProcess();
          this.turn = { proc: run.proc, emit, texts: [], resolve, reject };
          const line = JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } });
          run.proc.stdin?.write(line + '\n');
        }),
    );
  }

  reset(): void {
    this.stop();
    this.sessionId = undefined;
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
    const run: Running = { proc, resumedWith: this.sessionId, sawInit: false, tail: stderrTail(proc) };
    onJsonLines(proc, (msg) => this.handle(run, msg));
    proc.on('error', (err) => this.fail(run, new Error(`não consegui iniciar o claude: ${err.message}`)));
    proc.on('exit', (code) => this.onExit(run, code));
    this.run = run;
    return run;
  }

  private onExit(run: Running, code: number | null): void {
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
    if (msg.type === 'system' && msg.subtype === 'init') run.sawInit = true;
    const resumeFailed = msg.type === 'result' && msg.is_error && run.resumedWith !== undefined && !run.sawInit;

    if (typeof msg.session_id === 'string' && !resumeFailed && msg.session_id !== this.sessionId) {
      this.sessionId = msg.session_id;
      this.onSessionId?.(msg.session_id);
    }

    const turn = this.turn;
    if (!turn || turn.proc !== run.proc) return;

    if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) {
          turn.texts.push(block.text);
          turn.emit({ kind: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          turn.emit({ kind: 'tool', text: describeTool(block.name, block.input) });
        }
      }
      return;
    }

    if (msg.type === 'result') {
      if (resumeFailed) {
        // Pode ser "conversa não existe": quem decide é o stderr, quando o processo sair.
        turn.resumeError = typeof msg.result === 'string' && msg.result ? msg.result : String(msg.subtype);
        setTimeout(() => killTree(run.proc), 5000).unref(); // ele sai sozinho; se não sair, forçamos
        return;
      }
      for (const denial of msg.permission_denials ?? []) {
        turn.emit({
          kind: 'error',
          text: `permissão negada: ${describeTool(denial.tool_name, denial.tool_input)} (veja --claude-permission)`,
        });
      }
      if (msg.is_error) {
        this.settle(turn, new Error(typeof msg.result === 'string' && msg.result ? msg.result : String(msg.subtype)));
      } else {
        this.settle(turn, turn.texts.join('\n\n'));
      }
    }
  }
}

export function describeTool(name: string, input: any): string {
  const arg =
    input?.command ?? input?.file_path ?? input?.pattern ?? input?.url ?? input?.query ?? input?.description ?? '';
  return truncate(`${name}${arg ? ' ' + String(arg) : ''}`);
}
