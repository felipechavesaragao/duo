import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAgent } from '../src/agents/claude.js';
import { CodexAgent } from '../src/agents/codex.js';
import { ResumeFailedError, type Agent, type AgentEvent, type AgentTask } from '../src/agents/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = [process.execPath, path.join(here, 'fixtures', 'fake-claude.mjs')];
const fakeCodex = [process.execPath, path.join(here, 'fixtures', 'fake-codex.mjs')];
const noop = () => undefined;
/** um PNG de 1×1 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const pngFile = () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'duo-print-')), 'print.png');
  fs.writeFileSync(file, PNG);
  return file;
};

const live: Agent[] = [];
const track = <T extends Agent>(a: T) => (live.push(a), a);
afterEach(() => live.splice(0).forEach((a) => a.dispose()));

/**
 * Prazo curto só depois que a conexão subiu: o initialize inclui subir o processo, que com a máquina ocupada (os
 * arquivos de teste rodam em paralelo) passa de 150ms.
 */
async function shortDeadline(agent: CodexAgent, ms: number) {
  agent.warmUp();
  // as skills só carregam depois do initialize
  await vi.waitFor(() => expect(agent.commands.length).toBeGreaterThan(0), { timeout: 4000 });
  agent.rpcTimeoutMs = ms;
}

