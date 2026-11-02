import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAgent } from '../src/agents/claude.js';
import { CodexAgent } from '../src/agents/codex.js';
import { ResumeFailedError, type Agent } from '../src/agents/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = [process.execPath, path.join(here, 'fixtures', 'fake-claude.mjs')];
const fakeCodex = [process.execPath, path.join(here, 'fixtures', 'fake-codex.mjs')];
const noop = () => undefined;

const live: Agent[] = [];
const track = <T extends Agent>(a: T) => (live.push(a), a);
afterEach(() => live.splice(0).forEach((a) => a.dispose()));

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
    expect(agent.stats).toEqual({ model: 'claude-falso-1', contextTokens: 1000, contextWindow: 200000, subagents: 0 });
    await agent.send('AGENTE', noop);
    expect(agent.stats).toMatchObject({ contextTokens: 2000, subagents: 1 }); // o uso do subagente não conta
    await agent.send('FIM', noop);
    expect(agent.stats.subagents).toBe(0);
    expect(seen).toHaveBeenLastCalledWith(agent.stats);
    agent.reset();
    expect(agent.stats).toMatchObject({ contextTokens: undefined, subagents: 0 });
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
    expect(agent.stats).toEqual({ model: 'gpt-falso', contextTokens: 5000, contextWindow: 475000, subagents: 0 });
    await agent.send('AGENTE', noop);
    expect(agent.stats).toMatchObject({ contextTokens: 10000, subagents: 1 }); // a conversa do filho não conta
    await agent.send('FIM', noop);
    expect(agent.stats.subagents).toBe(0);
    agent.reset();
    expect(agent.stats.contextTokens).toBeUndefined();
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

  it('reset: a próxima mensagem começa conversa nova', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex, resumeId: 'abc' }));
    await agent.send('oi', noop);
    agent.reset();
    expect(agent.resumeId).toBeUndefined();
    await agent.send('oi', noop);
    expect(agent.resumeId).toBe('thread-nova');
  });
});
