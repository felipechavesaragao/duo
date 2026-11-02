import type { AgentId } from './agents/types.js';

/**
 * /brain: quem foi marcado responde, o outro avalia, e eles revezam até um concordar com a última
 * resposta do outro. Cada um vê a resposta anterior pelo contexto compartilhado da janela.
 *
 * Acordo: a partir da 2ª resposta, cada um termina com uma linha só com [CONCORDO] ou [DISCORDO].
 * [CONCORDO] = concorda com a última resposta do outro sem mudar nada; aí os dois têm a mesma posição
 * e o brain termina. Sem marca conta como discordância. Limite escolhido pelo Felipe em 02/11/2026.
 */
export const BRAIN_MAX = 6;

const NAMES: Record<AgentId, string> = { claude: 'Claude', codex: 'Codex' };
export const otherOf = (id: AgentId): AgentId => (id === 'claude' ? 'codex' : 'claude');

/** O que vai para quem responde primeiro: a instrução do brain e a pergunta do usuário. */
export function brainOpening(first: AgentId, question: string): string {
  return (
    `[duo · brain] Você responde primeiro. Depois o ${NAMES[otherOf(first)]} vai avaliar a sua resposta, e vocês ` +
    `vão revezar até concordarem (no máximo ${BRAIN_MAX} respostas no total). Dê a sua melhor resposta completa.\n\n` +
    question
  );
}

/** O que vai para quem avalia: a última resposta do outro já está no contexto, logo acima. */
export function brainReview(who: AgentId): string {
  const other = NAMES[otherOf(who)];
  return (
    `[duo · brain] Vocês dois estão revezando sobre a pergunta do usuário até concordarem. ` +
    `A última resposta do ${other} está no contexto acima.\n` +
    `Avalie essa resposta. Se concorda com ela integralmente, sem mudar nada, termine com uma última linha contendo só [CONCORDO]. ` +
    `Se não concorda, explique o que muda, dê a sua versão completa e termine com uma última linha contendo só [DISCORDO].`
  );
}

/** Lê a marca da última linha. Aceita negrito/código em volta; qualquer outra coisa não é acordo. */
export function brainVerdict(answer: string): 'concordo' | 'discordo' | null {
  const last = answer.trim().split(/\r?\n/).at(-1) ?? '';
  const mark = last.replace(/[*_`]/g, '').trim().toUpperCase();
  if (/^\[\s*CONCORDO\s*\]\.?$/.test(mark)) return 'concordo';
  if (/^\[\s*DISCORDO\s*\]\.?$/.test(mark)) return 'discordo';
  return null;
}
