import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentId } from './agents/types.js';
import type { Target } from './router.js';
import { emptyLogState, type SharedLogState } from './shared.js';

export type Who = AgentId | 'voce' | 'sistema';

/** Uma linha da tela, do jeito que é gravada para reaparecer na retomada. */
export interface ScreenEntry {
  who: Who;
  kind: 'text' | 'tool' | 'error';
  text: string;
  /** mostra o nome de quem fala (só quando muda de quem falava antes) */
  label: boolean;
}

/** pending = na fila · running = enviado ao agente · done/failed = terminou · interrupted = o duo fechou no meio */
export type TurnStatus = 'pending' | 'running' | 'done' | 'failed' | 'interrupted';

export interface TurnRecord {
  id: number;
  agent: AgentId;
  text: string;
  status: TurnStatus;
}

/** Tudo o que o `duo -c` precisa para continuar uma conversa. */
export interface SessionData {
  version: 1;
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  /** session_id do Claude Code (para --resume) */
  claudeSessionId?: string;
  /** thread_id do Codex (para exec resume) */
  codexThreadId?: string;
  shared: boolean;
  target: Target;
  log: SharedLogState;
  turns: TurnRecord[];
  nextTurn: number;
  screen: ScreenEntry[];
}

const MAX_SCREEN = 300;
const MAX_TURNS = 300;

export function newSessionData(cwd: string): SessionData {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: randomUUID(),
    cwd: path.resolve(cwd),
    createdAt: now,
    updatedAt: now,
    shared: true,
    target: 'claude',
    log: emptyLogState(),
    turns: [],
    nextTurn: 1,
    screen: [],
  };
}

/**
 * Turnos que estavam na fila ou rodando quando o duo fechou viram `interrupted`.
 * Eles NÃO são reenviados: o agente pode já ter mexido em arquivos.
 */
export function markInterrupted(data: SessionData): TurnRecord[] {
  const lost: TurnRecord[] = [];
  for (const t of data.turns) {
    if (t.status === 'pending' || t.status === 'running') {
      t.status = 'interrupted';
      lost.push(t);
    }
  }
  return lost;
}

function isSessionData(d: any): d is SessionData {
  return (
    d &&
    d.version === 1 &&
    typeof d.id === 'string' &&
    typeof d.cwd === 'string' &&
    Array.isArray(d.turns) &&
    Array.isArray(d.screen) &&
    d.log &&
    Array.isArray(d.log.items)
  );
}

/**
 * Onde as conversas moram: `~/.duo/` (fora do projeto, para não sujar o repositório).
 *   sessions/<id>.json   uma conversa
 *   sessions/<id>.lock   pid do duo que está com ela aberta
 *   last/<pasta>.txt     id da última conversa daquela pasta (o que o `duo -c` abre)
 */
export class SessionStore {
  readonly root: string;

  constructor(root = process.env.DUO_HOME || path.join(os.homedir(), '.duo')) {
    this.root = root;
  }

  lastIdFor(cwd: string): string | undefined {
    try {
      const id = fs.readFileSync(this.pointerFile(cwd), 'utf8').trim();
      return /^[0-9a-f-]{36}$/i.test(id) ? id : undefined;
    } catch {
      return undefined;
    }
  }

  load(id: string): SessionData | undefined {
    try {
      const data = JSON.parse(fs.readFileSync(this.sessionFile(id), 'utf8'));
      return isSessionData(data) ? data : undefined;
    } catch {
      return undefined;
    }
  }

  save(data: SessionData): void {
    data.updatedAt = new Date().toISOString();
    writeAtomic(this.sessionFile(data.id), JSON.stringify(data));
    writeAtomic(this.pointerFile(data.cwd), data.id);
  }

  /** Uma conversa, um duo: impede dois duos de escreverem na mesma conversa. */
  lock(id: string): { ok: true } | { ok: false; pid: number } {
    const file = this.lockFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return { ok: true };
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (pid && pid !== process.pid && isAlive(pid)) return { ok: false, pid };
    fs.writeFileSync(file, String(process.pid)); // trava velha: o duo dono dela já morreu
    return { ok: true };
  }

  unlock(id: string): void {
    const file = this.lockFile(id);
    try {
      if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file);
    } catch {
      // já não existe
    }
  }

  private sessionFile(id: string) {
    return path.join(this.root, 'sessions', `${id}.json`);
  }
  private lockFile(id: string) {
    return path.join(this.root, 'sessions', `${id}.lock`);
  }
  private pointerFile(cwd: string) {
    return path.join(this.root, 'last', `${folderKey(cwd)}.txt`);
  }
}

/**
 * Grava a conversa em disco. Sem store, só guarda em memória (testes).
 * Gravações importantes são imediatas e síncronas, para sobreviver a um Ctrl+C logo em seguida.
 */
export class Recorder {
  onError?: (message: string) => void;
  private timer?: NodeJS.Timeout;
  private lastError?: string;

  constructor(
    public data: SessionData,
    private readonly store?: SessionStore,
  ) {}

  /** Grava agora. Conversa sem nenhuma mensagem não é gravada (não toma o lugar da anterior). */
  saveNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.store || this.data.turns.length === 0) return;
    if (this.data.screen.length > MAX_SCREEN) this.data.screen.splice(0, this.data.screen.length - MAX_SCREEN);
    if (this.data.turns.length > MAX_TURNS) this.data.turns.splice(0, this.data.turns.length - MAX_TURNS);
    try {
      this.store.save(this.data);
      this.lastError = undefined;
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (message !== this.lastError) this.onError?.(message);
      this.lastError = message;
    }
  }

  /** Para o que muda o tempo todo (linhas da tela): junta várias mudanças numa gravação. */
  saveSoon(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.saveNow(), 200);
    this.timer.unref?.();
  }

  /** /novo: grava a conversa atual, solta a trava dela e passa a gravar a nova. */
  switchTo(next: SessionData): void {
    this.saveNow();
    this.store?.unlock(this.data.id);
    this.data = next;
    this.store?.lock(next.id);
  }

  close(): void {
    this.saveNow();
    this.store?.unlock(this.data.id);
  }
}

function folderKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM'; // existe, só não é nosso
  }
}

/** Escreve num arquivo temporário e renomeia: uma gravação interrompida nunca deixa o arquivo pela metade. */
function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err: any) {
      // No Windows, antivírus/indexador às vezes segura o arquivo por um instante.
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          // ignora
        }
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
}
