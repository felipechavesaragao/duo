// Claude falso para os testes: fala o protocolo do `claude -p --input-format/--output-format stream-json`.
// --resume sumiu  → imita o claude real com id inexistente (medido em 02/11/2026, 2.1.316):
//                   result de erro SEM init, stderr "No conversation found...", sai com 1.
// "PEDE <comando>" → imita uma regra "ask" do settings (medido em 02/11/2026, 2.1.316): com
//                   --permission-prompt-tool stdio manda can_use_tool e espera o control_response;
//                   sem ele, nega sozinho e só conta no permission_denials do result.
// "CHAMA <texto>"  → usa a ferramenta do servidor MCP "duo" (sdk, via --mcp-config), como o 2.1.316:
//                   initialize, notifications/initialized, tools/list e tools/call em mcp_message.
// "AGENTE" / "FIM" → um subagente começa (task_started, mais uma mensagem dele com parent_tool_use_id)
//                   e termina (task_notification), como no 2.1.316.
// "ARGS"           → responde com os argumentos da linha de comando.
// Toda resposta traz usage (contexto = 1000 × número da mensagem) e o result traz o contextWindow.
import readline from 'node:readline';

const args = process.argv.slice(2);
const i = args.indexOf('--resume');
const resume = i >= 0 ? args[i + 1] : undefined;
const canAsk = args.includes('--permission-prompt-tool');
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
  const usage = () => ({ input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 1000 * n - 110, output_tokens: 10 });
  const reply = (text, denials = []) => {
    out({ type: 'assistant', session_id: sid, message: { model, usage: usage(), content: [{ type: 'text', text }] } });
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sid,
      result: 'ok',
      permission_denials: denials,
      modelUsage: { [model]: { contextWindow: 200000 } },
    });
  };
  readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    const msg = JSON.parse(line);
    if (msg.type === 'control_response') {
      const resolve = pending.get(msg.response.request_id);
      pending.delete(msg.response.request_id);
      return resolve?.(msg.response);
    }
    if (++n === 1) out({ type: 'system', subtype: 'init', session_id: sid, model });
    const text = msg.message.content;
    if (text === 'ARGS') return reply(`eco: ${JSON.stringify(args)}`);
    if (text === 'AGENTE') {
      out({ type: 'system', subtype: 'task_started', task_id: 'tarefa-1', tool_use_id: 'toolu_a', task_type: 'local_agent', session_id: sid });
      const big = { input_tokens: 999999, output_tokens: 1 }; // do subagente: não é o contexto da conversa
      out({ type: 'assistant', parent_tool_use_id: 'toolu_a', session_id: sid, message: { model, usage: big, content: [] } });
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
