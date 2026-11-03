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

/**
 * pending = na fila · running = enviado ao agente · done/failed = terminou · interrupted = o duo fechou no meio ·
 * cancelled = saiu da fila (ou foi cortado) por você: /novo
 */
export type TurnStatus = 'pending' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';

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

const AGENTS = ['claude', 'codex'] as const;
const STATUSES: TurnStatus[] = ['pending', 'running', 'done', 'failed', 'interrupted', 'cancelled'];
const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAgent = (v: unknown) => AGENTS.includes(v as AgentId);
/** campo opcional que, quando vem, é uma lista de agentes (`to`, `onlyFor`) */
const isAgentList = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(isAgent));
const optional = (v: unknown, type: string) => v === undefined || typeof v === type;

const isLogItem = (i: any) =>
  isObject(i) && (i.from === 'voce' || isAgent(i.from)) && typeof i.text === 'string' && isAgentList(i.to) && isAgentList(i.onlyFor);
const isTurn = (t: any) =>
  isObject(t) && Number.isInteger(t.id) && isAgent(t.agent) && typeof t.text === 'string' && STATUSES.includes(t.status);
const isScreenEntry = (e: any) =>
  isObject(e) &&
  ['claude', 'codex', 'voce', 'sistema'].includes(e.who) &&
  ['text', 'tool', 'error'].includes(e.kind) &&
  typeof e.text === 'string' &&
  typeof e.label === 'boolean';

/**
 * Confere a estrutura inteira, campo a campo do que a retomada usa: um JSON válido mas incompleto quebraria a
 * conversa mais tarde, no meio dela.
 */
function isSessionData(d: any): d is SessionData {
  if (!isObject(d) || d.version !== 1 || typeof d.id !== 'string' || typeof d.cwd !== 'string') return false;
  if (typeof d.shared !== 'boolean' || !['claude', 'codex', 'todos'].includes(d.target)) return false;
  if (!Number.isInteger(d.nextTurn) || !optional(d.claudeSessionId, 'string') || !optional(d.codexThreadId, 'string')) {
    return false;
  }
  const log = d.log;
  if (!isObject(log) || !Array.isArray(log.items) || !isObject(log.seen) || !isObject(log.introduced)) return false;
  if (!AGENTS.every((a) => Number.isInteger(log.seen[a]) && typeof log.introduced[a] === 'boolean')) return false;
  if (log.amnesia !== undefined && !(isObject(log.amnesia) && AGENTS.every((a) => optional(log.amnesia[a], 'boolean')))) {
    return false;
  }
  if (!log.items.every(isLogItem)) return false;
  return Array.isArray(d.turns) && d.turns.every(isTurn) && Array.isArray(d.screen) && d.screen.every(isScreenEntry);
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

  /**
   * Uma conversa, um duo: impede dois duos de escreverem na mesma conversa. Trava velha (o duo dono dela morreu)
   * só é tomada por quem criar primeiro o `.takeover` (criação exclusiva): dois duos que leram o mesmo pid morto
   * não saem os dois com a trava. Só quem criou o `.takeover` o apaga: um que sobrou de um duo morto no meio da
   * troca volta em `stuck`, para você apagar (apagar aqui correria o risco de levar o de outro duo que acabou
   * de criar o seu).
   */
  lock(id: string, retries = 2): { ok: true } | { ok: false; pid: number; stuck?: string } {
    const file = this.lockFile(id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (createExclusive(file)) return { ok: true };
    const pid = readPid(file);
    if (pid === undefined) return retries > 0 ? this.lock(id, retries - 1) : { ok: false, pid: 0 }; // o dono soltou agora
    if (pid && pid !== process.pid && isAlive(pid)) return { ok: false, pid };

    const takeover = `${file}.takeover`;
    if (!createExclusive(takeover)) {
      const owner = readPid(takeover);
      if (owner === undefined) return retries > 0 ? this.lock(id, retries - 1) : { ok: false, pid: 0 }; // terminou agora
      if (owner && isAlive(owner)) return { ok: false, pid: owner }; // outro duo está tomando a trava agora
      return { ok: false, pid: owner, stuck: takeover }; // sobrou de um duo que morreu no meio da troca
    }
    try {
      // relê: outro duo pode ter tomado a trava entre a leitura acima e o .takeover
      const now = readPid(file);
      if (now && now !== pid && now !== process.pid && isAlive(now)) return { ok: false, pid: now };
      fs.writeFileSync(file, String(process.pid));
      return { ok: true };
    } finally {
      tryUnlink(takeover);
    }
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

  /**
   * Grava agora. Conversa sem nenhuma mensagem não é gravada (não toma o lugar da anterior). Mensagem que chegou
   * pelo app (Remote Control) conta: ela entra no log sem virar turno do duo.
   */
  saveNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.store || (this.data.turns.length === 0 && this.data.log.items.length === 0)) return;
    if (this.data.screen.length > MAX_SCREEN) this.data.screen.splice(0, this.data.screen.length - MAX_SCREEN);
    if (this.data.turns.length > MAX_TURNS) {
      // os que ainda estão na fila ou rodando ficam: é por eles que a retomada avisa o que foi interrompido
      const cut = this.data.turns.length - MAX_TURNS;
      const active = this.data.turns.slice(0, cut).filter((t) => t.status === 'pending' || t.status === 'running');
      this.data.turns = [...active, ...this.data.turns.slice(cut)];
    }
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

/**
 * Cria o arquivo com o nosso pid só se ele não existir. false = já existia. O pid vai antes num arquivo nosso, que
 * vira o da trava num passo só (link exclusivo): quem a encontra nunca a vê vazia, sem dono. Sem link no disco
 * (FAT, por exemplo), cai na criação exclusiva direta: a trava existe vazia por um instante, e quem a lê nesse
 * instante espera o pid chegar (readPid).
 */
function createExclusive(file: string): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, String(process.pid));
    fs.linkSync(tmp, file);
    return true;
  } catch (err: any) {
    if (err?.code === 'EEXIST') return false;
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return true;
    } catch (err2: any) {
      if (err2?.code === 'EEXIST') return false;
      throw err2;
    }
  } finally {
    tryUnlink(tmp);
  }
}

/** Quanto esperar o pid de uma trava vazia antes de dá-la por abandonada. */
const EMPTY_LOCK_WAIT_MS = 2000;

/**
 * O pid gravado numa trava; undefined = o arquivo sumiu (o dono soltou). Vazia, espera o pid chegar: quem a criou
 * sem link (ou a está regravando ao tomá-la) ainda não o escreveu. Vazia até o fim da espera = o dono morreu nesse
 * instante (0).
 */
function readPid(file: string): number | undefined {
  const until = Date.now() + EMPTY_LOCK_WAIT_MS;
  for (;;) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8').trim();
    } catch (err: any) {
      if (err?.code === 'ENOENT') return undefined;
      throw err;
    }
    if (text || Date.now() >= until) return Number(text) || 0;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

function tryUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // já não existe
  }
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
