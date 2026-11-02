import type { AgentId } from './agents/types.js';
import { BRAIN_MAX } from './brain.js';

export type Target = AgentId | 'todos';

export type Command =
  | { type: 'ask'; targets: AgentId[]; prompt: string; newDefault: Target }
  | { type: 'brain'; first: AgentId; prompt: string }
  | { type: 'stop' }
  | { type: 'share'; on: boolean }
  | { type: 'new' }
  | { type: 'clear' }
  | { type: 'help' }
  | { type: 'quit' }
  | { type: 'invalid'; message: string };

/** Nomes de quem recebe. Valem com `/` (principal) ou `@`: /fog e @fog são a mesma coisa. */
export const ALIASES: Record<string, Target> = {
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

/** Comandos do próprio duo. ⛔ Nenhum nome aqui pode existir em ALIASES (o teste do roteador cobra). */
export const COMMANDS: Record<string, Exclude<Command, { type: 'ask' | 'invalid' | 'brain' }>> = {
  parar: { type: 'stop' },
  sair: { type: 'quit' },
  quit: { type: 'quit' },
  exit: { type: 'quit' },
  limpar: { type: 'clear' },
  clear: { type: 'clear' },
  novo: { type: 'new' },
  new: { type: 'new' },
  ajuda: { type: 'help' },
  help: { type: 'help' },
  privado: { type: 'share', on: false },
  compartilhado: { type: 'share', on: true },
  compartilhar: { type: 'share', on: true },
};

/** Comandos que levam argumento. Entram na checagem de nomes junto com COMMANDS. */
export const COMMAND_NAMES = [...Object.keys(COMMANDS), 'brain'];

const BRAIN_USAGE = 'use /brain /cla <pergunta> (o Claude começa) ou /brain /fog <pergunta> (o Codex começa)';

/** O nome é só letras/números: "/fog?" é /fog + "?", e "/codex, revisa" é /codex + "revisa". */
const NAMED = /^([/@])([\p{L}\p{N}_-]+)([\s\S]*)$/u;
const cleanPrompt = (rest: string) => rest.replace(/^[\s,:;]+/, '').trim();
const targetOf = (name: string): Target | undefined => (Object.hasOwn(ALIASES, name) ? ALIASES[name] : undefined);

/** Transforma o que você digitou em uma ação. `current` é o destino padrão atual. */
export function parseInput(raw: string, current: Target): Command | null {
  const input = raw.trim();
  if (!input) return null;

  const named = input.match(NAMED);
  const [sigil, name = '', rest = ''] = named ? [named[1], named[2].toLowerCase(), named[3]] : [input[0]];

  // Object.hasOwn: "/constructor" ou "@toString" não podem achar nada herdado do objeto.
  if (sigil === '/' && Object.hasOwn(COMMANDS, name)) return { ...COMMANDS[name] };

  if (sigil === '/' && name === 'brain') {
    const who = rest.trim().match(NAMED);
    const first = who ? targetOf(who[2].toLowerCase()) : undefined;
    if (!who || !first || first === 'todos') return { type: 'invalid', message: `quem começa o brain? ${BRAIN_USAGE}` };
    const prompt = cleanPrompt(who[3]);
    if (!prompt) return { type: 'invalid', message: `falta a pergunta: ${BRAIN_USAGE}` };
    return { type: 'brain', first, prompt };
  }

  if (sigil === '/' || sigil === '@') {
    const target = targetOf(name);
    if (!target) {
      const typed = named ? `${sigil}${named[2]}` : sigil;
      return sigil === '/'
        ? { type: 'invalid', message: `comando desconhecido: ${typed} — para falar com um agente use /cla, /fog ou /todos (digite /ajuda)` }
        : { type: 'invalid', message: `não conheço ${typed} — use /cla, /fog ou /todos` };
    }
    // "/cla /init" manda o /init para o Claude: o que vem depois do nome é a mensagem, como está.
    const prompt = cleanPrompt(rest);
    // "/codex" sozinho só troca o destino padrão.
    return { type: 'ask', targets: prompt ? targetsOf(target) : [], prompt, newDefault: target };
  }

  return { type: 'ask', targets: targetsOf(current), prompt: input, newDefault: current };
}

export const HELP_TEXT = [
  '/claude <msg>     manda só para o Claude      (atalhos: /c, /cla)',
  '/codex <msg>      manda só para o Codex       (atalhos: /x, /fog)',
  '/todos <msg>      manda para os dois          (ou /ambos)',
  '/codex            sem mensagem: muda o destino padrão',
  '<msg>             manda para o destino padrão (aparece antes do ›)',
  '/cla /init        manda um comando do agente (o /init vai para o Claude)',
  '                  (com @ também funciona: @fog, @todos...)',
  '/brain /cla <msg> o Claude responde, o Codex avalia, e revezam até concordarem',
  `                  (no máximo ${BRAIN_MAX} respostas; /brain /fog: o Codex começa)`,
  '/parar            encerra o brain depois da resposta em andamento',
  '/compartilhado    (padrão) cada um vê o que você e o outro disseram',
  '/privado          só quem recebe vê; o outro não fica sabendo nem depois',
  '/novo             começa conversas novas com os dois',
  '/limpar           limpa a tela',
  '/sair             encerra (ou Ctrl+C)',
].join('\n');
