import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react';
import {
  truncate,
  type AgentCommand,
  type AgentId,
  type AgentModel,
  type AgentStats,
  type AgentTask,
  type AgentTool,
  type ModelChoice,
} from '../src/agents/types.js';
import type { Ask, Entry } from '../src/core.js';
import { COLORS, currentModel, footerText, modelLabel, NAMES } from '../src/display.js';
import type { Who } from '../src/persist.js';
import type { ModelBody, PastedImage, ServerEvents, Snapshot, StopBody } from '../src/gui/protocol.js';
import { agentCommandQuery, matchCommands, targetsOf, type Target } from '../src/router.js';
import { blocksOf, stepStatus, type Block, type StepRow } from './blocks.js';

/**
 * A janela: barra lateral com as ações do duo, a conversa no meio e o painel com o que está rodando, a pasta, o modo e
 * o contexto de cada um. Mostra o estado do duo (que chega por /events) e manda para ele o que você digita e clica: todo botão
 * é um comando do duo, o mesmo que você digitaria.
 */

type Conn = 'conectando' | 'aberta' | 'caiu' | 'encerrado';

const AGENTS: AgentId[] = ['claude', 'codex'];
const TARGETS: Target[] = ['claude', 'codex', 'todos'];
/** Quantos comandos a lista mostra de cada vez: o resto aparece conforme você filtra. */
const LIST_MAX = 8;
/** Sem sinal do agente (ou sem progresso do subagente) há mais que isto: o quadro avisa que pode estar travado. */
const STALE_MS = 120_000;
/** Os mesmos limites do servidor para os prints. */
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 3_750_000;
/** O maior lado que vai sem reduzir: acima disso o Claude reduz de qualquer jeito, e só fica mais lento. */
const MAX_IMAGE_SIDE = 2576;
const IMAGE_TYPES: string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** a cor de quem fala, para o CSS (var(--c)) */
const tint = (color: string) => ({ '--c': color }) as CSSProperties;

async function post(path: string, body: unknown): Promise<boolean> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.text()) || `erro ${res.status}`);
  return ((await res.json()) as { ok: boolean }).ok;
}

/** Liga no duo e mantém uma cópia do estado dele. Reconectou: o estado vem inteiro de novo. */
function useDuo(): [Snapshot | null, Conn] {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [conn, setConn] = useState<Conn>('conectando');
  useEffect(() => {
    const es = new EventSource('/events');
    const on = <K extends keyof ServerEvents>(name: K, fn: (data: ServerEvents[K]) => void) =>
      es.addEventListener(name, (e) => fn(JSON.parse((e as MessageEvent<string>).data)));
    on('snapshot', (s) => {
      setSnap(s);
      setConn('aberta');
    });
    on('entry', (entry) => setSnap((s) => s && { ...s, entries: [...s.entries, entry] }));
    on('clear', () => setSnap((s) => s && { ...s, entries: [] }));
    on('status', (status) => setSnap((s) => s && { ...s, ...status }));
    on('commands', (commands) => setSnap((s) => s && { ...s, commands }));
    on('models', (models) => setSnap((s) => s && { ...s, models }));
    on('quit', () => {
      es.close();
      setConn('encerrado');
    });
    es.onerror = () => setConn((c) => (c === 'encerrado' ? c : 'caiu'));
    return () => es.close();
  }, []);
  return [snap, conn];
}

/** O relógio de agora, andando de segundo em segundo enquanto tem algo rodando (os tempos do quadro e da conversa). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('não consegui converter o print'))), type, quality),
  );

const dataUrlOf = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('não consegui ler o print'));
    reader.readAsDataURL(blob);
  });

type Pasted = PastedImage & { key: number; url: string };
let pastedKey = 0;

/**
 * Um print colado, pronto para ir: como veio, se já cabe; senão redesenhado menor (PNG, que mantém o texto nítido; JPEG
 * só se o PNG ainda passar do limite).
 */
async function readImage(file: File): Promise<Pasted> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.max(bitmap.width, bitmap.height);
    let blob: Blob = file;
    if (!IMAGE_TYPES.includes(file.type) || file.size > MAX_IMAGE_BYTES || side > MAX_IMAGE_SIDE) {
      const scale = Math.min(1, MAX_IMAGE_SIDE / side);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      blob = await toBlob(canvas, 'image/png');
      if (blob.size > MAX_IMAGE_BYTES) blob = await toBlob(canvas, 'image/jpeg', 0.85);
      if (blob.size > MAX_IMAGE_BYTES) throw new Error('o print é grande demais, mesmo reduzido');
    }
    const url = await dataUrlOf(blob);
    return { key: pastedKey++, mediaType: blob.type as PastedImage['mediaType'], data: url.slice(url.indexOf(',') + 1), url };
  } finally {
    bitmap.close();
  }
}

/** 8 s, 3 min 05 s, 1 h 02 min */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** trabalhando: tem mensagem do duo rodando ou na fila, ou um turno que ele abriu sozinho */
const working = (snap: Snapshot, id: AgentId) => snap.busy[id] > 0 || snap.runningSince[id] !== null;

