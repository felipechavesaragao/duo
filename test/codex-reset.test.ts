import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexAgent } from '../src/agents/codex.js';

// O processo velho ainda responde depois do reset (a resposta já estava a caminho): aqui o killTree não mata na
// hora, só guarda o processo para o fim do teste.
const held = vi.hoisted(() => [] as ChildProcess[]);
vi.mock('../src/agents/process.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/agents/process.js')>();
  return { ...real, killTree: (proc: ChildProcess | undefined) => void (proc && held.push(proc)) };
});
const { killTree } = await vi.importActual<typeof import('../src/agents/process.js')>('../src/agents/process.js');
afterEach(() => held.splice(0).forEach((p) => killTree(p)));

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCodex = [process.execPath, path.join(here, 'fixtures', 'fake-codex.mjs')];

it('/novo no meio da abertura da conversa: a resposta atrasada do processo velho não grava o id dela', async () => {
  const agent = new CodexAgent({ bin: [...fakeCodex, '--thread-delay', '300'] });
  const ids: string[] = [];
  agent.onSessionId = (id) => ids.push(id);
  agent.warmUp();
  await vi.waitFor(() => expect(agent.commands.length).toBeGreaterThan(0), { timeout: 4000 }); // o initialize passou
  const sent = agent.send('oi', () => undefined);
  await new Promise((r) => setTimeout(r, 100)); // o thread/start está pendente
  agent.reset();
  await expect(sent).rejects.toThrow('o duo fechou o codex');
  await new Promise((r) => setTimeout(r, 400)); // o processo velho respondeu aos 300ms
  expect(agent.resumeId).toBeUndefined();
  expect(ids).toEqual([]);
  agent.dispose();
});
