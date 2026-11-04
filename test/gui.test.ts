import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  AgentCommand,
  AgentEvent,
  AgentId,
  AgentModel,
  AgentStats,
  AgentTask,
  EmitFn,
  ImageInput,
  ModelChoice,
} from '../src/agents/types.js';
import { Duo } from '../src/core.js';
import { currentModel, modelLabel } from '../src/display.js';
import { newSessionData, Recorder } from '../src/persist.js';
import { startGui, type Gui } from '../src/gui/server.js';

class FakeAgent implements Agent {
  prompts: string[] = [];
  images: ImageInput[][] = [];
  resumeId: string | undefined = undefined;
  stats: AgentStats = { subagents: 0 };
  commands: AgentCommand[] = [];
  models: AgentModel[] = [];
  onModels?: Agent['onModels'];
  onStats?: Agent['onStats'];
  /** o que o seletor pediu, na ordem; `modelFails` faz a próxima troca falhar com essa mensagem */
  choices: ModelChoice[] = [];
  modelFails?: string;
  /** enquanto existir, a troca espera por ele (o CLI ainda não respondeu) */
  modelGate?: Promise<void>;
  disposed = 0;
  /** enquanto existir, o turno espera por ele */
  gate?: Promise<void>;
  /** o que o turno manda para a tela antes da resposta (passos, o fim deles) */
  events: AgentEvent[] = [];
  askPermission?: Agent['askPermission'];
  onTasks?: Agent['onTasks'];
  onSignal?: Agent['onSignal'];
  onOwnTurnEvent?: Agent['onOwnTurnEvent'];
  onOwnTurnReply?: Agent['onOwnTurnReply'];
  onRemoteMessage?: Agent['onRemoteMessage'];
  onTools?: Agent['onTools'];
  askPeer?: Agent['askPeer'];
  /** quantas vezes pediram para parar; `slowStop` = o turno só fecha no `finishStop` (o CLI ainda não parou) */
  interrupts = 0;
  slowStop = false;
  /** enquanto existir, o pedido de parar espera por ele; `interruptFails` faz o pedido falhar com essa mensagem */
  interruptGate?: Promise<void>;
  interruptFails?: string;
  private stopTurn?: (err: Error) => void;
  constructor(
    readonly id: AgentId,
    readonly name: string,
  ) {}
  async send(prompt: string, emit: EmitFn, _shared?: boolean, images: ImageInput[] = []) {
    this.prompts.push(prompt);
    this.images.push(images);
    // parar derruba o turno que o gate segura, como o adaptador de verdade
    await Promise.race([this.gate, new Promise<never>((_, reject) => (this.stopTurn = reject))]);
    this.stopTurn = undefined;
    for (const ev of this.events) emit(ev);
    const answer = `${this.name} responde ${this.prompts.length}`;
    emit({ kind: 'text', text: answer });
    return answer;
  }
  async setModel(choice: ModelChoice) {
    this.choices.push(choice);
    await this.modelGate;
    if (this.modelFails) throw new Error(this.modelFails);
    const { model, effort, fast } = choice;
    this.stats = {
      ...this.stats,
      ...(model !== undefined ? { model, selected: model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(fast !== undefined ? { fast } : {}),
    };
    this.onStats?.({ ...this.stats });
  }
  warmUp() {}
  async interrupt() {
    this.interrupts++;
    await this.interruptGate;
    if (this.interruptFails) throw new Error(this.interruptFails);
    if (!this.slowStop) this.finishStop();
  }
  finishStop() {
    this.stopTurn?.(new Error('parado'));
  }
  reset() {}
  dispose() {
    this.disposed++;
  }
}

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path ?? '/',
        headers: { Host: `127.0.0.1:${port}`, ...opts.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

/** Ouve o /events: guarda cada evento e deixa esperar por um. */
function listen(port: number, cookie: string) {
  const events: { name: string; data: any }[] = [];
  let ended = false;
  let buf = '';
  const req = http.get(
    { host: '127.0.0.1', port, path: '/events', headers: { Host: `127.0.0.1:${port}`, Cookie: cookie } },
    (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const name = block.match(/^event: (.*)$/m)?.[1];
          const data = block.match(/^data: (.*)$/m)?.[1];
          if (name && data !== undefined) events.push({ name, data: JSON.parse(data) });
        }
      });
      res.on('end', () => (ended = true));
    },
  );
  const until = async (check: () => boolean, what: string, ms = 3000) => {
    const t0 = Date.now();
    while (!check()) {
      if (Date.now() - t0 > ms) throw new Error(`não chegou: ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return {
    events,
    ended: () => ended,
    /** espera um evento com esse nome (e que passe no filtro) e devolve o data dele */
    async next(name: string, pick: (data: any) => boolean = () => true) {
      await until(() => events.some((e) => e.name === name && pick(e.data)), name);
      return events.find((e) => e.name === name && pick(e.data))!.data;
    },
    until,
    close: () => req.destroy(),
  };
}

const TOKEN = 'a'.repeat(64);
let opened: Gui[] = [];
afterEach(async () => {
  await Promise.all(opened.map((g) => g.close()));
  opened = [];
});

/** um PNG de 1×1 */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function setup() {
  const publicDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-gui-'));
  fs.writeFileSync(path.join(publicDir, 'app.js'), 'console.log("duo")');
  fs.writeFileSync(path.join(publicDir, 'app.css'), 'body{}');
  const imagesDir = path.join(publicDir, 'imagens');
  const agents = { claude: new FakeAgent('claude', 'Claude'), codex: new FakeAgent('codex', 'Codex') };
  const duo = new Duo({ agents });
  const gui = await startGui(duo, { publicDir, token: TOKEN, imagesDir });
  opened.push(gui);
  duo.start();
  const port = Number(new URL(gui.url).port);
  const cookie = `duo-${port}=${TOKEN}`;
  const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
    request(port, {
      method: 'POST',
      path: p,
      body: JSON.stringify(body),
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', ...headers },
    });
  return { agents, duo, gui, port, cookie, post, imagesDir };
}

const filesIn = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);

describe('janela: acesso', () => {
  it('sem a chave nada responde; a chave vira cookie e sai do endereço', async () => {
    const { gui, port, cookie } = await setup();
    expect(gui.url).toBe(`http://127.0.0.1:${port}/?t=${TOKEN}`);

    expect((await request(port)).status).toBe(403);
    expect((await request(port, { path: '/app.js' })).status).toBe(403);
    expect((await request(port, { path: '/events' })).status).toBe(403);
    expect((await request(port, { path: `/?t=${'b'.repeat(64)}` })).status).toBe(403);

    const entry = await request(port, { path: `/?t=${TOKEN}` });
    expect(entry.status).toBe(303);
    expect(entry.headers.location).toBe('/');
    const set = String(entry.headers['set-cookie']);
    expect(set).toContain(cookie);
    expect(set).toContain('HttpOnly');
    expect(set).toContain('SameSite=Strict');

    const page = await request(port, { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect(page.body).toContain('<script type="module" src="/app.js"></script>');
    // a política inteira: um 'unsafe-inline' ou um domínio a mais também tem de quebrar este teste
    expect(page.headers['content-security-policy']).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(page.headers['x-frame-options']).toBe('DENY');
    expect((await request(port, { path: '/app.js', headers: { Cookie: cookie } })).body).toBe('console.log("duo")');
  });

  it('outro nome no Host não passa, mesmo com o cookie (site com DNS apontado para cá)', async () => {
    const { port, cookie } = await setup();
    const res = await request(port, { headers: { Cookie: cookie, Host: `evil.example:${port}` } });
    expect(res.status).toBe(403);
    expect((await request(port, { headers: { Cookie: cookie, Host: `localhost:${port}` } })).status).toBe(200);
  });

  it('POST sem a origem da página ou sem JSON não chega ao duo', async () => {
    const { agents, post } = await setup();
    expect((await post('/api/submit', { text: 'oi' }, { Origin: '' })).status).toBe(403);
    expect((await post('/api/submit', { text: 'oi' }, { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await post('/api/submit', { text: 'oi' }, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post('/api/submit', { texto: 'oi' })).status).toBe(400);
    expect(agents.claude.prompts).toHaveLength(0);
  });

  it('sem a página montada, o erro diz o que fazer', async () => {
    const duo = new Duo({ agents: { claude: new FakeAgent('claude', 'Claude'), codex: new FakeAgent('codex', 'Codex') } });
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-gui-vazio-'));
    await expect(startGui(duo, { publicDir: empty })).rejects.toThrow('npm run build');
  });
});

describe('janela: conversa', () => {
  it('chega o estado inteiro, e depois cada linha; o que a janela manda vai pelo mesmo caminho do terminal', async () => {
    const { agents, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    const snap = await events.next('snapshot');
    expect(snap.names).toEqual({ claude: 'Claude', codex: 'Codex' });
    expect(snap.cwd).toBe(process.cwd());
    expect(snap.target).toBe('claude');
    expect(snap.entries.at(-1).text).toContain('Claude + Codex na mesma janela');

    expect(JSON.parse((await post('/api/submit', { text: '@todos oi' })).body)).toEqual({ ok: true });
    await events.next('entry', (e) => e.who === 'voce' && e.text === '[para os dois] oi');
    await events.next('entry', (e) => e.who === 'claude' && e.text === 'Claude responde 1');
    await events.next('entry', (e) => e.who === 'codex' && e.text === 'Codex responde 1');
    await events.next('status', (s) => s.busy.claude === 1);
    await events.next('status', (s) => s.target === 'todos' && s.busy.claude === 0 && s.busy.codex === 0);
    expect(agents.claude.prompts[0]).toContain('oi');

    // só espaços: nada acontece
    expect(JSON.parse((await post('/api/submit', { text: '   ' })).body)).toEqual({ ok: false });

    await post('/api/submit', { text: '/privado' });
    await events.next('status', (s) => s.shared === false);

    await post('/api/submit', { text: '/limpar' });
    await events.next('clear');

    // reconectar traz o estado de agora
    const again = listen(port, cookie);
    const now = await again.next('snapshot');
    expect(now.entries).toEqual([]);
    expect(now.shared).toBe(false);
    events.close();
    again.close();
  });

  it('passos: a linha leva o texto inteiro e o fim dele; o fim que deu certo não conta como quem falou', async () => {
    const { agents, port, cookie, post } = await setup();
    agents.claude.events = [
      { kind: 'tool', text: '$ ls', step: { id: 's0', full: '$ ls' } }, // o fim dele chega depois do Codex falar
      { kind: 'tool', text: '$ npm test', step: { id: 's1', full: '$ npm test -- --run' } },
      { kind: 'tool', text: '  ↳ saiu com código 1', result: { of: 's1', ok: false, exitCode: 1 } },
    ];
    const events = listen(port, cookie);
    await events.next('snapshot');
    await post('/api/submit', { text: 'oi' });
    expect(await events.next('entry', (e) => e.step?.id === 's0')).toMatchObject({ kind: 'tool', label: true });
    expect(await events.next('entry', (e) => e.step?.id === 's1')).toMatchObject({
      kind: 'tool',
      label: false,
      step: { id: 's1', full: '$ npm test -- --run' },
    });
    expect(await events.next('entry', (e) => e.result?.of === 's1')).toMatchObject({
      label: false,
      result: { of: 's1', ok: false, exitCode: 1 },
    });
    await events.next('entry', (e) => e.text === 'Claude responde 1');
    // o fim que deu certo não leva o nome, nem faz a linha seguinte de quem falava perder o dela
    agents.codex.onOwnTurnEvent!({ kind: 'text', text: 'enquanto isso' });
    agents.claude.onOwnTurnEvent!({ kind: 'tool', text: '  ↳ ok', result: { of: 's0', ok: true } });
    agents.codex.onOwnTurnEvent!({ kind: 'text', text: 'continuo' });
    expect(await events.next('entry', (e) => e.result?.of === 's0')).toMatchObject({ who: 'claude', label: false });
    expect(await events.next('entry', (e) => e.text === 'continuo')).toMatchObject({ who: 'codex', label: false });
    // quem abre a janela depois recebe o mesmo
    const again = listen(port, cookie);
    const snap = await again.next('snapshot');
    expect(snap.entries.filter((e: any) => e.step || e.result).map((e: any) => e.step?.id ?? e.result.of)).toEqual(['s0', 's1', 's1', 's0']);
    events.close();
    again.close();
  });

  it('passos: o fim de um passo que você limpou da tela não aparece, nem fica com o nome de quem fala', async () => {
    const agents = { claude: new FakeAgent('claude', 'Claude'), codex: new FakeAgent('codex', 'Codex') };
    const duo = new Duo({ agents });
    duo.start();
    agents.claude.onOwnTurnEvent!({ kind: 'tool', text: '$ npm test', step: { id: 's1', full: '$ npm test' } });
    await duo.submit('/limpar');
    agents.claude.onOwnTurnEvent!({ kind: 'tool', text: '  ↳ saiu com código 1', result: { of: 's1', ok: false, exitCode: 1 } });
    agents.claude.onOwnTurnEvent!({ kind: 'text', text: 'falhou um teste' });
    expect(duo.getState().entries.map((e) => [e.text, e.label])).toEqual([['falhou um teste', true]]);
  });

  it('passos: na conversa retomada, o passo que o duo deixou aberto diz que não terminou', () => {
    const data = newSessionData('/p');
    data.screen.push({ who: 'claude', kind: 'tool', text: '$ npm test', label: true, step: { id: 's1', full: '$ npm test' } });
    const agents = { claude: new FakeAgent('claude', 'Claude'), codex: new FakeAgent('codex', 'Codex') };
    const duo = new Duo({ agents, recorder: new Recorder(data), resumed: true });
    expect(duo.getState().entries.slice(0, 2)).toMatchObject([
      { step: { id: 's1' } },
      { who: 'claude', kind: 'tool', label: false, result: { of: 's1', ok: false, note: 'não terminou' } },
    ]);
    const plain = new Duo({ agents, recorder: new Recorder(newSessionData('/p')) }); // conversa nova: nada a fechar
    expect(plain.getState().entries.some((e) => e.result)).toBe(false);
    // o fim que deu certo, na última linha gravada, não conta como quem falou por último
    const quiet = newSessionData('/p');
    quiet.screen.push(
      { who: 'sistema', kind: 'text', text: 'antes', label: true },
      { who: 'claude', kind: 'tool', text: '  ↳ ok', label: false, result: { of: 's9', ok: true } },
    );
    const back = new Duo({ agents, recorder: new Recorder(quiet), resumed: true });
    back.start();
    expect(back.getState().entries[2]).toMatchObject({ who: 'sistema', text: expect.stringContaining('retomada'), label: false });
  });

  it('pedido de permissão: aparece na janela, a resposta vai pelo id e não vale duas vezes', async () => {
    const { agents, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');

    const asked = agents.claude.askPermission!({ text: 'Bash git push', signal: new AbortController().signal });
    const status = await events.next('status', (s) => s.asks.length === 1);
    const ask = status.asks[0];
    expect(ask).toMatchObject({ who: 'claude', text: 'Bash git push' });

    expect(JSON.parse((await post('/api/answer', { id: ask.id, ok: true })).body)).toEqual({ ok: true });
    await expect(asked).resolves.toBe(true);
    await events.next('entry', (e) => e.text === 'você permitiu: Bash git push');
    await events.next('status', (s) => s.asks.length === 0);
    // respondido (nesta ou em outra janela): a segunda resposta não decide nada
    expect(JSON.parse((await post('/api/answer', { id: ask.id, ok: false })).body)).toEqual({ ok: false });
    expect((await post('/api/answer', { id: 'x', ok: true })).status).toBe(400);
    events.close();
  });

  it('pergunta com opções: chega na janela com as perguntas, e só respostas para todas e nenhuma a mais valem', async () => {
    const { agents, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    const questions = [
      { question: 'Qual cor?', options: [{ label: 'azul' }, { label: 'verde' }] },
      { question: 'Quais sabores?', options: [{ label: 'uva' }], multiSelect: true },
    ];
    const asked = agents.claude.askPermission!({ text: 'AskUserQuestion …', signal: new AbortController().signal, questions });
    const ask = (await events.next('status', (s) => s.asks.length === 1)).asks[0];
    expect(ask.questions).toEqual(questions);

    const answer = async (body: object) => JSON.parse((await post('/api/answer', { id: ask.id, ...body })).body);
    const refused = async (answers?: unknown) => {
      const res = await post('/api/answer', { id: ask.id, ok: true, ...(answers === undefined ? {} : { answers }) });
      return [res.status, res.body];
    };
    const invalid = [400, 'as respostas não servem às perguntas: responda cada uma'];
    expect(await refused()).toEqual(invalid); // responder sem as respostas
    expect(await refused({ 'Qual cor?': 'azul' })).toEqual(invalid); // faltou uma
    expect(await refused({ 'Qual cor?': 'azul', 'Quais sabores?': '  ' })).toEqual(invalid);
    expect(await refused({ 'Qual cor?': 'azul', 'Quais sabores?': 'uva', 'Outra?': 'x' })).toEqual(invalid);
    expect((await refused({ 'Qual cor?': 1 }))[0]).toBe(400);
    expect((await refused(['azul']))[0]).toBe(400);
    // nada disso respondeu: o pedido continua esperando
    let settled = false;
    void asked.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    expect(await answer({ ok: true, answers: { 'Qual cor?': ' roxo ', 'Quais sabores?': 'uva' } })).toEqual({ ok: true });
    await expect(asked).resolves.toEqual({ answers: { 'Qual cor?': 'roxo', 'Quais sabores?': 'uva' } });
    await events.next('entry', (e) => e.text === 'você respondeu: Qual cor? → roxo · Quais sabores? → uva');
    // respondido (aqui ou no terminal): a segunda resposta não decide nada, e não é "pedido inválido"
    expect(await answer({ ok: true, answers: { 'Qual cor?': 'azul', 'Quais sabores?': 'uva' } })).toEqual({ ok: false });
    events.close();
  });

  it('não responder uma pergunta: o agente recebe não, e a conversa diz que você não quis', async () => {
    const { agents, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    const questions = [{ question: 'Qual cor?', options: [{ label: 'azul' }] }];
    const asked = agents.claude.askPermission!({ text: 'AskUserQuestion Qual cor?', signal: new AbortController().signal, questions });
    const ask = (await events.next('status', (s) => s.asks.length === 1)).asks[0];
    expect(JSON.parse((await post('/api/answer', { id: ask.id, ok: false, answers: { 'Qual cor?': 'azul' } })).body)).toEqual({
      ok: true,
    });
    await expect(asked).resolves.toBe(false);
    await events.next('entry', (e) => e.text === 'você não quis responder: AskUserQuestion Qual cor?');
    events.close();
  });

  it('a janela sabe quando tem brain rodando (o botão de parar aparece e some)', async () => {
    const { port, cookie, post } = await setup();
    const events = listen(port, cookie);
    expect((await events.next('snapshot')).brain).toBe(false);
    await post('/api/submit', { text: '/brain /cla qual banco?' });
    await events.next('status', (s) => s.brain === true);
    await events.next('entry', (e) => e.text.startsWith('🧠 sem acordo'));
    await events.next('status', (s) => s.brain === false);
    events.close();
  });

  it('o quadro: o turno rodando, o último sinal e o segundo plano de cada um chegam no status', async () => {
    const { agents, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    const snap = await events.next('snapshot');
    expect(snap.tasks).toEqual({ claude: [], codex: [] });
    expect(snap.runningSince).toEqual({ claude: null, codex: null });

    let release!: () => void;
    agents.claude.gate = new Promise((r) => (release = r));
    const t0 = Date.now();
    await post('/api/submit', { text: '/cla oi' });
    const running = await events.next('status', (s) => s.runningSince.claude !== null);
    expect(running.runningSince.claude).toBeGreaterThanOrEqual(t0);
    expect(running.lastSignal.claude).toBe(running.runningSince.claude); // começar conta como sinal
    expect(running.runningSince.codex).toBeNull();

    const task: AgentTask = { id: 't1', kind: 'subagente', title: 'revisar', detail: 'devil-advocate', startedAt: 1, lastAt: 2 };
    agents.claude.onTasks!([task]);
    await events.next('status', (s) => s.tasks.claude.length === 1 && s.tasks.claude[0].detail === 'devil-advocate');

    // o sinal anda de segundo em segundo, não a cada coisa que chega
    const before = (events.events.filter((e) => e.name === 'status').at(-1)!.data as any).lastSignal.claude;
    await new Promise((r) => setTimeout(r, 1100));
    agents.claude.onSignal!();
    agents.claude.onSignal!();
    const moved = await events.next('status', (s) => s.lastSignal.claude > before);
    expect(moved.lastSignal.claude - before).toBeGreaterThanOrEqual(1000);
    const statuses = () => events.events.filter((e) => e.name === 'status').length;
    const seen = statuses();
    agents.claude.onSignal!();
    agents.claude.onSignal!();
    await new Promise((r) => setTimeout(r, 100));
    expect(statuses()).toBe(seen); // menos de um segundo depois: nada novo

    release();
    await events.next('status', (s) => s.runningSince.claude === null && s.busy.claude === 0);
    agents.claude.onTasks!([]);
    await events.next('status', (s) => s.tasks.claude.length === 0);
    events.close();
  });

  it('o quadro: turno que ele abriu sozinho e mensagem sua se sobrepõem, e ele só para quando os dois acabam', async () => {
    const { agents, duo, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    const claude = agents.claude;
    const state = () => duo.getState();

    claude.onOwnTurnEvent!({ kind: 'text', text: 'TRABALHANDO SOZINHO' });
    const since = state().runningSince.claude;
    expect(since).not.toBeNull();
    expect(state().busy.claude).toBe(0);

    // a sua mensagem entra: ao lê-la, o CLI fecha o turno dele (o adaptador avisa), e o do duo continua rodando
    let release!: () => void;
    claude.gate = new Promise((r) => (release = r));
    await post('/api/submit', { text: '/cla oi' });
    await events.until(() => claude.prompts.length === 1, 'turno do duo');
    claude.onOwnTurnReply!('TRABALHANDO SOZINHO');
    expect(state().runningSince.claude).toBe(since);
    expect(state().busy.claude).toBe(1);

    // outro turno dele começa antes de o do duo fechar (as duas coisas na mesma leva de linhas): segue rodando
    claude.onOwnTurnEvent!({ kind: 'text', text: 'OUTRO TURNO DELE' });
    release();
    await events.until(() => state().busy.claude === 0, 'fim do turno do duo');
    expect(state().runningSince.claude).not.toBeNull();
    claude.onOwnTurnReply!('OUTRO TURNO DELE');
    expect(state().runningSince.claude).toBeNull();

    // /novo no meio de um turno dele (que nunca vai fechar: o processo cai): para de rodar, e não fica preso depois
    claude.onOwnTurnEvent!({ kind: 'text', text: 'TURNO QUE O NOVO CORTA' });
    await post('/api/submit', { text: '/novo' });
    expect(state().runningSince.claude).toBeNull();
    await post('/api/submit', { text: '/cla depois do novo' });
    await events.until(() => claude.prompts.length === 2 && state().busy.claude === 0, 'turno depois do /novo');
    expect(state().runningSince.claude).toBeNull();
    events.close();
  });

  it('turno dele que começa junto com o fim de um turno do duo guarda o modo dele: o privado não vaza', async () => {
    const { agents, duo, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    const { claude, codex } = agents;
    await post('/api/submit', { text: '/privado' });
    let release!: () => void;
    claude.gate = new Promise((r) => (release = r));
    await post('/api/submit', { text: '/cla mensagem privada' });
    await events.until(() => claude.prompts.length === 1, 'turno do duo');

    // o turno dele começa antes de o do duo fechar, ainda no privado (a tarefa que o abriu era compartilhada)
    claude.onOwnTurnEvent!({ kind: 'text', text: 'SEGREDO DO TURNO DELE' });
    release();
    await events.until(() => duo.getState().busy.claude === 0, 'fim do turno do duo');
    await post('/api/submit', { text: '/compartilhado' });
    claude.onOwnTurnReply!('SEGREDO DO TURNO DELE', true);

    await post('/api/submit', { text: '/fog e agora?' });
    await events.until(() => codex.prompts.length === 1, 'turno do Codex');
    expect(codex.prompts[0]).toContain('e agora?');
    expect(codex.prompts[0]).not.toContain('SEGREDO DO TURNO DELE');
    expect(codex.prompts[0]).not.toContain('mensagem privada');
    events.close();
  });

  it('mensagem pelo app no meio de um turno do duo não passa o modo dela para o turno dele seguinte', async () => {
    const { agents, duo, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    const { claude, codex } = agents;
    let release!: () => void;
    claude.gate = new Promise((r) => (release = r));
    await post('/api/submit', { text: '/cla pergunta pública' });
    await events.until(() => claude.prompts.length === 1, 'turno do duo');

    // no compartilhado, pelo app, no meio do turno do duo (é ele quem responde); depois você passa para o privado
    claude.onRemoteMessage!('MENSAGEM PÚBLICA PELO APP', true);
    await post('/api/submit', { text: '/privado' });
    // o turno dele (de uma tarefa compartilhada) começa antes de o do duo fechar, e termina ainda no privado
    claude.onOwnTurnEvent!({ kind: 'text', text: 'SEGREDO DO TURNO DELE' });
    release();
    await events.until(() => duo.getState().busy.claude === 0, 'fim do turno do duo');
    claude.onOwnTurnReply!('SEGREDO DO TURNO DELE', true, false);
    await post('/api/submit', { text: '/compartilhado' });

    await post('/api/submit', { text: '/fog e agora?' });
    await events.until(() => codex.prompts.length === 1, 'turno do Codex');
    expect(codex.prompts[0]).toContain('MENSAGEM PÚBLICA PELO APP');
    expect(codex.prompts[0]).not.toContain('SEGREDO DO TURNO DELE');
    events.close();
  });

  it('mensagem pelo app que entrou num turno do duo não conta para o turno dele que responde outra', async () => {
    const { agents, duo, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    const { claude, codex } = agents;
    let release!: () => void;
    claude.gate = new Promise((r) => (release = r));
    await post('/api/submit', { text: '/cla pergunta pública' });
    await events.until(() => claude.prompts.length === 1, 'turno do duo');
    await post('/api/submit', { text: '/privado' });
    claude.onRemoteMessage!('PRIVADA NO TURNO DO DUO', true);
    release();
    await events.until(() => duo.getState().busy.claude === 0, 'fim do turno do duo');
    await post('/api/submit', { text: '/compartilhado' });

    // depois, no compartilhado, outra pelo app abre um turno dele: a resposta é pública
    claude.onRemoteMessage!('PÚBLICA PELO APP', false);
    claude.onOwnTurnEvent!({ kind: 'text', text: 'RESPOSTA PÚBLICA AO APP' });
    claude.onOwnTurnReply!('RESPOSTA PÚBLICA AO APP', undefined, true);

    await post('/api/submit', { text: '/fog e agora?' });
    await events.until(() => codex.prompts.length === 1, 'turno do Codex');
    expect(codex.prompts[0]).not.toContain('PRIVADA NO TURNO DO DUO');
    expect(codex.prompts[0]).toContain('RESPOSTA PÚBLICA AO APP');
    events.close();
  });

  it('mensagem pelo app que o CLI respondeu junto com a do duo não dá o modo dela a um turno dele de tarefa', async () => {
    const { agents, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    const { claude, codex } = agents;
    // lida antes de a do duo começar (o adaptador não sabe ainda de quem é), e respondida junto com ela
    claude.onRemoteMessage!('PÚBLICA LIDA ANTES', false);
    await post('/api/submit', { text: '/cla pergunta pública' });
    await events.until(() => claude.prompts.length === 1, 'turno do duo');
    // depois, no privado, uma tarefa abre um turno dele: o adaptador diz que nenhuma mensagem do app era desse turno
    await post('/api/submit', { text: '/privado' });
    claude.onOwnTurnEvent!({ kind: 'text', text: 'SEGREDO DA TAREFA' });
    claude.onOwnTurnReply!('SEGREDO DA TAREFA', true, false);
    await post('/api/submit', { text: '/compartilhado' });

    await post('/api/submit', { text: '/fog e agora?' });
    await events.until(() => codex.prompts.length === 1, 'turno do Codex');
    expect(codex.prompts[0]).toContain('PÚBLICA LIDA ANTES');
    expect(codex.prompts[0]).not.toContain('SEGREDO DA TAREFA');
    events.close();
  });

  it('turno dele que responde a mensagem pelo app: leva o modo de quando ela chegou', async () => {
    const { agents, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    const { claude, codex } = agents;

    // pelo app no privado; o turno que responde começa e termina já no compartilhado
    await post('/api/submit', { text: '/privado' });
    claude.onRemoteMessage!('PERGUNTA PRIVADA PELO APP', false);
    await post('/api/submit', { text: '/compartilhado' });
    claude.onOwnTurnEvent!({ kind: 'text', text: 'RESPOSTA PRIVADA' });
    claude.onOwnTurnReply!('RESPOSTA PRIVADA', undefined, true);
    // pelo app no compartilhado: a resposta é pública, mesmo com algo privado antes nesta conversa
    claude.onRemoteMessage!('PERGUNTA PÚBLICA PELO APP', false);
    claude.onOwnTurnEvent!({ kind: 'text', text: 'RESPOSTA PÚBLICA' });
    claude.onOwnTurnReply!('RESPOSTA PÚBLICA', undefined, true);

    await post('/api/submit', { text: '/fog e agora?' });
    await events.until(() => codex.prompts.length === 1, 'turno do Codex');
    expect(codex.prompts[0]).not.toContain('PERGUNTA PRIVADA PELO APP');
    expect(codex.prompts[0]).not.toContain('RESPOSTA PRIVADA');
    expect(codex.prompts[0]).toContain('PERGUNTA PÚBLICA PELO APP');
    expect(codex.prompts[0]).toContain('RESPOSTA PÚBLICA');
    events.close();
  });

  it('/sair pela janela: avisa, fecha a ligação e encerra os agentes', async () => {
    const { agents, duo, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    let quit = false;
    duo.subscribe((ev) => {
      if (ev.type === 'quit') quit = true;
    });
    await post('/api/submit', { text: '/sair' });
    await events.next('quit');
    await events.until(events.ended, 'fim do /events');
    expect(quit).toBe(true);
    expect(agents.claude.disposed).toBe(1);
    expect(agents.codex.disposed).toBe(1);
  });
});

describe('janela: print colado', () => {
  it('vai para o disco e para o agente; a janela mostra de volta pelo nome, e só com o cookie', async () => {
    const { agents, port, cookie, post, imagesDir } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');

    const res = await post('/api/submit', { text: 'olha isso', images: [{ mediaType: 'image/png', data: PNG }] });
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    const entry = await events.next('entry', (e) => e.who === 'voce');
    expect(entry.text).toBe('olha isso');
    expect(entry.images).toHaveLength(1);
    const name = entry.images[0];
    expect(name).toMatch(/^[0-9a-f]{32}\.png$/);

    // o agente recebe o caminho do arquivo gravado; o texto diz que tem print
    await events.until(() => agents.claude.images.length === 1, 'turno do Claude');
    expect(agents.claude.images[0]).toEqual([{ path: path.join(imagesDir, name), mediaType: 'image/png' }]);
    expect(fs.readFileSync(path.join(imagesDir, name))).toEqual(Buffer.from(PNG, 'base64'));
    expect(agents.claude.prompts[0]).toContain('olha isso');
    expect(agents.claude.prompts[0]).toContain('[um print colado pelo usuário]');

    const img = await request(port, { path: `/imagem/${name}`, headers: { Cookie: cookie } });
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect((await request(port, { path: `/imagem/${name}` })).status).toBe(403);
    expect((await request(port, { path: `/imagem/${'0'.repeat(32)}.png`, headers: { Cookie: cookie } })).status).toBe(404);
    expect((await request(port, { path: '/imagem/..%2Fapp.js', headers: { Cookie: cookie } })).status).toBe(404);
    events.close();
  });

  it('print sozinho vai para o destino; junto de um comando do duo não vai, e não fica no disco', async () => {
    const { agents, port, cookie, post, imagesDir } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    const one = [{ mediaType: 'image/png', data: PNG }];

    expect(JSON.parse((await post('/api/submit', { text: '', images: one })).body)).toEqual({ ok: true });
    await events.until(() => agents.claude.images.length === 1, 'turno do Claude');
    expect(agents.claude.prompts[0]).toContain('[um print colado pelo usuário]');
    expect(agents.codex.images).toHaveLength(0);

    // "@fog" sozinho com o print: vai para o Codex (e ele vira o destino)
    expect(JSON.parse((await post('/api/submit', { text: '@fog', images: [...one, ...one] })).body)).toEqual({ ok: true });
    await events.until(() => agents.codex.images.length === 1, 'turno do Codex');
    expect(agents.codex.images[0]).toHaveLength(2);
    expect(agents.codex.prompts[0]).toContain('[2 prints colados pelo usuário]');
    expect(filesIn(imagesDir)).toHaveLength(3);

    expect(JSON.parse((await post('/api/submit', { text: '/limpar', images: one })).body)).toEqual({ ok: false });
    await events.next('entry', (e) => e.who === 'sistema' && e.text.includes('o print vai junto de uma mensagem'));
    expect(JSON.parse((await post('/api/submit', { text: '/xyz', images: one })).body)).toEqual({ ok: false });
    await events.next('entry', (e) => e.who === 'sistema' && e.text.startsWith('comando desconhecido'));
    expect(filesIn(imagesDir)).toHaveLength(3); // os recusados não ficaram
    events.close();
  });

  it('o disco falha no meio, ou o duo dá erro: nenhum print daquela mensagem fica no disco', async () => {
    const { agents, duo, post, imagesDir } = await setup();
    const two = [{ mediaType: 'image/png', data: PNG }, { mediaType: 'image/png', data: PNG }];
    const write = fs.writeFileSync;
    let calls = 0;
    const disk = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data) => {
      if (++calls < 2) return write(file, data);
      write(file, 'pela metade'); // o segundo começa a gravar e o disco enche
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    try {
      expect((await post('/api/submit', { text: 'dois prints', images: two })).status).toBe(500);
    } finally {
      disk.mockRestore();
    }
    expect(calls).toBe(2);
    expect(filesIn(imagesDir)).toHaveLength(0);

    const broken = vi.spyOn(duo, 'submit').mockImplementation(() => {
      throw new Error('quebrou');
    });
    try {
      expect((await post('/api/submit', { text: 'dois prints', images: two })).status).toBe(500);
    } finally {
      broken.mockRestore();
    }
    expect(filesIn(imagesDir)).toHaveLength(0);
    expect(agents.claude.prompts).toHaveLength(0);
  });

  it('print que não é imagem do tipo que diz ser, ou demais, não passa', async () => {
    const { agents, post, imagesDir } = await setup();
    const bad = async (images: unknown) => (await post('/api/submit', { text: 'x', images })).status;
    expect(await bad([{ mediaType: 'image/svg+xml', data: PNG }])).toBe(400);
    expect(await bad([{ mediaType: 'image/jpeg', data: PNG }])).toBe(400); // é PNG
    expect(await bad([{ mediaType: 'image/png', data: Buffer.from('<svg/>').toString('base64') }])).toBe(400);
    expect(await bad([{ mediaType: 'image/png', data: 'não é base64!' }])).toBe(400);
    expect(await bad([{ mediaType: 'image/png', data: '' }])).toBe(413);
    expect(await bad(Array(6).fill({ mediaType: 'image/png', data: PNG }))).toBe(400);
    expect(await bad('x')).toBe(400);
    const big = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(3_800_000)]).toString('base64');
    expect(await bad([{ mediaType: 'image/png', data: big }])).toBe(413);
    expect(agents.claude.prompts).toHaveLength(0);
    expect(filesIn(imagesDir)).toHaveLength(0);
  });
});

describe('janela: seletor de modelo', () => {
  const list = (): AgentModel[] => [
    { id: 'a', resolved: 'modelo-a', name: 'A', description: 'o primeiro', efforts: ['low', 'high', 'max'], defaultEffort: 'low', fast: true },
    { id: 'b', resolved: 'modelo-b', name: 'B', description: 'o segundo', efforts: ['low'], defaultEffort: 'low', fast: false },
  ];
  /** o Codex com a lista e o que vale agora, como o adaptador avisa */
  const ready = (agent: FakeAgent, stats: Partial<AgentStats>) => {
    agent.models = list();
    agent.onModels?.(agent.models);
    agent.stats = { subagents: 0, ...stats };
    agent.onStats?.({ ...agent.stats });
  };
  const last = (duo: Duo) => duo.getState().entries.at(-1);

  it('a lista chega na janela, e a troca vai para o agente e aparece na conversa', async () => {
    const { agents, duo, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    ready(agents.codex, { model: 'modelo-a', effort: 'high', fast: true });
    expect(await events.next('models')).toEqual({ claude: [], codex: list() });

    expect((await post('/api/modelo', { agent: 'codex', effort: 'max' })).status).toBe(200);
    await vi.waitFor(() => expect(last(duo)).toMatchObject({ who: 'sistema', kind: 'text', text: 'modelo do Codex agora: A · max · rápido' }));
    expect(agents.codex.choices).toEqual([{ effort: 'max' }]);
    await events.next('status', (s) => s.stats.codex.effort === 'max');

    await post('/api/modelo', { agent: 'codex', fast: false });
    await vi.waitFor(() => expect(last(duo)?.text).toBe('modelo do Codex agora: A · max'));
    expect(agents.codex.prompts).toEqual([]); // nenhuma troca virou mensagem
    events.close();
  });

  it('trocar de modelo leva junto o que o novo não tem: o esforço vai para o padrão dele, e o rápido desliga', async () => {
    const { agents, duo, post } = await setup();
    ready(agents.codex, { model: 'modelo-a', effort: 'high', fast: true });
    await post('/api/modelo', { agent: 'codex', model: 'b' });
    await vi.waitFor(() => expect(last(duo)?.text).toBe('modelo do Codex agora: B · low'));
    expect(agents.codex.choices).toEqual([{ model: 'b', effort: 'low', fast: false }]);
    // o que o novo tem fica como está
    await post('/api/modelo', { agent: 'codex', model: 'a' });
    await vi.waitFor(() => expect(agents.codex.choices).toHaveLength(2));
    expect(agents.codex.choices[1]).toEqual({ model: 'a' });
  });

  it('o que ele não oferece não chega nele, e a conversa diz por quê', async () => {
    const { agents, duo, post } = await setup();
    ready(agents.codex, { model: 'modelo-a', effort: 'high' });
    const refused = async (body: object, why: string) => {
      expect((await post('/api/modelo', body)).status).toBe(200);
      await vi.waitFor(() => expect(last(duo)).toMatchObject({ who: 'sistema', kind: 'error', text: why }));
    };
    await refused({ agent: 'codex', model: 'z' }, 'não troquei o modelo do Codex: ele não oferece z');
    await refused({ agent: 'codex', effort: 'ultra' }, 'não troquei o modelo do Codex: o A não tem o esforço ultra');
    await refused({ agent: 'codex', model: 'b', effort: 'max' }, 'não troquei o modelo do Codex: o B não tem o esforço max');
    await refused({ agent: 'codex', model: 'b', fast: true }, 'não troquei o modelo do Codex: o B não tem modo rápido');
    await refused({ agent: 'claude', effort: 'low' }, 'não troquei o modelo do Claude: a lista de modelos dele ainda não carregou');
    expect(agents.codex.choices).toEqual([]);
    expect(agents.claude.choices).toEqual([]);
  });

  it('troca pedida antes de a anterior terminar confere contra o que a anterior deixou', async () => {
    const { agents, duo, post } = await setup();
    ready(agents.codex, { model: 'modelo-a', effort: 'high' });
    let release!: () => void;
    agents.codex.modelGate = new Promise<void>((r) => (release = r));
    await post('/api/modelo', { agent: 'codex', model: 'b' }); // fica esperando o CLI
    await post('/api/modelo', { agent: 'codex', effort: 'high' }); // valia no A, não vale no B
    expect(agents.codex.choices).toEqual([{ model: 'b', effort: 'low' }]);
    release();
    await vi.waitFor(() =>
      expect(last(duo)).toMatchObject({ kind: 'error', text: 'não troquei o modelo do Codex: o B não tem o esforço high' }),
    );
    expect(agents.codex.choices).toHaveLength(1);
  });

  it('o chip mostra o modelo que o CLI diz que está em uso, mesmo trocado por fora do seletor', async () => {
    const { agents } = await setup();
    ready(agents.codex, { model: 'modelo-b', selected: 'a', effort: 'low' }); // escolheu A, e um /model mandado por fora pôs o B
    expect(currentModel(agents.codex.models, agents.codex.stats)?.id).toBe('b');
    expect(modelLabel(agents.codex.models, agents.codex.stats)).toBe('B · low');
    ready(agents.codex, { model: 'modelo-a', selected: 'a' });
    expect(currentModel(agents.codex.models, agents.codex.stats)?.id).toBe('a');
  });

  it('o agente recusa: o motivo aparece na conversa', async () => {
    const { agents, duo, post } = await setup();
    ready(agents.codex, { model: 'modelo-a', effort: 'high' });
    agents.codex.modelFails = 'not_found';
    await post('/api/modelo', { agent: 'codex', model: 'b' });
    await vi.waitFor(() =>
      expect(last(duo)).toMatchObject({ who: 'sistema', kind: 'error', text: 'não troquei o modelo do Codex: not_found' }),
    );
  });

  it('pedido malformado: 400, e nada chega no agente', async () => {
    const { agents, post } = await setup();
    ready(agents.codex, { model: 'modelo-a', effort: 'high' });
    for (const body of [
      { agent: 'outro', model: 'a' },
      { agent: 'codex' },
      { agent: 'codex', model: '' },
      { agent: 'codex', effort: 7 },
      { agent: 'codex', fast: 'sim' },
      { agent: 'codex', model: 'a'.repeat(201) },
    ]) {
      expect((await post('/api/modelo', body)).status).toBe(400);
    }
    expect(agents.codex.choices).toEqual([]);
  });
});

describe('janela: parar só um agente', () => {
  /** espera o estado ATUAL do duo passar no filtro: o `next` acha qualquer status desde o começo, e o inicial
   * (livre, sem parar nada) já passaria nas esperas de "voltou ao normal" */
  const now = (events: ReturnType<typeof listen>, duo: Duo, pick: (s: ReturnType<Duo['getState']>) => boolean) =>
    events.until(() => pick(duo.getState()), 'o estado esperado');

  it('para o turno e a fila só dele; o outro segue, e a próxima mensagem dele vai', async () => {
    const { agents, duo, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    let openCodex!: () => void;
    agents.claude.gate = new Promise(() => undefined);
    agents.codex.gate = new Promise((r) => (openCodex = r));
    await post('/api/submit', { text: '@todos um' });
    await post('/api/submit', { text: '@cla dois' });
    await events.next('status', (s) => s.busy.claude === 2 && s.runningSince.claude !== null);

    expect(JSON.parse((await post('/api/parar', { agent: 'claude' })).body)).toEqual({ ok: true });
    await events.next(
      'entry',
      (e) => e.text === 'você parou o Claude: o que ele estava fazendo e a mensagem na fila dele. A conversa continua.',
    );
    await now(events, duo, (s) => s.busy.claude === 0 && s.runningSince.claude === null && !s.stopping.claude);
    expect(agents.claude.interrupts).toBe(1);
    expect(agents.claude.prompts).toHaveLength(1); // a da fila nem foi
    expect(events.events.some((e) => e.name === 'entry' && e.data.who === 'claude' && e.data.kind === 'error')).toBe(false);
    const turns = (duo as any).rec.data.turns.filter((t: any) => t.agent === 'claude');
    expect(turns.map((t: any) => t.status)).toEqual(['cancelled', 'cancelled']);

    openCodex(); // o outro não foi parado
    await events.next('entry', (e) => e.who === 'codex' && e.text === 'Codex responde 1');
    agents.claude.gate = undefined;
    await post('/api/submit', { text: '@cla de novo' });
    await events.next('entry', (e) => e.who === 'claude' && e.text === 'Claude responde 2');
    events.close();
  });

  it('enquanto o turno não fecha, o quadro diz que está parando', async () => {
    const { agents, duo, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    agents.claude.gate = new Promise(() => undefined);
    agents.claude.slowStop = true;
    await post('/api/submit', { text: '@cla um' });
    await events.next('status', (s) => s.runningSince.claude !== null);
    await post('/api/parar', { agent: 'claude' });
    await events.next('status', (s) => s.stopping.claude === true && s.runningSince.claude !== null);
    agents.claude.finishStop();
    await now(events, duo, (s) => s.stopping.claude === false && s.runningSince.claude === null);
    events.close();
  });

  it('pedido inválido não chega ao duo; parar quem está livre só avisa', async () => {
    const { agents, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    expect((await post('/api/parar', { agent: 'gemini' })).status).toBe(400);
    expect((await post('/api/parar', {})).status).toBe(400);
    expect(JSON.parse((await post('/api/parar', { agent: 'codex' })).body)).toEqual({ ok: true });
    await events.next('entry', (e) => e.kind === 'error' && e.text === 'o Codex não está rodando nada.');
    expect(agents.codex.interrupts).toBe(0);
    events.close();
  });

  it('o motivo da espera: a ferramenta rodando, e quem espera o outro (até ser parado)', async () => {
    const { agents, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    agents.claude.onTools?.([{ id: 't1', text: 'Bash npm test', startedAt: 1 }]);
    await events.next('status', (s) => s.tools.claude[0]?.text === 'Bash npm test');

    let openCodex!: () => void;
    agents.codex.gate = new Promise((r) => (openCodex = r));
    const ctrl = new AbortController();
    const asked = agents.claude.askPeer!({ text: 'revisa', signal: ctrl.signal }).catch((e: Error) => e);
    await events.next('status', (s) => typeof s.peerWait.claude === 'number' && s.runningSince.codex !== null);
    ctrl.abort(); // você parou o Claude: deixa de esperar já, com o Codex ainda respondendo
    await events.next('status', (s) => s.peerWait.claude === null && s.runningSince.codex !== null);
    openCodex();
    expect(await asked).toBe('Codex responde 1');
    events.close();
  });

  it('parar quem foi chamado: quem chamou recebe na hora que você o parou, sem esperar o CLI parar', async () => {
    const { agents, duo, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    agents.codex.gate = new Promise(() => undefined);
    agents.codex.slowStop = true;
    const asked = agents.claude.askPeer!({ text: 'revisa', signal: new AbortController().signal }).catch((e: Error) => e);
    await events.next('status', (s) => s.runningSince.codex !== null);
    await post('/api/parar', { agent: 'codex' });
    expect(((await asked) as Error).message).toBe('o usuário parou o Codex antes de ele responder');
    expect((duo as any).state.stopping.codex).toBe(true); // o turno dele ainda não fechou
    await now(events, duo, (s) => s.peerWait.claude === null);
    agents.codex.finishStop();
    events.close();
  });

  it('parar no brain: o brain para dizendo que foi você', async () => {
    const { agents, duo, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    agents.claude.gate = new Promise(() => undefined);
    await post('/api/submit', { text: '/brain /cla qual banco?' });
    await events.next('status', (s) => s.runningSince.claude !== null);
    await post('/api/parar', { agent: 'claude' });
    await events.next('entry', (e) => e.text === '🧠 brain parou: você parou o Claude.');
    await now(events, duo, (s) => s.brain === false);
    expect(agents.codex.prompts).toHaveLength(0);
    events.close();
  });

  it('o brain para no clique, sem esperar o turno fechar; a resposta que chega depois não segue', async () => {
    const { agents, duo, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    let open!: () => void;
    agents.claude.gate = new Promise((r) => (open = r));
    agents.claude.slowStop = true;
    await post('/api/submit', { text: '/brain /cla qual banco?' });
    await events.next('status', (s) => s.runningSince.claude !== null);
    await post('/api/parar', { agent: 'claude' });
    await events.next('entry', (e) => e.text === '🧠 brain parou: você parou o Claude.');
    await now(events, duo, (s) => s.brain === false && s.stopping.claude); // o turno dele ainda não fechou
    open(); // o CLI respondeu antes de parar
    await events.next('entry', (e) => e.who === 'claude' && e.text === 'Claude responde 1');
    await now(events, duo, (s) => s.runningSince.claude === null);
    expect(agents.codex.prompts).toHaveLength(0);
    events.close();
  });

  it('turno que ele abriu sozinho começando pela ferramenta do duo: aparece rodando, e o Parar o alcança', async () => {
    const { agents, duo, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    agents.codex.gate = new Promise(() => undefined);
    void agents.claude.askPeer!({ text: 'revisa', signal: new AbortController().signal }).catch(() => undefined);
    await events.next('status', (s) => s.runningSince.claude !== null && typeof s.peerWait.claude === 'number');
    await post('/api/parar', { agent: 'claude' });
    await events.next('status', (s) => s.stopping.claude === true);
    expect(agents.claude.interrupts).toBe(1);
    agents.claude.onOwnTurnReply!(''); // o turno parado fecha
    await now(events, duo, (s) => s.runningSince.claude === null && !s.stopping.claude);
    events.close();
  });

  it('mensagem nova enquanto o turno parado fecha: o "parando" é só do turno parado', async () => {
    const { agents, duo, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    agents.claude.onOwnTurnEvent!({ kind: 'text', text: 'sozinho' });
    await events.next('status', (s) => s.runningSince.claude !== null);
    await post('/api/parar', { agent: 'claude' });
    await events.next('status', (s) => s.stopping.claude === true);
    agents.claude.gate = new Promise(() => undefined);
    await post('/api/submit', { text: '@cla nova' });
    await vi.waitFor(() => expect(agents.claude.prompts).toHaveLength(1));
    agents.claude.onOwnTurnReply!(''); // o turno parado fecha; o da mensagem nova segue
    await now(events, duo, (s) => s.stopping.claude === false && s.runningSince.claude !== null);
    events.close();
  });

  it('a falha atrasada de um parar antigo não desfaz o parar seguinte', async () => {
    const { agents, duo, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    let open!: () => void;
    let release!: () => void;
    agents.claude.gate = new Promise((r) => (open = r));
    agents.claude.interruptGate = new Promise((r) => (release = r));
    agents.claude.interruptFails = 'caiu';
    await post('/api/submit', { text: '@cla um' });
    await events.next('status', (s) => s.runningSince.claude !== null);
    await post('/api/parar', { agent: 'claude' });
    open(); // o turno fecha antes de o pedido de parar responder
    await now(events, duo, (s) => s.runningSince.claude === null && !s.stopping.claude);
    agents.claude.gate = new Promise(() => undefined);
    agents.claude.interruptGate = new Promise(() => undefined); // o segundo pedido ainda não respondeu
    await post('/api/submit', { text: '@cla dois' });
    await now(events, duo, (s) => s.runningSince.claude !== null);
    await post('/api/parar', { agent: 'claude' });
    await now(events, duo, (s) => s.stopping.claude);
    release(); // o primeiro pedido falha agora
    await new Promise((r) => setTimeout(r, 50));
    expect(duo.getState().stopping.claude).toBe(true);
    expect(events.events.some((e) => e.name === 'entry' && /não consegui parar/.test(e.data.text))).toBe(false);
    events.close();
  });

  it('o erro de um parar que demorou não aparece na conversa nova', async () => {
    const { agents, duo, port, cookie, post } = await setup();
    const events = listen(port, cookie);
    await events.next('snapshot');
    let release!: () => void;
    agents.claude.gate = new Promise(() => undefined);
    agents.claude.interruptGate = new Promise((r) => (release = r));
    agents.claude.interruptFails = 'caiu';
    await post('/api/submit', { text: '@cla um' });
    await events.next('status', (s) => s.runningSince.claude !== null);
    await post('/api/parar', { agent: 'claude' });
    await post('/api/submit', { text: '/novo' });
    await now(events, duo, (s) => s.runningSince.claude === null && !s.stopping.claude);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(events.events.some((e) => e.name === 'entry' && /não consegui parar/.test(e.data.text))).toBe(false);
    events.close();
  });
});
