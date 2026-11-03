// Claude falso para os testes: fala o protocolo do `claude -p --input-format/--output-format stream-json`.
// --resume sumiu  → imita o claude real com id inexistente (medido em 02/11/2026, 2.1.316):
//                   result de erro SEM init, stderr "No conversation found...", sai com 1.
// "PEDE <comando>" → imita uma regra "ask" do settings (medido em 02/11/2026, 2.1.316): com
//                   --permission-prompt-tool stdio manda can_use_tool e espera o control_response;
//                   sem ele, nega sozinho e só conta no permission_denials do result.
// "CHAMA <texto>"  → usa a ferramenta do servidor MCP "duo" (sdk, via --mcp-config), como o 2.1.316:
//                   initialize, notifications/initialized, tools/list e tools/call em mcp_message.
// "AGENTE" / "FIM" → um subagente começa (task_started com description e subagent_type, um task_progress, mais
//                   uma mensagem dele com texto e parent_tool_use_id) e termina (task_notification), como no 2.1.316.
// content em lista (texto + imagens) → responde com o texto e o tipo e o tamanho de cada imagem.
// O system/init traz apiKeySource: "ANTHROPIC_API_KEY" com a variável no ambiente, "none" sem ela (2.1.316).
// "ARGS"           → responde com os argumentos da linha de comando.
// "SOZINHO <texto>" → lança uma tarefa em segundo plano (task_started "local_bash", no turno), responde, e logo
//                   depois abre um turno sozinho, como o 2.1.316 quando ela termina: task_notification com o
//                   mesmo task_id, init, a resposta dele e o result. Mensagem que
//                   chega nesses 300ms entra no mesmo turno: eco dela, a resposta e um result só para os dois.
//                   "SOZINHO FIM <texto>": além disso, o subagente do "AGENTE" termina neste turno, antes da resposta.
//                   "SOZINHO MORRE <texto>": o processo cai (código 3) no meio do turno que ele abriu sozinho.
// "CALADO"         → como "SOZINHO", mas o turno que ele abre sozinho só usa uma ferramenta: nenhum texto.
// Com --replay-user-messages, ecoa cada mensagem lida (com o uuid dela), como o 2.1.316. O command_lifecycle
// "started" vem antes do eco; numa mensagem que entra no turno que ele abriu sozinho, logo depois.
// "/<comando>"     → comando local, como o /context no 2.1.316: "started", a saída (modelo <synthetic>), o eco
//                   e o result, nessa ordem.
// control_request "remote_control" → liga a ponte, como o 2.1.316: session_url na resposta e bridge_state.
// control_request "initialize" → responde com a lista de comandos, como o 2.1.316.
// "MUDA"           → system/commands_changed com um comando a mais.
// "APP <texto>"    → responde, e logo depois chega <texto> como se você tivesse digitado no app (Remote
//                   Control): o eco dela com um uuid que não é do duo, e um turno inteiro respondendo.
//                   "APP DENTRO <texto>": o eco dela chega no meio deste turno, e a resposta é deste turno.
//                   "APP ANTES <texto>": ele lê a dela antes desta, sem responder no meio: uma resposta para as duas.
// Toda resposta traz usage (contexto = 1000 × número da mensagem) e o result traz o contextWindow.
import readline from 'node:readline';

