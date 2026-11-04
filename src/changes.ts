import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fssync from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { CHANGES_CAVEAT, countText } from './display.js';

/**
 * O que mudou de fato no projeto. No fim de cada trabalho de um agente, o duo compara cada worktree do repositório
 * com a branch principal e mostra os arquivos, as linhas que entraram e saíram e a diferença de cada um, inclusive
 * dos arquivos que o git ainda não rastreia (o `git diff --stat` não mostra esses). Mostra a mudança; não prova que
 * funciona, nem quem fez: com os dois trabalhando ao mesmo tempo, a mudança de um aparece no fim do trabalho do outro.
 */

/** Um arquivo que mudou num worktree. */
export interface ChangedFile {
  /** relativo à pasta do worktree, com / */
  path: string;
  status: 'novo' | 'alterado' | 'apagado' | 'renomeado';
  /** o nome de antes, quando foi renomeado */
  from?: string;
  /** linhas que entraram e que saíram; undefined = não deu para contar (veja `note`) */
  added?: number;
  removed?: number;
  /** por que não há contagem nem diferença: "binário", "grande demais", "link" */
  note?: string;
  /** a diferença, para abrir na janela */
  diff?: string;
  /** a diferença foi cortada no limite, ou nem foi guardada porque o worktree passou do limite */
  cut?: boolean;
}

/** O que mudou num worktree, contra a branch principal. Sem arquivos = ele voltou a ficar igual à base. */
export interface WorktreeChanges {
  /** a pasta do worktree, como o git informa */
  root: string;
  /** a branch dele; null = HEAD solto */
  branch: string | null;
  /** contra o que compara: a branch principal (main, master), o último commit (HEAD) ou "o começo" */
  base: string;
  files: ChangedFile[];
  /** arquivos além do limite da lista */
  more: number;
}

/**
 * Uma marca de cada worktree, por pasta: muda quando qualquer arquivo dele muda. `FAILED` = não deu para medir esse
 * worktree naquela vez (não se sabe como ele estava).
 */
export type Fingerprints = Map<string, string>;
export const FAILED = 'falhou';

/** Quem mede: o git de verdade no duo, um falso nos testes. */
export interface ChangeWatcher {
  /** a marca de cada worktree agora; rejeita fora de um repositório (ou quando o git não responde) */
  fingerprints(): Promise<Fingerprints>;
  /**
   * O que mudou em cada worktree cuja marca não é mais a de `before`, e a marca de cada um agora: é o "antes" de quem
   * começar depois. Um worktree que não deu para medir agora fica com a marca de antes (aparece na próxima vez).
   */
  changedSince(before: Fingerprints): Promise<{ changes: WorktreeChanges[]; now: Fingerprints }>;
}

