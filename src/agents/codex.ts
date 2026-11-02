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

/**
 * Codex em modo não interativo documentado:
 *   codex exec --json -                 (primeira mensagem)
 *   codex exec --json resume <id> -     (as seguintes, mesma conversa)
 * Cada mensagem é um processo; o prompt vai pelo stdin e os eventos saem em JSONL.
 *
 * Medido em 02/11/2026 (codex-cli 0.166.0):
 * - o resume GRAVA o turno novo (3 turnos, cada um um processo: o 3º lembrou o fato dito só no 2º);
 * - id inexistente: nada no stdout, sai com 1, stderr "no rollout found for thread id".
 */
export class CodexAgent implements Agent {
  readonly id = 'codex' as const;
  readonly name = 'Codex';
  onSessionId?: (id: string) => void;
  private threadId?: string;
  private current?: ChildProcess;
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
    killTree(this.current);
    this.threadId = undefined;
  }

  dispose(): void {
    killTree(this.current);
  }

  buildArgs(): string[] {
    const args = ['exec', '--json', '--skip-git-repo-check'];
    if (this.opts.sandbox) args.push('--sandbox', this.opts.sandbox);
    else args.push('--dangerously-bypass-approvals-and-sandbox');
    if (this.opts.model) args.push('--model', this.opts.model);
    if (this.threadId) args.push('resume', this.threadId);
    args.push('-');
    return args;
  }

  private runTurn(prompt: string, emit: EmitFn): Promise<string> {
    return new Promise((resolve, reject) => {
      const resumedWith = this.threadId;
      const [cmd, ...pre] = this.opts.bin ?? ['codex'];
      const proc = spawn(cmd, [...pre, ...this.buildArgs()], {
        cwd: this.opts.cwd ?? process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
      proc.stdin?.on('error', () => undefined); // processo que já saiu: o 'close' explica o motivo
      this.current = proc;
      const tail = stderrTail(proc, 12);
      const texts: string[] = [];
      let failure: string | undefined;
      let sawThread = false;
      let completed = false;

      onJsonLines(proc, (msg) => {
        switch (msg.type) {
          case 'thread.started':
            sawThread = true;
            if (typeof msg.thread_id === 'string' && msg.thread_id !== this.threadId) {
              this.threadId = msg.thread_id;
              this.onSessionId?.(msg.thread_id);
            }
            break;
          case 'turn.completed':
            completed = true;
            break;
          case 'item.started':
            if (msg.item?.type === 'command_execution') {
              emit({ kind: 'tool', text: `$ ${shortenCommand(msg.item.command ?? '')}` });
            }
            break;
          case 'item.completed':
            handleItem(msg.item, texts, emit);
            break;
          case 'turn.failed':
            failure = msg.error?.message ?? 'o turno falhou';
            break;
          case 'error':
            failure = msg.message ?? 'erro do codex';
            break;
        }
      });

      proc.on('error', (err) => reject(new Error(`não consegui iniciar o codex: ${err.message}`)));
      proc.on('close', (code) => {
        if (this.current === proc) this.current = undefined;
        const stderr = tail();
        if (resumedWith && !sawThread && /no rollout found/i.test(stderr)) {
          if (this.threadId === resumedWith) this.threadId = undefined;
          return reject(new ResumeFailedError(`a conversa ${resumedWith} não existe mais no Codex`));
        }
        if (/active writer/i.test(stderr)) {
          return reject(new Error('a conversa do Codex está aberta em outro lugar (outro terminal?). Feche lá e mande de novo.'));
        }
        if (failure) return reject(new Error(failure));
        // Só é sucesso com turn.completed E saída 0: ter escrito algum texto não basta.
        if (!completed || code !== 0) {
          return reject(new Error(`o codex encerrou sem concluir o turno (código ${code ?? '?'})${stderr ? `\n${stderr}` : ''}`));
        }
        resolve(texts.join('\n\n'));
      });

      proc.stdin?.end(prompt);
    });
  }
}

function handleItem(item: any, texts: string[], emit: EmitFn): void {
  if (!item) return;
  switch (item.type) {
    case 'agent_message':
      if (item.text?.trim()) {
        texts.push(item.text);
        emit({ kind: 'text', text: item.text });
      }
      break;
    case 'file_change': {
      const files = (item.changes ?? []).map((c: any) => `${c.kind ?? ''} ${c.path ?? ''}`.trim());
      emit({ kind: 'tool', text: truncate(`arquivos: ${files.join(', ') || '(alteração)'}`) });
      break;
    }
    case 'mcp_tool_call':
      emit({ kind: 'tool', text: truncate(`mcp ${item.server ?? ''} ${item.tool ?? ''}`) });
      break;
    case 'web_search':
      emit({ kind: 'tool', text: truncate(`busca na web: ${item.query ?? ''}`) });
      break;
    case 'command_execution':
      if (item.exit_code !== 0 && item.exit_code !== null && item.exit_code !== undefined) {
        emit({ kind: 'tool', text: `  ↳ saiu com código ${item.exit_code}` });
      }
      break;
    case 'error':
      // Aviso de recurso experimental ligado no config.toml: só ruído.
      if (!/Under-development features/i.test(item.message ?? '')) {
        emit({ kind: 'error', text: truncate(item.message ?? 'erro', 300) });
      }
      break;
  }
}

/** Tira o invólucro "powershell.exe -Command '...'" que o Codex põe no Windows. */
export function shortenCommand(command: string): string {
  const m = command.match(/(?:-Command|\/c)\s+(['"])([\s\S]*)\1\s*$/);
  return truncate(m ? m[2] : command);
}