const args = process.argv.slice(2);
const i = args.indexOf('--resume');
const resume = i >= 0 ? args[i + 1] : undefined;
const canAsk = args.includes('--permission-prompt-tool');
const replay = args.includes('--replay-user-messages');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (resume === 'sumiu') {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: resume });
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  setTimeout(() => process.exit(1), 50);
} else {
  const sid = resume ?? 'sessao-nova';
  let n = 0;
  /** pedidos de controle esperando o control_response, por request_id */
  const pending = new Map();
  let nextReq = 0;
  const control = (request) =>
    new Promise((resolve) => {
      const request_id = `req-${++nextReq}`;
      pending.set(request_id, resolve);
      out({ type: 'control_request', request_id, request });
    });
  const mcp = async (message) =>
    (await control({ subtype: 'mcp_message', server_name: 'duo', message: { jsonrpc: '2.0', ...message } })).response
      .mcp_response;

  const model = 'claude-falso-1';
  const commands = [
    { name: 'compact', description: 'Resume a conversa', argumentHint: '<instruções>' },
    { name: 'context', description: 'Mostra o uso de contexto', argumentHint: '' },
    { name: 'doctor', description: 'Confere a instalação', argumentHint: '' },
  ];
  const usage = () => ({ input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 1000 * n - 110, output_tokens: 10 });
  const say = (text) =>
    out({ type: 'assistant', session_id: sid, message: { model, usage: usage(), content: [{ type: 'text', text }] } });
  const done = (denials = []) =>
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sid,
      result: 'ok',
      permission_denials: denials,
      modelUsage: { [model]: { contextWindow: 200000 } },
    });
  const reply = (text, denials = []) => {
    say(text);
    done(denials);
  };
  const echo = (msg) =>
    replay && out({ type: 'user', session_id: sid, uuid: msg.uuid, isReplay: true, parent_tool_use_id: null, message: msg.message });
  const started = (msg) => out({ type: 'command_lifecycle', command_uuid: msg.uuid, state: 'started', session_id: sid });

  /** mensagens que chegaram no meio do turno que ele abriu sozinho; null = nenhum aberto */
  let own = null;
  const ownTurn = async (text) => {
    own = [];
    out({ type: 'system', subtype: 'task_notification', task_id: 'tarefa-bg', status: 'completed', session_id: sid });
    out({ type: 'system', subtype: 'init', session_id: sid, model });
    if (text === null) {
      const content = [{ type: 'tool_use', id: 'toolu_calado', name: 'Read', input: { file_path: 'saida.txt' } }];
      out({ type: 'assistant', session_id: sid, message: { model, usage: usage(), content } });
    } else say(`sozinho: ${text}`);
    if (text?.startsWith('MORRE ')) {
      process.stderr.write('caiu no meio do turno\n');
      return void setTimeout(() => process.exit(3), 200);
    }
    await new Promise((r) => setTimeout(r, 300));
    for (const msg of own) {
      echo(msg);
      started(msg);
      say(`eco: ${msg.message.content}`);
    }
    own = null;
    done();
  };

  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    const msg = JSON.parse(line);
    if (msg.type === 'control_response') {
      const resolve = pending.get(msg.response.request_id);
      pending.delete(msg.response.request_id);
      return resolve?.(msg.response);
    }
    if (msg.type === 'control_request' && msg.request.subtype === 'initialize') {
      const response = { commands, models: [], pid: process.pid };
      return out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
    }
    if (msg.type === 'control_request' && msg.request.subtype === 'remote_control') {
      const response = { session_url: 'https://claude.ai/code/session_falsa', bridge_session_id: 'cse_falsa' };
      out({ type: 'system', subtype: 'bridge_state', state: 'ready', session_id: sid });
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
      return out({ type: 'system', subtype: 'bridge_state', state: 'connected', session_id: sid });
    }
    if (own) return void own.push(msg);
    const before = typeof msg.message.content === 'string' && msg.message.content.startsWith('APP ANTES ');
    if (before) echo({ uuid: 'mensagem-do-app', message: { role: 'user', content: msg.message.content.slice(10) } });
    started(msg);
    const apiKeySource = process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'none';
    if (++n === 1) out({ type: 'system', subtype: 'init', session_id: sid, model, apiKeySource });
    if (Array.isArray(msg.message.content)) {
      echo(msg);
      const blocks = msg.message.content;
      const said = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
      const pics = blocks
        .filter((b) => b.type === 'image')
        .map((b) => `${b.source.type} ${b.source.media_type} ${Buffer.from(b.source.data, 'base64').length}`);
      return reply(`eco: ${said} | imagens: ${pics.join(', ')}`);
    }
    const text = msg.message.content;
    if (text.startsWith('/')) {
      out({ type: 'assistant', session_id: sid, message: { model: '<synthetic>', content: [{ type: 'text', text: `saída do ${text}` }] } });
      echo(msg);
      return done();
    }
    echo(msg);
    if (text === 'ARGS') return reply(`eco: ${JSON.stringify(args)}`);
    if (text === 'MUDA') {
      commands.push({ name: 'nova', description: 'chegou depois', argumentHint: '' });
      out({ type: 'system', subtype: 'commands_changed', commands, session_id: sid });
      return reply('eco: MUDA');
    }
    if (text.startsWith('APP DENTRO ')) {
      echo({ uuid: 'mensagem-do-app', message: { role: 'user', content: text.slice(11) } });
      return reply(`eco: ${text.slice(11)}`);
    }
    if (text.startsWith('APP ANTES ')) return reply(`eco: ${text.slice(10)}`);
    if (text.startsWith('APP ')) {
      reply('eco: ok');
      setTimeout(() => {
        const typed = { role: 'user', content: text.slice(4) };
        out({ type: 'system', subtype: 'init', session_id: sid, model });
        echo({ uuid: 'mensagem-do-app', message: typed });
        reply(`eco: ${typed.content}`);
      }, 100);
      return;
    }
    if (text.startsWith('SOZINHO ') || text === 'CALADO') {
      out({ type: 'system', subtype: 'task_started', task_id: 'tarefa-bg', task_type: 'local_bash', session_id: sid });
      if (text.startsWith('SOZINHO FIM ')) {
        out({ type: 'system', subtype: 'task_notification', task_id: 'tarefa-1', status: 'completed', session_id: sid });
      }
      reply('eco: lancei');
      setTimeout(() => ownTurn(text === 'CALADO' ? null : text.slice(8)), 100);
      return;
    }
    if (text === 'AGENTE') {
      const desc = { description: 'revisar o diff', subagent_type: 'devil-advocate' };
      out({ type: 'system', subtype: 'task_started', task_id: 'tarefa-1', tool_use_id: 'toolu_a', task_type: 'local_agent', ...desc, session_id: sid });
      out({ type: 'system', subtype: 'task_progress', task_id: 'tarefa-1', description: 'Lendo src/core.ts', last_tool_name: 'Read', session_id: sid });
      const big = { input_tokens: 999999, output_tokens: 1 }; // do subagente: não é o contexto da conversa
      const content = [{ type: 'text', text: 'texto do subagente' }];
      out({ type: 'assistant', parent_tool_use_id: 'toolu_a', session_id: sid, message: { model, usage: big, content } });
    }
    if (text === 'FIM') out({ type: 'system', subtype: 'task_notification', task_id: 'tarefa-1', status: 'completed', session_id: sid });

    if (text.startsWith('CHAMA ')) {
      if (!args.includes('--mcp-config')) return reply('eco: sem a ferramenta do duo');
      await mcp({ method: 'initialize', params: { protocolVersion: '2025-11-25' }, id: 0 });
      await mcp({ method: 'notifications/initialized' });
      const tool = (await mcp({ method: 'tools/list', id: 1 })).result.tools[0].name;
      const input = { mensagem: text.slice(6) };
      out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', id: 'toolu_c', name: `mcp__duo__${tool}`, input }] } });
      const r = (await mcp({ method: 'tools/call', params: { name: tool, arguments: input }, id: 2 })).result;
      return reply(`eco: [${tool}${r.isError ? ' erro' : ''}] ${r.content[0].text}`);
    }

    if (!text.startsWith('PEDE ')) return reply(`eco: ${text}`);
    const call = { tool_name: 'Bash', tool_use_id: `toolu_${n}`, tool_input: { command: text.slice(5) } };
    if (!canAsk) return reply('eco: negado sem perguntar', [call]);
    const r = (await control({ subtype: 'can_use_tool', tool_name: call.tool_name, input: call.tool_input, tool_use_id: call.tool_use_id })).response;
    if (r.behavior === 'allow') reply(`eco: rodei ${r.updatedInput.command}`);
    else reply(`eco: negado (${r.message})`, [call]);
  });
}
