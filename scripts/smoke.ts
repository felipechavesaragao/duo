// Teste real: fala com o Claude Code e o Codex de verdade, sem a tela.
import { ClaudeAgent } from '../src/agents/claude.js';
import { CodexAgent } from '../src/agents/codex.js';
import type { Agent, AgentId } from '../src/agents/types.js';
import { SharedLog } from '../src/shared.js';

const log = new SharedLog();
const agents: Record<AgentId, Agent> = {
  claude: new ClaudeAgent({ permissionMode: 'default' }),
  codex: new CodexAgent({ sandbox: 'read-only' }),
};

/** O mesmo ciclo do duo: registra, monta o prompt na vez do agente, marca entregue só se ele responder. */
async function ask(id: AgentId, text: string): Promise<string> {
  const idx = log.userMessage([id], text, true);
  const prepared = log.prepare(id, text, true, idx);
  const answer = await agents[id].send(prepared.prompt, (ev) => console.log(`[${id}:${ev.kind}] ${ev.text}`));
  log.delivered(id, prepared);
  log.agentReply(id, answer, true);
  return answer;
}

try {
  const a1 = await ask('claude', 'Escolha um número secreto entre 1 e 9 e responda só com ele.');
  const a2 = await ask('codex', 'Qual número o Claude escolheu? Responda só com o número.');
  const a3 = await ask('claude', 'O Codex acertou? E qual número você tinha escolhido? Responda numa linha.');
  const a4 = await ask('codex', 'Diga a palavra BANANA e lembre qual era o número.');
  console.log('\nRESULTADO', JSON.stringify({ a1, a2, a3, a4 }));
} finally {
  Object.values(agents).forEach((a) => a.dispose());
}
