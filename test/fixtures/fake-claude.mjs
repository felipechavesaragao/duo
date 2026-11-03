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
// control_request "initialize" → responde com a lista de comandos e a de modelos, como o 2.1.316.
// control_request "set_model" / "apply_flag_settings" {effortLevel} / "get_settings" → como o 2.1.316: o set_model
//                   responde com o id resolvido (o que não está na lista: erro), o esforço que o modelo não aceita é
//                   ignorado sem erro, e o get_settings diz em `applied` o modelo e o esforço (null no modelo sem
//                   esforço). --model e --effort valem desde o começo. "MODELO" → responde com o modelo e o esforço.
// "TROCA <modelo>" → troca o modelo como um /model mandado como mensagem: o turno seguinte abre com o system/init
//                   do modelo novo.
// "MUDA"           → system/commands_changed com um comando a mais.
// "APP <texto>"    → responde, e logo depois chega <texto> como se você tivesse digitado no app (Remote
//                   Control): o eco dela com um uuid que não é do duo, e um turno inteiro respondendo.
//                   "APP DENTRO <texto>": o eco dela chega no meio deste turno, e a resposta é deste turno.
//                   "APP ANTES <texto>": ele lê a dela antes desta, sem responder no meio: uma resposta para as duas.
// "LONGO <comando>" → roda um Bash que demora 2s ("CURTO <comando>": 50ms): o tool_use, e no fim o tool_result.
// control_request "interrupt" → como o 2.1.316 (medido em 03/11/2026): responde na hora {still_queued: []}, mesmo
//                   sem turno. No meio do LONGO, do CHAMA (esperando a ferramenta do duo), do PEDE (esperando a
//                   permissão) ou do turno que ele abriu sozinho, fecha o turno: o tool_result de erro (só no LONGO),
//                   o texto "[Request interrupted by user for tool use]" e um result error_during_execution.
//                   "SOZINHO DEVAGAR <texto>": parar o turno que ele abriu sozinho leva 200ms, e a mensagem que chega
//                   nesse meio vai depois, num turno dela, como o 2.1.316 (medido em 03/11/2026: ela fica na fila e o
//                   command_lifecycle "started" e o eco dela só vêm depois do result do turno parado).
// "TARDE"          → espera o interrupt; quando ele chega, ainda manda uma chamada da ferramenta do duo e um
//                   can_use_tool (estavam a caminho), espera as respostas e fecha como parado. "TARDIAS" → responde
//                   com o que o duo devolveu a elas.
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

  const models = [
    { value: 'default', resolvedModel: 'claude-falso-1', displayName: 'Padrão (recomendado)', description: 'Falso 1 · o de sempre', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'], supportsFastMode: true },
    { value: 'ligeiro', resolvedModel: 'claude-ligeiro-1', displayName: 'Ligeiro 1', description: 'o rápido', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    { value: 'claude-velho-1', resolvedModel: 'claude-velho-1', displayName: 'Velho 1', description: 'sem esforço' },
  ];
  const resolve = (value) => models.find((m) => m.value === value)?.resolvedModel;
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  let model = resolve(flag('--model') ?? 'default') ?? flag('--model');
  let effort = flag('--effort') ?? 'medium';
  /** o modelo do último system/init */
  let announced;
  /** o esforço que vale: o escolhido, se o modelo aceita; senão o primeiro dele; null no modelo sem esforço */
  const appliedEffort = () => {
    const levels = models.find((m) => m.resolvedModel === model)?.supportedEffortLevels;
    return levels ? (levels.includes(effort) ? effort : levels[0]) : null;
  };
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

  /** o que o interrupt corta agora: o turno esperando alguma coisa (null = nada que dê para parar) */
  let stop = null;
  /** o que o duo devolveu às chamadas que o TARDE mandou depois do interrupt */
  let late = null;
  /** fecha o turno como o 2.1.316 depois de um interrupt */
  const interrupted = () => {
    const content = [{ type: 'text', text: '[Request interrupted by user for tool use]' }];
    out({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content } });
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sid, errors: ['[ede_diagnostic] parado'] });
  };
  /** espera `p`, ou o interrupt: aí fecha o turno (depois de `before`, `delay` ms depois) e devolve null */
  const stoppable = (p, before = () => undefined, delay = 0) =>
    new Promise((resolve) => {
      const close = () => {
        before();
        interrupted();
        resolve(null);
      };
      const mine = () => (delay ? void setTimeout(close, delay) : close());
      stop = mine;
      p.then((v) => {
        if (stop !== mine) return;
        stop = null;
        resolve(v);
      });
    });

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
    const slow = text?.startsWith('DEVAGAR ') ? 200 : 0;
    if ((await stoppable(new Promise((r) => setTimeout(() => r(true), 300)), undefined, slow)) === null) {
      const queued = own;
      own = null;
      for (const msg of queued) void onMessage(msg);
      return;
    }
    for (const msg of own) {
      echo(msg);
      started(msg);
      say(`eco: ${msg.message.content}`);
    }
    own = null;
    done();
  };

  const onMessage = async (msg) => {
    if (msg.type === 'control_response') {
      const resolve = pending.get(msg.response.request_id);
      pending.delete(msg.response.request_id);
      return resolve?.(msg.response);
    }
    if (msg.type === 'control_request' && msg.request.subtype === 'initialize') {
      const response = { commands, models, pid: process.pid };
      return out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
    }
    if (msg.type === 'control_request' && ['set_model', 'apply_flag_settings', 'get_settings'].includes(msg.request.subtype)) {
      const ok = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
      const { subtype } = msg.request;
      if (subtype === 'set_model') {
        const resolved = resolve(msg.request.model);
        if (!resolved) return out({ type: 'control_response', response: { subtype: 'error', request_id: msg.request_id, error: 'not_found' } });
        model = resolved;
        return ok({ model });
      }
      if (subtype === 'apply_flag_settings') {
        if (typeof msg.request.settings?.effortLevel === 'string') effort = msg.request.settings.effortLevel;
        return out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id } });
      }
      return ok({ effective: { effortLevel: effort }, applied: { model, effort: appliedEffort() } });
    }
    if (msg.type === 'control_request' && msg.request.subtype === 'interrupt') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } } });
      const cut = stop;
      stop = null;
      return cut?.();
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
    if (++n === 1 || model !== announced) out({ type: 'system', subtype: 'init', session_id: sid, model, apiKeySource });
    announced = model;
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
    if (text === 'TARDIAS') return reply(`eco: ${JSON.stringify(late)}`);
    if (text === 'TARDE') {
      await mcp({ method: 'initialize', params: { protocolVersion: '2025-11-25' }, id: 0 });
      await mcp({ method: 'notifications/initialized' });
      const tool = (await mcp({ method: 'tools/list', id: 1 })).result.tools[0].name;
      await new Promise((r) => {
        stop = r;
        say('esperando');
      });
      const [called, asked] = await Promise.all([
        mcp({ method: 'tools/call', params: { name: tool, arguments: { mensagem: 'tarde' } }, id: 2 }),
        control({ subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_tarde' }),
      ]);
      late = { called: called.result, asked: asked.response };
      return interrupted();
    }
    if (text === 'MODELO') return reply(`eco: ${model} ${appliedEffort()}`);
    if (text.startsWith('TROCA ')) {
      model = resolve(text.slice(6)) ?? model;
      return reply('eco: troquei');
    }
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
      const called = await stoppable(mcp({ method: 'tools/call', params: { name: tool, arguments: input }, id: 2 }));
      if (called === null) return; // parado: o 2.1.316 fecha o turno sem esperar a resposta da ferramenta
      const r = called.result;
      return reply(`eco: [${tool}${r.isError ? ' erro' : ''}] ${r.content[0].text}`);
    }

    if (text.startsWith('LONGO ') || text.startsWith('CURTO ')) {
      const id = `toolu_longo_${n}`;
      const command = text.slice(6);
      out({ type: 'assistant', session_id: sid, message: { model, usage: usage(), content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
      const result = (content, is_error) =>
        out({ type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] } });
      const ms = text.startsWith('LONGO ') ? 2000 : 50;
      const ran = await stoppable(new Promise((r) => setTimeout(() => r(true), ms)), () =>
        result("The user doesn't want to proceed with this tool use. The tool use was rejected.", true),
      );
      if (ran === null) return;
      result('pronto', false);
      return reply(`eco: rodei ${command}`);
    }

    if (!text.startsWith('PEDE ')) return reply(`eco: ${text}`);
    const call = { tool_name: 'Bash', tool_use_id: `toolu_${n}`, tool_input: { command: text.slice(5) } };
    if (!canAsk) return reply('eco: negado sem perguntar', [call]);
    const asked = await stoppable(control({ subtype: 'can_use_tool', tool_name: call.tool_name, input: call.tool_input, tool_use_id: call.tool_use_id }));
    if (asked === null) return;
    const r = asked.response;
    if (r.behavior === 'allow') reply(`eco: rodei ${r.updatedInput.command}`);
    else reply(`eco: negado (${r.message})`, [call]);
  };
  readline.createInterface({ input: process.stdin }).on('line', (line) => onMessage(JSON.parse(line)));
}
