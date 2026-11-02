import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import {
  createQueue,
  ResumeFailedError,
  truncate,
  type Agent,
  type AgentId,
  type AgentStats,
} from './agents/types.js';
import {
  markInterrupted,
  newSessionData,
  Recorder,
  type ScreenEntry,
  type SessionData,
  type TurnStatus,
  type Who,
} from './persist.js';
import { BRAIN_MAX, brainOpening, brainReview, brainVerdict, otherOf } from './brain.js';
import { HELP_TEXT, parseInput, type Target } from './router.js';
import { SharedLog } from './shared.js';

interface Entry extends ScreenEntry {
  id: number;
}

/** Um pedido de permissão esperando a sua resposta. */
interface Ask {
  who: AgentId;
  text: string;
  answer: (ok: boolean) => void;
}

const YES = ['s', 'sim'];
const NO = ['n', 'não', 'nao'];

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
  // Pedidos de permissão em fila: enquanto houver um, a caixa de texto responde a ele.
  const [asks, setAsks] = useState<Ask[]>([]);
  const [answer, setAnswer] = useState('');
  const [stats, setStats] = useState<Record<AgentId, AgentStats>>(() => ({
    claude: { ...agents.claude.stats },
    codex: { ...agents.codex.stats },
  }));

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
    for (const agent of Object.values(agents)) {
      agent.onStats = (s) => setStats((prev) => ({ ...prev, [agent.id]: s }));
      // turno que ele abriu sozinho (terminou um subagente em segundo plano): aparece e entra na janela como os outros
      agent.onOwnTurnEvent = (ev) => add(agent.id, ev.kind, ev.text);
      agent.onOwnTurnReply = (text) => {
        log.current.agentReply(agent.id, text, rec.data.shared);
        rec.saveSoon();
      };
      agent.askPermission = ({ text, signal }) =>
        new Promise<boolean>((resolve) => {
          const drop = () => setAsks((q) => q.filter((a) => a !== ask));
          const cancel = () => {
            drop();
            add(agent.id, 'error', `pedido de permissão cancelado: ${truncate(text)}`);
            resolve(false);
          };
          const ask: Ask = {
            who: agent.id,
            text,
            answer: (ok) => {
              signal.removeEventListener('abort', cancel);
              drop();
              resolve(ok);
            },
          };
          signal.addEventListener('abort', cancel, { once: true });
          setAsks((q) => [...q, ask]);
        });
    }
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
   * `msgIndex` = a sua mensagem (ele vê a janela até ali); sem ele, vê a janela até agora (brain).
   * `call` = quem chamou pela ferramenta do duo: a resposta volta direto para ele.
   * Resolve com a resposta, ou null se o turno falhou.
   */
  const runTurn = useCallback(
    (
      id: AgentId,
      turnId: number,
      text: string,
      sharedTurn: boolean,
      msgIndex?: number,
      call?: { from: AgentId; signal: AbortSignal },
    ): Promise<string | null> => {
      const data = rec.data;
      const myLog = log.current;
      setBusy((b) => ({ ...b, [id]: b[id] + 1 }));
      return queues[id](async (): Promise<string | null> => {
        for (let attempt = 0; ; attempt++) {
          const prepared = myLog.prepare(id, text, sharedTurn, msgIndex, call?.from);
          setTurn(data, turnId, 'running');
          rec.saveNow();
          try {
            const answer = await agents[id].send(prepared.prompt, (ev) => add(id, ev.kind, ev.text));
            myLog.delivered(id, prepared);
            // quem chamou só recebeu a resposta se ainda esperava; senão ela vai no contexto dele
            myLog.agentReply(id, answer, sharedTurn, call && !call.signal.aborted ? call.from : undefined);
            setTurn(data, turnId, 'done');
            return answer;
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
            return null;
          }
        }
      }).finally(() => {
        setBusy((b) => ({ ...b, [id]: b[id] - 1 }));
        rec.saveNow();
      });
    },
    [agents, add, rec, queues],
  );

  /** Chamadas em andamento de cada um ao outro, pela ferramenta do duo. */
  const calling = useRef<Record<AgentId, number>>({ claude: 0, codex: 0 });

  // Um agente chama o outro pela ferramenta do duo: vira um turno normal do outro, na fila dele e visível na
  // janela, e a resposta volta como resultado da ferramenta. Segue o modo atual (compartilhado ou privado).
  useEffect(() => {
    for (const agent of Object.values(agents)) {
      const to = otherOf(agent.id);
      agent.askPeer = async ({ text, signal }) => {
        // Se o outro está esperando este, a chamada ficaria na fila atrás do turno que espera: os dois travariam.
        if (calling.current[to] > 0) {
          throw new Error(
            `o ${agents[to].name} está esperando uma resposta sua (ele te chamou); chamá-lo agora travaria os dois. ` +
              `Termine esta resposta primeiro; se precisar perguntar algo a ele, pergunte nela.`,
          );
        }
        calling.current[agent.id]++;
        try {
          const sharedNow = rec.data.shared;
          add(agent.id, 'text', `[para o ${agents[to].name}] ${text}`);
          const msgIndex = log.current.agentMessage(agent.id, to, text, sharedNow);
          const turnId = newTurn(rec.data, to, `[do ${agents[agent.id].name}] ${text}`);
          rec.saveNow();
          const prompt =
            `[duo] O ${agents[agent.id].name} chamou você pela ferramenta do duo. A sua resposta volta direto para ele, ` +
            `e o usuário acompanha na janela. Termine dizendo claramente se concorda sem ressalvas ou o que ainda ` +
            `falta: é assim que ele sabe se chama você de novo. Não o chame de volta agora (ele está esperando você); ` +
            `se precisar perguntar algo, pergunte na resposta.\n\n${text}`;
          const answer = await runTurn(to, turnId, prompt, sharedNow, msgIndex, { from: agent.id, signal });
          if (answer === null) {
            throw new Error(`o ${agents[to].name} não conseguiu responder; o erro aparece na janela do duo`);
          }
          return answer;
        } finally {
          calling.current[agent.id]--;
        }
      };
    }
  }, [agents, add, rec, runTurn]);

  /** O brain em andamento (só um por vez). `stop` = /parar: encerra depois da resposta em andamento. */
  const brain = useRef<{ stop: boolean } | null>(null);

  /**
   * /brain: quem foi marcado responde, o outro avalia, e revezam até um concordar com a última resposta
   * do outro, ou até BRAIN_MAX respostas. Os dois participam, então a conversa do brain é sempre
   * compartilhada entre eles, mesmo no modo privado.
   */
  const runBrain = useCallback(
    async (first: AgentId, question: string) => {
      const state = { stop: false };
      brain.current = state;
      const data = rec.data;
      const name = (id: AgentId) => agents[id].name;
      add(
        'sistema',
        'text',
        `🧠 brain: o ${name(first)} responde, o ${name(otherOf(first))} avalia, e eles revezam até concordarem ` +
          `(no máximo ${BRAIN_MAX} respostas). /parar encerra.${shared ? '' : ' Os dois veem o brain, mesmo no modo privado.'}`,
      );
      add('voce', 'text', `[brain · ${name(first)} começa] ${question}`);
      const msgIndex = log.current.userMessage([first], question, true);
      rec.saveNow();

      let who = first;
      try {
        for (let n = 1; n <= BRAIN_MAX; n++) {
          const turnId = newTurn(data, who, n === 1 ? question : `[brain] avaliar a resposta do ${name(otherOf(who))}`);
          rec.saveNow();
          const answer =
            n === 1
              ? await runTurn(who, turnId, brainOpening(who, question), true, msgIndex)
              : await runTurn(who, turnId, brainReview(who), true);
          if (answer === null) {
            add('sistema', 'error', `🧠 brain parou: a resposta do ${name(who)} falhou.`);
            return;
          }
          if (n > 1 && brainVerdict(answer) === 'concordo') {
            add('sistema', 'text', `🧠 concordaram: o ${name(who)} concordou com o ${name(otherOf(who))} (${n} respostas).`);
            return;
          }
          if (state.stop) {
            add('sistema', 'text', `🧠 brain encerrado por você depois de ${n} ${n === 1 ? 'resposta' : 'respostas'}.`);
            return;
          }
          who = otherOf(who);
        }
        add('sistema', 'text', `🧠 sem acordo em ${BRAIN_MAX} respostas. Mande /brain de novo para continuar.`);
      } finally {
        if (brain.current === state) brain.current = null;
        rec.saveNow();
      }
    },
    [agents, add, rec, runTurn, shared],
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
        case 'brain':
          if (brain.current) {
            add('sistema', 'error', 'já tem um brain rodando: espere terminar ou digite /parar.');
            return;
          }
          void runBrain(cmd.first, cmd.prompt);
          return;
        case 'stop':
          if (!brain.current) {
            add('sistema', 'error', 'não tem nenhum brain rodando.');
          } else if (!brain.current.stop) {
            brain.current.stop = true;
            add('sistema', 'text', '🧠 o brain para depois da resposta em andamento.');
          }
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
            add('sistema', 'text', `destino padrão agora: /${cmd.newDefault}`);
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
    [agents, add, exit, stdout, target, shared, rec, runTurn, runBrain],
  );

  /** Responde ao pedido da vez. Só s ou n: qualquer outra coisa não decide nada e ele pergunta de novo. */
  const onAnswer = useCallback(
    (value: string) => {
      const ask = asks[0];
      const reply = value.trim().toLowerCase();
      setAnswer('');
      if (!ask) return;
      const ok = YES.includes(reply) ? true : NO.includes(reply) ? false : null;
      if (ok === null) {
        add('sistema', 'error', 'responda s para permitir ou n para negar.');
        return;
      }
      add(ask.who, ok ? 'tool' : 'error', `${ok ? 'você permitiu' : 'você negou'}: ${truncate(ask.text)}`);
      ask.answer(ok);
    },
    [asks, add],
  );

  const promptColor = target === 'todos' ? 'white' : COLORS[target];
  const asking = asks[0];

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
        {asking ? (
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
            <TextInput value={input} onChange={setInput} onSubmit={onSubmit} />
          </Box>
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
