import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  closeOpenSteps,
  markInterrupted,
  newSessionData,
  Recorder,
  SessionStore,
  trimScreen,
  type ScreenEntry,
} from '../src/persist.js';

/** Uma linha de passo e a do fim dele, como os adaptadores mandam. */
const stepLine = (id: string, who: 'claude' | 'codex' = 'claude'): ScreenEntry => ({
  who,
  kind: 'tool',
  text: `$ ${id}`,
  label: false,
  step: { id, full: `$ ${id}` },
});
const endLine = (of: string, who: 'claude' | 'codex' = 'claude'): ScreenEntry => ({
  who,
  kind: 'tool',
  text: '  ↳ ok',
  label: false,
  result: { of, ok: true },
});

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
    // o passo e o fim dele voltam na retomada; o que não tem a forma deles não passa
    const tool = { who: 'claude', kind: 'tool', text: '$ npm test', label: true };
    const end = { of: 's1', ok: false, exitCode: 3, note: 'x', files: [{ path: 'a.ts', change: 'criado' }] };
    const steps = [{ ...tool, step: { id: 's1', full: '$ npm test --run' } }, { ...tool, label: false, result: end }];
    expect(broken((d) => (d.screen = steps))).toBeDefined();
    expect(store.load(data.id)!.screen).toEqual(steps);
    expect(broken((d) => (d.screen = [{ ...tool, step: { id: 1, full: 'x' } }]))).toBeUndefined();
    expect(broken((d) => (d.screen = [{ ...tool, step: { id: 's1' } }]))).toBeUndefined();
    expect(broken((d) => (d.screen = [{ ...tool, result: { ...end, ok: 'sim' } }]))).toBeUndefined();
    expect(broken((d) => (d.screen = [{ ...tool, result: { ...end, exitCode: '3' } }]))).toBeUndefined();
    expect(broken((d) => (d.screen = [{ ...tool, result: { ...end, files: [{ path: 'a.ts', change: 'mexido' }] } }]))).toBeUndefined();
    expect(broken((d) => (d.screen = [{ ...entry, step: { id: 's1', full: 'x' } }]))).toBeUndefined(); // só linha de ação
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

  it('o limite da tela gravada não deixa o fim de um passo sem o passo dele', () => {
    const store = tmpStore();
    const rec = new Recorder(newSessionData('/p'), store);
    rec.data.turns.push({ id: 1, agent: 'claude', text: 'oi', status: 'done' });
    for (let i = 0; i < 150; i++) rec.data.screen.push(stepLine(`s${i}`), endLine(`s${i}`));
    rec.data.screen.push({ who: 'claude', kind: 'text', text: 'fim', label: false }); // 301: o corte leva o passo s0
    rec.saveNow();
    const screen = store.load(rec.data.id)!.screen;
    expect(screen[0].step?.id).toBe('s1'); // o fim do s0 saiu junto
    expect(screen).toHaveLength(299);
    const steps = new Set(screen.flatMap((e) => (e.step ? [e.step.id] : [])));
    expect(screen.every((e) => !e.result || steps.has(e.result.of))).toBe(true);
  });

  it('o passo que saiu num corte de antes: o fim que chega depois também não fica', () => {
    const store = tmpStore();
    const rec = new Recorder(newSessionData('/p'), store);
    const text: ScreenEntry = { who: 'claude', kind: 'text', text: 'linha', label: false };
    rec.data.turns.push({ id: 1, agent: 'claude', text: 'oi', status: 'done' });
    rec.data.screen.push(stepLine('a'), stepLine('b'), ...Array.from({ length: 299 }, () => ({ ...text })));
    rec.saveNow(); // 300: sai o passo a
    rec.data.screen.push(endLine('a'));
    rec.saveNow(); // 301: sai o passo b, e o fim do a
    rec.data.screen.push(endLine('b'));
    rec.saveNow(); // 300, sem corte: o fim do b, que saiu antes, também sai
    expect(store.load(rec.data.id)!.screen.filter((e) => e.step || e.result)).toEqual([]);
  });

  it('a linha que sai no corte levava o nome de quem fala: o nome passa para a próxima', () => {
    const fail: ScreenEntry = { ...endLine('c'), label: true, result: { of: 'c', ok: false, exitCode: 1 } };
    const screen: ScreenEntry[] = [
      stepLine('c'), // sai no corte
      { who: 'codex', kind: 'text', text: 'enquanto isso', label: true },
      fail, // o Claude volta a falar: o fim do c levava o nome
      { who: 'claude', kind: 'text', text: 'falhou', label: false },
    ];
    expect(trimScreen(screen, 3).map((e) => [e.text, e.label])).toEqual([
      ['enquanto isso', true],
      ['falhou', true],
    ]);
  });

  it('o nome é refeito mesmo quando nada sai: a linha que o decidia pode ter saído numa gravação de antes', () => {
    // o fim que levava o nome do Claude saiu antes; o texto dele chegou depois, sem nome, atrás do Codex
    const screen: ScreenEntry[] = [
      { who: 'codex', kind: 'text', text: 'enquanto isso', label: true },
      { who: 'claude', kind: 'text', text: 'falhou', label: false },
    ];
    expect(trimScreen(screen).map((e) => e.label)).toEqual([true, true]);
    const right = trimScreen(screen);
    expect(trimScreen(right)).toBe(right); // nada mudou: a mesma lista
  });
});

describe('closeOpenSteps', () => {
  it('na retomada, o passo que o duo deixou aberto ganha "não terminou" logo depois dele', () => {
    const screen: ScreenEntry[] = [
      stepLine('a'),
      endLine('a'),
      stepLine('b'), // aberto
      { who: 'codex', kind: 'text', text: 'outro falando', label: true },
      stepLine('d', 'codex'), // aberto: outro passo com o mesmo id veio depois
      stepLine('d', 'codex'),
      endLine('d', 'codex'),
      stepLine('c', 'codex'), // aberto, no fim
    ];
    expect(closeOpenSteps(screen)).toBe(3);
    const unfinished = { kind: 'tool', text: '  ↳ não terminou', label: false };
    expect(screen.map((e) => e.step?.id ?? (e.result ? `fim ${e.result.of}` : e.text))).toEqual([
      'a', 'fim a', 'b', 'fim b', 'outro falando', 'd', 'fim d', 'd', 'fim d', 'c', 'fim c',
    ]);
    expect(screen[3]).toEqual({ who: 'claude', ...unfinished, result: { of: 'b', ok: false, note: 'não terminou' } });
    expect(screen[6]).toEqual({ who: 'codex', ...unfinished, result: { of: 'd', ok: false, note: 'não terminou' } });
    expect(screen[10]).toEqual({ who: 'codex', ...unfinished, result: { of: 'c', ok: false, note: 'não terminou' } });
    expect(closeOpenSteps(screen)).toBe(0); // nada mais aberto
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
