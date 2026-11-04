import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentCommand, AgentId, AgentModel, AgentStats, EmitFn } from '../src/agents/types.js';
import {
  DIFF_LINES,
  DIFF_TOTAL,
  describeChanges,
  FAILED,
  gitChanges,
  MAX_FILES,
  NEW_FILE_MAX,
  type ChangeWatcher,
  type Fingerprints,
  type WorktreeChanges,
} from '../src/changes.js';
import { Duo } from '../src/core.js';
import { CHANGES_CAVEAT, countText } from '../src/display.js';
import { newSessionData, Recorder, SessionStore } from '../src/persist.js';

/**
 * O git do duo passa por aqui: `before` vê cada chamada (os argumentos e a pasta) antes de ela rodar, e pode mexer nos
 * arquivos nesse meio (o agente editando no meio da medida), devolver true para ela falhar, ou devolver um texto para
 * ser a saída dela (o git de mentira).
 */
const gitHook = vi.hoisted(() => ({
  before: undefined as undefined | ((args: string[], cwd: string) => boolean | string | void),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const execFile = (file: string, args: string[], opts: { cwd: string }, cb: (err: Error | null, out: string) => void) => {
    const hooked = gitHook.before?.(args, opts.cwd);
    if (hooked === true) {
      setImmediate(() => cb(new Error('o git falhou (de propósito)'), ''));
      return undefined;
    }
    if (typeof hooked === 'string') {
      setImmediate(() => cb(null, hooked));
      return undefined;
    }
    return real.execFile(file, args, opts as never, cb as never);
  };
  return { ...real, execFile };
});
/** A abertura de arquivo do duo passa por aqui: `before` pode mexer no arquivo entre a olhada (lstat) e a abertura. */
const openHook = vi.hoisted(() => ({ before: undefined as undefined | ((file: string) => void) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const open = (file: string, ...rest: unknown[]) => {
    openHook.before?.(String(file));
    return (real.open as (...args: unknown[]) => unknown)(file, ...rest);
  };
  return { ...real, open, default: { ...real, open } };
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const write = (file: string, text: string | Buffer) => fs.writeFileSync(file, text);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let repo: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-mudou-'));
  repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'teste@exemplo.invalid');
  git(repo, 'config', 'user.name', 'Teste');
  git(repo, 'config', 'core.autocrlf', 'false');
  write(path.join(repo, 'a.txt'), 'um\ndois\ntrês\n');
  write(path.join(repo, 'b.txt'), 'apagar\n');
  write(path.join(repo, 'velho.txt'), 'linha 1\nlinha 2\nlinha 3\nlinha 4\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'começo');
});

afterEach(() => {
  gitHook.before = undefined;
  openHook.before = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** a pasta de um worktree como o git informa (a chave da marca), pelo último nome */
const keyOf = (marks: Fingerprints, name: string) => [...marks.keys()].find((k) => path.basename(k) === name)!;

// o git de verdade, um processo por pergunta: no Windows cada um leva uma fração de segundo
describe('o que mudou de fato (git)', { timeout: 30_000 }, () => {
  it('num worktree de branch: alterado, apagado, renomeado e novo (inclusive o que o git não rastreia), desde a main', async () => {
    const watcher = gitChanges(repo);
    const before = await watcher.fingerprints();
    expect(before.size).toBe(1);
    expect((await watcher.changedSince(before)).changes).toEqual([]); // nada mudou: nenhum quadro

    const wt = path.join(dir, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt, 'main');
    // a main anda depois que a branch saiu: isso não é mudança da branch, e a main limpa não ganha quadro
    write(path.join(repo, 'na-main.txt'), 'da main\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'a main anda');

    write(path.join(wt, 'a.txt'), 'um\nDOIS\ntrês\nquatro\n');
    git(wt, 'commit', '-q', '-am', 'o que já foi commitado na branch também conta');
    fs.rmSync(path.join(wt, 'b.txt'));
    git(wt, 'mv', 'velho.txt', 'novo-nome.txt');
    write(path.join(wt, 'n.txt'), 'primeira\nsegunda\n');
    write(path.join(wt, 'img.bin'), Buffer.from([0, 1, 2, 0]));

    const { changes: found, now } = await watcher.changedSince(before);
    expect(now.size).toBe(2); // a principal e o worktree: a medida de agora, para quem começar depois
    expect(found).toHaveLength(1);
    const [c] = found;
    expect(c.branch).toBe('feat/x');
    expect(c.base).toBe('main');
    expect(c.more).toBe(0);
    expect(c.files.map((f) => [f.status, f.path, f.from, countText(f)])).toEqual([
      ['alterado', 'a.txt', undefined, '+2 −1'],
      ['apagado', 'b.txt', undefined, '−1'],
      ['novo', 'img.bin', undefined, 'binário'],
      ['novo', 'n.txt', undefined, '+2'],
      ['renomeado', 'novo-nome.txt', 'velho.txt', ''],
    ]);
    const file = Object.fromEntries(c.files.map((f) => [f.path, f]));
    expect(file['a.txt'].diff).toContain('-dois\n+DOIS');
    expect(file['n.txt'].diff).toBe('--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+primeira\n+segunda');
    expect(file['img.bin'].diff).toBeUndefined();

    const text = describeChanges(c, 'Claude', repo).split('\n');
    expect(text[0]).toBe(
      `O que mudou enquanto o Claude trabalhava, na branch feat/x (na pasta ${c.root}), desde a main: 5 arquivos, +4 −2`,
    );
    expect(text).toContain('  renomeado  velho.txt → novo-nome.txt');
    expect(text.at(-1)).toBe(CHANGES_CAVEAT);
  });

  it('na pasta principal, na própria main: o que ainda não foi commitado', async () => {
    const watcher = gitChanges(repo);
    const before = await watcher.fingerprints();
    write(path.join(repo, 'a.txt'), 'um\ndois\n');
    const [c] = (await watcher.changedSince(before)).changes;
    expect(c.base).toBe('HEAD');
    expect(describeChanges(c, 'Codex', repo).split('\n')[0]).toBe(
      'O que mudou enquanto o Codex trabalhava, na branch main (nesta pasta), desde o último commit: 1 arquivo, −1',
    );
  });

  it('binário rastreado, novo já adicionado ao git, novo grande demais, link para fora do projeto (que não é lido) e repositório dentro do projeto', async () => {
    write(path.join(repo, 'foto.bin'), Buffer.from([0, 1, 2, 3]));
    git(repo, 'add', 'foto.bin');
    git(repo, 'commit', '-q', '-m', 'um binário');
    const watcher = gitChanges(repo);
    const before = await watcher.fingerprints();

    write(path.join(repo, 'foto.bin'), Buffer.from([0, 9, 9, 9]));
    write(path.join(repo, 'rastreado.txt'), 'um\ndois\n');
    git(repo, 'add', 'rastreado.txt');
    write(path.join(repo, 'grande.txt'), 'x'.repeat(NEW_FILE_MAX + 1));
    const outside = path.join(dir, 'segredo.txt');
    write(outside, 'SEGREDO de fora do projeto\n');
    fs.symlinkSync(outside, path.join(repo, 'link.txt'), 'file');
    // um repositório dentro do projeto (o agente clonou algo): o git lista a pasta, não os arquivos dela
    fs.mkdirSync(path.join(repo, 'sub'));
    git(path.join(repo, 'sub'), 'init', '-q');

    const [c] = (await watcher.changedSince(before)).changes;
    expect(c.files.map((f) => [f.status, f.path, countText(f), f.diff === undefined])).toEqual([
      ['alterado', 'foto.bin', 'binário', true],
      ['novo', 'grande.txt', 'grande demais', true],
      ['novo', 'link.txt', 'link', true],
      ['novo', 'rastreado.txt', '+2', false],
      ['novo', 'sub/', 'não é um arquivo comum', true],
    ]);
    expect(c.files.find((f) => f.path === 'rastreado.txt')!.diff).toContain('new file mode');
    expect(JSON.stringify(c)).not.toContain('SEGREDO'); // nem na janela, nem na conversa gravada
  });

  it('a marca muda quando o conteúdo muda, mesmo com a mesma contagem de linhas', async () => {
    const watcher = gitChanges(repo);
    write(path.join(repo, 'a.txt'), 'um\nX\ntrês\n');
    const mid = await watcher.fingerprints();
    write(path.join(repo, 'a.txt'), 'um\nY\ntrês\n'); // continua +1 −1
    const [c] = (await watcher.changedSince(mid)).changes;
    expect(c.files[0].diff).toContain('+Y');
    expect((await watcher.changedSince(await watcher.fingerprints())).changes).toEqual([]);
  });

  it('voltar a ficar igual à base também aparece: o quadro diz que não há diferença agora', async () => {
    write(path.join(repo, 'a.txt'), 'mudado\n');
    write(path.join(repo, 'n.txt'), 'novo\n');
    const watcher = gitChanges(repo);
    const before = await watcher.fingerprints();
    git(repo, 'checkout', '--', 'a.txt');
    fs.rmSync(path.join(repo, 'n.txt'));
    const { changes, now } = await watcher.changedSince(before);
    expect(changes).toHaveLength(1);
    expect(changes[0].files).toEqual([]);
    expect(describeChanges(changes[0], 'Claude', repo).split('\n')).toEqual([
      'O que mudou enquanto o Claude trabalhava, na branch main (nesta pasta), desde o último commit: nenhuma diferença agora',
      CHANGES_CAVEAT,
    ]);
    expect((await watcher.changedSince(now)).changes).toEqual([]); // limpo e continua limpo: nada
  });

  it('a lista, a contagem e a diferença de cada worktree vêm de uma chamada só do git (do mesmo momento)', async () => {
    const watcher = gitChanges(repo);
    const before = await watcher.fingerprints();
    write(path.join(repo, 'a.txt'), 'um\nX\ntrês\n');
    const calls: string[][] = [];
    gitHook.before = (args) => {
      calls.push(args);
    };
    const [c] = (await watcher.changedSince(before)).changes;
    const diffs = calls.filter((args) => args.includes('diff'));
    expect(diffs).toHaveLength(1); // a medida; a lista do quadro sai dela, sem outro git
    expect(diffs[0]).toEqual(expect.arrayContaining(['--raw', '--numstat', '-p']));
    expect(c.files.map((f) => [f.path, countText(f)])).toEqual([['a.txt', '+1 −1']]);
    expect(c.files[0].diff).toContain('-dois\n+X');
  });

  it('a configuração de diff do repositório (sem prefixo, com cor) não tira a diferença', async () => {
    git(repo, 'config', 'diff.noprefix', 'true');
    git(repo, 'config', 'color.ui', 'always');
    write(path.join(repo, 'a.txt'), 'um\nmudou\ntrês\n');
    const [c] = (await gitChanges(repo).changedSince(new Map())).changes;
    expect(c.files[0].diff).toContain('diff --git a/a.txt b/a.txt');
    expect(c.files[0].diff).toContain('-dois\n+mudou');
    expect(c.files[0].diff).not.toContain('\u001b'); // sem código de cor
  });

  it('o git falhando num worktree (inclusive ao achar a base): fica a marca de antes, e nada aparece de mentira', async () => {
    const wt = path.join(dir, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt, 'main');
    write(path.join(wt, 'a.txt'), 'commitado na branch\n');
    git(wt, 'commit', '-q', '-am', 'na branch');
    write(path.join(wt, 'b.txt'), 'e um pendente\n');
    const watcher = gitChanges(repo);
    const before = await watcher.fingerprints();
    const wtKey = keyOf(before, 'wt');
    const inWt = (cwd: string) => path.basename(cwd) === 'wt';

    // a medida falha no diff, no merge-base (a base) ou no rev-parse do HEAD: sem quadro, e fica a marca de antes
    // (falhar não é "não tem": a base não vira o último commit nem "o começo")
    for (const failing of ['diff', 'merge-base', 'rev-parse']) {
      gitHook.before = (args, cwd) => inWt(cwd) && args.includes(failing);
      const failed = await watcher.changedSince(before);
      expect(failed.changes, failing).toEqual([]);
      expect(failed.now.get(wtKey), failing).toBe(before.get(wtKey));
    }
    // voltou, sem ninguém ter editado: nenhum quadro
    gitHook.before = undefined;
    const back = await watcher.changedSince(before);
    expect(back.changes).toEqual([]);
    expect(back.now.get(wtKey)).toBe(before.get(wtKey));

    // a primeira medida falhou nele: não se sabe como estava, então a próxima não vira quadro
    gitHook.before = (args, cwd) => inWt(cwd) && args.includes('diff');
    const unknown = await watcher.fingerprints();
    expect(unknown.get(wtKey)).toBe(FAILED);
    gitHook.before = undefined;
    write(path.join(wt, 'a.txt'), 'e de novo\n');
    expect((await watcher.changedSince(unknown)).changes).toEqual([]);

    // nem a lista dos worktrees, ou a branch principal, veio: rejeita (o duo continua com a medida que tinha)
    for (const failing of ['worktree', 'refs/remotes/origin/HEAD', 'refs/heads/main']) {
      gitHook.before = (args) => args.includes(failing);
      await expect(watcher.changedSince(before), failing).rejects.toThrow();
      await expect(watcher.fingerprints(), failing).rejects.toThrow();
    }
  });

  it('o arquivo novo trocado por um link (ele ou a pasta dele), ou que cresce, entre a olhada e a leitura: não é lido', async () => {
    const watcher = gitChanges(repo);
    const before = await watcher.fingerprints();
    const swapped = path.join(repo, 'troca.txt');
    const growing = path.join(repo, 'cresce.txt');
    const folder = path.join(repo, 'sub');
    write(swapped, 'comum\n');
    write(growing, 'pequeno\n');
    fs.mkdirSync(folder);
    write(path.join(folder, 'dentro.txt'), 'de dentro\n');
    const outside = path.join(dir, 'segredo.txt');
    write(outside, 'SEGREDO de fora do projeto\n');
    const outsideFolder = path.join(dir, 'fora');
    fs.mkdirSync(outsideFolder);
    write(path.join(outsideFolder, 'dentro.txt'), 'SEGREDO da pasta de fora\n');
    openHook.before = (file) => {
      if (path.basename(file) === 'troca.txt') {
        fs.rmSync(swapped);
        fs.symlinkSync(outside, swapped, 'file');
      } else if (path.basename(file) === 'cresce.txt') {
        fs.appendFileSync(growing, 'x'.repeat(NEW_FILE_MAX));
      } else if (path.basename(file) === 'dentro.txt') {
        // a pasta do caminho vira um link (junction, no Windows) para uma pasta de fora com um arquivo de mesmo nome
        fs.renameSync(folder, path.join(repo, 'sub-de-verdade'));
        fs.symlinkSync(outsideFolder, folder, 'junction');
      }
    };
    const [c] = (await watcher.changedSince(before)).changes;
    expect(c.files.map((f) => [f.path, countText(f), f.diff])).toEqual([
      ['cresce.txt', 'grande demais', undefined],
      ['sub/dentro.txt', 'mudou enquanto era lido', undefined],
      ['troca.txt', 'mudou enquanto era lido', undefined],
    ]);
    expect(JSON.stringify(c)).not.toContain('SEGREDO');
  });

  it('a diferença que não bate com a contagem não aparece (o git leu o arquivo de novo entre uma e outra)', async () => {
    write(path.join(repo, 'a.txt'), 'um\nX\ntrês\n');
    write(path.join(repo, 'b.txt'), 'outra\n');
    const head = (p: string) => `diff --git a/${p} b/${p}\nindex 1111111..2222222 100644\n--- a/${p}\n+++ b/${p}\n`;
    // a saída de uma chamada só: a lista e a contagem dizem a.txt +2 −1, mas a diferença dele tem +1 −1
    const fake = [
      ':100644 100644 1111111 0000000 M\0a.txt\0',
      ':100644 100644 1111111 0000000 M\0b.txt\0',
      '2\t1\ta.txt\0',
      '1\t1\tb.txt\0',
      '\0',
      `${head('a.txt')}@@ -2 +2 @@\n-dois\n+X\n`,
      `${head('b.txt')}@@ -1 +1 @@\n-apagar\n+outra\n`,
    ].join('');
    gitHook.before = (args) => (args.includes('--numstat') ? fake : undefined);
    const [c] = (await gitChanges(repo).changedSince(new Map())).changes;
    expect(c.files.map((f) => [f.path, countText(f), f.diff !== undefined])).toEqual([
      ['a.txt', '+2 −1', false],
      ['b.txt', '+1 −1', true],
    ]);
  });

  it('uma tag com o nome da branch principal não confunde: o que foi commitado na branch continua no quadro', async () => {
    const wt = path.join(dir, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'feat/x', wt, 'main');
    write(path.join(wt, 'a.txt'), 'commitado na branch\n');
    git(wt, 'commit', '-q', '-am', 'na branch');
    git(repo, 'tag', 'main', 'feat/x'); // no commit da branch: pelo nome curto, a tag ganha e o quadro sai vazio
    const [c] = (await gitChanges(repo).changedSince(new Map())).changes;
    expect(c.base).toBe('main');
    expect(c.files.map((f) => f.path)).toEqual(['a.txt']);
  });

  it('os limites: a lista para em MAX_FILES e a diferença de um arquivo em DIFF_LINES linhas', async () => {
    for (let i = 0; i <= MAX_FILES; i++) write(path.join(repo, `f${String(i).padStart(3, '0')}.txt`), 'x\n');
    const lines = Array.from({ length: DIFF_LINES + 10 }, (_, i) => `l${i}`);
    write(path.join(repo, 'a-grande.txt'), lines.join('\n') + '\n');
    const [c] = (await gitChanges(repo).changedSince(new Map())).changes;
    expect(c.files).toHaveLength(MAX_FILES);
    expect(c.more).toBe(2);
    const big = c.files[0];
    expect(big.path).toBe('a-grande.txt');
    expect(big.added).toBe(DIFF_LINES + 10); // a contagem é a do arquivo inteiro
    expect(big.cut).toBe(true);
    expect(big.diff!.split('\n')).toHaveLength(DIFF_LINES);
    // além do limite da lista, a soma das linhas diz que é só a dos mostrados
    expect(describeChanges(c, 'Claude', repo).split('\n')[0]).toMatch(/: 102 arquivos, \+509 nos 100 mostrados$/);
    expect(describeChanges(c, 'Claude', repo)).toContain('  e mais 2 arquivos');
  });

  it('o total de diferença guardada num worktree para em DIFF_TOTAL: os arquivos seguintes ficam só com a contagem', async () => {
    const body = Array.from({ length: 300 }, () => 'y'.repeat(99)).join('\n') + '\n'; // uns 30 mil caracteres
    for (let i = 0; i < 10; i++) write(path.join(repo, `g${i}.txt`), body);
    const [c] = (await gitChanges(repo).changedSince(new Map())).changes;
    const kept = c.files.filter((f) => f.diff !== undefined);
    const dropped = c.files.filter((f) => f.diff === undefined);
    expect(kept.map((f) => f.path)).toEqual(['g0.txt', 'g1.txt', 'g2.txt', 'g3.txt', 'g4.txt', 'g5.txt']);
    expect(kept.reduce((n, f) => n + f.diff!.length, 0)).toBeLessThanOrEqual(DIFF_TOTAL);
    expect(dropped.map((f) => [f.path, f.cut, f.added])).toEqual(
      ['g6.txt', 'g7.txt', 'g8.txt', 'g9.txt'].map((p) => [p, true, 300]),
    );
  });

  it('a medida não roda o conversor de texto (textconv) nem o diff externo configurados no repositório', async () => {
    const slash = (p: string) => p.replace(/\\/g, '/');
    const marker = slash(path.join(dir, 'rodou.txt'));
    const script = path.join(dir, 'conv.sh');
    write(script, `#!/bin/sh\necho rodou > "${marker}"\ncat "$1"\n`);
    git(repo, 'config', 'diff.conv.textconv', `sh ${slash(script)}`);
    git(repo, 'config', 'diff.external', `sh ${slash(script)}`);
    write(path.join(repo, '.git', 'info', 'attributes'), '*.txt diff=conv\n');
    write(path.join(repo, 'a.txt'), 'um\nmudou\ntrês\n');

    const [c] = (await gitChanges(repo).changedSince(new Map())).changes;
    expect(c.files.map((f) => [f.path, countText(f)])).toEqual([['a.txt', '+1 −1']]);
    expect(fs.existsSync(marker)).toBe(false);
    git(repo, 'diff'); // o git sem as opções do duo roda o que está configurado: a prova de que o teste vale
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('fora de um repositório git: a medida rejeita (o duo não mostra nada)', async () => {
    const plain = path.join(dir, 'sem-git');
    fs.mkdirSync(plain);
    const watcher = gitChanges(plain);
    await expect(watcher.fingerprints()).rejects.toThrow();
    await expect(watcher.changedSince(new Map())).rejects.toThrow();
  });
});

class Stub implements Agent {
  resumeId: string | undefined = undefined;
  stats: AgentStats = { subagents: 0 };
  commands: AgentCommand[] = [];
  models: AgentModel[] = [];
  onOwnTurnEvent?: EmitFn;
  onOwnTurnReply?: (text: string, tasksShared?: boolean, fromApp?: boolean) => void;
  sent = 0;
  constructor(
    readonly id: AgentId,
    readonly name: string,
  ) {}
  async send(prompt: string, emit: EmitFn) {
    this.sent++;
    emit({ kind: 'text', text: `${this.name} fez` });
    return `${this.name} fez`;
  }
  async setModel() {}
  warmUp() {}
  async interrupt() {}
  reset() {}
  dispose() {}
}

const change: WorktreeChanges = {
  root: '/proj',
  branch: 'feat/y',
  base: 'main',
  files: [{ path: 'a.ts', status: 'alterado', added: 3, removed: 1, diff: '@@ -1 +1 @@\n-x\n+y' }],
  more: 0,
};

/** um medidor falso: cada medida é um número, e `report` é o que a próxima comparação acha */
function fakeWatcher() {
  const calls: string[] = [];
  let mark = 0;
  const w: { calls: string[]; report: WorktreeChanges[]; watcher: ChangeWatcher } = {
    calls,
    report: [change],
    watcher: {
      async fingerprints() {
        calls.push(`medida ${++mark}`);
        return new Map([['/proj', String(mark)]]);
      },
      async changedSince(before) {
        calls.push(`compara com ${before.get('/proj')}`);
        return { changes: w.report, now: new Map([['/proj', String(++mark)]]) };
      },
    },
  };
  return w;
}

const newDuo = (watcher?: ChangeWatcher, claude = new Stub('claude', 'Claude')) =>
  new Duo({ agents: { claude, codex: new Stub('codex', 'Codex') }, changes: watcher });
const cardsOf = (duo: Duo) => duo.getState().entries.filter((e) => e.changes);

describe('o que mudou de fato (no duo)', () => {
  it('o quadro aparece no fim do trabalho de quem rodou, e só quando algo mudou desde a medida que valia quando ele começou', async () => {
    const fake = fakeWatcher();
    const duo = newDuo(fake.watcher);
    duo.start();

    duo.submit('/cla faz a mudança');
    await vi.waitFor(() => expect(cardsOf(duo)).toHaveLength(1), { timeout: 5000 });
    expect(fake.calls).toEqual(['medida 1', 'compara com 1']); // a medida de quando o duo abriu
    const [card] = cardsOf(duo);
    expect(card.who).toBe('sistema');
    expect(card.changes).toEqual(change);
    expect(card.text).toBe(describeChanges(change, 'Cla', duo.cwd));

    fake.report = [];
    duo.submit('/cla só uma pergunta');
    // compara com a medida do fim do trabalho anterior, não mede de novo ao começar
    await vi.waitFor(() => expect(fake.calls).toEqual(['medida 1', 'compara com 1', 'compara com 2']), { timeout: 5000 });
    await sleep(20);
    expect(cardsOf(duo)).toHaveLength(1); // nada mudou: nenhum quadro novo
  });

  it('o turno que o Claude abre sozinho (tarefa em segundo plano que terminou) também ganha o quadro', async () => {
    const fake = fakeWatcher();
    const claude = new Stub('claude', 'Claude');
    const duo = newDuo(fake.watcher, claude);
    duo.start();
    await vi.waitFor(() => expect(fake.calls).toEqual(['medida 1']));
    claude.onOwnTurnEvent!({ kind: 'text', text: 'a tarefa terminou e eu continuei' });
    claude.onOwnTurnReply!('pronto', true);
    await vi.waitFor(() => expect(cardsOf(duo)).toHaveLength(1), { timeout: 5000 });
    expect(fake.calls).toEqual(['medida 1', 'compara com 1']);
    expect(cardsOf(duo)[0].text.split('\n')[0]).toContain('enquanto o Cla trabalhava');
  });

  it('o agente que edita assim que recebe a mensagem, logo depois de abrir o duo: a edição aparece', async () => {
    class Quick extends Stub {
      override async send(prompt: string, emit: EmitFn) {
        write(path.join(repo, 'a.txt'), 'um\nmudou na hora\ntrês\n');
        return super.send(prompt, emit);
      }
    }
    const duo = newDuo(gitChanges(repo), new Quick('claude', 'Claude'));
    duo.start();
    duo.submit('/cla edita'); // no mesmo instante: o trabalho espera a primeira medida
    await vi.waitFor(() => expect(cardsOf(duo)).toHaveLength(1), { timeout: 15_000 });
    expect(cardsOf(duo)[0].changes!.files.map((f) => f.path)).toEqual(['a.txt']);
  }, 30_000);

  it('o trabalho do duo espera a primeira medida, até 10 s; passou disso, começa assim mesmo', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let release!: (m: Fingerprints) => void;
      const watcher: ChangeWatcher = {
        fingerprints: () => new Promise((r) => (release = r)),
        changedSince: async () => ({ changes: [], now: new Map() }),
      };
      const claude = new Stub('claude', 'Claude');
      const duo = newDuo(watcher, claude);
      duo.start();
      duo.submit('/cla faz');
      await vi.advanceTimersByTimeAsync(9_000);
      expect(claude.sent).toBe(0);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(claude.sent).toBe(1);
      release(new Map());

      // com a medida pronta, não espera nada
      const quick = new Stub('claude', 'Claude');
      const other = newDuo({ fingerprints: async () => new Map(), changedSince: watcher.changedSince }, quick);
      other.start();
      other.submit('/cla faz');
      await vi.advanceTimersByTimeAsync(0);
      expect(quick.sent).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a primeira medida falhou: o fim do primeiro trabalho só mede, sem quadro; o seguinte compara com ela', async () => {
    const calls: string[] = [];
    let n = 0;
    const watcher: ChangeWatcher = {
      async fingerprints() {
        calls.push('medida');
        if (n++ === 0) throw new Error('o git não respondeu');
        return new Map([['/proj', 'x']]);
      },
      async changedSince(before) {
        calls.push(`compara com ${before.get('/proj')}`);
        return { changes: [change], now: before };
      },
    };
    const duo = newDuo(watcher);
    duo.start();
    duo.submit('/cla faz');
    await vi.waitFor(() => expect(calls).toEqual(['medida', 'medida']), { timeout: 5000 });
    await sleep(20);
    expect(cardsOf(duo)).toHaveLength(0);
    duo.submit('/cla de novo');
    await vi.waitFor(() => expect(cardsOf(duo)).toHaveLength(1), { timeout: 5000 });
    expect(calls).toEqual(['medida', 'medida', 'compara com x']);
  });

  it('a comparação falhou: continua valendo a medida que o duo tinha', async () => {
    const seen: (string | undefined)[] = [];
    const watcher: ChangeWatcher = {
      fingerprints: async () => new Map([['/proj', '1']]),
      async changedSince(before) {
        seen.push(before.get('/proj'));
        if (seen.length === 1) throw new Error('nem a lista dos worktrees veio');
        return { changes: [], now: new Map([['/proj', '2']]) };
      },
    };
    const duo = newDuo(watcher);
    duo.start();
    duo.submit('/cla faz');
    duo.submit('/cla de novo');
    await vi.waitFor(() => expect(seen).toEqual(['1', '1']), { timeout: 5000 });
  });

  it('a medida do fim que chega depois de um /novo não entra na conversa nova', async () => {
    let release!: () => void;
    const watcher: ChangeWatcher = {
      fingerprints: async () => new Map([['/proj', '1']]),
      changedSince: () => new Promise((r) => (release = () => r({ changes: [change], now: new Map([['/proj', '2']]) }))),
    };
    const duo = newDuo(watcher);
    duo.start();
    duo.submit('/cla faz');
    await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 5000 });
    duo.submit('/novo');
    release();
    await sleep(20);
    expect(cardsOf(duo)).toHaveLength(0);
  });

  it('o quadro fica gravado e volta ao retomar a conversa do disco; um quadro estragado no arquivo não passa', async () => {
    const store = new SessionStore(path.join(dir, 'duo-home'));
    const data = newSessionData(repo);
    const rec = new Recorder(data, store);
    const duo = new Duo({ agents: { claude: new Stub('claude', 'Claude'), codex: new Stub('codex', 'Codex') }, recorder: rec, changes: fakeWatcher().watcher });
    duo.start();
    duo.submit('/cla faz');
    await vi.waitFor(() => expect(cardsOf(duo)).toHaveLength(1), { timeout: 5000 });
    rec.saveNow();

    const loaded = store.load(data.id)!;
    const resumed = new Duo({
      agents: { claude: new Stub('claude', 'Claude'), codex: new Stub('codex', 'Codex') },
      recorder: new Recorder(loaded, store),
      resumed: true,
    });
    const [card] = cardsOf(resumed);
    expect(card.changes).toEqual(change);
    expect(card.text).toBe(describeChanges(change, 'Cla', resumed.cwd));

    const file = path.join(store.root, 'sessions', `${data.id}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.screen.find((e: { changes?: unknown }) => e.changes).changes = {};
    fs.writeFileSync(file, JSON.stringify(raw));
    expect(store.load(data.id)).toBeUndefined();
    rec.close();
  });

  it('sem quem meça, o duo não mede nada', async () => {
    const duo = newDuo();
    duo.start();
    duo.submit('/cla faz');
    await vi.waitFor(() => expect(duo.getState().runningSince.claude).toBe(null), { timeout: 5000 });
    expect(duo.getState().entries.some((e) => e.changes)).toBe(false);
  });
});
