import type { AgentId } from './agents/types.js';

export type Target = AgentId | 'todos';

export type Command =
  | { type: 'ask'; targets: AgentId[]; prompt: string; newDefault: Target }
  | { type: 'share'; on: boolean }
  | { type: 'new' }
  | { type: 'clear' }
  | { type: 'help' }
  | { type: 'quit' }
  | { type: 'invalid'; message: string };

const ALIASES: Record<string, Target> = {
  claude: 'claude',
  c: 'claude',
  cla: 'claude',
  codex: 'codex',
  x: 'codex',
  fog: 'codex',
  todos: 'todos',
  ambos: 'todos',
  all: 'todos',
};

export function targetsOf(t: Target): AgentId[] {
  return t === 'todos' ? ['claude', 'codex'] : [t];
}

/** Transforma o que você digitou em uma ação. `current` é o destino padrão atual. */
export function parseInput(raw: string, current: Target): Command | null {
  const input = raw.trim();
  if (!input) return null;

  if (input.startsWith('/')) {
    const [cmd] = input.slice(1).split(/\s+/);
    switch (cmd.toLowerCase()) {
      case 'sair':
      case 'quit':
      case 'exit':
        return { type: 'quit' };
      case 'limpar':
      case 'clear':
        return { type: 'clear' };
      case 'novo':
      case 'new':
        return { type: 'new' };
      case 'ajuda':
      case 'help':
        return { type: 'help' };
      case 'privado':
        return { type: 'share', on: false };
      case 'compartilhado':
      case 'compartilhar':
        return { type: 'share', on: true };
      default:
        return { type: 'invalid', message: `comando desconhecido: /${cmd} (digite /ajuda)` };
    }
  }

  // O nome é só letras/números: "@fog?" é @fog + "?", e "@codex, revisa" é @codex + "revisa".
  const mention = input.match(/^@([\p{L}\p{N}_-]+)([\s\S]*)$/u);
  if (mention) {
    const target = ALIASES[mention[1].toLowerCase()];
    if (!target) return { type: 'invalid', message: `não conheço @${mention[1]} — use @claude, @codex ou @todos` };
    const prompt = mention[2].replace(/^[\s,:;]+/, '').trim();
    // "@codex" sozinho só troca o destino padrão.
    return { type: 'ask', targets: prompt ? targetsOf(target) : [], prompt, newDefault: target };
  }

  return { type: 'ask', targets: targetsOf(current), prompt: input, newDefault: current };
}

export const HELP_TEXT = [
  '@claude <msg>     manda só para o Claude      (atalhos: @c, @cla)',
  '@codex <msg>      manda só para o Codex       (atalhos: @x, @fog)',
  '@todos <msg>      manda para os dois          (ou @ambos)',
  '@codex            sem mensagem: muda o destino padrão',
  '<msg>             manda para o destino padrão (aparece antes do ›)',
  '/compartilhado    (padrão) cada um vê o que você e o outro disseram',
  '/privado          só quem recebe vê; o outro não fica sabendo nem depois',
  '/novo             começa conversas novas com os dois',
  '/limpar           limpa a tela',
  '/sair             encerra (ou Ctrl+C)',
].join('\n');