const folderOf = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
const parentOf = (cwd: string) => cwd.replace(/[\\/][^\\/]+[\\/]?$/, '');

export function App() {
  const [snap, conn] = useDuo();
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [left, setLeft] = useState(() => window.innerWidth >= 820);
  const [right, setRight] = useState(() => window.innerWidth >= 1150);
  const now = useNow(
    snap !== null && AGENTS.some((id) => snap.busy[id] > 0 || snap.runningSince[id] !== null || snap.tasks[id].length > 0),
  );

  useEffect(() => {
    if (snap) document.title = `duo · ${folderOf(snap.cwd)}`;
  }, [snap?.cwd]);
  useEffect(() => {
    if (conn === 'encerrado') window.close(); // só fecha se o navegador deixar; senão fica o aviso
  }, [conn]);

  if (!snap) {
    return (
      <div className="loading">
        {conn === 'caiu' ? 'Não consegui ligar no duo. Ele ainda está rodando no terminal?' : 'Ligando no duo…'}
      </div>
    );
  }

  const live = conn === 'aberta';
  const run = async (path: string, body: unknown) => {
    try {
      setError(null);
      return await post(path, body);
    } catch (e) {
      setError(`não consegui mandar para o duo: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }
  };
  const send = (value: string, images: PastedImage[] = []) =>
    run('/api/submit', images.length ? { text: value, images } : { text: value });
  const command = (cmd: string) => void send(cmd).catch(() => undefined);
  const answer = (ask: Ask, ok: boolean) => void run('/api/answer', { id: ask.id, ok }).catch(() => undefined);
  const setModel = (agent: AgentId, choice: ModelChoice) =>
    void run('/api/modelo', { agent, ...choice } satisfies ModelBody).catch(() => undefined);
  const stop = (agent: AgentId) => void run('/api/parar', { agent } satisfies StopBody).catch(() => undefined);
  /** começa a mensagem por você (o brain, a lista de comandos) e põe o cursor no fim */
  const prefill = (value: string) => {
    setText(value);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(value.length, value.length);
    });
  };
  const anyBusy = AGENTS.some((id) => working(snap, id));

  return (
    <div className={`app${left ? ' with-left' : ''}${right ? ' with-right' : ''}`}>
      {left && (
        <Sidebar
          snap={snap}
          live={live}
          onHide={() => setLeft(false)}
          onNew={() => {
            if (
              !anyBusy ||
              window.confirm('Tem agente trabalhando ou mensagem na fila: a conversa nova corta. Começar mesmo assim?')
            ) {
              command('/novo');
            }
          }}
          onBrain={() => prefill(`/brain /${snap.target === 'codex' ? 'fog' : 'cla'} `)}
          onCommand={command}
          onQuit={() => window.confirm('Encerrar o duo? Os dois agentes fecham junto.') && command('/sair')}
        />
      )}

      <section className="center">
        <header className="top">
          {!left && <IconButton icon={icons.panelLeft} label="Mostrar a barra lateral" onClick={() => setLeft(true)} />}
          <span className="title">{folderOf(snap.cwd)}</span>
          <span className="spacer" />
          {!right && <IconButton icon={icons.panelRight} label="Mostrar o painel" onClick={() => setRight(true)} />}
        </header>

        <Timeline entries={snap.entries} anyBusy={anyBusy}>
          {AGENTS.filter((id) => working(snap, id)).map((id) => {
            const since = snap.runningSince[id];
            return (
              <div key={id} className="busy" style={tint(COLORS[id])}>
                <span className="spinner" />
                {snap.names[id]} trabalhando
                {snap.busy[id] > 1 ? ` (+${snap.busy[id] - 1} na fila)` : ''}
                <span className="busy-time">{since !== null ? elapsed(now - since) : ''}</span>
              </div>
            );
          })}
        </Timeline>

        <footer className="dock">
          {snap.asks[0] && (
            <AskCard
              ask={snap.asks[0]}
              more={snap.asks.length - 1}
              name={snap.names[snap.asks[0].who]}
              disabled={!live}
              onAnswer={(ok) => answer(snap.asks[0], ok)}
            />
          )}
          {error && <div className="send-error">{error}</div>}
          <Composer
            snap={snap}
            disabled={!live}
            text={text}
            setText={setText}
            inputRef={inputRef}
            send={send}
            command={command}
            setModel={setModel}
            prefill={prefill}
            onError={setError}
          />
        </footer>
      </section>

      {right && (
        <Panel snap={snap} live={live} now={now} onHide={() => setRight(false)} onCommand={command} onStop={stop} />
      )}

      {conn === 'caiu' && <div className="banner">A ligação com o duo caiu. Tentando de novo…</div>}
      {conn === 'encerrado' && (
        <div className="closed">
          <div>O duo foi encerrado. Pode fechar esta janela.</div>
        </div>
      )}
    </div>
  );
}

/* barra lateral: as ações do duo e como cada agente está */

function Sidebar(props: {
  snap: Snapshot;
  live: boolean;
  onHide: () => void;
  onNew: () => void;
  onBrain: () => void;
  onCommand: (cmd: string) => void;
  onQuit: () => void;
}) {
  const { snap, live, onHide, onNew, onBrain, onCommand, onQuit } = props;
  const status = (id: AgentId) =>
    snap.asks.some((a) => a.who === id)
      ? 'pede permissão'
      : working(snap, id)
        ? `trabalhando${snap.busy[id] > 1 ? ` (+${snap.busy[id] - 1})` : ''}`
        : 'livre';
  return (
    <aside className="side">
      <div className="side-top">
        <span className="logo" aria-hidden="true">
          <span style={tint(COLORS.claude)} />
          <span style={tint(COLORS.codex)} />
        </span>
        <span className="brand">duo</span>
        <span className="spacer" />
        <IconButton icon={icons.panelLeft} label="Esconder a barra lateral" onClick={onHide} />
      </div>

      <nav className="side-nav">
        <NavButton icon={icons.plus} label="Nova conversa" disabled={!live} onClick={onNew} />
        <NavButton icon={icons.sparkle} label="Brain" disabled={!live || snap.brain} onClick={onBrain} />
        {snap.brain && <NavButton icon={icons.stop} label="Parar o brain" disabled={!live} onClick={() => onCommand('/parar')} />}
        <NavButton icon={icons.eraser} label="Limpar a tela" disabled={!live} onClick={() => onCommand('/limpar')} />
        <NavButton icon={icons.help} label="Comandos" disabled={!live} onClick={() => onCommand('/ajuda')} />
      </nav>

      <div className="side-section">Agentes</div>
      {AGENTS.map((id) => (
        <button
          key={id}
          className={`agent-row${snap.target === id ? ' on' : ''}`}
          style={tint(COLORS[id])}
          disabled={!live}
          title={`Mandar para o ${snap.names[id]} por padrão`}
          onClick={() => snap.target !== id && onCommand(`/${id}`)}
        >
          <span className={`dot${working(snap, id) ? ' pulse' : ''}`} />
          <span className="agent-name">{snap.names[id]}</span>
          <span className="agent-status">{status(id)}</span>
        </button>
      ))}

      <span className="spacer" />
      <nav className="side-nav">
        <NavButton icon={icons.power} label="Encerrar o duo" disabled={!live} onClick={onQuit} />
      </nav>
    </aside>
  );
}

/* painel: o que está rodando, a pasta, o modo e o contexto de cada um */

function Panel(props: {
  snap: Snapshot;
  live: boolean;
  now: number;
  onHide: () => void;
  onCommand: (cmd: string) => void;
  onStop: (agent: AgentId) => void;
}) {
  const { snap, live, now, onHide, onCommand, onStop } = props;
  return (
    <aside className="panel">
      <div className="panel-top">
        <span className="spacer" />
        <IconButton icon={icons.panelRight} label="Esconder o painel" onClick={onHide} />
      </div>

      <div className="panel-section">Rodando agora</div>
      <Running snap={snap} live={live} now={now} onStop={onStop} />

      <div className="panel-divider" />
      <div className="panel-section">Ambiente</div>
      <div className="panel-row" title={snap.cwd}>
        {icons.folder}
        <span className="row-text">
          {folderOf(snap.cwd)}
          <span className="muted"> · {parentOf(snap.cwd)}</span>
        </span>
      </div>
      <div className="panel-row">
        {snap.shared ? icons.users : icons.lock}
        <span className="row-text">{snap.shared ? 'Compartilhado' : 'Privado'}</span>
        <Switch
          on={snap.shared}
          disabled={!live}
          label={snap.shared ? 'Passar para o modo privado' : 'Passar para o modo compartilhado'}
          onClick={() => onCommand(snap.shared ? '/privado' : '/compartilhado')}
        />
      </div>
      <p className="panel-note">
        {snap.shared
          ? 'Cada um vê o que você e o outro disseram.'
          : 'Só quem recebe a mensagem vê, e o outro não fica sabendo nem depois.'}
      </p>

      <div className="panel-divider" />
      <div className="panel-section">Contexto</div>
      {AGENTS.map((id) => (
        <ContextRow key={id} name={snap.names[id]} color={COLORS[id]} stats={snap.stats[id]} />
      ))}
    </aside>
  );
}

/**
 * O quadro do que está rodando: o turno de cada um (desde quando, e o que ele espera agora: você, o outro, uma
 * ferramenta, ou nada que se saiba) e o que ele pôs em segundo plano. Cada um tem o botão de parar só ele.
 */
function Running(props: { snap: Snapshot; live: boolean; now: number; onStop: (agent: AgentId) => void }) {
  const { snap, live, now, onStop } = props;
  const active = AGENTS.filter((id) => snap.busy[id] > 0 || snap.runningSince[id] !== null || snap.tasks[id].length > 0);
  return (
    <div className="running">
      {active.length === 0 ? (
        <div className="running-idle">Nada rodando. Os dois estão livres.</div>
      ) : (
        active.map((id) => (
          <RunningAgent
            key={id}
            name={snap.names[id]}
            color={COLORS[id]}
            since={snap.runningSince[id]}
            busy={snap.busy[id]}
            signal={snap.lastSignal[id]}
            asking={snap.asks.some((a) => a.who === id)}
            tasks={snap.tasks[id]}
            other={snap.names[id === 'claude' ? 'codex' : 'claude']}
            tools={snap.tools[id]}
            peerWait={snap.peerWait[id]}
            stopping={snap.stopping[id]}
            live={live}
            onStop={() => onStop(id)}
            now={now}
          />
        ))
      )}
    </div>
  );
}

function RunningAgent(props: {
  name: string;
  color: string;
  since: number | null;
  busy: number;
  signal: number | null;
  asking: boolean;
  tasks: AgentTask[];
  /** o nome do outro agente */
  other: string;
  tools: AgentTool[];
  peerWait: number | null;
  stopping: boolean;
  live: boolean;
  onStop: () => void;
  now: number;
}) {
  const { name, color, since, busy, signal, asking, tasks, other, tools, peerWait, stopping, live, onStop, now } = props;
  const silent = signal !== null ? now - signal : null;
  // a ferramenta mais antiga é a que segura o turno
  const tool = tools.reduce<AgentTool | undefined>((a, t) => (a && a.startedAt <= t.startedAt ? a : t), undefined);
  // Só conta com turno rodando: parado, com algo em segundo plano, o processo fica quieto mesmo (cada tarefa mostra o
  // próprio progresso). Esperando você, o outro ou uma ferramenta não é estar travado.
  const stale = since !== null && !asking && peerWait === null && !tool && silent !== null && silent > STALE_MS;
  const queued = since !== null ? busy - 1 : busy;
  return (
    <div className="running-agent" style={tint(color)}>
      <div className="running-head">
        <span className={`dot${since !== null ? ' pulse' : ''}`} />
        <span className="running-name">{name}</span>
        {!stopping && (since !== null || queued > 0) && (
          <button
            className="stop-agent"
            disabled={!live}
            aria-label={`Parar o ${name}`}
            title={`Parar só o ${name}: o que ele está fazendo e a fila dele. O ${other} segue, e a conversa continua.`}
            onClick={onStop}
          >
            {icons.stop}
          </button>
        )}
        <span className="running-status muted">
          {stopping
            ? 'parando…'
            : asking
              ? 'pede permissão'
              : since !== null
                ? `respondendo · ${elapsed(now - since)}`
                : 'sem turno'}
        </span>
      </div>
      {queued > 0 && !stopping && (
        <div className="running-line muted">{queued === 1 ? '1 mensagem na fila' : `${queued} mensagens na fila`}</div>
      )}
      {since !== null && !asking && (
        <div className={`running-line${stale ? ' warn' : ' muted'}`} title={tools.map((t) => t.text).join('\n') || undefined}>
          {peerWait !== null
            ? `esperando o ${other} responder · há ${elapsed(now - peerWait)}`
            : tool
              ? `rodando: ${truncate(tool.text, 80)} · há ${elapsed(now - tool.startedAt)}${tools.length > 1 ? ` (+${tools.length - 1})` : ''}`
              : silent === null
                ? 'sem sinal ainda'
                : stale
                  ? `sem sinal há ${elapsed(silent)}, sem ferramenta rodando: pode estar travado`
                  : `último sinal há ${elapsed(silent)}`}
        </div>
      )}
      {tasks.map((t) => (
        <RunningTask key={t.id} task={t} now={now} />
      ))}
    </div>
  );
}

function RunningTask({ task, now }: { task: AgentTask; now: number }) {
  const quiet = now - task.lastAt;
  // só dá para dizer que parou quem já mandou progresso alguma vez
  const stale = task.activity !== undefined && quiet > STALE_MS;
  return (
    <div className="task">
      <div className="task-head">
        <span className="task-title" title={task.title}>
          {task.title}
        </span>
        <span className="muted">{elapsed(now - task.startedAt)}</span>
      </div>
      <div className="task-kind">
        {task.kind}
        {task.detail ? ` · ${task.detail}` : ''}
      </div>
      {task.activity && (
        <div className={`task-activity${stale ? ' warn' : ''}`} title={task.activity}>
          {truncate(task.activity, 80)} · há {elapsed(quiet)}
        </div>
      )}
    </div>
  );
}

function ContextRow({ name, color, stats }: { name: string; color: string; stats: AgentStats }) {
  const pct =
    stats.contextTokens !== undefined && stats.contextWindow
      ? Math.min(100, Math.round((100 * stats.contextTokens) / stats.contextWindow))
      : undefined;
  return (
    <div className="context" style={tint(color)}>
      <div className="context-head">
        <span className="context-name">{name}</span>
        <span className="spacer" />
        <span className="muted">{pct === undefined ? '—' : `${pct}%`}</span>
        <span className="meter" role="img" aria-label={pct === undefined ? 'sem dado' : `${pct}% do contexto`}>
          <span style={{ width: `${pct ?? 0}%` }} />
        </span>
      </div>
      {/* a porcentagem já está ao lado do nome */}
      <div className="context-detail">{footerText(stats).replace(/ \(\d+%\)/, '')}</div>
    </div>
  );
}

/* a conversa */

function Timeline({ entries, anyBusy, children }: { entries: Entry[]; anyBusy: boolean; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  // segue a conversa enquanto você está no fim dela; se subiu para ler, fica onde está
  const stick = useRef(true);
  const blocks = useMemo(() => blocksOf(entries), [entries]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [blocks, anyBusy]);
  return (
    <main className="timeline" ref={ref} onScroll={onScroll}>
      <div className="column">
        {blocks.map((b) => ('tools' in b ? <ToolGroup key={b.key} block={b} /> : <EntryView key={b.key} entry={b.entry} />))}
        {children}
      </div>
    </main>
  );
}

function Label({ who }: { who: Who }) {
  return (
    <div className="who">
      <span className="dot" />
      {NAMES[who]}
    </div>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  if (entry.who === 'voce') {
    return (
      <div className="entry from-you">
        <div className="bubble">
          {entry.images?.length ? (
            <div className="shots">
              {entry.images.map((name) => (
                <a key={name} href={`/imagem/${name}`} target="_blank" rel="noreferrer" title="Abrir o print">
                  <img src={`/imagem/${name}`} alt="print colado" />
                </a>
              ))}
            </div>
          ) : null}
          {entry.text && <RichText text={entry.text} />}
        </div>
      </div>
    );
  }
  if (entry.who === 'sistema') {
    return (
      <div className={`entry system${entry.kind === 'error' ? ' error' : ''}`}>
        {entry.text.includes('\n') ? <pre className="system-pre">{entry.text}</pre> : <p>{entry.text}</p>}
      </div>
    );
  }
  return (
    <div className={`entry agent${entry.label ? ' labeled' : ''}`} style={tint(COLORS[entry.who])}>
      {entry.label && <Label who={entry.who} />}
      {entry.kind === 'error' ? <div className="error">✗ {entry.text}</div> : <RichText text={entry.text} />}
    </div>
  );
}

function ToolGroup({ block }: { block: Extract<Block, { tools: StepRow[] }> }) {
  const [open, setOpen] = useState(false);
  const { tools } = block;
  const last = tools[tools.length - 1];
  const failed = tools.filter((t) => stepStatus(t)?.tone === 'fail').length;
  return (
    <div className={`entry agent${block.label ? ' labeled' : ''}`} style={tint(COLORS[block.who])}>
      {block.label && <Label who={block.who} />}
      {tools.length === 1 ? (
        <div className="steps">
          <StepLine row={last} />
        </div>
      ) : (
        <>
          <button className="tool-summary" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <span>
              {tools.length} ações
              {failed > 0 && <span className="step-why fail"> · {failed} {failed === 1 ? 'falhou' : 'falharam'}</span>}
              {!open && <span className="tool-last"> · {truncate(last.entry.text, 90)}</span>}
            </span>
            <span className={`chev${open ? ' open' : ''}`}>{icons.chevronRight}</span>
          </button>
          {open && (
            <div className="tool-list">
              {tools.map((t) => (
                <StepLine key={t.entry.id} row={t} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Uma ação: o ✓ ou o ✗ de como acabou e, num clique, o comando inteiro e os arquivos que ela mexeu. */
function StepLine({ row }: { row: StepRow }) {
  const [open, setOpen] = useState(false);
  const { entry, result } = row;
  const status = stepStatus(row);
  const full = entry.step?.full;
  const long = full !== undefined && full !== entry.text;
  const files = result?.ok ? (result.files ?? []) : [];
  const more = long || files.length > 1;
  return (
    <div className="step">
      <div className="tool-line step-line">
        {status && <span className={`step-mark ${status.tone}`}>{status.mark}</span>}
        <span className="step-body">
          {more ? (
            <button className="step-open" aria-expanded={open} title="Ver por inteiro" onClick={() => setOpen((o) => !o)}>
              {entry.text}
            </button>
          ) : (
            entry.text
          )}
          {status?.why && <span className={`step-why ${status.tone}`}> · {status.why}</span>}
        </span>
      </div>
      {open && more && (
        <div className="step-detail">
          {long && <pre>{full}</pre>}
          {files.length > 1 && (
            <ul>
              {files.map((f) => (
                <li key={f.path}>
                  <span className="step-change">{f.change}</span> {f.path}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const FENCE = /```[^\n]*\n([\s\S]*?)```/g;
const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;

/** Texto com blocos de código, `código` e **negrito**. Sempre como texto: nada do que o agente escreve vira HTML. */
function RichText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  const prose = (from: number, to: number) => {
    const chunk = text.slice(from, to).replace(/^\n+|\n+$/g, '');
    if (chunk) parts.push(<Inline key={`p${from}`} text={chunk} />);
  };
  for (const m of text.matchAll(FENCE)) {
    prose(last, m.index);
    parts.push(
      <pre key={`c${m.index}`}>
        <code>{m[1].replace(/\n$/, '')}</code>
      </pre>,
    );
    last = m.index + m[0].length;
  }
  prose(last, text.length);
  return <div className="text">{parts}</div>;
}

function Inline({ text }: { text: string }) {
  return (
    <p>
      {text.split(INLINE).map((piece, i) =>
        i % 2 === 0 ? (
          piece
        ) : piece.startsWith('`') ? (
          <code key={i}>{piece.slice(1, -1)}</code>
        ) : (
          <strong key={i}>{piece.slice(2, -2)}</strong>
        ),
      )}
    </p>
  );
}

