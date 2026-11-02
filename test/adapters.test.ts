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

describe('CodexAgent', () => {
  it('conversa nova e depois retomada pelo thread_id', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    const seen = vi.fn();
    agent.onSessionId = seen;
    expect(await agent.send('oi', noop)).toBe('eco: oi');
    expect(agent.resumeId).toBe('thread-nova');
    expect(agent.buildArgs()).toEqual(expect.arrayContaining(['resume', 'thread-nova']));
    expect(await agent.send('segunda', noop)).toBe('eco: segunda');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('conversa que não existe mais: ResumeFailedError, esquece o id e a próxima abre uma nova', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex, resumeId: 'sumiu' }));
    await expect(agent.send('oi', noop)).rejects.toBeInstanceOf(ResumeFailedError);
    expect(agent.resumeId).toBeUndefined();
    expect(await agent.send('oi', noop)).toBe('eco: oi');
    expect(agent.resumeId).toBe('thread-nova');
  });

  it('conversa aberta em outro lugar: erro claro, e NÃO abandona a conversa', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex, resumeId: 'ocupada' }));
    const err = await agent.send('oi', noop).catch((e) => e);
    expect(err).not.toBeInstanceOf(ResumeFailedError);
    expect(String(err.message)).toContain('aberta em outro lugar');
    expect(agent.resumeId).toBe('ocupada');
  });

  it('escreveu texto mas caiu antes de concluir: é falha, não sucesso', async () => {
    const agent = track(new CodexAgent({ bin: fakeCodex }));
    const emitted: string[] = [];
    const err = await agent.send('QUEBRA aqui', (ev) => emitted.push(ev.text)).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err.message)).toContain('sem concluir o turno');
    expect(emitted).toContain('eco: QUEBRA aqui'); // o texto apareceu na tela, mas o turno não fechou
  });
});
