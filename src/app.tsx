import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { createQueue, ResumeFailedError, truncate, type Agent, type AgentId } from './agents/types.js';
import {
  markInterrupted,
  newSessionData,
  Recorder,
  type ScreenEntry,
  type SessionData,
  type TurnStatus,
  type Who,
} from './persist.js';
import { HELP_TEXT, parseInput, type Target } from './router.js';
import { SharedLog } from './shared.js';

interface Entry extends ScreenEntry {
  id: number;
}

export const COLORS: Record<Who, string> = {
  claude: '#D97757',
  codex: '#10A37F',
  voce: '#4F9DFF',
  sistema: 'gray',
};

const NAMES: Record<Who, string> = { claude: 'Claude', codex: 'Codex', voce: 'você', sistema: 'duo' };
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export interface AppProps {
  agents: Record<AgentId, Agent>;
  /** onde a conversa é gravada; sem ele, fica só na memória */
  recorder?: Recorder;
  /** true quando veio de `duo -c` */
  resumed?: boolean;
}

function newTurn(data: SessionData, agent: AgentId, text: string): number {
  const id = data.nextTurn++;
  data.turns.push({ id, agent, text, status: 'pending' });
  return id;
}

function setTurn(data: SessionData, id: number, status: TurnStatus): void {
  const turn = data.turns.find((t) => t.id === id);
  if (turn) turn.status = status;
}