/* pedido de permissão, caixa de texto */

function AskCard(props: { ask: Ask; more: number; name: string; disabled: boolean; onAnswer: (ok: boolean) => void }) {
  const { ask, more, name, disabled, onAnswer } = props;
  return (
    <div className="ask" style={tint(COLORS[ask.who])}>
      <div className="ask-title">
        <span className="dot" />
        {name} pede permissão{more > 0 ? ` (+${more} na fila)` : ''}
      </div>
      <code className="ask-text">{ask.text}</code>
      <div className="ask-actions">
        <button className="deny" disabled={disabled} onClick={() => onAnswer(false)}>
          Negar
        </button>
        <button className="allow" disabled={disabled} onClick={() => onAnswer(true)}>
          Permitir
        </button>
      </div>
    </div>
  );
}

/** Fecha o menu num clique fora dele. */
function useOutside(ref: RefObject<HTMLElement>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [ref, open, close]);
}

function Composer(props: {
  snap: Snapshot;
  disabled: boolean;
  text: string;
  setText: Dispatch<SetStateAction<string>>;
  inputRef: RefObject<HTMLTextAreaElement>;
  send: (text: string, images?: PastedImage[]) => Promise<boolean>;
  command: (cmd: string) => void;
  setModel: (agent: AgentId, choice: ModelChoice) => void;
  prefill: (text: string) => void;
  onError: (msg: string) => void;
}) {
  const { snap, disabled, text, setText, inputRef, send, command, setModel, prefill, onError } = props;
  const [menu, setMenu] = useState<'mais' | 'destino' | AgentId | null>(null);
  const [images, setImages] = useState<Pasted[]>([]);
  /** prints colados que ainda estão sendo preparados (lidos, reduzidos) */
  const [preparing, setPreparing] = useState(0);
  /** Enter com print ainda sendo preparado: a mensagem sai assim que ele fica pronto, junto com ele */
  const [sendWhenReady, setSendWhenReady] = useState(false);
  /** a mensagem foi e o duo ainda não respondeu: a caixa fica só leitura até lá */
  const [sending, setSending] = useState(false);
  // as mesmas duas, na hora: dois eventos seguidos (colar e Enter, ou Enter duas vezes) não esperam o React desenhar
  const now = useRef({ preparing: 0, sending: false });
  const boxRef = useRef<HTMLDivElement>(null);
  const close = useMemo(() => () => setMenu(null), []);
  useOutside(boxRef, menu !== null, close);

  // "@cla /co": a lista de comandos de quem você chamou, filtrada pelo que já digitou
  const query = agentCommandQuery(text);
  const matches = query ? matchCommands(snap.commands[query.target], query.query) : [];
  const complete = (name: string) => {
    if (!query) return;
    prefill(`${query.head}/${name} `);
  };

  // a caixa cresce com o texto, até um limite
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text, inputRef]);

  // A caixa só esvazia quando o duo recebeu. Não foi (print junto de um comando do duo: o duo diz por quê na
  // conversa) ou não chegou: a mensagem continua na caixa, e nada escrito nesse meio-tempo se perde.
  const submit = async () => {
    if (disabled || now.current.sending) return;
    if (now.current.preparing > 0) {
      setSendWhenReady(true);
      return;
    }
    if (!text.trim() && images.length === 0) return;
    const value = text;
    const pics = images;
    now.current.sending = true;
    setSending(true);
    try {
      if (await send(value, pics.map(({ mediaType, data }) => ({ mediaType, data })))) {
        setText((cur) => (cur === value ? '' : cur));
        setImages((cur) => cur.filter((p) => !pics.includes(p)));
      }
    } catch {
      // o erro aparece acima da caixa
    } finally {
      now.current.sending = false;
      setSending(false);
    }
  };
  useEffect(() => {
    if (!sendWhenReady || preparing > 0) return;
    setSendWhenReady(false);
    void submit();
  }, [sendWhenReady, preparing]);

  // print colado (Win+Shift+S, PrintScreen): entra na mensagem; texto colado segue normal
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.items]
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    if (!e.clipboardData.types.includes('text/plain')) e.preventDefault();
    if (now.current.sending) return; // a caixa está só leitura até o duo receber a mensagem anterior
    if (images.length + now.current.preparing + files.length > MAX_IMAGES) {
      onError(`no máximo ${MAX_IMAGES} prints por mensagem`);
      return;
    }
    const count = (delta: number) => setPreparing((now.current.preparing += delta));
    count(+files.length);
    void Promise.all(files.map(readImage))
      .then(
        (read) => setImages((prev) => [...prev, ...read].slice(0, MAX_IMAGES)),
        (err) => {
          setSendWhenReady(false); // sem o print, a mensagem não sai sozinha: fica na caixa
          onError(err instanceof Error ? err.message : String(err));
        },
      )
      .finally(() => count(-files.length));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab' && query && matches[0]) {
      e.preventDefault();
      complete(matches[0].name);
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  const targetName = (t: Target) => (t === 'todos' ? 'os dois' : snap.names[t]);
  const pick = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };

  return (
    <div className="composer" ref={boxRef}>
      {query && (
        <CommandList
          name={snap.names[query.target]}
          color={COLORS[query.target]}
          total={snap.commands[query.target].length}
          matches={matches}
          onPick={complete}
        />
      )}
      {menu === 'mais' && (
        <div className="menu menu-plus">
          <button onClick={pick(() => prefill('@cla /'))}>
            <span className="menu-dot" style={tint(COLORS.claude)} />
            Comandos do {snap.names.claude}
          </button>
          <button onClick={pick(() => prefill('@fog /'))}>
            <span className="menu-dot" style={tint(COLORS.codex)} />
            Skills do {snap.names.codex}
          </button>
          <button disabled={snap.brain} onClick={pick(() => prefill('/brain /cla '))}>
            {icons.sparkle} Brain: o {snap.names.claude} começa
          </button>
          <button disabled={snap.brain} onClick={pick(() => prefill('/brain /fog '))}>
            {icons.sparkle} Brain: o {snap.names.codex} começa
          </button>
        </div>
      )}
      {(menu === 'claude' || menu === 'codex') && (
        <ModelMenu
          key={menu}
          name={snap.names[menu]}
          models={snap.models[menu]}
          stats={snap.stats[menu]}
          onPick={(choice, close) => {
            if (close) setMenu(null);
            setModel(menu, choice);
          }}
        />
      )}
      {menu === 'destino' && (
        <div className="menu menu-target">
          {TARGETS.map((t) => (
            <button
              key={t}
              className={snap.target === t ? 'on' : ''}
              onClick={pick(() => snap.target !== t && command(`/${t}`))}
            >
              <span className="menu-dot" style={tint(t === 'todos' ? 'var(--fg)' : COLORS[t])} />
              {t === 'todos' ? 'Os dois' : snap.names[t]}
              {snap.target === t && <span className="check">✓</span>}
            </button>
          ))}
        </div>
      )}

      {(images.length > 0 || preparing > 0) && (
        <div className="attachments">
          {images.map((img) => (
            <div key={img.key} className="thumb">
              <img src={img.url} alt="print colado" />
              <button
                className="thumb-x"
                aria-label="Tirar este print"
                title="Tirar este print"
                onClick={() => setImages((prev) => prev.filter((p) => p.key !== img.key))}
              >
                ×
              </button>
            </div>
          ))}
          {preparing > 0 && (
            <div className="thumb thumb-wait">{sendWhenReady ? 'vai assim que carregar…' : 'carregando…'}</div>
          )}
        </div>
      )}
      <div className={`input-box${disabled ? ' off' : ''}`}>
        <IconButton
          icon={icons.plus}
          label="Comandos, skills e brain"
          disabled={disabled}
          onClick={() => setMenu((m) => (m === 'mais' ? null : 'mais'))}
        />
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          autoFocus
          disabled={disabled}
          readOnly={sending}
          placeholder={`Mensagem para ${targetName(snap.target)}`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <IconButton
          icon={icons.enter}
          label="Enviar"
          disabled={disabled || sending || (!text.trim() && images.length === 0 && preparing === 0)}
          onClick={() => void submit()}
        />
      </div>

      <div className="under">
        <button
          className="chip"
          disabled={disabled}
          style={tint(snap.target === 'todos' ? 'var(--fg)' : COLORS[snap.target])}
          onClick={() => setMenu((m) => (m === 'destino' ? null : 'destino'))}
        >
          <span className="menu-dot" />
          Para {targetName(snap.target)}
          {icons.chevronDown}
        </button>
        {targetsOf(snap.target).map((id) => (
          <button
            key={id}
            className="chip chip-model"
            disabled={disabled || snap.models[id].length === 0}
            style={tint(COLORS[id])}
            title={
              snap.models[id].length === 0
                ? `a lista de modelos do ${snap.names[id]} ainda não carregou`
                : `Modelo e esforço do ${snap.names[id]}`
            }
            onClick={() => setMenu((m) => (m === id ? null : id))}
          >
            {snap.target === 'todos' && <span className="menu-dot" />}
            <span className="chip-label">{modelLabel(snap.models[id], snap.stats[id])}</span>
            {icons.chevronDown}
          </button>
        ))}
        <button
          className={`chip${snap.shared ? '' : ' strong'}`}
          disabled={disabled}
          title={snap.shared ? 'Clique para o modo privado' : 'Clique para compartilhar'}
          onClick={() => command(snap.shared ? '/privado' : '/compartilhado')}
        >
          {snap.shared ? icons.users : icons.lock}
          {snap.shared ? 'Compartilhado' : 'Privado'}
        </button>
        <span className="spacer" />
        <span className="hint">Ctrl+V cola print · Shift+Enter quebra a linha · /ajuda</span>
      </div>
    </div>
  );
}

