import type { AgentCommand, AgentId } from './agents/types.js';
import { BRAIN_MAX } from './brain.js';

export type Target = AgentId | 'todos';

export type Command =
  | { type: 'ask'; targets: AgentId[]; prompt: string; newDefault: Target }
  /** `first` = quem começa (/brain /cla|/fog: o jeito velho); sem ele, o jeito novo (os dois respondem cada um por si) */
  | { type: 'brain'; first?: AgentId; prompt: string }
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

const BRAIN_USAGE =
  'use /brain <pergunta> (os dois respondem cada um por si, depois se confrontam) ou /brain /cla <pergunta> ' +
  '(o Cla responde, o Fog avalia; /brain /fog: o Fog começa)';

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
    if (!who) {
      // sem quem começa: o jeito novo
      const prompt = cleanPrompt(rest);
      return prompt ? { type: 'brain', prompt } : { type: 'invalid', message: `falta a pergunta: ${BRAIN_USAGE}` };
    }
    const first = targetOf(who[2].toLowerCase());
    if (!first || first === 'todos') return { type: 'invalid', message: `quem começa o brain? ${BRAIN_USAGE}` };
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

/**
 * Você está digitando um comando de um agente ("@cla /co", "/fog /rev"): para quem, o que vem antes da barra
 * e o que já foi digitado do nome. null = não é isso (inclusive /todos: cada um tem a sua lista).
 */
export function agentCommandQuery(input: string): { target: AgentId; head: string; query: string } | null {
  const m = input.match(/^([/@])([\p{L}\p{N}_-]+)(\s+)\/(\S*)$/u);
  const target = m ? targetOf(m[2].toLowerCase()) : undefined;
  if (!m || !target || target === 'todos') return null;
  return { target, head: `${m[1]}${m[2]}${m[3]}`, query: m[4].toLowerCase() };
}

/** Os comandos que batem com o que você digitou: os que começam com ele primeiro, depois os que o contêm. */
export function matchCommands(commands: AgentCommand[], query: string): AgentCommand[] {
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(query));
  const contains = commands.filter((c) => !c.name.toLowerCase().startsWith(query) && c.name.toLowerCase().includes(query));
  return [...starts, ...contains];
}

/**
 * Os comandos do duo para a lista que aparece quando você digita "/" na janela: um por linha, com os outros nomes
 * que também valem. ⛔ Todo nome de ALIASES e COMMAND_NAMES tem de estar aqui, e só eles (o teste do roteador cobra).
 */
export const DUO_COMMANDS: { name: string; also: string[]; description: string }[] = [
  { name: 'cla', also: ['claude', 'c'], description: 'manda só para o Cla; sozinho, vira o destino padrão' },
  { name: 'fog', also: ['codex', 'x'], description: 'manda só para o Fog; sozinho, vira o destino padrão' },
  { name: 'todos', also: ['ambos', 'all'], description: 'manda para os dois; sozinho, vira o destino padrão' },
  {
    name: 'brain',
    also: [],
    description: '/brain <msg>: os dois respondem por si, depois se confrontam; /brain /cla <msg>: o Cla responde, o Fog avalia',
  },
  { name: 'parar', also: [], description: 'encerra o brain depois da resposta em andamento' },
  { name: 'compartilhado', also: ['compartilhar'], description: 'cada um vê o que você e o outro disseram' },
  { name: 'privado', also: [], description: 'só quem recebe vê; o outro não fica sabendo nem depois' },
  { name: 'novo', also: ['new'], description: 'começa conversas novas com os dois' },
  { name: 'limpar', also: ['clear'], description: 'limpa a tela' },
  { name: 'ajuda', also: ['help'], description: 'mostra o que cada comando faz' },
  { name: 'sair', also: ['quit', 'exit'], description: 'encerra o duo' },
];

/** Você está digitando um comando do duo ("/", "/li"): o que já digitou do nome. null = não é isso. */
export function duoCommandQuery(input: string): string | null {
  const m = input.match(/^\/([\p{L}\p{N}_-]*)$/u);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Os comandos do duo que batem com o que você digitou, por qualquer um dos nomes: os que começam com ele primeiro,
 * depois os que o contêm. Cada um aparece pelo nome que bateu, que é o que o Tab completa ("/cod" → /codex).
 */
export function matchDuoCommands(query: string): AgentCommand[] {
  const starts: AgentCommand[] = [];
  const contains: AgentCommand[] = [];
  for (const { name, also, description } of DUO_COMMANDS) {
    const names = [name, ...also];
    const start = names.find((n) => n.startsWith(query));
    const inside = names.find((n) => n.includes(query));
    if (start !== undefined) starts.push({ name: start, description });
    else if (inside !== undefined) contains.push({ name: inside, description });
  }
  return [...starts, ...contains];
}

export const HELP_TEXT = [
  '/cla <msg>        manda só para o Cla         (atalhos: /c, /claude)',
  '/fog <msg>        manda só para o Fog         (atalhos: /x, /codex)',
  '/todos <msg>      manda para os dois          (ou /ambos)',
  '/fog              sem mensagem: muda o destino padrão',
  '<msg>             manda para o destino padrão (aparece antes do ›)',
  '/cla /init        manda um comando do agente (o /init vai para o Cla)',
  '@cla /  @fog /    mostra a lista de comandos de cada um (do Fog, as skills);',
  '                  digite para filtrar, Tab completa o primeiro',
  '                  (com @ também funciona: @fog, @todos...)',
  '/brain <msg>      o Cla e o Fog respondem cada um por si, sem ver o outro;',
  '                  depois o destino padrão abre o confronto (com /todos, o Cla),',
  '                  e revezam até concordarem ou concluírem que falta uma informação',
  '/brain /cla <msg> o Cla responde, o Fog avalia, e revezam até concordarem',
  '                  (/brain /fog: o Fog começa)',
  `                  (nos dois, no máximo ${BRAIN_MAX} respostas)`,
  '/parar            encerra o brain depois da resposta em andamento',
  '/compartilhado    (padrão) cada um vê o que você e o outro disseram',
  '/privado          só quem recebe vê; o outro não fica sabendo nem depois',
  '/novo             começa conversas novas com os dois',
  '/limpar           limpa a tela',
  '/sair             encerra (ou Ctrl+C)',
].join('\n');
