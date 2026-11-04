import type { AgentModel, AgentStats } from './agents/types.js';
import type { ChangedFile } from './changes.js';
import type { Who } from './persist.js';

/** O que as duas telas (terminal e janela) mostram do mesmo jeito. Sem nada de Node: a janela também usa. */

/** As linhas de um arquivo no "O que mudou": "+12 −3", "+40", "−7"; ou o motivo de não ter contagem. */
export function countText(f: ChangedFile): string {
  if (f.added === undefined || f.removed === undefined) return f.note ?? '';
  // só renomeado, ou arquivo novo vazio: não há linha para contar
  return [f.added > 0 ? `+${f.added}` : '', f.removed > 0 ? `−${f.removed}` : ''].filter(Boolean).join(' ');
}

/** O aviso que acompanha o "O que mudou". */
export const CHANGES_CAVEAT = 'Mostra o que mudou, não que funciona, nem quem fez cada mudança.';

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

/**
 * O modelo da lista que está valendo: o escolhido no duo, se é ele que o CLI diz que está em uso (um /model mandado
 * como mensagem troca por fora); senão o que bate com o que o CLI informou.
 */
export function currentModel(models: AgentModel[], stats: AgentStats): AgentModel | undefined {
  const inUse = (m: AgentModel) => stats.model === undefined || m.id === stats.model || m.resolved === stats.model;
  return (
    models.find((m) => m.id === stats.selected && inUse(m)) ??
    models.find((m) => m.id === stats.model) ??
    models.find((m) => m.resolved === stats.model)
  );
}

/** "Sonnet 5.5 · high · rápido": o chip do seletor e o aviso de troca na conversa. */
export function modelLabel(models: AgentModel[], stats: AgentStats): string {
  const name = currentModel(models, stats)?.name ?? stats.model ?? 'modelo padrão';
  return [name, stats.effort, stats.fast ? 'rápido' : undefined].filter(Boolean).join(' · ');
}

export const COLORS: Record<Who, string> = {
  claude: '#D97757',
  codex: '#10A37F',
  voce: '#4F9DFF',
  sistema: 'gray',
};

export const NAMES: Record<Who, string> = { claude: 'Claude', codex: 'Codex', voce: 'você', sistema: 'duo' };