describe('ClaudeAgent', () => {
  it('conversa nova: avisa o id assim que aparece e mantém o processo entre mensagens', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const seen = vi.fn();
    agent.onSessionId = seen;
    expect(await agent.send('oi', noop)).toBe('eco: oi');
    expect(await agent.send('de novo', noop)).toBe('eco: de novo');
    expect(agent.resumeId).toBe('sessao-nova');
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith('sessao-nova');
  });

  it('retoma pelo id guardado, sem trocar de conversa', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude, resumeId: 'abc' }));
    const seen = vi.fn();
    agent.onSessionId = seen;
    expect(await agent.send('oi', noop)).toBe('eco: oi');
    expect(agent.resumeId).toBe('abc');
    expect(seen).not.toHaveBeenCalled();
  });

  it('conversa que não existe mais: ResumeFailedError, esquece o id e a próxima abre uma nova', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude, resumeId: 'sumiu' }));
    await expect(agent.send('oi', noop)).rejects.toBeInstanceOf(ResumeFailedError);
    expect(agent.resumeId).toBeUndefined();
    expect(await agent.send('oi de novo', noop)).toBe('eco: oi de novo');
    expect(agent.resumeId).toBe('sessao-nova');
  });

  it('rodapé: modelo, contexto da conversa principal e subagentes rodando', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const seen = vi.fn();
    agent.onStats = seen;
    expect(agent.stats).toEqual({ model: undefined, subagents: 0 });
    await agent.send('oi', noop);
    expect(agent.stats).toMatchObject({ model: 'claude-falso-1', contextTokens: 1000, contextWindow: 200000, subagents: 0 });
    const shown: string[] = [];
    // o texto do subagente não vira resposta do Claude nem aparece como dele
    expect(await agent.send('AGENTE', (ev) => shown.push(ev.text))).toBe('eco: AGENTE');
    expect(shown).toEqual(['eco: AGENTE']);
    expect(agent.stats).toMatchObject({ contextTokens: 2000, subagents: 1 }); // o uso do subagente não conta
    await agent.send('FIM', noop);
    expect(agent.stats.subagents).toBe(0);
    expect(seen).toHaveBeenLastCalledWith(agent.stats);
    agent.reset();
    expect(agent.stats).toMatchObject({ contextTokens: undefined, subagents: 0 });
  });

  it('seletor de modelo: a lista do CLI, o que vale antes da primeira mensagem, e a troca sem abrir turno', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const lists: unknown[] = [];
    agent.onModels = (m) => lists.push(m);
    const replies: string[] = [];
    agent.onOwnTurnReply = (text) => replies.push(text);
    agent.warmUp();
    await vi.waitFor(() => expect(agent.stats).toMatchObject({ model: 'claude-falso-1', effort: 'medium' }));
    expect(agent.models).toEqual([
      { id: 'default', resolved: 'claude-falso-1', name: 'Padrão (recomendado)', description: 'Falso 1 · o de sempre', efforts: ['low', 'medium', 'high'], fast: false },
      { id: 'ligeiro', resolved: 'claude-ligeiro-1', name: 'Ligeiro 1', description: 'o rápido', efforts: ['low', 'high'], fast: false },
      { id: 'claude-velho-1', resolved: 'claude-velho-1', name: 'Velho 1', description: 'sem esforço', efforts: [], fast: false },
    ]);
    expect(lists).toEqual([agent.models]);

    await agent.setModel({ model: 'ligeiro', effort: 'high' });
    expect(agent.stats).toMatchObject({ model: 'claude-ligeiro-1', selected: 'ligeiro', effort: 'high' });
    expect(await agent.send('MODELO', noop)).toBe('eco: claude-ligeiro-1 high');
    await agent.setModel({ effort: 'low' });
    expect(agent.stats).toMatchObject({ model: 'claude-ligeiro-1', selected: 'ligeiro', effort: 'low' });
    // modelo sem esforço: o CLI diz null, e o rodapé fica sem
    await agent.setModel({ model: 'claude-velho-1' });
    expect(agent.stats).toMatchObject({ model: 'claude-velho-1', selected: 'claude-velho-1', effort: undefined });
    expect(replies).toEqual([]); // nenhuma troca abriu turno
  });

  it('seletor de modelo: o processo seguinte sobe com o que foi escolhido', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude, model: 'default' }));
    agent.warmUp();
    await vi.waitFor(() => expect(agent.models).toHaveLength(3));
    await agent.setModel({ model: 'ligeiro', effort: 'high' });
    agent.reset(); // o /novo derruba o processo
    const args = JSON.parse((await agent.send('ARGS', noop)).slice('eco: '.length));
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'ligeiro']);
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'high']);
    expect(await agent.send('MODELO', noop)).toBe('eco: claude-ligeiro-1 high');
    expect(agent.stats).toMatchObject({ model: 'claude-ligeiro-1', selected: 'ligeiro', effort: 'high' });
  });

  it('seletor de modelo: o que o CLI recusa rejeita com o motivo e não fica para o próximo processo', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    agent.warmUp();
    await vi.waitFor(() => expect(agent.stats.effort).toBe('medium'));
    await expect(agent.setModel({ model: 'nao-existe' })).rejects.toThrow('not_found');
    expect(agent.stats).toMatchObject({ model: 'claude-falso-1', selected: undefined });
    agent.reset();
    expect(await agent.send('ARGS', noop)).not.toContain('--model');
  });

  it('seletor de modelo: o esforço que o modelo novo não aceita não volta no processo seguinte', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    agent.warmUp();
    await vi.waitFor(() => expect(agent.models).toHaveLength(3));
    await agent.setModel({ effort: 'medium' });
    await agent.setModel({ model: 'ligeiro' }); // o Ligeiro não tem medium: o CLI fica com o low
    expect(agent.stats).toMatchObject({ model: 'claude-ligeiro-1', effort: 'low' });
    agent.reset();
    const args: string[] = JSON.parse((await agent.send('ARGS', noop)).slice('eco: '.length));
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'low']);
    await agent.setModel({ model: 'claude-velho-1' }); // sem esforço: o próximo processo sobe sem --effort
    agent.reset();
    expect(await agent.send('ARGS', noop)).not.toContain('--effort');
  });

  it('seletor de modelo: o modelo trocado por fora do seletor traz o esforço que vale nele', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    agent.warmUp();
    await vi.waitFor(() => expect(agent.stats).toMatchObject({ model: 'claude-falso-1', effort: 'medium' }));
    await agent.send('TROCA claude-velho-1', noop); // um /model mandado como mensagem
    await agent.send('MODELO', noop); // o turno seguinte abre com o system/init do Velho, que não tem esforço
    await vi.waitFor(() => expect(agent.stats).toMatchObject({ model: 'claude-velho-1', effort: undefined }));
    await agent.send('TROCA ligeiro', noop); // o Ligeiro não tem medium: o CLI fica com o low
    await agent.send('MODELO', noop);
    await vi.waitFor(() => expect(agent.stats).toMatchObject({ model: 'claude-ligeiro-1', effort: 'low' }));
  });

  it('seletor de modelo: o processo que não sobe (error sem exit) solta a troca pendente com o motivo', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const run = (agent as any).ensureProcess();
    const pending = (agent as any).control(run, { subtype: 'get_settings' });
    run.proc.emit('error', new Error('spawn falhou'));
    await expect(pending).rejects.toThrow('não consegui iniciar o claude: spawn falhou');
  });

  it('segundo plano: o subagente aparece com o que faz, o tipo e o progresso, e sai quando termina', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const seen: AgentTask[][] = [];
    agent.onTasks = (list) => seen.push(list);
    await agent.send('AGENTE', noop);
    expect(seen.at(-1)).toEqual([
      expect.objectContaining({
        id: 'tarefa-1',
        kind: 'subagente',
        title: 'revisar o diff',
        detail: 'devil-advocate',
        activity: 'Lendo src/core.ts',
      }),
    ]);
    const task = seen.at(-1)![0];
    expect(task.lastAt).toBeGreaterThanOrEqual(task.startedAt);
    await agent.send('FIM', noop);
    expect(seen.at(-1)).toEqual([]);
    // comando em segundo plano conta como comando
    await agent.send('SOZINHO x', noop);
    expect(seen.flat().some((t) => t.id === 'tarefa-bg' && t.kind === 'comando')).toBe(true);
  });

  it('sinal de vida: cada coisa que chega do processo avisa', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const signal = vi.fn();
    agent.onSignal = signal;
    await agent.send('oi', noop);
    expect(signal.mock.calls.length).toBeGreaterThan(2);
  });

  it('print: vai como imagem em base64 na mesma mensagem, junto do texto (ou sozinho)', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const img = { path: pngFile(), mediaType: 'image/png' as const };
    expect(await agent.send('olha', noop, true, [img])).toBe(`eco: olha | imagens: base64 image/png ${PNG.length}`);
    expect(await agent.send('', noop, true, [img, img])).toBe(
      `eco:  | imagens: base64 image/png ${PNG.length}, base64 image/png ${PNG.length}`,
    );
    // sem print, a mensagem segue em texto puro
    expect(await agent.send('oi', noop)).toBe('eco: oi');
  });

  it('print que sumiu do disco: o turno falha dizendo por quê, e o próximo segue', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const gone = { path: path.join(os.tmpdir(), 'duo-nao-existe.png'), mediaType: 'image/png' as const };
    await expect(agent.send('olha', noop, true, [gone])).rejects.toThrow(/não consegui ler a imagem/);
    expect(await agent.send('oi', noop)).toBe('eco: oi');
  });

  it('falar com o Codex: a ferramenta do duo leva a mensagem e devolve a resposta dele', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const asked: string[] = [];
    agent.askPeer = async (req) => (asked.push(req.text), 'pode subir');
    const events: string[] = [];
    const answer = await agent.send('CHAMA revisa o plano', (ev) => events.push(ev.kind));
    expect(asked).toEqual(['revisa o plano']);
    expect(answer).toBe('eco: [falar_com_codex] O Codex respondeu:\n\npode subir');
    expect(events).not.toContain('tool'); // a tela mostra a mensagem inteira, não a linha da ferramenta
    const args = await agent.send('ARGS', noop);
    expect(args).toContain('--mcp-config');
    expect(args).toContain('--append-system-prompt');
  });

  it('o Codex falha: a ferramenta devolve erro e o turno do Claude segue', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    agent.askPeer = async () => {
      throw new Error('o Codex não conseguiu responder');
    };
    expect(await agent.send('CHAMA oi', noop)).toBe('eco: [falar_com_codex erro] o Codex não conseguiu responder');
  });

  it('sem ninguém do outro lado, o Claude nem ganha a ferramenta', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    expect(await agent.send('CHAMA oi', noop)).toBe('eco: sem a ferramenta do duo');
  });

  it('pedido de permissão chega a você: permitir roda o comando inteiro, sem aviso de negado', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const asked: string[] = [];
    agent.askPermission = async (req) => (asked.push(req.text), true);
    const events: string[] = [];
    const cmd = 'cd "C:/projeto" && git push origin HEAD:master 2>&1 | tail -2';
    expect(await agent.send(`PEDE ${cmd}`, (ev) => events.push(ev.kind))).toBe(`eco: rodei ${cmd}`);
    expect(asked).toEqual([`Bash ${cmd}`]); // inteiro: você vê o que está aprovando
    expect(events).not.toContain('error');
  });

  it('você nega: o Claude recebe o motivo e o duo não repete como "permissão negada"', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    agent.askPermission = async () => false;
    const errors: string[] = [];
    const answer = await agent.send('PEDE git push', (ev) => ev.kind === 'error' && errors.push(ev.text));
    expect(answer).toBe('eco: negado (O usuário negou pela janela do duo.)');
    expect(errors).toEqual([]);
  });

  it('sem ninguém para perguntar, nega e avisa como antes', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const errors: string[] = [];
    await agent.send('PEDE git push', (ev) => ev.kind === 'error' && errors.push(ev.text));
    expect(errors).toEqual(['permissão negada: Bash git push (veja --claude-permission)']);
  });

  it('turno que ele abre sozinho (tarefa em segundo plano terminou) aparece, e a próxima mensagem não leva a resposta dele', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const own: string[] = [];
    const replies: string[] = [];
    agent.onOwnTurnEvent = (ev) => own.push(ev.text);
    agent.onOwnTurnReply = (text) => replies.push(text);
    expect(await agent.send('SOZINHO o devil aprovou', noop)).toBe('eco: lancei');
    await vi.waitFor(() => expect(replies).toEqual(['sozinho: o devil aprovou']));
    expect(own).toEqual(['sozinho: o devil aprovou']);
    expect(await agent.send('e agora?', noop)).toBe('eco: e agora?');
  });

  it('o processo cai no meio do turno que ele abriu sozinho: o turno termina e a janela fica sabendo', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const own: string[] = [];
    const replies: string[] = [];
    agent.onOwnTurnEvent = (ev) => own.push(`${ev.kind}: ${ev.text}`);
    agent.onOwnTurnReply = (text) => replies.push(text);
    await agent.send('SOZINHO MORRE adeus', noop);
    await vi.waitFor(() => expect(replies).toEqual(['sozinho: MORRE adeus']));
    expect(own[0]).toBe('text: sozinho: MORRE adeus');
    expect(own[1]).toMatch(/^error: o processo do claude encerrou \(código 3\)\ncaiu no meio do turno/);
    expect(await agent.send('voltou?', noop)).toBe('eco: voltou?'); // a próxima sobe outro processo
  });

  it('cai com uma mensagem sua esperando: o erro aparece uma vez só, na sua mensagem', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const own: string[] = [];
    const replies: string[] = [];
    agent.onOwnTurnEvent = (ev) => own.push(`${ev.kind}: ${ev.text}`);
    agent.onOwnTurnReply = (text) => replies.push(text);
    await agent.send('SOZINHO MORRE adeus', noop);
    await vi.waitFor(() => expect(own).toHaveLength(1));
    await expect(agent.send('espera', noop)).rejects.toThrow(/o processo do claude encerrou \(código 3\)/);
    expect(replies).toEqual(['sozinho: MORRE adeus']);
    expect(own).toEqual(['text: sozinho: MORRE adeus']);
  });

  it('o turno que ele abre sozinho diz o modo da mensagem que lançou a tarefa, não o da última', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const replies: [string, boolean | undefined][] = [];
    agent.onOwnTurnReply = (text, tasksShared) => replies.push([text, tasksShared]);
    await agent.send('SOZINHO da privada', noop, false);
    await agent.send('pública no meio', noop, true); // antes de a tarefa terminar
    await vi.waitFor(() => expect(replies).toEqual([['sozinho: da privada', false]]));
    await agent.send('SOZINHO da pública', noop, true);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies[1]).toEqual(['sozinho: da pública', true]);
  });

  it('subagente privado que termina no meio de um turno público não decide a origem do turno dele seguinte', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const replies: [string, boolean | undefined][] = [];
    agent.onOwnTurnReply = (text, tasksShared) => replies.push([text, tasksShared]);
    await agent.send('AGENTE', noop, false); // subagente lançado no privado
    await agent.send('SOZINHO FIM da pública', noop, true); // a pública lança a tarefa; o subagente termina nela
    await vi.waitFor(() => expect(replies).toEqual([['sozinho: FIM da pública', true]]));
  });

  it('turno dele sem texto (só ferramenta) também avisa o fim, com texto vazio', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const seen: string[] = [];
    const replies: [string, boolean | undefined][] = [];
    agent.onOwnTurnEvent = (ev) => seen.push(`${ev.kind}: ${ev.text}`);
    agent.onOwnTurnReply = (text, tasksShared) => replies.push([text, tasksShared]);
    await agent.send('CALADO', noop, true);
    await vi.waitFor(() => expect(replies).toEqual([['', true]]));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^tool: /);
    await agent.send('depois', noop); // a mensagem seguinte não reabre o aviso
    expect(replies).toHaveLength(1);
  });

  it('mensagem que chega no meio do turno que ele abriu sozinho: cada resposta vai para o seu lugar', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const seen: string[] = [];
    const replies: string[] = [];
    agent.onOwnTurnEvent = (ev) => seen.push(ev.text);
    agent.onOwnTurnReply = (text) => replies.push(text);
    await agent.send('SOZINHO o Fog respondeu', noop);
    await vi.waitFor(() => expect(seen).toContain('sozinho: o Fog respondeu')); // o turno dele está aberto
    const texts: string[] = [];
    const answer = await agent.send('devil?', (ev) => texts.push(ev.text)); // o CLI junta os dois num result só
    expect(answer).toBe('eco: devil?');
    expect(texts).toEqual(['eco: devil?']);
    expect(replies).toEqual(['sozinho: o Fog respondeu']);
  });

  it('Remote Control: liga a ponte ao subir o processo e avisa o link', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude, remoteControl: true }));
    const notices: string[] = [];
    agent.onNotice = (ev) => notices.push(ev.text);
    expect(await agent.send('oi', noop)).toBe('eco: oi');
    expect(notices).toEqual(['Claude no Remote Control: https://claude.ai/code/session_falsa']);
  });

  it('Remote Control: o que você digita no app aparece como seu, e a resposta como turno dele', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude, remoteControl: true }));
    const typed: string[] = [];
    const replies: string[] = [];
    agent.onRemoteMessage = (text) => typed.push(text);
    agent.onOwnTurnReply = (text) => replies.push(text);
    await agent.send('APP oi do celular', noop);
    await vi.waitFor(() => expect(replies).toEqual(['eco: oi do celular']));
    expect(typed).toEqual(['oi do celular']);
    expect(await agent.send('e aqui?', noop)).toBe('eco: e aqui?');
  });

  it('Remote Control: cada mensagem do app fica com o turno que a responde', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude, remoteControl: true }));
    const typed: [string, boolean | undefined][] = [];
    const replies: [string, boolean | undefined][] = [];
    agent.onRemoteMessage = (text, inDuoTurn) => typed.push([text, inDuoTurn]);
    agent.onOwnTurnReply = (text, _tasks, fromApp) => replies.push([text, fromApp]);
    // lida no meio de um turno do duo: é dele, e não sobra nada para o turno seguinte
    expect(await agent.send('APP DENTRO no meio', noop)).toBe('eco: no meio');
    // lida antes da do duo, sem resposta no meio: entrou no turno do duo (o CLI respondeu as duas juntas)
    expect(await agent.send('APP ANTES junto', noop)).toBe('eco: junto');
    // com ele parado: abre um turno dele
    await agent.send('APP do celular', noop);
    await vi.waitFor(() => expect(replies).toEqual([['eco: do celular', true]]));
    // um turno dele aberto por tarefa, depois: não herda nada do app
    await agent.send('SOZINHO terminei', noop);
    await vi.waitFor(() => expect(replies).toEqual([['eco: do celular', true], ['sozinho: terminei', false]]));
    expect(typed).toEqual([
      ['no meio', true],
      ['junto', false],
      ['do celular', false],
    ]);
  });

  it('Remote Control: a lida antes da do duo, sem resposta no meio, não passa para o turno dele seguinte', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude, remoteControl: true }));
    const replies: [string, boolean | undefined][] = [];
    agent.onOwnTurnReply = (text, _tasks, fromApp) => replies.push([text, fromApp]);
    expect(await agent.send('APP ANTES junto', noop)).toBe('eco: junto');
    await agent.send('SOZINHO terminei', noop);
    await vi.waitFor(() => expect(replies).toEqual([['sozinho: terminei', false]]));
  });

  it('comandos: carregam ao subir, sem mensagem nenhuma, e acompanham as mudanças', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const seen: string[][] = [];
    agent.onCommands = (list) => seen.push(list.map((c) => c.name));
    agent.warmUp();
    await vi.waitFor(() => expect(agent.commands.map((c) => c.name)).toEqual(['compact', 'context', 'doctor']));
    expect(agent.commands[0]).toEqual({ name: 'compact', description: 'Resume a conversa', hint: '<instruções>' });
    await agent.send('MUDA', noop);
    expect(agent.commands.map((c) => c.name)).toEqual(['compact', 'context', 'doctor', 'nova']);
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it('comando local: a saída chega antes do eco e é a resposta do turno, não um turno dele sozinho', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const own: string[] = [];
    agent.onOwnTurnEvent = (ev) => own.push(ev.text);
    agent.onOwnTurnReply = (text) => own.push(text);
    const emitted: AgentEvent[] = [];
    expect(await agent.send('/context', (ev) => emitted.push(ev))).toBe('saída do /context');
    expect(emitted).toEqual([{ kind: 'text', text: 'saída do /context' }]);
    expect(own).toEqual([]);
  });

  it('ANTHROPIC_API_KEY no ambiente: avisa uma vez que o uso pode ser cobrado pela API; sem ela, nada', async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    try {
      process.env.ANTHROPIC_API_KEY = 'sk-falsa';
      const agent = track(new ClaudeAgent({ bin: fakeClaude }));
      const notices: string[] = [];
      agent.onNotice = (ev) => notices.push(ev.text);
      await agent.send('oi', noop);
      agent.reset(); // processo novo, novo system/init: o aviso não repete
      await agent.send('de novo', noop);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('ANTHROPIC_API_KEY');

      delete process.env.ANTHROPIC_API_KEY;
      const clean = track(new ClaudeAgent({ bin: fakeClaude }));
      const none: string[] = [];
      clean.onNotice = (ev) => none.push(ev.text);
      await clean.send('oi', noop);
      expect(none).toEqual([]);
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  });

  it('sem Remote Control, não pede a ponte', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    const notices: string[] = [];
    agent.onNotice = (ev) => notices.push(ev.text);
    await agent.send('oi', noop);
    expect(notices).toEqual([]);
  });

  it('o processo cai com a pergunta aberta: o pedido é cancelado', async () => {
    const agent = track(new ClaudeAgent({ bin: fakeClaude }));
    let signal: AbortSignal | undefined;
    agent.askPermission = (req) => ((signal = req.signal), new Promise<boolean>(() => undefined));
    const turn = agent.send('PEDE git push', noop).catch((e: Error) => e);
    await vi.waitFor(() => expect(signal).toBeDefined());
    agent.reset();
    await vi.waitFor(() => expect(signal!.aborted).toBe(true));
    expect(await turn).toBeInstanceOf(Error);
  });
});

