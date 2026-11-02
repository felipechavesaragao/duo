import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { markInterrupted, newSessionData, Recorder, SessionStore } from '../src/persist.js';

const tmpStore = () => new SessionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'duo-test-')));
const filesIn = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

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