export function App({ agents, recorder, resumed = false }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rec = useRef(recorder ?? new Recorder(newSessionData(process.cwd()))).current;
  const log = useRef(new SharedLog(rec.data.log));
  const queues = useRef({ claude: createQueue(), codex: createQueue() }).current;
  const nextId = useRef(0);
  const lastWho = useRef<Who | null>(null);

  // Na retomada, a tela volta como estava.
  const [entries, setEntries] = useState<Entry[]>(() => {
    const restored = rec.data.screen.map((e) => ({ ...e, id: nextId.current++ }));
    lastWho.current = restored.at(-1)?.who ?? null;
    return restored;
  });
  const [staticKey, setStaticKey] = useState(0);
  const [input, setInput] = useState('');
  const [target, setTargetState] = useState<Target>(rec.data.target);
  const [shared, setSharedState] = useState(rec.data.shared);
  const [busy, setBusy] = useState<Record<AgentId, number>>({ claude: 0, codex: 0 });
  const [frame, setFrame] = useState(0);

  const add = useCallback(
    (who: Who, kind: Entry['kind'], text: string) => {
      const label = lastWho.current !== who;
      lastWho.current = who;
      const entry: ScreenEntry = { who, kind, text, label };
      rec.data.screen.push(entry);
      rec.saveSoon();
      setEntries((prev) => [...prev, { ...entry, id: nextId.current++ }]);
    },
    [rec],
  );

  const setTarget = (t: Target) => {
    rec.data.target = t;
    setTargetState(t);
  };

  const anyBusy = busy.claude > 0 || busy.codex > 0;
  useEffect(() => {
    if (!anyBusy) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(t);
  }, [anyBusy]);

  useEffect(() => {
    rec.onError = (msg) => add('sistema', 'error', `não consegui salvar a conversa: ${msg}`);
    // Os ids das conversas são gravados assim que aparecem.
    agents.claude.onSessionId = (id) => {
      rec.data.claudeSessionId = id;
      rec.saveNow();
    };
    agents.codex.onSessionId = (id) => {
      rec.data.codexThreadId = id;
      rec.saveNow();
    };
    if (resumed) {
      add('sistema', 'text', 'Conversa retomada: cada um continua de onde parou.');
      for (const t of markInterrupted(rec.data)) {
        add(
          'sistema',
          'error',
          `interrompida quando o duo fechou: "${truncate(t.text, 80)}" para o ${agents[t.agent].name}. Não foi reenviada.`,
        );
      }
      rec.saveNow();
    } else {
      add('sistema', 'text', 'Claude + Codex na mesma janela. Digite /ajuda para ver os comandos.');
    }
    // roda uma vez, ao abrir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Um turno de um agente. O prompt só é montado quando chega a vez dele na fila, e o contexto
   * só conta como entregue depois que ele responde: se falhar, vai de novo na próxima.
   */
  const runTurn = useCallback(
    (id: AgentId, turnId: number, text: string, sharedTurn: boolean, msgIndex: number) => {
      const data = rec.data;
      const myLog = log.current;
      setBusy((b) => ({ ...b, [id]: b[id] + 1 }));
      queues[id](async () => {
        for (let attempt = 0; ; attempt++) {
          const prepared = myLog.prepare(id, text, sharedTurn, msgIndex);
          setTurn(data, turnId, 'running');
          rec.saveNow();
          try {
            const answer = await agents[id].send(prepared.prompt, (ev) => add(id, ev.kind, ev.text));
            myLog.delivered(id, prepared);
            myLog.agentReply(id, answer, sharedTurn);
            setTurn(data, turnId, 'done');
            return;
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            if (err instanceof ResumeFailedError && attempt === 0) {
              // Nada foi executado: abre conversa nova e manda de novo, com a janela inteira de contexto.
              myLog.forget(id);
              add(
                'sistema',
                'error',
                `não deu para retomar a conversa anterior do ${agents[id].name} (${err.message}). Abri uma nova, com o histórico da janela como contexto.`,
              );
              continue;
            }
            add(id, 'error', err.message);
            setTurn(data, turnId, 'failed');
            return;
          }
        }
      }).finally(() => {
        setBusy((b) => ({ ...b, [id]: b[id] - 1 }));
        rec.saveNow();
      });
    },
    [agents, add, rec, queues],
  );

  const onSubmit = useCallback(
    (value: string) => {
      const cmd = parseInput(value, target);
      if (!cmd) return;
      setInput('');

      switch (cmd.type) {
        case 'quit':
          Object.values(agents).forEach((a) => a.dispose());
          exit();
          return;
        case 'clear':
          stdout.write('\x1b[2J\x1b[3J\x1b[H');
          lastWho.current = null;
          rec.data.screen = [];
          rec.saveNow();
          setEntries([]);
          setStaticKey((k) => k + 1);
          return;
        case 'help':
          add('sistema', 'text', HELP_TEXT);
          return;
        case 'new': {
          Object.values(agents).forEach((a) => a.reset());
          const next = newSessionData(rec.data.cwd);
          next.shared = rec.data.shared;
          next.target = rec.data.target;
          rec.switchTo(next);
          log.current = new SharedLog(next.log);
          add('sistema', 'text', 'Conversa nova: a próxima mensagem começa do zero nos dois. A anterior continua salva.');
          return;
        }
        case 'invalid':
          add('sistema', 'error', cmd.message);
          return;
        case 'share':
          rec.data.shared = cmd.on;
          setSharedState(cmd.on);
          add(
            'sistema',
            'text',
            cmd.on
              ? 'Modo compartilhado: cada um vê o que você e o outro disseram.'
              : 'Modo privado: só quem recebe a mensagem vê, e o outro não fica sabendo nem depois.',
          );
          rec.saveNow();
          return;
        case 'ask': {
          setTarget(cmd.newDefault);
          if (cmd.targets.length === 0) {
            add('sistema', 'text', `destino padrão agora: @${cmd.newDefault}`);
            rec.saveNow();
            return;
          }
          add('voce', 'text', cmd.targets.length > 1 ? `[para os dois] ${cmd.prompt}` : cmd.prompt);
          const data = rec.data;
          const msgIndex = log.current.userMessage(cmd.targets, cmd.prompt, shared);
          const turnIds = cmd.targets.map((id) => newTurn(data, id, cmd.prompt));
          rec.saveNow(); // a sua mensagem fica gravada ANTES de sair para os agentes
          cmd.targets.forEach((id, i) => runTurn(id, turnIds[i], cmd.prompt, shared, msgIndex));
          return;
        }
      }
    },
    [agents, add, exit, stdout, target, shared, rec, runTurn],
  );

  const promptColor = target === 'todos' ? 'white' : COLORS[target];

  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={entries}>
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
        <Box>
          <Text color={promptColor} bold>
            {shared ? '' : '🔒 '}@{target} ›{' '}
          </Text>
          <TextInput value={input} onChange={setInput} onSubmit={onSubmit} />
        </Box>
      </Box>
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
          <Text color={entry.who === 'sistema' ? 'gray' : undefined}>{entry.text}</Text>
        )}
      </Box>
    </Box>
  );
}
