import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { markInterrupted, newSessionData, Recorder, SessionStore } from '../src/persist.js';

const tmpStore = () => new SessionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'duo-test-')));
const filesIn = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
const lockHold = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'lock-hold.ts');

/** Espera parado (sem devolver o controle ao Node): é assim que este duo fica "no meio" de uma operação. */
function waitSync(done: () => boolean, ms: number): void {
  const until = Date.now() + ms;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!done()) {
    if (Date.now() > until) throw new Error('o outro duo não respondeu a tempo');
    Atomics.wait(cell, 0, 0, 20);
  }
}

describe('SessionStore', () => {
  it('grava, relê e aponta a última conversa da pasta', () => {
    const store = tmpStore();
    const data = newSessionData('/projeto/a');
    data.turns.push({ id: 1, agent: 'claude', text: 'oi', status: 'done' });
    data.claudeSessionId = 'sess-1';
    store.save(data);
    expect(store.lastIdFor('/projeto/a')).toBe(data.id);
    expect(store.lastIdFor('/projeto/b')).toBeUndefined();
    expect(store.load(data.id)).toMatchObject({ id: data.id, claudeSessionId: 'sess-1', turns: [{ text: 'oi' }] });
    // gravação atômica não deixa temporário para trás
    expect(filesIn(path.join(store.root, 'sessions')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('arquivo corrompido ou de outro formato: trata como inexistente', () => {
    const store = tmpStore();
    const data = newSessionData('/p');
    data.turns.push({ id: 1, agent: 'claude', text: 'x', status: 'done' });
    store.save(data);
    fs.writeFileSync(path.join(store.root, 'sessions', `${data.id}.json`), '{"version": 1, "id": ');
    expect(store.load(data.id)).toBeUndefined();
  });

  it('JSON válido mas incompleto também é inexistente: senão a retomada quebra no meio da conversa', () => {
    const store = tmpStore();
    const data = newSessionData('/p');
    data.turns.push({ id: 1, agent: 'claude', text: 'x', status: 'done' });
    store.save(data);
    expect(store.load(data.id)).toBeDefined();
    const file = path.join(store.root, 'sessions', `${data.id}.json`);
    const broken = (change: (d: any) => void) => {
      const d = JSON.parse(JSON.stringify(data));
      change(d);
      fs.writeFileSync(file, JSON.stringify(d));
      return store.load(data.id);
    };
    const item = { from: 'claude', to: ['codex'], text: 'oi', onlyFor: ['claude', 'codex'] };
    const entry = { who: 'claude', kind: 'text', text: 'oi', label: true };
    expect(broken((d) => ((d.log.items = [item]), (d.screen = [entry]), (d.log.amnesia = { codex: true })))).toBeDefined();
    expect(broken((d) => (d.log.items = [{ ...item, onlyFor: {} }]))).toBeUndefined(); // .includes quebraria
    expect(broken((d) => (d.log.items = [{ ...item, to: 'codex' }]))).toBeUndefined();
    expect(broken((d) => (d.log.items = [{ ...item, from: 'gpt' }]))).toBeUndefined();
    expect(broken((d) => (d.log.amnesia = []))).toBeUndefined();
    expect(broken((d) => delete d.turns[0].agent)).toBeUndefined();
    expect(broken((d) => (d.turns[0].status = 'talvez'))).toBeUndefined();
    expect(broken((d) => (d.screen = [{ ...entry, kind: undefined }]))).toBeUndefined();
    expect(broken((d) => (d.screen = [{ ...entry, images: ['a.png'] }]))).toBeDefined();
    expect(broken((d) => (d.screen = [{ ...entry, images: 'a.png' }]))).toBeUndefined();
    expect(broken((d) => (d.screen = [{ ...entry, images: [1] }]))).toBeUndefined();
    expect(broken((d) => (d.claudeSessionId = 42))).toBeUndefined();
    expect(broken((d) => delete d.log.seen)).toBeUndefined();
    expect(broken((d) => (d.log.introduced = { claude: true }))).toBeUndefined();
    expect(broken((d) => (d.target = 'gpt'))).toBeUndefined();
    expect(broken((d) => (d.log.items = [{ from: 'voce' }]))).toBeUndefined();
    expect(broken((d) => (d.turns = [null]))).toBeUndefined();
    expect(broken((d) => delete d.nextTurn)).toBeUndefined();
  });

  it('trava: recusa se outro duo vivo está com a conversa; assume trava de duo morto', () => {
    const store = tmpStore();
    const id = newSessionData('/p').id;
    const lockFile = path.join(store.root, 'sessions', `${id}.lock`);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });

    fs.writeFileSync(lockFile, String(process.ppid)); // processo vivo (quem rodou o vitest)
    expect(store.lock(id)).toEqual({ ok: false, pid: process.ppid });

    fs.writeFileSync(lockFile, '999999999'); // processo que não existe
    expect(store.lock(id)).toEqual({ ok: true });
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(String(process.pid));

    store.unlock(id);
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('trava velha: só um duo a toma; quem chega durante a troca recebe "ocupada"', () => {
    const store = tmpStore();
    const id = newSessionData('/p').id;
    const lockFile = path.join(store.root, 'sessions', `${id}.lock`);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });

    // outro duo vivo está no meio da troca (criou o .takeover): este não sai com a trava
    fs.writeFileSync(lockFile, '999999999');
    fs.writeFileSync(`${lockFile}.takeover`, String(process.ppid));
    expect(store.lock(id)).toEqual({ ok: false, pid: process.ppid });
    expect(fs.readFileSync(lockFile, 'utf8')).toBe('999999999');

    // o .takeover sobrou de um duo que morreu no meio da troca: ninguém o apaga (podia ser o de outro duo que
    // acabou de criar o seu); a trava volta em "stuck" para você apagar
    fs.writeFileSync(`${lockFile}.takeover`, '999999998');
    expect(store.lock(id)).toEqual({ ok: false, pid: 999999998, stuck: `${lockFile}.takeover` });
    expect(fs.readFileSync(`${lockFile}.takeover`, 'utf8')).toBe('999999998');
    expect(fs.readFileSync(lockFile, 'utf8')).toBe('999999999');

    // apagado por você: a trava velha é tomada, e o .takeover deste duo sai no fim
    fs.unlinkSync(`${lockFile}.takeover`);
    expect(store.lock(id)).toEqual({ ok: true });
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(String(process.pid));
    expect(fs.existsSync(`${lockFile}.takeover`)).toBe(false);
  });

  it('dois duos criando a trava ao mesmo tempo: quem chega no meio da criação não a vê vazia, e só um sai dono', () => {
    const store = tmpStore();
    const id = newSessionData('/p').id;
    const lockFile = path.join(store.root, 'sessions', `${id}.lock`);
    const out = path.join(store.root, 'outro.json');
    const theirs = () => {
      try {
        return JSON.parse(fs.readFileSync(out, 'utf8'));
      } catch {
        return undefined;
      }
    };
    const link = fs.linkSync;
    let other: ChildProcess | undefined;
    // este duo para no instante em que a trava passaria a existir; o outro (processo de verdade) chega e vai até o fim
    const spy = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      if (to === lockFile && !other) {
        other = spawn(process.execPath, ['--import', 'tsx', lockHold, store.root, id, out], { stdio: 'ignore' });
        waitSync(() => theirs() !== undefined, 15000);
      }
      link(from, to);
    });
    try {
      const mine = store.lock(id);
      expect(other).toBeDefined();
      expect(theirs()).toEqual({ ok: true, me: other!.pid });
      expect(mine).toEqual({ ok: false, pid: other!.pid });
      expect(fs.readFileSync(lockFile, 'utf8')).toBe(String(other!.pid));
      expect(filesIn(path.dirname(lockFile)).filter((f) => f.endsWith('.tmp'))).toEqual([]); // o deste duo saiu
    } finally {
      spy.mockRestore();
      other?.kill();
    }
  }, 20000);

  it('trava ainda vazia (disco sem link: o pid não chegou): espera o pid em vez de tomá-la; vazia de vez, toma', () => {
    const store = tmpStore();
    const id = newSessionData('/p').id;
    const lockFile = path.join(store.root, 'sessions', `${id}.lock`);
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });

    // outro duo criou a trava sem link e ainda vai gravar o pid (processo de verdade, vivo até o fim)
    fs.writeFileSync(lockFile, '');
    const code = `require('fs').writeFileSync(${JSON.stringify(lockFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
    const other = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
    try {
      expect(store.lock(id)).toEqual({ ok: false, pid: other.pid });
    } finally {
      other.kill();
    }

    // vazia até o fim da espera: o dono morreu naquele instante, e a trava é tomada
    fs.writeFileSync(lockFile, '');
    expect(store.lock(id)).toEqual({ ok: true });
    expect(fs.readFileSync(lockFile, 'utf8')).toBe(String(process.pid));
  }, 20000);
});

describe('Recorder', () => {
  it('conversa sem nenhuma mensagem não é gravada (não toma o lugar da anterior)', () => {
    const store = tmpStore();
    const anterior = newSessionData('/p');
    anterior.turns.push({ id: 1, agent: 'codex', text: 'antes', status: 'done' });
    store.save(anterior);

    const vazia = new Recorder(newSessionData('/p'), store);
    vazia.saveNow();
    expect(store.lastIdFor('/p')).toBe(anterior.id);

    vazia.data.turns.push({ id: 1, agent: 'claude', text: 'agora', status: 'pending' });
    vazia.saveNow();
    expect(store.lastIdFor('/p')).toBe(vazia.data.id);
  });

  it('conversa que só teve mensagens pelo app (Remote Control) é gravada', () => {
    const store = tmpStore();
    const rec = new Recorder(newSessionData('/p'), store);
    rec.data.log.items.push({ from: 'voce', to: ['claude'], text: 'oi pelo celular' });
    rec.data.claudeSessionId = 'sess-app';
    rec.saveNow();
    expect(store.lastIdFor('/p')).toBe(rec.data.id);
    expect(store.load(rec.data.id)).toMatchObject({ claudeSessionId: 'sess-app' });
  });

  it('o limite de turnos gravados não leva os que ainda estão rodando ou na fila', () => {
    const store = tmpStore();
    const rec = new Recorder(newSessionData('/p'), store);
    rec.data.turns.push({ id: 1, agent: 'claude', text: 'ainda rodando', status: 'running' });
    rec.data.turns.push({ id: 2, agent: 'claude', text: 'na fila', status: 'pending' });
    for (let i = 3; i <= 302; i++) rec.data.turns.push({ id: i, agent: 'codex', text: `t${i}`, status: 'done' });
    rec.data.turns.push({ id: 303, agent: 'codex', text: 'feito há muito', status: 'done' });
    rec.data.turns.splice(2, 0, { id: 0, agent: 'codex', text: 'velho e terminado', status: 'done' });
    rec.saveNow();
    const saved = store.load(rec.data.id)!;
    expect(saved.turns).toHaveLength(302); // 300 + os 2 ativos
    expect(saved.turns.slice(0, 2).map((t) => t.text)).toEqual(['ainda rodando', 'na fila']);
    expect(saved.turns.map((t) => t.text)).not.toContain('velho e terminado');
    expect(markInterrupted(saved).map((t) => t.id)).toEqual([1, 2]);
  });
});

describe('markInterrupted', () => {
  it('turno na fila ou rodando vira interrompido; os terminados ficam como estão', () => {
    const data = newSessionData('/p');
    data.turns.push(
      { id: 1, agent: 'claude', text: 'a', status: 'done' },
      { id: 2, agent: 'codex', text: 'b', status: 'running' },
      { id: 3, agent: 'claude', text: 'c', status: 'pending' },
      { id: 4, agent: 'codex', text: 'd', status: 'failed' },
    );
    expect(markInterrupted(data).map((t) => t.id)).toEqual([2, 3]);
    expect(data.turns.map((t) => t.status)).toEqual(['done', 'interrupted', 'interrupted', 'failed']);
  });
});