/**
 * O seletor de modelo de um deles: os modelos que o CLI dele informa e, do modelo em uso, o submenu de esforço e o modo
 * rápido (só se ele tem). `onPick` manda a troca; `close` = fechar o menu junto (o modo rápido deixa aberto).
 */
function ModelMenu(props: {
  name: string;
  models: AgentModel[];
  stats: AgentStats;
  onPick: (choice: ModelChoice, close: boolean) => void;
}) {
  const { name, models, stats, onPick } = props;
  const [view, setView] = useState<'modelos' | 'esforco'>('modelos');
  const current = currentModel(models, stats);
  if (view === 'esforco' && current) {
    return (
      <div className="menu menu-model">
        <button className="menu-back" onClick={() => setView('modelos')}>
          {icons.chevronLeft}
          Esforço do {current.name}
        </button>
        {current.efforts.map((e) => (
          <button key={e} className={stats.effort === e ? 'on' : ''} onClick={() => onPick({ effort: e }, true)}>
            {e}
            {stats.effort === e && <span className="check">✓</span>}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="menu menu-model">
      <div className="menu-title">Modelo do {name}</div>
      <div className="menu-models">
        {models.map((m) => (
          <button
            key={m.id}
            className={m === current ? 'on' : ''}
            title={m.id}
            onClick={() => m !== current && onPick({ model: m.id }, true)}
          >
            <span className="model-text">
              <span>{m.name}</span>
              {m.description && <span className="model-desc">{m.description}</span>}
            </span>
            {m === current && <span className="check">✓</span>}
          </button>
        ))}
      </div>
      {current && (current.efforts.length > 0 || current.fast) && <div className="menu-sep" />}
      {current && current.efforts.length > 0 && (
        <button onClick={() => setView('esforco')}>
          Esforço
          <span className="menu-value">{stats.effort ?? '—'}</span>
          {icons.chevronRight}
        </button>
      )}
      {current?.fast && (
        <div className="menu-row">
          Modo rápido
          <Switch on={stats.fast === true} label="Modo rápido" onClick={() => onPick({ fast: stats.fast !== true }, false)} />
        </div>
      )}
    </div>
  );
}

function CommandList(props: {
  name: string;
  color: string;
  total: number;
  matches: AgentCommand[];
  onPick: (name: string) => void;
}) {
  const { name, color, total, matches, onPick } = props;
  if (total === 0) return <div className="menu cmds empty">os comandos do {name} ainda não carregaram</div>;
  if (matches.length === 0) return <div className="menu cmds empty">nenhum comando do {name} com esse nome</div>;
  const shown = matches.slice(0, LIST_MAX);
  return (
    <div className="menu cmds" style={tint(color)}>
      {shown.map((c, i) => (
        <button
          key={c.name}
          className={i === 0 ? 'first' : ''}
          // não tira o foco da caixa de texto
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(c.name)}
        >
          <span className="cmd-name">/{c.name}</span>
          <span className="cmd-desc">{c.description}</span>
        </button>
      ))}
      <div className="cmds-hint">
        {matches.length > LIST_MAX ? `+${matches.length - LIST_MAX} · ` : ''}Tab completa /{shown[0].name}
      </div>
    </div>
  );
}

/* peças pequenas */

function IconButton(props: { icon: ReactNode; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button className="icon-btn" title={props.label} aria-label={props.label} disabled={props.disabled} onClick={props.onClick}>
      {props.icon}
    </button>
  );
}

function NavButton(props: { icon: ReactNode; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button className="nav-btn" disabled={props.disabled} onClick={props.onClick}>
      {props.icon}
      <span>{props.label}</span>
    </button>
  );
}

function Switch(props: { on: boolean; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      className={`switch${props.on ? ' on' : ''}`}
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span />
    </button>
  );
}

const svg = (children: ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

const icons = {
  plus: svg(<path d="M12 5v14M5 12h14" />),
  sparkle: svg(<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" />),
  stop: svg(<rect x="6" y="6" width="12" height="12" rx="2" />),
  eraser: svg(<path d="M8 20h12M5.5 14.5l8-8a2 2 0 012.8 0l2.2 2.2a2 2 0 010 2.8L12 18H8.5l-3-3a.4.4 0 010-.5z" />),
  help: svg(
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.2a2.5 2.5 0 014.9.6c0 1.7-2.5 2.2-2.5 3.7M12 17h.01" />
    </>,
  ),
  power: svg(<path d="M12 3v8M6.4 6.6a8 8 0 1011.2 0" />),
  folder: svg(<path d="M3 7.5A1.5 1.5 0 014.5 6h4l2 2h9A1.5 1.5 0 0121 9.5v8a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5z" />),
  lock: svg(
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8.5 11V8a3.5 3.5 0 017 0v3" />
    </>,
  ),
  users: svg(
    <>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0111 0M16 5.5a3 3 0 010 6M20.5 19a5.5 5.5 0 00-3.5-5.1" />
    </>,
  ),
  panelLeft: svg(
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M9 4.5v15" />
    </>,
  ),
  panelRight: svg(
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M15 4.5v15" />
    </>,
  ),
  enter: svg(<path d="M19 5v6a3 3 0 01-3 3H6M10 10l-4 4 4 4" />),
  chevronDown: svg(<path d="M7 10l5 5 5-5" />),
  chevronRight: svg(<path d="M10 7l5 5-5 5" />),
  chevronLeft: svg(<path d="M14 7l-5 5 5 5" />),
};
