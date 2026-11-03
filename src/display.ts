import type { AgentStats } from './agents/types.js';
import type { Who } from './persist.js';

/** O que as duas telas (terminal e janela) mostram do mesmo jeito. Sem nada de Node: a janela também usa. */

/** 950, 12k, 1M, 1,5M */
function shortCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '').replace('.', ',')}M`;
}

/** Uma metade do rodapé: "claude-opus-5-5 · 64k/1M tokens (6%) · 1 agent rodando". */
export function footerText(s: AgentStats): string {
  const model = s.model ?? 'modelo ?';
  let tokens = '— tokens';
  if (s.contextTokens !== undefined) {
    tokens = shortCount(s.contextTokens);
    if (s.contextWindow) {
      tokens += `/${shortCount(s.contextWindow)} tokens (${Math.round((100 * s.contextTokens) / s.contextWindow)}%)`;
    } else {
      tokens += ' tokens';
    }
  }
  const agents =
    s.subagents === 0 ? 'sem agent' : `${s.subagents} ${s.subagents === 1 ? 'agent rodando' : 'agents rodando'}`;
  return `${model} · ${tokens} · ${agents}`;
}

export const COLORS: Record<Who, string> = {
  claude: '#D97757',
  codex: '#10A37F',
  voce: '#4F9DFF',
  sistema: 'gray',
};

export const NAMES: Record<Who, string> = { claude: 'Claude', codex: 'Codex', voce: 'você', sistema: 'duo' };
