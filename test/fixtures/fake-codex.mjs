// Codex falso para os testes: fala o protocolo do `codex app-server` (JSON-RPC por linhas).
// Os erros imitam os do codex real (medidos em 02/11/2026, 0.166.0):
//   resume sumiu   → -32600 "no rollout found for thread id sumiu"
//   resume ruim    → -32600 "invalid session id: …"
//   resume ocupada → -32600 "thread ocupada already has an active writer"
// Prompts especiais: PID (responde o pid), PARAMS (devolve os parâmetros da conversa), CMD (roda um
// "comando" que sai com 1), PEDE (pede aprovação ao cliente), FALHA (turno falha), QUEBRA (escreve e cai),
// AGENTE / FIM (um subagente começa / termina), INIT (devolve os parâmetros do initialize),
// CHAMA <texto> (usa a ferramenta do cliente, se o thread/start a trouxe em dynamicTools: pedido item/tool/call,
// como o 0.166.0). Todo turno manda o uso de tokens da conversa.
// skills/list → duas skills, uma desligada, como o 0.166.0. Turno com o item {type:"skill"} responde
// "eco: [skill <nome>] <texto>". Turno com itens {type:"localImage"} acrescenta " | imagens: <caminhos>".
// Cada turno tem id próprio (turno-1, turno-2...), como o real. Pedido antes do initialize → "Not initialized".
// --init-delay <ms> → demora para responder o initialize (o real leva ~1s subindo).
// INTRUSO → antes da resposta, chegam um item e um turn/completed de OUTRO turno (um que estourou o prazo).
// ANTES → os eventos do turno saem antes da resposta do turn/start.
// DEMORA → a resposta do turn/start atrasa 400ms; o turno demorado só responde se não for interrompido.
// INTERROMPIDOS → responde com os ids dos turnos que receberam turn/interrupt.
// ATRASA <texto> → a resposta do turn/start atrasa 600ms; aos 300ms o turno chama a ferramenta do cliente com <texto>.
// RESPOSTAS → responde com o que o cliente devolveu às chamadas da ferramenta feitas pelo ATRASA.
// --thread-delay <ms> → demora para responder o thread/start e o thread/resume.
// LONGO <comando> → um commandExecution que demora 2s. turn/interrupt no meio dele (ou do CHAMA esperando a resposta
// da ferramenta) fecha o turno como interrompido, na hora. RESPOSTAS também traz o que o cliente devolveu ao CHAMA.
// model/list → três modelos em duas páginas (nextCursor), um deles escondido, como o 0.166.0: esforços, o padrão e
// os serviceTiers (o "priority", de nome "Fast"). config/read → o que o config.toml diz (esforço high, tier
// priority, sem modelo). O thread/start responde com model, reasoningEffort e serviceTier. TURNO → responde com o
// model, o effort e o serviceTier que vieram no turn/start deste turno.
// PASSOS → os passos como o 0.166.0 (03/11/2026): um comando que dá certo e um que falha (status "failed", exitCode 1,
// como o PowerShell devolve), os dois no invólucro do Windows com as aspas de dentro como \"; um comando recusado que
// só aparece no item/completed; um fileChange que cria, altera, apaga e move arquivos da pasta; um mcpToolCall que
// falha (com a mensagem comprida) e uma busca na web. Medidos rodando: os dois comandos e o fileChange que cria e
// altera; o resto segue a forma do esquema do próprio CLI (`codex app-server generate-ts`). Responde "fim".
// CAI → um comando começa, e o processo cai antes do fim dele.
// SOLTO → um comando começa e o turno acaba (completed) sem o item/completed dele.
import path from 'node:path';
import readline from 'node:readline';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const argv = process.argv.slice(2);
const initDelay = Number(argv[argv.indexOf('--init-delay') + 1]) || 0;
const threadDelay = Number(argv[argv.indexOf('--thread-delay') + 1]) || 0;
let thread = null; // conversa aberta neste processo
let threadParams = null;
let initParams = null;
let initialized = false;
let tools = []; // ferramentas do cliente: só o thread/start traz (o resume ignora, como o real)
let next = 1000;
let turns = 0;
const interrupted = [];
const toolReplies = []; // o que o cliente devolveu às chamadas do ATRASA
const waiting = new Map(); // respostas do cliente a pedidos do servidor
const cancel = new Map(); // turnos que podem ser interrompidos, por id

