import type { AgentId } from './agents/types.js';
import { clip } from './shared.js';

/**
 * /brain tem dois jeitos (Felipe, 04/11/2026: "com o /cla ou /fog seria o jeito velho e sem o jeito novo").
 *
 * Jeito velho, /brain /cla|/fog <pergunta>: quem foi marcado responde, o outro avalia, e eles revezam até um
 * concordar com a última resposta do outro. Cada um vê a resposta anterior pelo contexto compartilhado da janela.
 * A partir da 2ª resposta, cada um termina com uma linha só com [CONCORDO] ou [DISCORDO]. [CONCORDO] = concorda com a
 * última resposta do outro sem mudar nada; aí os dois têm a mesma posição e o brain termina. Sem marca conta como
 * discordância.
 *
 * Jeito novo, /brain <pergunta>: os dois respondem cada um por si, ao mesmo tempo, sem ver a resposta do outro (como
 * no /todos). Depois vem o confronto: o destino padrão (brainOpener) lê a resposta do outro e avalia, e eles revezam
 * como no jeito velho. Além das duas marcas, qualquer resposta pode terminar com [FALTA: <a informação>] = sem ela não
 * dá para responder. Como o [CONCORDO], ela só encerra quando o outro concorda: [CONCORDO] com uma resposta [FALTA: X]
 * encerra dizendo que falta X, em vez de forçar um acordo.
 *
 * Limite escolhido pelo Felipe em 02/11/2026, nos dois jeitos: 6 respostas no total (no novo, contando as 2 primeiras).
 */
export const BRAIN_MAX = 6;
/**
 * No jeito novo, quem abre o confronto: o destino padrão na hora do /brain (Felipe, 04/11/2026: "O destino padrão").
 * O /todos não indica ninguém: aí o Claude abre, o primeiro da ordem do /todos (Felipe, 04/11/2026: "Sim, o Cla abre").
 */
export const brainOpener = (target: AgentId | 'todos'): AgentId => (target === 'todos' ? 'claude' : target);

const NAMES: Record<AgentId, string> = { claude: 'Claude', codex: 'Codex' };
export const otherOf = (id: AgentId): AgentId => (id === 'claude' ? 'codex' : 'claude');

// ---- jeito velho: /brain /cla|/fog <pergunta> ----

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
  const mark = lastLine(answer).replace(/[*_`]/g, '').trim().toUpperCase();
  if (/^\[\s*CONCORDO\s*\]\.?$/.test(mark)) return 'concordo';
  if (/^\[\s*DISCORDO\s*\]\.?$/.test(mark)) return 'discordo';
  return null;
}

// ---- jeito novo: /brain <pergunta> ----

const FALTA_MARK = 'termine com uma última linha contendo só [FALTA: <a informação>]';

/** O que vai para cada um no começo do jeito novo: a instrução e a pergunta do usuário. */
export function brainAlone(who: AgentId, question: string): string {
  return (
    `[duo · brain] Você e o ${NAMES[otherOf(who)]} vão responder a esta pergunta cada um por si, ao mesmo tempo: ` +
    `nenhum dos dois vê a resposta do outro antes de responder. Depois vem o confronto: cada um lê a resposta do ` +
    `outro, e vocês revezam até concordarem (no máximo ${BRAIN_MAX} respostas no total, contando estas duas). ` +
    `Dê a sua melhor resposta completa. Se não dá para responder sem uma informação que você não tem, diga qual é e ` +
    `${FALTA_MARK}.\n\n` +
    question
  );
}

/**
 * O que vai para quem avalia no confronto do jeito novo, com a resposta avaliada no próprio prompt, e não só no
 * contexto: uma mensagem sua para o outro no meio do brain (/fog …) também entra no contexto, e a "última resposta"
 * dele lá seria a de fora do brain. O [CONCORDO] encerra sobre esta resposta (é dela que vem a falta anunciada).
 * Ela vai cortada como no contexto (clip): o começo e o fim, se for longa.
 */
export function brainConfront(who: AgentId, answer: string): string {
  const other = NAMES[otherOf(who)];
  return (
    `[duo · brain] Confronto: vocês dois já responderam à pergunta do usuário cada um por si e agora revezam até ` +
    `concordarem. A resposta do ${other} que você avalia é a última dele no brain, repetida entre as linhas ===== ` +
    `(se o contexto acima tiver outra mensagem dele, de fora do brain, ela não conta):\n` +
    `=====\n${clip(answer)}\n=====\n` +
    `Avalie essa resposta. Se concorda com ela integralmente, sem mudar nada, termine com uma última linha contendo ` +
    `só [CONCORDO]; vale também quando ela diz que falta uma informação e você concorda que falta. ` +
    `Se não dá para responder sem uma informação que vocês não têm, diga qual é e ${FALTA_MARK}. ` +
    `Se não concorda, explique o que muda, dê a sua versão completa e termine com uma última linha contendo só [DISCORDO].`
  );
}

/**
 * A informação que a resposta diz que falta: a última linha é [FALTA: <a informação>], com negrito/código em volta.
 * null = não é isso. O texto da informação vem como está (sem tirar `_` nem `*` de dentro dele).
 */
export function brainMissing(answer: string): string | null {
  return lastLine(answer).match(/^[\s*_`]*\[\s*FALTA\s*:\s*(.*\S)\s*\][\s*_`]*\.?$/i)?.[1] ?? null;
}

function lastLine(answer: string): string {
  return answer.trim().split(/\r?\n/).at(-1) ?? '';
}