/** Até quantos arquivos a lista mostra, por worktree. */
export const MAX_FILES = 100;
/** Até quantas linhas a diferença de um arquivo guarda. */
export const DIFF_LINES = 400;
/** Até quantos caracteres de diferença um worktree guarda, somando os arquivos (a conversa gravada leva tudo). */
export const DIFF_TOTAL = 200_000;
/** O arquivo novo maior que isto não é lido: fica sem contagem e sem diferença. */
export const NEW_FILE_MAX = 512 * 1024;
/** Arquivos novos além disto entram na marca só pela quantidade. */
const STAT_MAX = 5000;
/** A saída do git maior que isto (uma diferença enorme) faz a medida daquele worktree falhar, em vez de lotar a memória. */
const OUTPUT_MAX = 64 * 1024 * 1024;
/** O git que não responde em tanto tempo é derrubado: a medida daquele worktree falha. */
const GIT_TIMEOUT_MS = 60_000;
/** A árvore vazia do git: a base de um repositório ainda sem commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      // os nomes com acento vêm como estão (o cabeçalho de cada diferença é conferido contra eles)
      ['-c', 'core.quotepath=false', ...args],
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: OUTPUT_MAX,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        // só lê: não disputa a trava do índice com o agente que está mexendo no mesmo repositório
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

interface Worktree {
  root: string;
  branch: string | null;
}

/** Os worktrees do repositório, inclusive o principal; os que sumiram do disco ficam de fora. */
async function worktrees(cwd: string): Promise<Worktree[]> {
  const out = await git(cwd, ['worktree', 'list', '--porcelain', '-z']);
  const list: Worktree[] = [];
  let fields: string[] = [];
  // -z: um campo por NUL, e um NUL a mais entre um worktree e outro
  for (const field of out.split('\0')) {
    if (field !== '') {
      fields.push(field);
      continue;
    }
    const root = fields.find((f) => f.startsWith('worktree '))?.slice('worktree '.length);
    if (root && !fields.some((f) => f === 'bare' || f.startsWith('prunable'))) {
      const ref = fields.find((f) => f.startsWith('branch '))?.slice('branch '.length);
      list.push({ root, branch: ref ? ref.replace(/^refs\/heads\//, '') : null });
    }
    fields = [];
  }
  return list;
}

/**
 * O git que pode responder "não tem": ele sai com 1 quando a coisa não existe (a ref, o HEAD de um repositório sem
 * commit, um ancestral comum). Isso vira null; qualquer outra saída (erro do git, tempo esgotado) é falha e rejeita:
 * uma falha nunca vira "não tem", senão a base mudaria sozinha.
 */
function gitMaybe(cwd: string, args: string[]): Promise<string | null> {
  return git(cwd, args).catch((err: { code?: unknown }) => {
    if (err?.code === 1) return null;
    throw err;
  });
}

/** A branch principal: a que o origin aponta como padrão, senão main, senão master; null = nenhuma existe aqui. */
async function mainBranch(cwd: string): Promise<string | null> {
  // O for-each-ref só sai com 0: o que não existe vem vazio, e qualquer erro é falha de verdade. Os nomes vão e voltam
  // completos (refs/heads/...): uma tag com o mesmo nome da branch não confunde.
  const origin = (await git(cwd, ['for-each-ref', '--format=%(symref)', 'refs/remotes/origin/HEAD'])).trim();
  const names = [origin.replace(/^refs\/remotes\/origin\//, ''), 'main', 'master'].filter(Boolean);
  const out = await git(cwd, ['for-each-ref', '--format=%(refname)', ...names.map((n) => `refs/heads/${n}`)]);
  const have = new Set(out.split('\n').map((s) => s.trim()));
  return names.find((n) => have.has(`refs/heads/${n}`)) ?? null;
}

/** De onde o worktree conta "o que mudou": onde ele saiu da branch principal (nela mesma, o último commit). */
async function baseOf({ root, branch }: Worktree, main: string | null): Promise<{ commit: string; label: string }> {
  if ((await gitMaybe(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])) === null) {
    return { commit: EMPTY_TREE, label: 'o começo' };
  }
  if (main && branch !== main) {
    // sem ancestral comum (histórias separadas), conta desde o último commit dele
    const fork = (await gitMaybe(root, ['merge-base', 'HEAD', `refs/heads/${main}`]))?.trim();
    if (fork) return { commit: fork, label: main };
  }
  return { commit: 'HEAD', label: 'HEAD' };
}

interface Measure extends Worktree {
  base: { commit: string; label: string };
  /** a saída inteira do `git diff` (lista, contagem e diferença dos rastreados), do ponto de partida até o disco */
  diff: string;
  /** os arquivos que o git ainda não rastreia (e não ignora) */
  untracked: string[];
  mark: string;
}

/**
 * Uma chamada só do git dá a lista (--raw), a contagem (--numstat) e a diferença (-p) dos rastreados. Dentro dela, o
 * git pode ler um arquivo de novo entre a contagem e a diferença: por isso cada diferença é conferida contra a
 * contagem (`chunkCounts`), e a que não bate não aparece. Com a mesma contagem, a diferença pode ser de um instante
 * depois dela; é ela que vai para a marca. Sem diff externo e sem textconv (só o que o `git status` já roda); os
 * prefixos a/ e b/ fixos, seja qual for a configuração (o cabeçalho de cada diferença é lido por eles).
 */
const DIFF_ARGS = [
  'diff',
  '-z',
  '--raw',
  '--numstat',
  '-p',
  '--no-color',
  '--no-ext-diff',
  '--no-textconv',
  '-M',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

/** A marca diz também se há algo pendente: voltar a ficar igual à base é uma mudança que aparece. */
const isClean = (mark: string | undefined) => mark?.endsWith(':limpo') === true;

async function measure(tree: Worktree, main: string | null): Promise<Measure> {
  const base = await baseOf(tree, main);
  const [diff, others] = await Promise.all([
    git(tree.root, [...DIFF_ARGS, base.commit]),
    git(tree.root, ['ls-files', '-z', '--others', '--exclude-standard']),
  ]);
  const untracked = others.split('\0').filter(Boolean);
  // o arquivo novo muda a marca pelo tamanho e pela hora em que foi gravado (como o próprio git faz com os rastreados):
  // ler todos a cada trabalho custaria caro
  const stats = await Promise.all(
    untracked.slice(0, STAT_MAX).map((p) =>
      fs.lstat(path.join(tree.root, p)).then(
        (s) => `${p}\t${s.size}\t${s.mtimeMs}`,
        () => p,
      ),
    ),
  );
  const hash = createHash('sha1')
    .update([base.commit, diff, String(untracked.length), ...stats].join('\0'))
    .digest('hex');
  const clean = diff === '' && untracked.length === 0;
  return { ...tree, base, diff, untracked, mark: `${hash}:${clean ? 'limpo' : 'pendente'}` };
}

/** Cada worktree do repositório de `cwd`, medido (ou `null`, o que falhou). Rejeita se nem a lista vier. */
async function measureAll(cwd: string): Promise<{ tree: Worktree; m: Measure | null }[]> {
  const trees = await worktrees(cwd);
  const main = await mainBranch(cwd);
  return Promise.all(trees.map(async (tree) => ({ tree, m: await measure(tree, main).catch(() => null) })));
}

const STATUS: Record<string, ChangedFile['status']> = { A: 'novo', C: 'novo', D: 'apagado', R: 'renomeado' };

/** Corta a diferença em DIFF_LINES linhas. */
function capDiff(diff: string): { diff: string; cut: boolean } {
  const lines = diff.replace(/\n$/, '').split('\n');
  if (lines.length <= DIFF_LINES) return { diff: lines.join('\n'), cut: false };
  return { diff: lines.slice(0, DIFF_LINES).join('\n'), cut: true };
}

/**
 * Os arquivos rastreados que mudaram, com a contagem e a diferença de cada um, lidos da saída da medida: primeiro as
 * linhas do --raw (":modo modo id id STATUS\0caminho\0", ou "\0antes\0depois\0" num renomeado ou copiado), depois as
 * do --numstat ("entraram\tsaíram\tcaminho\0", ou "entraram\tsaíram\t\0antes\0depois\0"; o nome pode ter TAB, só as
 * duas primeiras separam), um NUL a mais, e a diferença.
 */
function trackedFiles(m: Measure): ChangedFile[] {
  const end = m.diff.indexOf('\0\0');
  const head = (end < 0 ? m.diff : m.diff.slice(0, end)).split('\0');
  const patch = end < 0 ? '' : m.diff.slice(end + 2);
  /** cada arquivo e a primeira linha que a diferença dele tem */
  const files: { file: ChangedFile; header: string }[] = [];
  const counts = new Map<string, [string, string]>();
  for (let i = 0; i < head.length && head[i]; ) {
    const token = head[i++];
    if (token.startsWith(':')) {
      const code = token.slice(token.lastIndexOf(' ') + 1);
      const kind = STATUS[code[0]] ?? 'alterado';
      if (code[0] === 'R' || code[0] === 'C') {
        const from = head[i++];
        const to = head[i++];
        files.push({ file: { path: to, status: kind, ...(code[0] === 'R' ? { from } : {}) }, header: `diff --git a/${from} b/${to}` });
      } else {
        const p = head[i++];
        files.push({ file: { path: p, status: kind }, header: `diff --git a/${p} b/${p}` });
      }
      continue;
    }
    const t1 = token.indexOf('\t');
    const t2 = token.indexOf('\t', t1 + 1);
    const name = token.slice(t2 + 1);
    const target = name !== '' ? name : (i++, head[i++]);
    counts.set(target, [token.slice(0, t1), token.slice(t1 + 1, t2)]);
  }
  for (const { file } of files) {
    const c = counts.get(file.path);
    if (!c) continue;
    if (c[0] === '-') file.note = 'binário';
    else {
      file.added = Number(c[0]);
      file.removed = Number(c[1]);
    }
  }
  // Cada arquivo fica com o pedaço cuja primeira linha é a dele (e cujas linhas batem com a contagem); o nome com o que
  // o git escreve entre aspas não acha o pedaço: fica sem diferença, nunca com a de outro arquivo.
  const chunks = new Map<string, string>();
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (chunk.startsWith('diff --git ')) chunks.set(chunk.slice(0, chunk.indexOf('\n')), chunk);
  }
  for (const { file, header } of files) {
    const chunk = chunks.get(header);
    if (file.note || chunk === undefined) continue;
    const [added, removed] = chunkCounts(chunk);
    if (added !== file.added || removed !== file.removed) continue;
    Object.assign(file, capDiff(chunk));
  }
  return files.map((f) => f.file);
}

/** As linhas que entraram e saíram num pedaço da diferença (depois do primeiro @@, o resto é cabeçalho). */
function chunkCounts(chunk: string): [number, number] {
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const line of chunk.split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line[0] === '+') added++;
    else if (inHunk && line[0] === '-') removed++;
  }
  return [added, removed];
}

/**
 * Um arquivo que o git ainda não rastreia: tudo nele entrou. Link não é seguido (o alvo pode estar fora do projeto).
 * Abre e só depois confere que o aberto é o mesmo arquivo comum que está no caminho, dentro do worktree: trocado (ele
 * ou uma pasta do caminho) por um link, ou por outro arquivo, entre a olhada e a abertura, não lê. E lê no máximo
 * NEW_FILE_MAX + 1 bytes, mesmo que ele cresça no meio.
 */
async function newFile(root: string, realRoot: string, p: string): Promise<ChangedFile> {
  const file: ChangedFile = { path: p, status: 'novo' };
  const full = path.join(root, p);
  let handle: FileHandle | undefined;
  try {
    const st = await fs.lstat(full);
    if (st.isSymbolicLink()) return { ...file, note: 'link' };
    if (!st.isFile()) return { ...file, note: 'não é um arquivo comum' };
    if (st.size > NEW_FILE_MAX) return { ...file, note: 'grande demais' };
    handle = await fs.open(full, 'r');
    // O aberto tem de ser o arquivo comum que está nesse caminho dentro do worktree, sem link em nenhuma pasta do
    // caminho (o git não lista arquivo dentro de pasta que é link): uma pasta trocada por um link entre a olhada e a
    // abertura leva o caminho para fora, e o arquivo aberto não é o de lá de dentro.
    const [opened, real] = await Promise.all([handle.stat({ bigint: true }), fs.realpath(full)]);
    const now = await fs.lstat(real, { bigint: true });
    const inside = sameText(real, path.join(realRoot, p));
    if (!inside || now.isSymbolicLink() || !opened.isFile() || opened.ino !== now.ino || opened.dev !== now.dev) {
      return { ...file, note: 'mudou enquanto era lido' };
    }
    const buf = Buffer.alloc(NEW_FILE_MAX + 1);
    let size = 0;
    for (let n = -1; n !== 0 && size < buf.length; size += n) {
      ({ bytesRead: n } = await handle.read(buf, size, buf.length - size, size));
    }
    if (size > NEW_FILE_MAX) return { ...file, note: 'grande demais' };
    const data = buf.subarray(0, size);
    if (data.includes(0)) return { ...file, note: 'binário' };
    const text = data.toString('utf8');
    const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
    const hunk = lines.length > 0 ? [`@@ -0,0 +1,${lines.length} @@`] : [];
    const body = [`--- /dev/null`, `+++ b/${p}`, ...hunk, ...lines.map((l) => `+${l.replace(/\r$/, '')}`)].join('\n');
    return { ...file, added: lines.length, removed: 0, ...capDiff(body) };
  } catch {
    return { ...file, note: 'não deu para ler' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** O que mudou num worktree medido: a lista em ordem de caminho, cortada nos limites. Não roda o git de novo. */
async function details(m: Measure): Promise<WorktreeChanges> {
  const tracked = trackedFiles(m);
  const all: (ChangedFile | { path: string; pending: true })[] = [...tracked, ...m.untracked.map((p) => ({ path: p, pending: true as const }))];
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const shown = all.slice(0, MAX_FILES);
  const realRoot = await fs.realpath(m.root);
  const files = await Promise.all(
    shown.map((f) => ('pending' in f ? newFile(m.root, realRoot, f.path) : Promise.resolve(f))),
  );
  // a conversa gravada leva as diferenças: passou do total, os arquivos seguintes ficam só com a contagem
  let total = 0;
  for (const f of files) {
    if (f.diff === undefined) continue;
    total += f.diff.length;
    if (total > DIFF_TOTAL) {
      delete f.diff;
      f.cut = true;
    }
  }
  return { root: m.root, branch: m.branch, base: m.base.label, files, more: all.length - shown.length };
}

/** O git de verdade, no repositório da pasta `cwd`. */
export function gitChanges(cwd: string): ChangeWatcher {
  return {
    async fingerprints() {
      return new Map((await measureAll(cwd)).map(({ tree, m }) => [tree.root, m ? m.mark : FAILED]));
    },
    async changedSince(before) {
      const now: Fingerprints = new Map();
      const changes: WorktreeChanges[] = [];
      await Promise.all(
        (await measureAll(cwd)).map(async ({ tree, m }) => {
          const was = before.get(tree.root);
          // não deu para medir agora: fica a marca de antes, e a mudança aparece quando der
          if (!m) return now.set(tree.root, was ?? FAILED);
          now.set(tree.root, m.mark);
          // sem marca de antes que valha (não deu para medir antes): não se sabe o que mudou, só passa a valer esta
          if (was === m.mark || was === FAILED) return;
          // não roda o git: só lê a medida e os arquivos novos (um erro aqui rejeita a comparação inteira, e o duo
          // continua com a medida de antes)
          const c = await details(m);
          if (c.files.length > 0 || (was !== undefined && !isClean(was) && isClean(m.mark))) changes.push(c);
        }),
      );
      changes.sort((a, b) => (a.root < b.root ? -1 : 1));
      return { changes, now };
    },
  };
}

/** A mesma pasta, mesmo escrita de outro jeito (o git dá C:/Users/..., o Windows pode dar C:\Users\NOME~1\...). */
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fssync.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  return sameText(real(a), real(b));
}

/** Dois caminhos já resolvidos são o mesmo (no Windows, sem diferença de maiúscula, e com qualquer barra). */
function sameText(a: string, b: string): boolean {
  const [x, y] = [path.normalize(a), path.normalize(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** O cabeçalho do quadro: onde mudou e o tamanho da mudança. */
export function changesTitle(c: WorktreeChanges, who: string, cwd: string): string {
  const where = c.branch ? `na branch ${c.branch}` : 'num HEAD solto';
  const folder = samePath(c.root, cwd) ? 'nesta pasta' : `na pasta ${c.root}`;
  const since = c.base === 'HEAD' ? 'desde o último commit' : c.base === 'o começo' ? 'desde o começo' : `desde a ${c.base}`;
  const head = `O que mudou enquanto o ${who} trabalhava, ${where} (${folder}), ${since}`;
  const count = c.files.length + c.more;
  if (count === 0) return `${head}: nenhuma diferença agora`;
  const added = c.files.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = c.files.reduce((n, f) => n + (f.removed ?? 0), 0);
  const lines = [added > 0 ? `+${added}` : '', removed > 0 ? `−${removed}` : ''].filter(Boolean).join(' ');
  // além do limite da lista, as linhas somadas são só as dos arquivos mostrados
  const scope = lines && c.more > 0 ? ` nos ${c.files.length} mostrados` : '';
  return `${head}: ${count} ${count === 1 ? 'arquivo' : 'arquivos'}${lines ? `, ${lines}${scope}` : ''}`;
}

/** O quadro em texto: o terminal mostra e a conversa gravada guarda; a janela mostra o quadro. */
export function describeChanges(c: WorktreeChanges, who: string, cwd: string): string {
  const width = Math.max(0, ...c.files.map((f) => f.status.length));
  const rows = c.files.map((f) => {
    const name = f.from ? `${f.from} → ${f.path}` : f.path;
    const count = countText(f);
    return `  ${f.status.padEnd(width)}  ${name}${count ? `  ${count}` : ''}`;
  });
  if (c.more > 0) rows.push(`  e mais ${c.more} ${c.more === 1 ? 'arquivo' : 'arquivos'}`);
  return [changesTitle(c, who, cwd), ...rows, CHANGES_CAVEAT].join('\n');
}