let images = [];
let overrides = {}; // model, effort e serviceTier do último turn/start
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) return waiting.get(msg.id)?.(msg);
  const { id, method, params = {} } = msg;
  const reply = (result) => out({ id, result });
  const fail = (message) => out({ id, error: { code: -32600, message } });
  if (method === 'initialize') {
    initParams = params;
    return setTimeout(() => {
      initialized = true;
      reply({ userAgent: 'codex-falso' });
    }, initDelay);
  }
  if (method === 'initialized') return;
  if (!initialized) return id !== undefined && fail('Not initialized');
  switch (method) {
    case 'skills/list': {
      const skill = (name, enabled) => ({ name, description: `a skill ${name}`, path: `C:/skills/${name}/SKILL.md`, enabled, scope: 'user' });
      return reply({ data: [{ cwd: params.cwds?.[0], skills: [skill('revisar', true), skill('desligada', false)], errors: [] }] });
    }
    case 'model/list': {
      const efforts = (list) => list.map((reasoningEffort) => ({ reasoningEffort, description: `esforço ${reasoningEffort}` }));
      const fast = [{ id: 'priority', name: 'Fast', description: 'mais rápido' }];
      const all = [
        { id: 'gpt-falso', model: 'gpt-falso', displayName: 'GPT Falso', description: 'o de sempre', hidden: false, isDefault: true, supportedReasoningEfforts: efforts(['low', 'high']), defaultReasoningEffort: 'low', serviceTiers: fast },
        { id: 'gpt-escondido', model: 'gpt-escondido', displayName: 'Escondido', description: '', hidden: true, isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'low', serviceTiers: [] },
        { id: 'gpt-mini', model: 'gpt-mini', displayName: 'GPT Mini', description: 'o pequeno', hidden: false, isDefault: false, supportedReasoningEfforts: efforts(['medium']), defaultReasoningEffort: 'medium', serviceTiers: [] },
      ];
      return reply(params.cursor === 'p2' ? { data: all.slice(2), nextCursor: null } : { data: all.slice(0, 2), nextCursor: 'p2' });
    }
    case 'config/read':
      return reply({ config: { model: null, model_reasoning_effort: 'high', service_tier: 'priority' }, origins: {}, layers: null });
    case 'thread/start':
      thread = 'thread-nova';
      threadParams = params;
      tools = params.dynamicTools ?? [];
      return setTimeout(() => reply({ thread: { id: thread }, model: 'gpt-falso', reasoningEffort: 'high', serviceTier: 'priority' }), threadDelay);
    case 'thread/resume':
      if (params.threadId === 'sumiu') return fail('no rollout found for thread id sumiu');
      if (params.threadId === 'ruim') return fail('invalid session id: invalid character: found `r` at 1');
      if (params.threadId === 'ocupada') return fail('thread ocupada already has an active writer');
      thread = params.threadId;
      threadParams = params;
      return setTimeout(() => reply({ thread: { id: thread } }), threadDelay);
    case 'turn/interrupt':
      interrupted.push(params.turnId);
      reply({});
      return cancel.get(params.turnId)?.();
    case 'turn/start': {
      if (params.threadId !== thread) return fail(`thread not loaded: ${params.threadId}`);
      const turnId = `turno-${++turns}`;
      const text = params.input?.[0]?.text ?? '';
      const skill = params.input?.find((i) => i.type === 'skill');
      images = (params.input ?? []).filter((i) => i.type === 'localImage').map((i) => i.path);
      overrides = { model: params.model, effort: params.effort, serviceTier: params.serviceTier };
      if (text === 'DEMORA') return slowTurn(id, turnId);
      if (text.startsWith('ATRASA ')) return lateCall(id, turnId, text.slice(7));
      if (text === 'ANTES') {
        void runTurn(turnId, text, skill); // os eventos saem antes da resposta
        return reply({ turn: { id: turnId, status: 'inProgress' } });
      }
      reply({ turn: { id: turnId, status: 'inProgress' } });
      return runTurn(turnId, text, skill);
    }
    default:
      return out({ id, error: { code: -32601, message: `método desconhecido: ${method}` } });
  }
});

const note = (method, params) => out({ method, params: { threadId: thread, ...params } });

