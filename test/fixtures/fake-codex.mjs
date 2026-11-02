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
import readline from 'node:readline';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let thread = null; // conversa aberta neste processo
let threadParams = null;
let initParams = null;
let tools = []; // ferramentas do cliente: só o thread/start traz (o resume ignora, como o real)
let next = 1000;
let turns = 0;
const waiting = new Map(); // respostas do cliente a pedidos do servidor

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) return waiting.get(msg.id)?.(msg);
  const { id, method, params = {} } = msg;
  const reply = (result) => out({ id, result });
  const fail = (message) => out({ id, error: { code: -32600, message } });
  switch (method) {
    case 'initialize':
      initParams = params;
      return reply({ userAgent: 'codex-falso' });
    case 'initialized':
      return;
    case 'thread/start':
      thread = 'thread-nova';
      threadParams = params;
      tools = params.dynamicTools ?? [];
      return reply({ thread: { id: thread }, model: 'gpt-falso' });
    case 'thread/resume':
      if (params.threadId === 'sumiu') return fail('no rollout found for thread id sumiu');
      if (params.threadId === 'ruim') return fail('invalid session id: invalid character: found `r` at 1');
      if (params.threadId === 'ocupada') return fail('thread ocupada already has an active writer');
      thread = params.threadId;
      threadParams = params;
      return reply({ thread: { id: thread } });
    case 'turn/start':
      if (params.threadId !== thread) return fail(`thread not loaded: ${params.threadId}`);
      reply({ turn: { id: 'turno', status: 'inProgress' } });
      return runTurn(params.input?.[0]?.text ?? '');
    default:
      return out({ id, error: { code: -32601, message: `método desconhecido: ${method}` } });
  }
});

const note = (method, params) => out({ method, params: { threadId: thread, ...params } });
const message = (text) => note('item/completed', { item: { id: 'm', type: 'agentMessage', text } });

async function runTurn(text) {
  note('turn/started', { turn: { id: 'turno' } });
  let answer = `eco: ${text}`;
  if (text === 'PID') answer = `pid ${process.pid}`;
  if (text === 'PARAMS') answer = JSON.stringify(threadParams);
  if (text === 'INIT') answer = JSON.stringify(initParams);
  if (text.startsWith('CHAMA ')) {
    const tool = tools.find((t) => t.name === 'falar_com_claude');
    if (!tool) {
      answer = 'eco: sem a ferramenta do duo';
    } else {
      const reqId = next++;
      const args = { mensagem: text.slice(6) };
      const res = await new Promise((resolve) => {
        waiting.set(reqId, resolve);
        const params = { threadId: thread, turnId: 'turno', callId: 'call-1', namespace: null, tool: tool.name, arguments: args };
        out({ id: reqId, method: 'item/tool/call', params });
      });
      const r = res.result;
      answer = `eco: [${tool.name}${r.success ? '' : ' erro'}] ${r.contentItems[0].text}`;
    }
  }
  if (text === 'CMD') {
    const command = `"C:\\WINDOWS\\powershell.exe" -Command 'echo oi'`;
    note('item/started', { item: { id: 'c', type: 'commandExecution', command } });
    note('item/completed', { item: { id: 'c', type: 'commandExecution', command, exitCode: 1 } });
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
    note('item/completed', { item: { id: `s-${kind}`, type: 'subAgentActivity', kind, agentThreadId: 'filho', agentPath: '/root/x' } });
    const big = { last: { totalTokens: 999999 }, modelContextWindow: 475000 };
    out({ method: 'thread/tokenUsage/updated', params: { threadId: 'filho', turnId: 't', tokenUsage: big } });
  }
  turns++;
  note('thread/tokenUsage/updated', { turnId: 'turno', tokenUsage: { last: { totalTokens: 5000 * turns }, modelContextWindow: 475000 } });
  message(answer);
  if (text.includes('QUEBRA')) process.exit(2);
  if (text === 'FALHA') {
    note('error', { error: { message: 'deu ruim' }, willRetry: false });
    return note('turn/completed', { turn: { id: 'turno', status: 'failed', error: { message: 'deu ruim' } } });
  }
  note('turn/completed', { turn: { id: 'turno', status: 'completed' } });
}
