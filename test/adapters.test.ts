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
