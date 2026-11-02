import { spawnSync, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';

/** Mata o processo e seus filhos (no Windows, o codex roda via .cmd → node). */
export function killTree(proc: ChildProcess | undefined): void {
  if (!proc || proc.exitCode !== null || proc.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    proc.kill('SIGTERM');
  }
}

/** Lê stdout linha a linha e entrega cada linha que for JSON válido. */
export function onJsonLines(proc: ChildProcess, handler: (msg: any) => void): void {
  if (!proc.stdout) return;
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    handler(msg);
  });
}

/** Guarda as últimas linhas de stderr para explicar uma falha. */
export function stderrTail(proc: ChildProcess, maxLines = 6): () => string {
  const lines: string[] = [];
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => {
    for (const l of chunk.split(/\r?\n/)) {
      if (l.trim()) lines.push(l.trim());
    }
    while (lines.length > maxLines) lines.shift();
  });
  return () => lines.join('\n');
}
