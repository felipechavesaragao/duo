import { spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

/** O arquivo relativo à pasta do projeto, quando está dentro dela; fora dela, o caminho como veio. */
export function relPath(cwd: string, file: string): string {
  if (!path.isAbsolute(file)) return file;
  const rel = path.relative(cwd, file);
  const outside = rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel); // absoluto: outro disco
  return rel && !outside ? rel : file;
}

/** Prazo do taskkill: a tela trava enquanto ele roda (é síncrono, para valer também no 'exit' do duo). */
const TASKKILL_TIMEOUT_MS = 5000;

/**
 * Mata o processo e seus filhos (no Windows, o codex roda via .cmd → node). Se o taskkill falhar ou estourar o
 * prazo, mata ao menos o processo direto: os filhos dele podem sobrar, mas o duo não segue falando com ele.
 */
export function killTree(proc: ChildProcess | undefined): void {
  if (!proc || proc.exitCode !== null || proc.pid === undefined) return;
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: TASKKILL_TIMEOUT_MS,
      windowsHide: true,
    });
    if (r.error || r.status !== 0) proc.kill();
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