/** Espera `p`, ou o turn/interrupt deste turno: aí o turno fecha como interrompido e devolve null. */
function stoppable(turnId, p) {
  return new Promise((resolve) => {
    cancel.set(turnId, () => {
      cancel.delete(turnId);
      note('turn/completed', { turn: { id: turnId, status: 'interrupted' } });
      resolve(null);
    });
    p.then((v) => cancel.delete(turnId) && resolve(v));
  });
}

/** A resposta do turn/start atrasa; o turno só responde se ninguém o interromper antes. */
function slowTurn(reqId, turnId) {
  let stopped = false;
  cancel.set(turnId, () => {
    stopped = true;
    note('turn/completed', { turn: { id: turnId, status: 'interrupted' } });
  });
  setTimeout(() => {
    out({ id: reqId, result: { turn: { id: turnId, status: 'inProgress' } } });
    setTimeout(() => {
      if (stopped) return;
      note('item/completed', { turnId, item: { id: 'm', type: 'agentMessage', text: 'RESPOSTA-DEMORADA' } });
      note('turn/completed', { turn: { id: turnId, status: 'completed' } });
    }, 300);
  }, 400);
}

/**
 * A resposta do turn/start atrasa; antes dela (e depois do prazo do cliente), o turno chama a ferramenta do cliente.
 * turn/interrupt fecha o turno como interrompido.
 */
function lateCall(reqId, turnId, mensagem) {
  cancel.set(turnId, () => {
    cancel.delete(turnId);
    note('turn/completed', { turn: { id: turnId, status: 'interrupted' } });
  });
  setTimeout(async () => {
    const callId = next++;
    const res = await new Promise((resolve) => {
      waiting.set(callId, resolve);
      const params = { threadId: thread, turnId, callId: 'call-atrasada', namespace: null, tool: 'falar_com_claude', arguments: { mensagem } };
      out({ id: callId, method: 'item/tool/call', params });
    });
    toolReplies.push(res.result ?? res.error);
  }, 300);
  setTimeout(() => out({ id: reqId, result: { turn: { id: turnId, status: 'inProgress' } } }), 600);
}

