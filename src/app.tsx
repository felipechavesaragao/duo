import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { quietStep, truncate, type Agent, type AgentCommand, type AgentId } from './agents/types.js';
import type { ChangeWatcher } from './changes.js';
import { Duo, type Entry } from './core.js';
import { COLORS, footerText, NAMES } from './display.js';
import type { Recorder } from './persist.js';
import { agentCommandQuery, matchCommands } from './router.js';

export { COLORS, footerText } from './display.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface AppProps {
  agents: Record<AgentId, Agent>;
  /** onde a conversa é gravada; sem ele, fica só na memória */
  recorder?: Recorder;
  /** true quando veio de `duo -c` */
  resumed?: boolean;
  /** mede o que mudou no projeto no fim do trabalho de cada um */
  changes?: ChangeWatcher;
}

/** A tela do terminal: mostra o estado do duo (core.ts) e manda para ele o que você digita. */
export function App({ agents, recorder, resumed = false, changes }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const duoRef = useRef<Duo | null>(null);
  duoRef.current ??= new Duo({ agents, recorder, resumed, changes });
  const duo = duoRef.current;
  const { entries, target, shared, busy, asks, stats, commands } = useSyncExternalStore(duo.subscribe, duo.getState);

  const [staticKey, setStaticKey] = useState(0);
  const [input, setInput] = useState('');
  const [frame, setFrame] = useState(0);
  const [answer, setAnswer] = useState('');
  // muda para remontar a caixa de texto: depois do Tab, o cursor vai para o fim
  const [inputKey, setInputKey] = useState(0);

  useEffect(() => {
    const off = duo.subscribe((ev) => {
      if (ev.type === 'clear') {
        stdout.write('\x1b[2J\x1b[3J\x1b[H');
        setStaticKey((k) => k + 1);
      } else if (ev.type === 'quit') {
        exit();
      }
    });
    duo.start();
    return off;
    // roda uma vez, ao abrir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const anyBusy = busy.claude > 0 || busy.codex > 0;
  useEffect(() => {
    if (!anyBusy) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(t);
  }, [anyBusy]);

  const onSubmit = (value: string) => {
    if (duo.submit(value)) setInput('');
  };

  const onAnswer = (value: string) => {
    setAnswer('');
    duo.answerText(value);
  };

  const promptColor = target === 'todos' ? 'white' : COLORS[target];
  const asking = asks[0];
  // o que você digitava valia para o pedido da vez: se ele sai (respondido ou cancelado), não passa para o próximo
  useEffect(() => setAnswer(''), [asking]);

  // "@cla /co": a lista de comandos de quem você chamou, filtrada pelo que já digitou
  const query = asking ? null : agentCommandQuery(input);
  const matches = query ? matchCommands(commands[query.target], query.query) : [];
  useInput(
    (_, key) => {
      if (!key.tab || !query || !matches[0]) return;
      setInput(`${query.head}/${matches[0].name} `);
      setInputKey((k) => k + 1);
    },
    { isActive: Boolean(query) },
  );

  return (
    <Box flexDirection="column">
      {/* o fim de um passo que deu certo só serve à janela (o ✓ no passo): aqui a linha do passo basta */}
      <Static key={staticKey} items={entries.filter((e) => !quietStep(e))}>
        {(e) => <EntryView key={e.id} entry={e} />}
      </Static>

      <Box flexDirection="column" marginTop={1}>
        {(Object.keys(busy) as AgentId[])
          .filter((id) => busy[id] > 0)
          .map((id) => (
            <Text key={id} color={COLORS[id]}>
              {SPINNER[frame]} {agents[id].name} trabalhando
              {busy[id] > 1 ? ` (+${busy[id] - 1} na fila)` : ''}…
            </Text>
          ))}
        {asking?.questions ? (
          <Box flexDirection="column">
            <Text color={COLORS[asking.who]} bold>
              ? {agents[asking.who].name} pergunta{asks.length > 1 ? ` (+${asks.length - 1} na fila)` : ''}:
            </Text>
            {asking.questions.map((q, i) => (
              <Box key={i} flexDirection="column">
                <Text bold>
                  {asking.questions!.length > 1 ? `${i + 1}. ` : ''}
                  {q.header ? `[${q.header}] ` : ''}
                  {q.question}
                  {q.multiSelect ? ' (pode escolher mais de uma, com vírgula)' : ''}
                </Text>
                {q.options.map((o, j) => (
                  <Text key={j}>
                    {'  '}
                    {j + 1}) {o.label}
                    {o.description ? <Text dimColor> — {o.description}</Text> : null}
                  </Text>
                ))}
              </Box>
            ))}
            <Box>
              <Text bold>
                {asking.questions.length > 1 ? 'respostas separadas por ";"' : 'número, nome ou texto seu'} (n = não
                responder) ›{' '}
              </Text>
              <TextInput value={answer} onChange={setAnswer} onSubmit={onAnswer} />
            </Box>
          </Box>
        ) : asking ? (
          <Box flexDirection="column">
            <Text color={COLORS[asking.who]} bold>
              ? {agents[asking.who].name} pede permissão{asks.length > 1 ? ` (+${asks.length - 1} na fila)` : ''}:{' '}
              {asking.text}
            </Text>
            <Box>
              <Text bold>permitir? s/n › </Text>
              <TextInput value={answer} onChange={setAnswer} onSubmit={onAnswer} />
            </Box>
          </Box>
        ) : (
          <Box>
            <Text color={promptColor} bold>
              {shared ? '' : '🔒 '}/{target} ›{' '}
            </Text>
            <TextInput key={inputKey} value={input} onChange={setInput} onSubmit={onSubmit} />
          </Box>
        )}
        {query && (
          <CommandList
            agent={agents[query.target].name}
            color={COLORS[query.target]}
            total={commands[query.target].length}
            matches={matches}
            width={stdout.columns ?? 100}
          />
        )}
        {(['claude', 'codex'] as AgentId[]).map((id) => (
          <Text key={id}>
            <Text color={COLORS[id]}>{agents[id].name.padEnd(7)}</Text>
            <Text dimColor>{footerText(stats[id])}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}

/** Quantos comandos a lista mostra de cada vez: o resto aparece conforme você filtra. */
const LIST_MAX = 8;

function CommandList(props: { agent: string; color: string; total: number; matches: AgentCommand[]; width: number }) {
  const { agent, color, total, matches, width } = props;
  if (total === 0) return <Text dimColor> os comandos do {agent} ainda não carregaram</Text>;
  if (matches.length === 0) return <Text dimColor> nenhum comando do {agent} com esse nome</Text>;
  const shown = matches.slice(0, LIST_MAX);
  const nameWidth = Math.min(30, Math.max(...shown.map((c) => c.name.length)) + 1);
  return (
    <Box flexDirection="column">
      {shown.map((c, i) => (
        <Text key={c.name} wrap="truncate">
          <Text color={color} bold={i === 0}>
            {' '}/{c.name.padEnd(nameWidth)}
          </Text>
          <Text dimColor> {truncate(c.description, Math.max(20, width - nameWidth - 6))}</Text>
        </Text>
      ))}
      <Text dimColor>
        {' '}
        {matches.length > LIST_MAX ? `+${matches.length - LIST_MAX} · ` : ''}Tab completa /{shown[0].name}
      </Text>
    </Box>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  const color = COLORS[entry.who];
  return (
    <Box flexDirection="column" marginTop={entry.label ? 1 : 0}>
      {entry.label && (
        <Text color={color} bold>
          ● {NAMES[entry.who]}
        </Text>
      )}
      <Box paddingLeft={2}>
        {entry.kind === 'tool' ? (
          <Text dimColor>↳ {entry.text}</Text>
        ) : entry.kind === 'error' ? (
          <Text color="red">✗ {entry.text}</Text>
        ) : (
          <Text color={entry.who === 'sistema' ? 'gray' : undefined}>
            {entry.text}
            {/* o print colado na janela: aqui só dá para dizer que ele existe */}
            {entry.images?.length ? (
              <Text dimColor>
                {entry.text ? ' ' : ''}[{entry.images.length === 1 ? 'print' : `${entry.images.length} prints`}]
              </Text>
            ) : null}
          </Text>
        )}
      </Box>
    </Box>
  );
}