describe('CodexAgent (app-server)', () => {
  it('conversa nova: avisa o id uma vez e usa o MESMO processo nas mensagens seguintes', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    const seen = vi.fn();
    agent.onSessionId = seen;
    expect(await agent.send('oi', noop)).toBe('eco: oi');
    expect(agent.resumeId).toBe('thread-nova');
    const pid1 = await agent.send('PID', noop);
    const pid2 = await agent.send('PID', noop);
    expect(pid1).toMatch(/^pid \d+$/);
    expect(pid2).toBe(pid1); // igual ao Claude: o Codex fica aberto
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith('thread-nova');
  });

  it('rodapé: modelo, contexto da conversa principal e subagentes rodando', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    await agent.send('oi', noop);
    expect(agent.stats).toEqual({ model: 'gpt-falso', effort: 'high', fast: true, contextTokens: 5000, contextWindow: 475000, subagents: 0 });
    await agent.send('AGENTE', noop);
    expect(agent.stats).toMatchObject({ contextTokens: 10000, subagents: 1 }); // a conversa do filho não conta
    await agent.send('FIM', noop);
    expect(agent.stats.subagents).toBe(0);
    agent.reset();
    expect(agent.stats.contextTokens).toBeUndefined();
  });

  it('seletor de modelo: a lista do model/list, o que vale antes da conversa, e a troca vai em cada turn/start', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    agent.warmUp();
    // todas as páginas, sem o escondido; e o config/read antes de abrir a conversa
    await vi.waitFor(() => expect(agent.models).toHaveLength(2));
    expect(agent.models).toEqual([
      { id: 'gpt-falso', resolved: 'gpt-falso', name: 'GPT Falso', description: 'o de sempre', efforts: ['low', 'high'], defaultEffort: 'low', fast: true },
      { id: 'gpt-mini', resolved: 'gpt-mini', name: 'GPT Mini', description: 'o pequeno', efforts: ['medium'], defaultEffort: 'medium', fast: false },
    ]);
    await vi.waitFor(() => expect(agent.stats).toMatchObject({ model: 'gpt-falso', effort: 'high', fast: true }));
    expect(await agent.send('TURNO', noop)).toBe('{}'); // nada escolhido: o turno segue a conversa

    await agent.setModel({ model: 'gpt-mini', effort: 'medium', fast: false });
    expect(agent.stats).toMatchObject({ model: 'gpt-mini', selected: 'gpt-mini', effort: 'medium', fast: undefined });
    expect(JSON.parse(await agent.send('TURNO', noop))).toEqual({ model: 'gpt-mini', effort: 'medium', serviceTier: null });
    // conversa nova: o thread/start diz o que o config.toml manda, e o escolhido continua por cima
    agent.reset();
    expect(JSON.parse(await agent.send('TURNO', noop))).toEqual({ model: 'gpt-mini', effort: 'medium', serviceTier: null });
    expect(agent.stats).toMatchObject({ model: 'gpt-mini', selected: 'gpt-mini', effort: 'medium' });

    await agent.setModel({ model: 'gpt-falso', effort: 'low', fast: true });
    expect(agent.stats).toMatchObject({ model: 'gpt-falso', effort: 'low', fast: true });
    expect(JSON.parse(await agent.send('TURNO', noop))).toEqual({ model: 'gpt-falso', effort: 'low', serviceTier: 'priority' });
  });

  it('segundo plano: o subagente aparece com o nome e o modelo, e sai quando termina', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    const seen: AgentTask[][] = [];
    agent.onTasks = (list) => seen.push(list);
    await agent.send('AGENTE', noop);
    expect(seen.at(-1)).toEqual([expect.objectContaining({ id: 'filho', kind: 'subagente', title: 'x', detail: 'gpt-filho' })]);
    await agent.send('FIM', noop);
    expect(seen.at(-1)).toEqual([]);
    await agent.send('AGENTE', noop);
    agent.reset(); // a conversa nova não herda o subagente da anterior
    expect(seen.at(-1)).toEqual([]);
  });

  it('sinal de vida: cada coisa que chega do processo avisa', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    const signal = vi.fn();
    agent.onSignal = signal;
    await agent.send('oi', noop);
    expect(signal.mock.calls.length).toBeGreaterThan(2);
  });

  it('sinal de vida: resposta também conta, não só notificação (a abertura só tem respostas)', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    const signal = vi.fn();
    agent.onSignal = signal;
    const loaded = new Promise<void>((r) => (agent.onCommands = () => r()));
    agent.warmUp();
    await loaded;
    expect(signal.mock.calls.length).toBeGreaterThanOrEqual(2); // initialize e skills/list
  });

  it('print: vai como localImage, pelo caminho, junto do texto (ou sozinho)', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    const img = { path: 'C:/prints/a.png', mediaType: 'image/png' as const };
    expect(await agent.send('olha', noop, true, [img])).toBe('eco: olha | imagens: C:/prints/a.png');
    expect(await agent.send('', noop, true, [img])).toBe('eco:  | imagens: C:/prints/a.png');
    expect(await agent.send('/revisar isto', noop, true, [img])).toBe(
      'eco: [skill revisar C:/skills/revisar/SKILL.md] $revisar isto | imagens: C:/prints/a.png',
    );
  });

  it('falar com o Claude: a ferramenta do duo leva a mensagem e devolve a resposta dele', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    const asked: string[] = [];
    agent.askPeer = async (req) => (asked.push(req.text), 'concordo');
    const errors: string[] = [];
    const answer = await agent.send('CHAMA revisa o diff', (ev) => ev.kind === 'error' && errors.push(ev.text));
    expect(asked).toEqual(['revisa o diff']);
    expect(answer).toBe('eco: [falar_com_claude] O Claude respondeu:\n\nconcordo');
    expect(errors).toEqual([]); // não é tratado como pedido recusado
    expect(JSON.parse(await agent.send('INIT', noop)).capabilities).toMatchObject({ experimentalApi: true });
    expect(JSON.parse(await agent.send('PARAMS', noop)).developerInstructions).toContain('falar_com_claude');
  });

  it('o Claude falha: a ferramenta devolve erro e o turno do Codex segue', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    agent.askPeer = async () => {
      throw new Error('o Claude não conseguiu responder');
    };
    expect(await agent.send('CHAMA oi', noop)).toBe('eco: [falar_com_claude erro] o Claude não conseguiu responder');
  });

  it('sem ninguém do outro lado, o Codex nem ganha a ferramenta (nem a API experimental)', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    expect(await agent.send('CHAMA oi', noop)).toBe('eco: sem a ferramenta do duo');
    expect(JSON.parse(await agent.send('INIT', noop))).not.toHaveProperty('capabilities');
  });

  it('retoma pelo id guardado, sem histórico inteiro e sem trocar de conversa', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex, resumeId: 'abc' }));
    const seen = vi.fn();
    agent.onSessionId = seen;
    const params = JSON.parse(await agent.send('PARAMS', noop));
    expect(params).toMatchObject({ threadId: 'abc', excludeTurns: true });
    expect(agent.resumeId).toBe('abc');
    expect(seen).not.toHaveBeenCalled();
  });

  it('por padrão roda livre: sem aprovações e sem sandbox', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    const params = JSON.parse(await agent.send('PARAMS', noop));
    expect(params).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
    expect(params).not.toHaveProperty('model');
  });

  it('com --codex-sandbox e --codex-model fica no modo e no modelo escolhidos', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex, sandbox: 'read-only', model: 'gpt-x' }));
    const params = JSON.parse(await agent.send('PARAMS', noop));
    expect(params).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only', model: 'gpt-x' });
  });

  it('conversa que não existe mais: ResumeFailedError, esquece o id e a próxima abre uma nova', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex, resumeId: 'sumiu' }));
    await expect(agent.send('oi', noop)).rejects.toBeInstanceOf(ResumeFailedError);
    expect(agent.resumeId).toBeUndefined();
    expect(await agent.send('oi', noop)).toBe('eco: oi');
    expect(agent.resumeId).toBe('thread-nova');
  });

  it('id malformado também conta como conversa perdida', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex, resumeId: 'ruim' }));
    await expect(agent.send('oi', noop)).rejects.toBeInstanceOf(ResumeFailedError);
    expect(agent.resumeId).toBeUndefined();
  });

  it('conversa aberta em outro lugar: erro claro, e NÃO abandona a conversa', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex, resumeId: 'ocupada' }));
    const err = await agent.send('oi', noop).catch((e) => e);
    expect(err).not.toBeInstanceOf(ResumeFailedError);
    expect(String(err.message)).toContain('aberta em outro lugar');
    expect(agent.resumeId).toBe('ocupada');
  });

  it('caiu no meio do turno: é falha; a próxima mensagem sobe outro processo e retoma a mesma conversa', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    const pidAntes = await agent.send('PID', noop);
    const emitted: string[] = [];
    const err = await agent.send('QUEBRA aqui', (ev) => emitted.push(ev.text)).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toContain('o codex fechou');
    expect(emitted).toContain('eco: QUEBRA aqui'); // o texto apareceu na tela, mas o turno não fechou
    const params = JSON.parse(await agent.send('PARAMS', noop));
    expect(params.threadId).toBe('thread-nova'); // retomou, não abriu outra
    expect(await agent.send('PID', noop)).not.toBe(pidAntes);
  });

  it('turno que falha: rejeita com a mensagem do Codex', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    await expect(agent.send('FALHA', noop)).rejects.toThrow('deu ruim');
    expect(await agent.send('depois', noop)).toBe('eco: depois'); // a conversa segue
  });

  it('mostra o comando sem o invólucro do PowerShell e o código de saída', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    const emitted: string[] = [];
    await agent.send('CMD', (ev) => emitted.push(ev.text));
    expect(emitted).toContain('$ echo oi');
    expect(emitted).toContain('  ↳ saiu com código 1');
  });

  it('pedido de aprovação do servidor: recusa, avisa na tela e o turno termina', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    const emitted: { kind: string; text: string }[] = [];
    const answer = await agent.send('PEDE', (ev) => emitted.push(ev));
    expect(answer).toMatch(/^recusado:/);
    expect(emitted.some((e) => e.kind === 'error' && e.text.includes('item/commandExecution/requestApproval'))).toBe(true);
  });

  it('mensagem logo depois do warmUp espera o initialize (o app-server recusa qualquer pedido antes dele)', async () => {
    const agent = track(new CodexAgent({ bin: [...fakeCodex, '--init-delay', '300'] }));
    agent.warmUp();
    expect(await agent.send('oi', noop)).toBe('eco: oi');
    expect(await agent.send('de novo', noop)).toBe('eco: de novo');
  });

  it('evento de outro turno não entra no turno atual', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    const shown: string[] = [];
    expect(await agent.send('INTRUSO', (ev) => shown.push(ev.text))).toBe('eco: INTRUSO');
    expect(shown).not.toContain('NAO-E-MEU');
  });

  it('eventos que chegam antes da resposta do turn/start esperam e entram no turno certo', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    expect(await agent.send('ANTES', noop)).toBe('eco: ANTES');
    expect(await agent.send('depois', noop)).toBe('eco: depois');
  });

  it('turn/start que estoura o prazo: falha, e quando a resposta chega atrasada o turno é interrompido', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    await shortDeadline(agent, 150);
    await expect(agent.send('DEMORA', noop)).rejects.toThrow(/não respondeu a turn\/start/);
    expect(await agent.send('oi', noop)).toBe('eco: oi'); // a resposta do turno demorado não vem para cá
    await new Promise((r) => setTimeout(r, 500)); // a resposta atrasada chega aos 400ms
    expect(JSON.parse(await agent.send('INTERROMPIDOS', noop))).toEqual(['turno-1']);
  });

  it('turno que estourou o prazo não chama o Claude: a ferramenta recusa', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    const asked: string[] = [];
    agent.askPeer = async ({ text }) => {
      asked.push(text);
      return 'NAO-DEVIA';
    };
    await shortDeadline(agent, 150);
    await expect(agent.send('ATRASA oi claude', noop)).rejects.toThrow(/não respondeu a turn\/start/);
    await new Promise((r) => setTimeout(r, 450)); // a chamada chega aos 300ms, sem a resposta do turn/start
    expect(asked).toEqual([]);
    const [res] = JSON.parse(await agent.send('RESPOSTAS', noop));
    expect(res.success).toBe(false);
    expect(res.contentItems[0].text).toMatch(/não espera mais este turno/);
  });

  it('comandos: as skills ligadas carregam ao subir, e "/skill" manda a skill junto', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    agent.warmUp();
    await vi.waitFor(() => expect(agent.commands).toEqual([{ name: 'revisar', description: 'a skill revisar' }]));
    expect(await agent.send('/revisar o parser', noop)).toBe(
      'eco: [skill revisar C:/skills/revisar/SKILL.md] $revisar o parser',
    );
    expect(await agent.send('/desligada x', noop)).toBe('eco: /desligada x'); // não é skill: vai como texto
  });

  it('reset: a próxima mensagem começa conversa nova', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex, resumeId: 'abc' }));
    await agent.send('oi', noop);
    agent.reset();
    expect(agent.resumeId).toBeUndefined();
    await agent.send('oi', noop);
    expect(agent.resumeId).toBe('thread-nova');
  });
});