async function runTurn(turnId, text, skill) {
  const item = (method, it) => note(method, { turnId, item: it });
  const message = (t) => item('item/completed', { id: 'm', type: 'agentMessage', text: t });
  note('turn/started', { turn: { id: turnId } });
  let answer = skill ? `eco: [skill ${skill.name} ${skill.path}] ${text}` : `eco: ${text}`;
  if (images.length > 0) answer += ` | imagens: ${images.join(', ')}`;
  if (text === 'PID') answer = `pid ${process.pid}`;
  if (text === 'PARAMS') answer = JSON.stringify(threadParams);
  if (text === 'INIT') answer = JSON.stringify(initParams);
  if (text === 'INTERROMPIDOS') answer = JSON.stringify(interrupted);
  if (text === 'RESPOSTAS') answer = JSON.stringify(toolReplies);
  if (text === 'TURNO') answer = JSON.stringify(overrides);
  if (text === 'INTRUSO') {
    note('item/completed', { turnId: 'turno-velho', item: { id: 'v', type: 'agentMessage', text: 'NAO-E-MEU' } });
    note('turn/completed', { turn: { id: 'turno-velho', status: 'completed' } });
  }
  if (text.startsWith('CHAMA ')) {
    const tool = tools.find((t) => t.name === 'falar_com_claude');
    if (!tool) {
      answer = 'eco: sem a ferramenta do duo';
    } else {
      const reqId = next++;
      const args = { mensagem: text.slice(6) };
      const replied = new Promise((resolve) => {
        waiting.set(reqId, (res) => {
          toolReplies.push(res.result ?? res.error);
          resolve(res);
        });
        const params = { threadId: thread, turnId, callId: 'call-1', namespace: null, tool: tool.name, arguments: args };
        out({ id: reqId, method: 'item/tool/call', params });
      });
      const res = await stoppable(turnId, replied);
      if (res === null) return;
      const r = res.result;
      answer = `eco: [${tool.name}${r.success ? '' : ' erro'}] ${r.contentItems[0].text}`;
    }
  }
  if (text.startsWith('LONGO ')) {
    const command = text.slice(6);
    item('item/started', { id: 'longo', type: 'commandExecution', command });
    if ((await stoppable(turnId, new Promise((r) => setTimeout(() => r(true), 2000)))) === null) return;
    item('item/completed', { id: 'longo', type: 'commandExecution', command, exitCode: 0 });
    answer = `eco: rodei ${command}`;
  }
  if (text === 'CMD') {
    const command = `"C:\\WINDOWS\\powershell.exe" -Command 'echo oi'`;
    item('item/started', { id: 'c', type: 'commandExecution', command });
    item('item/completed', { id: 'c', type: 'commandExecution', command, exitCode: 1 });
  }
  if (text === 'PASSOS') {
    const wrap = (c) => `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "${c.replace(/"/g, '\\"')}"`;
    const run = (id, inner, status, exitCode) => {
      const command = wrap(inner);
      item('item/started', { id, type: 'commandExecution', command, status: 'inProgress', exitCode: null });
      item('item/completed', { id, type: 'commandExecution', command, status, exitCode });
    };
    run('p1', `node -e "console.log('oi')"`, 'completed', 0);
    run('p2', 'node -e "process.exit(3)"', 'failed', 1);
    item('item/completed', { id: 'p3', type: 'commandExecution', command: wrap('rm -rf x'), status: 'declined', exitCode: null });
    const at = (...p) => path.join(process.cwd(), ...p);
    const changes = [
      { path: at('novo.txt'), kind: { type: 'add' }, diff: 'linha a\n' },
      { path: at('src', 'velho.ts'), kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: at('lixo.txt'), kind: { type: 'delete' }, diff: '' },
      { path: at('a.ts'), kind: { type: 'update', move_path: at('b.ts') }, diff: '' },
    ];
    item('item/started', { id: 'p4', type: 'fileChange', changes, status: 'inProgress' });
    item('item/completed', { id: 'p4', type: 'fileChange', changes, status: 'completed' });
    const why = `servidor fora: ${'tentou de novo e não respondeu; '.repeat(4)}desisti depois de 3 tentativas`;
    item('item/completed', { id: 'p5', type: 'mcpToolCall', server: 'docs', tool: 'buscar', status: 'failed', error: { message: why } });
    item('item/completed', { id: 'p6', type: 'webSearch', query: 'vitest' });
    answer = 'fim';
  }
  if (text === 'CAI') {
    item('item/started', { id: 'cai', type: 'commandExecution', command: 'npm test', status: 'inProgress' });
    return void setTimeout(() => process.exit(2), 100);
  }
  if (text === 'SOLTO') {
    item('item/started', { id: 'solto', type: 'commandExecution', command: 'npm test', status: 'inProgress' });
    answer = 'fim';
  }
  if (text === 'PEDE') {
    const reqId = next++;
    const res = await new Promise((resolve) => {
      waiting.set(reqId, resolve);
      out({ id: reqId, method: 'item/commandExecution/requestApproval', params: { threadId: thread, command: 'rm -rf /' } });
    });
    answer = res.error ? `recusado: ${res.error.message}` : 'aprovado?!';
  }
  // Subagente (0.166.0): item subAgentActivity na conversa principal; a dele tem uso de tokens próprio.
  if (text === 'AGENTE' || text === 'FIM') {
    const kind = text === 'AGENTE' ? 'started' : 'completed';
    item('item/completed', { id: `s-${kind}`, type: 'subAgentActivity', kind, agentThreadId: 'filho', agentPath: '/root/x', model: 'gpt-filho' });
    const big = { last: { totalTokens: 999999 }, modelContextWindow: 475000 };
    out({ method: 'thread/tokenUsage/updated', params: { threadId: 'filho', turnId: 't', tokenUsage: big } });
  }
  note('thread/tokenUsage/updated', { turnId, tokenUsage: { last: { totalTokens: 5000 * turns }, modelContextWindow: 475000 } });
  message(answer);
  if (text.includes('QUEBRA')) process.exit(2);
  if (text === 'FALHA') {
    note('error', { turnId, error: { message: 'deu ruim' }, willRetry: false });
    return note('turn/completed', { turn: { id: turnId, status: 'failed', error: { message: 'deu ruim' } } });
  }
  note('turn/completed', { turn: { id: turnId, status: 'completed' } });
}
