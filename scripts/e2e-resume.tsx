// Teste real do `duo -c`: digita na tela do duo com o Claude e o Codex DE VERDADE, fecha tudo,
// reabre retomando a conversa e confere que cada um lembra do que foi dito antes de fechar.
// uso: npx tsx scripts/e2e-resume.tsx <pasta-de-trabalho-vazia>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/app.js';
import { ClaudeAgent } from '../src/agents/claude.js';
import { CodexAgent } from '../src/agents/codex.js';
import { newSessionData, Recorder, SessionStore, type SessionData } from '../src/persist.js';

const work = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'duo-e2e-work-')));
fs.mkdirSync(work, { recursive: true });
const store = new SessionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'duo-e2e-store-')));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const makeAgents = (data: SessionData) => ({
  claude: new ClaudeAgent({ cwd: work, resumeId: data.claudeSessionId }),
  codex: new CodexAgent({ cwd: work, sandbox: 'read-only', resumeId: data.codexThreadId }),
});

async function type(stdin: { write: (s: string) => void }, text: string) {
  stdin.write(text);
  await delay(100);
  stdin.write('\r');
  await delay(300);
}

/** O que o teste cobra. Qualquer item falso faz o script sair com código 1. */
const checks: { what: string; ok: boolean; detail?: string }[] = [];
const check = (what: string, ok: boolean, detail?: string) => checks.push({ what, ok, detail });

/** Espera todos os turnos terminarem (lendo o mesmo estado que o duo grava) e cobra que todos deram certo. */
async function settle(rec: Recorder, label: string) {
  const t0 = Date.now();
  while (rec.data.turns.some((t) => t.status === 'pending' || t.status === 'running')) {
    if (Date.now() - t0 > 300_000) throw new Error(`${label}: demorou mais de 5 min`);
    await delay(500);
  }
  const states = rec.data.turns.map((t) => `${t.agent}=${t.status}`).join(' ');
  console.log(`  ${label}: ${states} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  check(`${label}: todos os turnos concluídos`, rec.data.turns.every((t) => t.status === 'done'), states);
}

const lastText = (data: SessionData, who: 'claude' | 'codex') =>
  [...data.screen].reverse().find((e) => e.who === who && e.kind === 'text')?.text ?? '(nada)';

// ---------- 1ª sessão
console.log(`pasta de trabalho: ${work}\n== 1ª sessão (duo)`);
const data1 = newSessionData(work);
const rec1 = new Recorder(data1, store);
const agents1 = makeAgents(data1);
const app1 = render(<App agents={agents1} recorder={rec1} />);
await delay(500); // a tela precisa abrir antes de receber teclas
await type(app1.stdin, '@todos Guarde a palavra-código TAMARINDO. Responda só: OK');
await settle(rec1, 'turno 1');
await type(app1.stdin, '@claude Guarde também: o número da sorte é 42. Responda só: OK');
await settle(rec1, 'turno 2');
app1.unmount();
rec1.close();
Object.values(agents1).forEach((a) => a.dispose()); // mata os processos: nada fica na memória

// ---------- 2ª sessão: como o `duo -c`
const data2 = store.load(store.lastIdFor(work)!)!;
const savedClaude = data2.claudeSessionId; // guardados ANTES: o duo atualiza data2 se o id mudar
const savedCodex = data2.codexThreadId;
console.log(`\n== 2ª sessão (duo -c)\n  ids gravados: claude=${savedClaude} codex=${savedCodex}`);
if (!savedClaude || !savedCodex) throw new Error('a 1ª sessão não gravou os dois ids: teste inválido');
const rec2 = new Recorder(data2, store);
const agents2 = makeAgents(data2);
const app2 = render(<App agents={agents2} recorder={rec2} resumed />);
await delay(500);
await type(app2.stdin, '@todos Sem procurar em arquivos: qual palavra-código eu pedi para guardar, e qual número da sorte eu disse ao Claude? Responda numa linha; se não souber algum, diga NAO SEI.');
await settle(rec2, 'turno 3');
const frames = app2.frames.join('\n');
app2.unmount();
rec2.close();
Object.values(agents2).forEach((a) => a.dispose());

const claudeSays = lastText(rec2.data, 'claude');
const codexSays = lastText(rec2.data, 'codex');
const knows = (t: string) => /TAMARINDO/i.test(t) && /\b42\b/.test(t);
check('banner de retomada na tela', frames.includes('Conversa retomada'));
check('mesma conversa do Claude', agents2.claude.resumeId === savedClaude, agents2.claude.resumeId);
check('mesma conversa do Codex', agents2.codex.resumeId === savedCodex, agents2.codex.resumeId);
check('Claude lembra TAMARINDO e 42', knows(claudeSays), claudeSays);
// TAMARINDO veio da conversa do próprio Codex; o 42 só foi dito ao Claude e chega pelo contexto compartilhado gravado.
check('Codex lembra TAMARINDO e 42', knows(codexSays), codexSays);

console.log('');
for (const c of checks) console.log(`  ${c.ok ? 'ok    ' : 'FALHOU'} ${c.what}${c.detail && !c.ok ? ` → ${c.detail}` : ''}`);
console.log(`  Claude: ${claudeSays}\n  Codex:  ${codexSays}`);
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `\nREPROVADO: ${failed} de ${checks.length} verificações falharam` : `\nAPROVADO: ${checks.length} de ${checks.length}`);
process.exit(failed ? 1 : 0);
