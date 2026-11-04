import path from 'node:path';
import {
  createQueue,
  quietStep,
  ResumeFailedError,
  truncate,
  type Agent,
  type AgentEvent,
  type AgentCommand,
  type AgentId,
  type AgentModel,
  type AgentStats,
  type AgentTask,
  type AgentTool,
  type EmitFn,
  type ImageInput,
  type ModelChoice,
  type AskQuestion,
  type PermissionAnswer,
} from './agents/types.js';
import {
  closeOpenSteps,
  markInterrupted,
  newSessionData,
  Recorder,
  type ScreenEntry,
  type SessionData,
  type TurnStatus,
  type Who,
} from './persist.js';
import { BRAIN_MAX, brainOpening, brainReview, brainVerdict, otherOf } from './brain.js';
import { describeChanges, type ChangeWatcher, type Fingerprints } from './changes.js';
import { currentModel, modelLabel } from './display.js';
import { HELP_TEXT, parseInput, targetsOf, type Target } from './router.js';
import { SharedLog } from './shared.js';

/**
 * O duo sem tela: a conversa, as filas, o brain, os pedidos de permissão. O terminal (app.tsx) e a janela
 * (gui/) são só jeitos de mostrar este estado e de mandar o que você digitou para `submit`.
 */

export interface Entry extends ScreenEntry {
  id: number;
}

/** Um pedido de permissão esperando a sua resposta. */
export interface Ask {
  id: number;
  who: AgentId;
  text: string;
  /** é uma pergunta com opções: as perguntas, para você responder (em vez de permitir ou negar) */
  questions?: AskQuestion[];
}

export interface DuoState {
  entries: Entry[];
  target: Target;
  shared: boolean;
  /** turnos de cada um rodando ou na fila */
  busy: Record<AgentId, number>;
  /** em fila: o primeiro é o da vez */
  asks: Ask[];
  stats: Record<AgentId, AgentStats>;
  commands: Record<AgentId, AgentCommand[]>;
  /** os modelos que cada um oferece (o seletor da janela) */
  models: Record<AgentId, AgentModel[]>;
  /** tem um /brain rodando */
  brain: boolean;
  /** o que cada um pôs para rodar em segundo plano (subagentes, comandos) */
  tasks: Record<AgentId, AgentTask[]>;
  /** desde quando o turno de cada um está rodando, em ms (null = parado) */
  runningSince: Record<AgentId, number | null>;
  /** quando chegou a última coisa do processo de cada um, em ms (null = nada ainda): sem sinal há muito = travado? */
  lastSignal: Record<AgentId, number | null>;
  /** as ferramentas que cada um está usando agora no turno (um comando, uma edição, uma busca) */
  tools: Record<AgentId, AgentTool[]>;
  /** desde quando cada um espera a resposta do outro pela ferramenta do duo, em ms (null = não espera) */
  peerWait: Record<AgentId, number | null>;
  /** você mandou parar e o turno dele ainda não fechou */
  stopping: Record<AgentId, boolean>;
}

/**
 * `entry` = uma linha nova; `clear` = /limpar, avisado ANTES de a tela ficar vazia (o terminal apaga o que já
 * escreveu); `change` = o resto do estado mudou; `quit` = /sair, com os agentes já encerrados.
 */
export type DuoEvent = { type: 'entry'; entry: Entry } | { type: 'clear' } | { type: 'change' } | { type: 'quit' };

export interface DuoOptions {
  agents: Record<AgentId, Agent>;
  /** onde a conversa é gravada; sem ele, fica só na memória */
  recorder?: Recorder;
  /** true quando veio de `duo -c` */
  resumed?: boolean;
  /** mede o que mudou no projeto no fim do trabalho de cada um (o git da pasta); sem ele, o duo não mede nada */
  changes?: ChangeWatcher;
}

/** De quanto em quanto tempo o último sinal é atualizado: chega coisa do processo o tempo todo. */
const SIGNAL_STEP_MS = 1000;
/** Até quanto o primeiro trabalho espera a primeira medida do "O que mudou" (o que ele editar antes dela entraria no
 * "antes" sem quadro). Passou disso, ele começa assim mesmo. */
const FIRST_MEASURE_WAIT_MS = 10_000;

const YES = ['s', 'sim'];
const NO = ['n', 'não', 'nao'];

/** As respostas que servem a estas perguntas: um texto não vazio para cada uma, e nenhuma a mais. null = não servem. */
export function cleanAnswers(questions: AskQuestion[], answers: unknown): Record<string, string> | null {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const given = answers as Record<string, unknown>;
  // as perguntas têm textos diferentes (o adaptador recusa repetidas): mesma quantidade e todas presentes = nenhuma a mais
  if (Object.keys(given).length !== questions.length) return null;
  const out: [string, string][] = [];
  for (const q of questions) {
    const a = Object.prototype.hasOwnProperty.call(given, q.question) ? given[q.question] : undefined;
    if (typeof a !== 'string' || !a.trim()) return null;
    out.push([q.question, a.trim()]);
  }
  return Object.fromEntries(out);
}

/**
 * O que você digitou no terminal para as perguntas. Para cada uma: o nome de uma opção, o número dela, ou um texto seu;
 * na que deixa escolher mais de uma, vários separados por vírgula (números, nomes e texto seu juntos). Mais de uma
 * pergunta: as respostas separadas por ";". O nome vem antes do número (uma opção pode se chamar "2026"), e um número
 * que não é de nenhuma opção não vale, em vez de virar texto: para responder com um número seu, escreva-o com texto.
 * null = não deu para tirar uma resposta para cada uma.
 */
export function answersFromText(questions: AskQuestion[], value: string): Record<string, string> | null {
  const parts = questions.length === 1 ? [value] : value.split(';');
  if (parts.length !== questions.length) return null;
  /** uma escolha: o nome da opção, o número dela, ou o texto como veio; null = um número que não é de nenhuma */
  const one = (q: AskQuestion, text: string): string | null => {
    const named = q.options.find((o) => o.label.trim().toLowerCase() === text.toLowerCase());
    if (named) return named.label;
    if (!/^[+-]?\d+$/.test(text)) return text;
    return q.options[Number(text) - 1]?.label ?? null;
  };
  const pick = (q: AskQuestion, raw: string): string | null => {
    const text = raw.trim();
    // sem opções, não há o que escolher: o texto vai como veio, vírgulas inclusive, mesmo na de várias escolhas
    if (q.options.length === 0) return text;
    if (!q.multiSelect) return one(q, text);
    // o nome inteiro de uma opção pode ter vírgula
    const whole = q.options.find((o) => o.label.trim().toLowerCase() === text.toLowerCase());
    if (whole) return whole.label;
    const picked = text
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => one(q, s));
    return picked.includes(null) ? null : [...new Set(picked)].join(', ');
  };
  const picked = questions.map((q, i) => [q.question, pick(q, parts[i])] as const);
  if (picked.some(([, a]) => a === null)) return null;
  return cleanAnswers(questions, Object.fromEntries(picked));
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

export class Duo {
  readonly agents: Record<AgentId, Agent>;
  private readonly rec: Recorder;
  private readonly resumed: boolean;
  private log: SharedLog;
  private readonly queues = { claude: createQueue(), codex: createQueue() };
  private nextId = 0;
  private nextAsk = 0;
  private lastWho: Who | null = null;
  /** os passos na tela ainda sem fim: quantos de cada id (o /limpar tira todos) */
  private openSteps = new Map<string, number>();
  // Muda a cada /novo: o que ainda era da conversa anterior (na fila, rodando, o brain) não roda nem aparece na nova.
  private session = 0;
  // O turno que ele abriu sozinho (ou que você abriu pelo app): o modo de quando começou, guardado para a resposta
  // seguir ele mesmo que você troque antes de ela chegar. Só o turno dele escreve e apaga aqui.
  private own: Record<AgentId, { shared: boolean } | undefined> = { claude: undefined, codex: undefined };
  // As mensagens suas pelo app lidas fora de um turno do duo desde a última resposta de um turno dele: todas foram no
  // modo compartilhado? O agente diz, no fim do turno dele, se alguma delas era desse turno.
  private fromApp: Record<AgentId, boolean | undefined> = { claude: undefined, codex: undefined };
  /**
   * O que deixa cada um rodando: um turno do duo na vez dele (`duo`) e um turno que ele abriu sozinho (`own`). Os
   * dois podem se sobrepor (a sua mensagem entra enquanto o dele ainda corre, ou o dele começa antes de o do duo
   * fechar): só para de rodar quando os dois acabam.
   */
  private readonly running: Record<AgentId, { duo: boolean; own: boolean }> = {
    claude: { duo: false, own: false },
    codex: { duo: false, own: false },
  };
  /** Uma troca de modelo por vez para cada um: a seguinte confere contra o que a anterior deixou. */
  private readonly modelQueues = { claude: createQueue(), codex: createQueue() };
  /** Chamadas em andamento de cada um ao outro, pela ferramenta do duo. */
  private readonly calling: Record<AgentId, number> = { claude: 0, codex: 0 };
  /** Muda a cada vez que você para um deles: o turno dele que estava rodando ou na fila não segue. */
  private readonly cut: Record<AgentId, number> = { claude: 0, codex: 0 };
  /** Quem espera uma resposta dele pela ferramenta do duo: parar ele avisa cada um na hora. */
  private readonly onCut: Record<AgentId, Set<() => void>> = { claude: new Set(), codex: new Set() };
  /** O que rodava quando você mandou parar: o "parando" dura até isso acabar, mesmo que outra coisa já tenha começado. */
  private readonly stopParts: Record<AgentId, Set<'duo' | 'own'>> = { claude: new Set(), codex: new Set() };
  /** O brain em andamento (só um por vez). `stop` = /parar: encerra depois da resposta em andamento. */
  private brain: { stop: boolean } | null = null;
  /** quem responde cada pedido de permissão da fila */
  private readonly answers = new Map<number, (reply: PermissionAnswer) => void>();
  private started = false;
  private readonly watcher?: ChangeWatcher;
  /**
   * como cada worktree estava na última medida (ao abrir o duo, e no fim de cada trabalho); null = não se sabe (a
   * primeira falhou): o próximo fim só mede, sem quadro
   */
  private known: Promise<Fingerprints | null> = Promise.resolve(null);
  /** a primeira medida, enquanto não termina: o trabalho do duo espera por ela (até FIRST_MEASURE_WAIT_MS) */
  private firstMeasure: Promise<void> | undefined;
  /**
   * a medida que valia quando cada um começou a rodar, e de qual conversa ele era: no fim, o que ficou diferente vira
   * o "O que mudou" (se ainda for a mesma conversa)
   */
  private readonly watchFrom: Record<AgentId, { from: Promise<Fingerprints | null>; session: number } | undefined> = {
    claude: undefined,
    codex: undefined,
  };
  private state: DuoState;
  private readonly listeners = new Set<(ev: DuoEvent) => void>();

  constructor({ agents, recorder, resumed = false, changes }: DuoOptions) {
    this.agents = agents;
    this.watcher = changes;
    this.rec = recorder ?? new Recorder(newSessionData(process.cwd()));
    this.resumed = resumed;
    this.log = new SharedLog(this.rec.data.log);
    // Na retomada, a tela volta como estava; o passo que o duo deixou aberto ao fechar diz que não terminou.
    if (resumed) closeOpenSteps(this.rec.data.screen);
    const restored = this.rec.data.screen.map((e) => ({ ...e, id: this.nextId++ }));
    this.lastWho = [...restored].reverse().find((e) => !quietStep(e))?.who ?? null; // o fim que deu certo não conta
    this.state = {
      entries: restored,
      target: this.rec.data.target,
      shared: this.rec.data.shared,
      busy: { claude: 0, codex: 0 },
      asks: [],
      stats: { claude: { ...agents.claude.stats }, codex: { ...agents.codex.stats } },
      commands: { claude: agents.claude.commands, codex: agents.codex.commands },
      models: { claude: agents.claude.models, codex: agents.codex.models },
      brain: false,
      tasks: { claude: [], codex: [] },
      runningSince: { claude: null, codex: null },
      lastSignal: { claude: null, codex: null },
      tools: { claude: [], codex: [] },
      peerWait: { claude: null, codex: null },
      stopping: { claude: false, codex: false },
    };
  }

  /** a pasta em que os dois trabalham */
  get cwd(): string {
    return this.rec.data.cwd;
  }

  /** O estado de agora. Cada mudança troca o objeto: dá para comparar por identidade. */
  getState = (): DuoState => this.state;

  subscribe = (listener: (ev: DuoEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(ev: DuoEvent): void {
    for (const listener of [...this.listeners]) listener(ev);
  }

  private update(patch: Partial<DuoState>, ev: DuoEvent = { type: 'change' }): void {
    this.state = { ...this.state, ...patch };
    this.emit(ev);
  }

  private add(
    who: Who,
    kind: Entry['kind'],
    text: string,
    extra: Pick<ScreenEntry, 'images' | 'step' | 'result' | 'changes'> = {},
  ): void {
    // o fim de um passo que deu certo não aparece no terminal: não conta como quem falou por último
    const quiet = quietStep({ kind, ...extra });
    const label = !quiet && this.lastWho !== who;
    if (!quiet) this.lastWho = who;
    const entry: ScreenEntry = { who, kind, text, label };
    if (extra.images?.length) entry.images = extra.images;
    if (extra.step) entry.step = extra.step;
    if (extra.result) entry.result = extra.result;
    if (extra.changes) entry.changes = extra.changes;
    this.rec.data.screen.push(entry);
    this.rec.saveSoon();
    const shown = { ...entry, id: this.nextId++ };
    this.update({ entries: [...this.state.entries, shown] }, { type: 'entry', entry: shown });
  }

  /** O que um agente mandou para a tela: um passo e o fim dele vão junto da linha. */
  private addEvent(who: AgentId, ev: AgentEvent): void {
    if (ev.kind !== 'tool') return this.add(who, ev.kind, ev.text);
    if (ev.result && !ev.step) {
      // o fim de um passo que não está na tela (você limpou com ele rodando) não entra: sozinho, não diz de que passo
      // era, e não toma o lugar de quem falou por último
      const open = this.openSteps.get(ev.result.of);
      if (!open) return;
      if (open > 1) this.openSteps.set(ev.result.of, open - 1);
      else this.openSteps.delete(ev.result.of);
    } else if (ev.step && !ev.result) {
      this.openSteps.set(ev.step.id, (this.openSteps.get(ev.step.id) ?? 0) + 1);
    }
    this.add(who, 'tool', ev.text, { step: ev.step, result: ev.result });
  }

  private setBusy(id: AgentId, delta: number): void {
    this.update({ busy: { ...this.state.busy, [id]: this.state.busy[id] + delta } });
  }

  /**
   * Espera `work`, ou você parar o `id`: aí devolve null no clique, sem esperar o turno dele fechar (o CLI pode
   * levar segundos). É como quem espera a resposta dele (quem o chamou, o brain) fica sabendo já.
   */
  private untilCut<T>(id: AgentId, work: Promise<T>): Promise<T | null> {
    let stopNow!: () => void;
    const stopped = new Promise<null>((resolve) => (stopNow = () => resolve(null)));
    this.onCut[id].add(stopNow);
    return Promise.race([work, stopped]).finally(() => this.onCut[id].delete(stopNow));
  }

  /**
   * O turno dele (o da fila, ou um que ele abriu sozinho) começou ou acabou. Começar conta como sinal. O "parando"
   * acaba quando acaba o que rodava no clique, ou quando ele para de rodar de vez.
   */
  private setRunning(id: AgentId, part: 'duo' | 'own', value: boolean): void {
    this.running[id][part] = value;
    const on = this.running[id].duo || this.running[id].own;
    const stops = this.stopParts[id];
    if (!on) stops.clear();
    else if (!value) stops.delete(part);
    if (stops.size === 0 && this.state.stopping[id]) this.update({ stopping: { ...this.state.stopping, [id]: false } });
    if (on === (this.state.runningSince[id] !== null)) return;
    this.watchChanges(id, on);
    const now = Date.now();
    this.update({
      runningSince: { ...this.state.runningSince, [id]: on ? now : null },
      ...(on ? { lastSignal: { ...this.state.lastSignal, [id]: now } } : {}),
    });
  }

  /**
   * Começou a rodar: fica com a última medida de cada worktree, na hora (medir agora correria com a primeira edição
   * dele). Parou: mede de novo, e o que ficou diferente aparece na conversa, um quadro por worktree (o "O que mudou");
   * essa medida vira a de quem começar depois. O git roda por fora, sem segurar o turno; sem git ou fora de um
   * repositório, não aparece nada.
   */
  private watchChanges(id: AgentId, on: boolean): void {
    if (!this.watcher) return;
    if (on) {
      this.watchFrom[id] = { from: this.known, session: this.session };
      return;
    }
    const start = this.watchFrom[id];
    this.watchFrom[id] = undefined;
    if (!start) return;
    const { from, session } = start;
    const watcher = this.watcher;
    // sem a medida de antes (a primeira falhou), não se sabe o que mudou: só mede, e esta passa a valer
    const result = from.then((before) =>
      before ? watcher.changedSince(before) : watcher.fingerprints().then((now) => ({ changes: [], now })),
    );
    this.known = result.then(
      (r) => r.now,
      () => from, // o git falhou (ou isto não é um repositório): continua valendo a medida anterior
    );
    void result.then(
      ({ changes }) => {
        if (this.session !== session) return; // houve /novo: o trabalho era da conversa anterior
        for (const c of changes) {
          this.add('sistema', 'text', describeChanges(c, this.agents[id].name, this.cwd), { changes: c });
        }
      },
      () => undefined,
    );
  }

  private signal(id: AgentId): void {
    const now = Date.now();
    if (now - (this.state.lastSignal[id] ?? 0) < SIGNAL_STEP_MS) return;
    this.update({ lastSignal: { ...this.state.lastSignal, [id]: now } });
  }

  private setTarget(t: Target): void {
    this.rec.data.target = t;
    this.update({ target: t });
  }

  // Já houve algo privado com ele nesta conversa (pelo duo ou pelo app, antes ou depois de retomar): um turno que ele
  // abre sozinho sem origem conhecida não é compartilhado (podia ser de uma tarefa lançada naquela mensagem).
  private hadPrivate(id: AgentId): boolean {
    return this.log.state.items.some((item) => item.onlyFor?.includes(id));
  }

  /** Liga os agentes a este duo e sobe os dois. Uma vez só, quando a tela já está pronta para mostrar. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const { agents, rec } = this;
    // a primeira medida: o que já estava mudado ao abrir não é de ninguém e não vira quadro
    if (this.watcher) {
      const first = this.watcher.fingerprints().catch(() => null);
      this.known = first;
      let timer: NodeJS.Timeout | undefined;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FIRST_MEASURE_WAIT_MS);
        timer.unref?.();
      });
      this.firstMeasure = Promise.race([first.then(() => undefined), waited]).finally(() => {
        clearTimeout(timer);
        this.firstMeasure = undefined;
      });
    }
    rec.onError = (msg) => this.add('sistema', 'error', `não consegui salvar a conversa: ${msg}`);
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
      agent.onStats = (s) => this.update({ stats: { ...this.state.stats, [agent.id]: s } });
      agent.onCommands = (list) => this.update({ commands: { ...this.state.commands, [agent.id]: list } });
      agent.onModels = (list) => this.update({ models: { ...this.state.models, [agent.id]: list } });
      agent.onTasks = (list) => this.update({ tasks: { ...this.state.tasks, [agent.id]: list } });
      agent.onTools = (list) => this.update({ tools: { ...this.state.tools, [agent.id]: list } });
      agent.onSignal = () => this.signal(agent.id);
      // turno que ele abriu sozinho (terminou um subagente em segundo plano): aparece e entra na janela como os outros
      agent.onOwnTurnEvent = (ev) => {
        this.own[agent.id] ??= { shared: rec.data.shared };
        this.setRunning(agent.id, 'own', true);
        this.addEvent(agent.id, ev);
      };
      // Compartilhada só se o modo era compartilhado quando o turno começou E a origem dele também: as tarefas que o
      // abriram (o agente diz se todas vieram de mensagens compartilhadas), as suas mensagens pelo app que ele diz que
      // eram deste turno (o modo de cada uma quando chegou) ou, sem origem conhecida, nada privado com ele nesta
      // conversa. Texto vazio (turno só de ferramenta) não entra no log, mas encerra o turno: o próximo começa com o
      // modo da hora dele.
      agent.onOwnTurnReply = (text, tasksShared, fromApp = false) => {
        const turn = this.own[agent.id] ?? { shared: rec.data.shared };
        const appShared = this.fromApp[agent.id];
        this.own[agent.id] = undefined;
        this.fromApp[agent.id] = undefined;
        const shared = turn.shared && (!fromApp || appShared === true);
        const origin = tasksShared ?? (fromApp || !this.hadPrivate(agent.id));
        this.log.agentReply(agent.id, text, shared && origin);
        this.setRunning(agent.id, 'own', false);
        rec.saveSoon();
      };
      // o que você digitou no app (Remote Control): aparece aqui e o outro recebe como contexto. A lida no meio de um
      // turno do duo é respondida nele; a outra conta para o turno dele que ela abre (ou em que entra).
      agent.onRemoteMessage = (text, inDuoTurn = false) => {
        this.add('voce', 'text', `[pelo app, para o ${agent.name}] ${text}`);
        this.log.userMessage([agent.id], text, rec.data.shared);
        if (!inDuoTurn) this.fromApp[agent.id] = (this.fromApp[agent.id] ?? true) && rec.data.shared;
        rec.saveSoon();
      };
      agent.onNotice = (ev) => this.add('sistema', ev.kind, ev.text);
      agent.askPermission = ({ text, signal, questions }) =>
        new Promise<PermissionAnswer>((resolve) => {
          const ask: Ask = { id: this.nextAsk++, who: agent.id, text, ...(questions ? { questions } : {}) };
          const drop = () => {
            this.answers.delete(ask.id);
            this.update({ asks: this.state.asks.filter((a) => a !== ask) });
          };
          const cancel = () => {
            drop();
            this.add(agent.id, 'error', `${questions ? 'pergunta cancelada' : 'pedido de permissão cancelado'}: ${truncate(text)}`);
            resolve(false);
          };
          this.answers.set(ask.id, (reply) => {
            signal.removeEventListener('abort', cancel);
            drop();
            resolve(reply);
          });
          signal.addEventListener('abort', cancel, { once: true });
          this.update({ asks: [...this.state.asks, ask] });
        });
    }
    if (this.resumed) {
      this.add('sistema', 'text', 'Conversa retomada: cada um continua de onde parou.');
      for (const t of markInterrupted(rec.data)) {
        this.add(
          'sistema',
          'error',
          `interrompida quando o duo fechou: "${truncate(t.text, 80)}" para o ${agents[t.agent].name}. Não foi reenviada.`,
        );
      }
      rec.saveNow();
    } else {
      this.add('sistema', 'text', 'Claude + Codex na mesma janela. Digite /ajuda para ver os comandos.');
    }

    // Um agente chama o outro pela ferramenta do duo: vira um turno normal do outro, na fila dele e visível na
    // janela, e a resposta volta como resultado da ferramenta. Segue o modo atual (compartilhado ou privado).
    for (const agent of Object.values(agents)) {
      const to = otherOf(agent.id);
      agent.askPeer = async ({ text, signal }) => {
        // Chamada fora de um turno do duo vem de um turno que ele abriu sozinho (o Claude, quando uma tarefa em segundo
        // plano termina) e que pode começar por ela: conta como rodando, para o quadro mostrar a espera e o Parar alcançá-lo.
        if (!this.running[agent.id].duo && !this.running[agent.id].own) {
          this.own[agent.id] ??= { shared: rec.data.shared };
          this.setRunning(agent.id, 'own', true);
        }
        // Se o outro está esperando este, a chamada ficaria na fila atrás do turno que espera: os dois travariam.
        if (this.calling[to] > 0) {
          throw new Error(
            `o ${agents[to].name} está esperando uma resposta sua (ele te chamou); chamá-lo agora travaria os dois. ` +
              `Termine esta resposta primeiro; se precisar perguntar algo a ele, pergunte nela.`,
          );
        }
        this.calling[agent.id]++;
        if (this.calling[agent.id] === 1) this.update({ peerWait: { ...this.state.peerWait, [agent.id]: Date.now() } });
        // parado por você (ou o processo dele caiu): deixa de esperar já, sem esperar o outro terminar a resposta
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          if (--this.calling[agent.id] === 0) this.update({ peerWait: { ...this.state.peerWait, [agent.id]: null } });
        };
        signal.addEventListener('abort', release, { once: true });
        try {
          const sharedNow = rec.data.shared;
          this.add(agent.id, 'text', `[para o ${agents[to].name}] ${text}`);
          const msgIndex = this.log.agentMessage(agent.id, to, text, sharedNow);
          const turnId = newTurn(rec.data, to, `[do ${agents[agent.id].name}] ${text}`);
          rec.saveNow();
          const prompt =
            `[duo] O ${agents[agent.id].name} chamou você pela ferramenta do duo. A sua resposta volta direto para ele, ` +
            `e o usuário acompanha na janela. Termine dizendo claramente se concorda sem ressalvas ou o que ainda ` +
            `falta: é assim que ele sabe se chama você de novo. Não o chame de volta agora (ele está esperando você); ` +
            `se precisar perguntar algo, pergunte na resposta.\n\n${text}`;
          const cutAt = this.cut[to];
          const answer = await this.untilCut(
            to,
            this.runTurn(to, turnId, prompt, sharedNow, { msgIndex, call: { from: agent.id, signal } }),
          );
          if (answer === null) {
            throw new Error(
              this.cut[to] !== cutAt
                ? `o usuário parou o ${agents[to].name} antes de ele responder`
                : `o ${agents[to].name} não conseguiu responder; o erro aparece na janela do duo`,
            );
          }
          return answer;
        } finally {
          signal.removeEventListener('abort', release);
          release();
        }
      };
    }

    // Sobe os dois já ao abrir, como o terminal: a lista de comandos carrega antes da primeira mensagem.
    // Vem depois do askPeer: é ao subir que cada um ganha a ferramenta de falar com o outro.
    for (const agent of Object.values(agents)) agent.warmUp();
  }

  /**
   * Um turno de um agente. O prompt só é montado quando chega a vez dele na fila, e o contexto
   * só conta como entregue depois que ele responde: se falhar, vai de novo na próxima.
   * `msgIndex` = a sua mensagem (ele vê a janela até ali); sem ele, vê a janela até agora (brain).
   * `call` = quem chamou pela ferramenta do duo: a resposta volta direto para ele.
   * `images` = os prints que você colou na mensagem: vão junto para ele.
   * Resolve com a resposta, ou null se o turno falhou.
   */
  private runTurn(
    id: AgentId,
    turnId: number,
    text: string,
    sharedTurn: boolean,
    opts: { msgIndex?: number; call?: { from: AgentId; signal: AbortSignal }; images?: ImageInput[] } = {},
  ): Promise<string | null> {
    const { msgIndex, call, images } = opts;
    const { agents, rec } = this;
    const data = rec.data;
    const myLog = this.log;
    const epoch = this.session;
    const stale = () => this.session !== epoch; // houve /novo: o turno era da conversa anterior
    const cutAt = this.cut[id];
    const cut = () => this.cut[id] !== cutAt; // você parou ele: o turno (rodando ou na fila) não segue
    this.setBusy(id, +1);
    return this.queues[id](async (): Promise<string | null> => {
      // o primeiro trabalho não começa antes da primeira medida: o que ele editasse nesse meio entraria no "antes"
      if (this.firstMeasure) await this.firstMeasure;
      for (let attempt = 0; ; attempt++) {
        if (stale() || cut()) return null;
        const prepared = myLog.prepare(id, text, sharedTurn, msgIndex, call?.from);
        setTurn(data, turnId, 'running');
        rec.saveNow();
        try {
          const emit: EmitFn = (ev) => {
            if (!stale()) this.addEvent(id, ev);
          };
          this.setRunning(id, 'duo', true);
          const answer = await agents[id].send(prepared.prompt, emit, sharedTurn, images);
          if (stale()) return null;
          myLog.delivered(id, prepared);
          // Quem chamou só recebeu a resposta se ainda esperava; senão ela vai no contexto dele. Se você parou ele e a
          // resposta chegou antes de o CLI parar, ela fica na conversa, mas quem esperava (quem chamou, o brain) já
          // soube que você parou: para eles, o turno não respondeu.
          const waited = call !== undefined && !call.signal.aborted && !cut();
          myLog.agentReply(id, answer, sharedTurn, waited ? call.from : undefined, call?.from);
          setTurn(data, turnId, 'done');
          return cut() ? null : answer;
        } catch (e) {
          if (stale()) return null; // o /novo derrubou o processo: o erro não é desta conversa
          if (cut()) {
            setTurn(data, turnId, 'cancelled'); // a conversa já diz que você parou
            return null;
          }
          const err = e instanceof Error ? e : new Error(String(e));
          if (err instanceof ResumeFailedError && attempt === 0) {
            // Nada foi executado: abre conversa nova e manda de novo, com a janela inteira de contexto.
            myLog.forget(id);
            this.add(
              'sistema',
              'error',
              `não deu para retomar a conversa anterior do ${agents[id].name} (${err.message}). Abri uma nova, com o histórico da janela como contexto.`,
            );
            continue;
          }
          this.add(id, 'error', err.message);
          setTurn(data, turnId, 'failed');
          return null;
        }
      }
    }).finally(() => {
      this.setRunning(id, 'duo', false);
      this.setBusy(id, -1);
      rec.saveNow();
    });
  }

  /**
   * /brain: quem foi marcado responde, o outro avalia, e revezam até um concordar com a última resposta
   * do outro, ou até BRAIN_MAX respostas. Os dois participam, então a conversa do brain é sempre
   * compartilhada entre eles, mesmo no modo privado.
   */
  private async runBrain(first: AgentId, question: string): Promise<void> {
    const state = { stop: false };
    this.brain = state;
    this.update({ brain: true });
    const data = this.rec.data;
    const epoch = this.session;
    const name = (id: AgentId) => this.agents[id].name;
    this.add(
      'sistema',
      'text',
      `🧠 brain: o ${name(first)} responde, o ${name(otherOf(first))} avalia, e eles revezam até concordarem ` +
        `(no máximo ${BRAIN_MAX} respostas). /parar encerra.${data.shared ? '' : ' Os dois veem o brain, mesmo no modo privado.'}`,
    );
    this.add('voce', 'text', `[brain · ${name(first)} começa] ${question}`);
    const msgIndex = this.log.userMessage([first], question, true);
    this.rec.saveNow();

    let who = first;
    try {
      for (let n = 1; n <= BRAIN_MAX; n++) {
        const turnId = newTurn(data, who, n === 1 ? question : `[brain] avaliar a resposta do ${name(otherOf(who))}`);
        this.rec.saveNow();
        const cutAt = this.cut[who];
        const answer = await this.untilCut(
          who,
          n === 1
            ? this.runTurn(who, turnId, brainOpening(who, question), true, { msgIndex })
            : this.runTurn(who, turnId, brainReview(who), true),
        );
        if (this.session !== epoch) return; // /novo: o brain era da conversa anterior
        if (answer === null) {
          if (this.cut[who] !== cutAt) this.add('sistema', 'text', `🧠 brain parou: você parou o ${name(who)}.`);
          else this.add('sistema', 'error', `🧠 brain parou: a resposta do ${name(who)} falhou.`);
          return;
        }
        if (n > 1 && brainVerdict(answer) === 'concordo') {
          this.add('sistema', 'text', `🧠 concordaram: o ${name(who)} concordou com o ${name(otherOf(who))} (${n} respostas).`);
          return;
        }
        if (state.stop) {
          this.add('sistema', 'text', `🧠 brain encerrado por você depois de ${n} ${n === 1 ? 'resposta' : 'respostas'}.`);
          return;
        }
        who = otherOf(who);
      }
      this.add('sistema', 'text', `🧠 sem acordo em ${BRAIN_MAX} respostas. Mande /brain de novo para continuar.`);
    } finally {
      if (this.brain === state) {
        this.brain = null;
        this.update({ brain: false });
      }
      this.rec.saveNow();
    }
  }

  /**
   * O que você digitou, e os prints que colou. false = não foi (só espaços, ou print junto de um comando do duo):
   * a tela deixa na caixa de texto o que estava lá.
   */
  submit(value: string, images: ImageInput[] = []): boolean {
    const { agents, rec } = this;
    let cmd = parseInput(value, rec.data.target);
    if (images.length > 0) {
      // print sozinho (ou só com "@cla") vai para o destino, como uma mensagem
      if (!cmd) cmd = { type: 'ask', targets: targetsOf(rec.data.target), prompt: '', newDefault: rec.data.target };
      else if (cmd.type === 'ask' && cmd.targets.length === 0) cmd = { ...cmd, targets: targetsOf(cmd.newDefault) };
      if (cmd.type !== 'ask') {
        const why = cmd.type === 'invalid' ? cmd.message : 'o print vai junto de uma mensagem para um agente, não de um comando do duo.';
        this.add('sistema', 'error', why);
        return false;
      }
    }
    if (!cmd) return false;

    switch (cmd.type) {
      case 'quit':
        Object.values(agents).forEach((a) => a.dispose());
        this.emit({ type: 'quit' });
        return true;
      case 'clear':
        this.emit({ type: 'clear' });
        this.lastWho = null;
        this.openSteps.clear();
        rec.data.screen = [];
        rec.saveNow();
        this.update({ entries: [] });
        return true;
      case 'help':
        this.add('sistema', 'text', HELP_TEXT);
        return true;
      case 'new': {
        // o que estava na fila ou rodando (e o brain) era da anterior: sai, e fica gravado como cortado por você
        this.session++;
        this.brain = null;
        // um turno que ele tinha aberto sozinho não termina mais (o processo cai no reset): não fica "rodando"
        for (const r of Object.values(this.running)) r.duo = r.own = false;
        for (const s of Object.values(this.stopParts)) s.clear();
        this.update({
          brain: false,
          runningSince: { claude: null, codex: null },
          tools: { claude: [], codex: [] },
          stopping: { claude: false, codex: false },
        });
        this.own = { claude: undefined, codex: undefined };
        this.fromApp = { claude: undefined, codex: undefined };
        Object.values(agents).forEach((a) => a.reset());
        const dropped = rec.data.turns.filter((t) => t.status === 'pending' || t.status === 'running');
        for (const t of dropped) t.status = 'cancelled';
        const next = newSessionData(rec.data.cwd);
        next.shared = rec.data.shared;
        next.target = rec.data.target;
        rec.switchTo(next);
        this.log = new SharedLog(next.log);
        const cut =
          dropped.length === 0
            ? ''
            : dropped.length === 1
              ? ' A mensagem que ainda estava rodando ou na fila foi descartada.'
              : ` As ${dropped.length} mensagens que ainda estavam rodando ou na fila foram descartadas.`;
        this.add(
          'sistema',
          'text',
          `Conversa nova: a próxima mensagem começa do zero nos dois. A anterior continua salva.${cut}`,
        );
        return true;
      }
      case 'invalid':
        this.add('sistema', 'error', cmd.message);
        return true;
      case 'brain':
        if (this.brain) {
          this.add('sistema', 'error', 'já tem um brain rodando: espere terminar ou digite /parar.');
          return true;
        }
        void this.runBrain(cmd.first, cmd.prompt);
        return true;
      case 'stop':
        if (!this.brain) {
          this.add('sistema', 'error', 'não tem nenhum brain rodando.');
        } else if (!this.brain.stop) {
          this.brain.stop = true;
          this.add('sistema', 'text', '🧠 o brain para depois da resposta em andamento.');
        }
        return true;
      case 'share':
        rec.data.shared = cmd.on;
        this.update({ shared: cmd.on });
        this.add(
          'sistema',
          'text',
          cmd.on
            ? 'Modo compartilhado: cada um vê o que você e o outro disseram.'
            : 'Modo privado: só quem recebe a mensagem vê, e o outro não fica sabendo nem depois.',
        );
        rec.saveNow();
        return true;
      case 'ask': {
        this.setTarget(cmd.newDefault);
        if (cmd.targets.length === 0) {
          this.add('sistema', 'text', `destino padrão agora: /${cmd.newDefault}`);
          rec.saveNow();
          return true;
        }
        const shown = cmd.targets.length > 1 ? `[para os dois] ${cmd.prompt}`.trimEnd() : cmd.prompt;
        this.add('voce', 'text', shown, { images: images.map((img) => path.basename(img.path)) });
        // quem recebe vê o print; o outro (no compartilhado) fica sabendo que ele existiu
        const n = images.length;
        const note = n === 0 ? '' : `[${n === 1 ? 'um print colado' : `${n} prints colados`} pelo usuário]`;
        const text = [cmd.prompt, note].filter(Boolean).join('\n\n');
        const data = rec.data;
        const shared = data.shared;
        const msgIndex = this.log.userMessage(cmd.targets, text, shared);
        const turnIds = cmd.targets.map((id) => newTurn(data, id, text));
        rec.saveNow(); // a sua mensagem fica gravada ANTES de sair para os agentes
        cmd.targets.forEach((id, i) => this.runTurn(id, turnIds[i], text, shared, { msgIndex, images }));
        return true;
      }
    }
  }

  /**
   * O seletor da janela: troca o modelo, o esforço ou o modo rápido de um deles, sem abrir turno. Só o que ele
   * oferece. Trocar de modelo leva junto o que o novo não tem: o esforço vai para o padrão dele, e o rápido desliga.
   * O que ficou (ou por que não trocou) aparece na conversa. As trocas de cada um vão em fila.
   */
  setModel(id: AgentId, choice: ModelChoice): Promise<void> {
    return this.modelQueues[id](() => this.applyModel(id, choice));
  }

  private async applyModel(id: AgentId, choice: ModelChoice): Promise<void> {
    const agent = this.agents[id];
    const fail = (why: string) => this.add('sistema', 'error', `não troquei o modelo do ${agent.name}: ${why}`);
    const target = choice.model === undefined ? currentModel(agent.models, agent.stats) : agent.models.find((m) => m.id === choice.model);
    if (!target) return fail(choice.model === undefined ? 'a lista de modelos dele ainda não carregou' : `ele não oferece ${choice.model}`);
    if (choice.effort !== undefined && !target.efforts.includes(choice.effort)) {
      return fail(`o ${target.name} não tem o esforço ${choice.effort}`);
    }
    if (choice.fast === true && !target.fast) return fail(`o ${target.name} não tem modo rápido`);
    const next = { ...choice };
    if (choice.model !== undefined) {
      const { effort, fast } = agent.stats;
      if (next.effort === undefined && effort && !target.efforts.includes(effort) && target.defaultEffort) {
        next.effort = target.defaultEffort;
      }
      if (next.fast === undefined && fast && !target.fast) next.fast = false;
    }
    try {
      await agent.setModel(next);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    this.add('sistema', 'text', `modelo do ${agent.name} agora: ${modelLabel(agent.models, agent.stats)}`);
  }

  /**
   * O botão Parar da janela: para só ele. O turno em andamento (do duo, ou um que ele abriu sozinho) termina sem
   * resposta, e as mensagens na fila dele saem. O outro segue, e a conversa fica: a próxima mensagem continua nela.
   */
  async interrupt(id: AgentId): Promise<void> {
    const agent = this.agents[id];
    if (this.state.stopping[id]) return; // já pediu: espera o turno fechar
    const running = this.state.runningSince[id] !== null;
    const queued = this.state.busy[id] - (this.running[id].duo ? 1 : 0);
    if (!running && queued === 0) {
      this.add('sistema', 'error', `o ${agent.name} não está rodando nada.`);
      return;
    }
    const epoch = this.session;
    const mine = ++this.cut[id];
    for (const t of this.rec.data.turns) if (t.agent === id && t.status === 'pending') t.status = 'cancelled';
    this.rec.saveNow();
    const what = [
      running ? 'o que ele estava fazendo' : '',
      queued === 1 ? 'a mensagem na fila dele' : queued > 1 ? `as ${queued} mensagens na fila dele` : '',
    ];
    this.add('sistema', 'text', `você parou o ${agent.name}: ${what.filter(Boolean).join(' e ')}. A conversa continua.`);
    for (const stop of [...this.onCut[id]]) stop(); // quem esperava a resposta dele fica sabendo já
    if (!running) return;
    for (const part of ['duo', 'own'] as const) if (this.running[id][part]) this.stopParts[id].add(part);
    this.update({ stopping: { ...this.state.stopping, [id]: true } });
    try {
      await agent.interrupt();
    } catch (e) {
      // o /novo derrubou o processo, ou você já parou ele de novo: o erro não é deste parar
      if (this.session !== epoch || this.cut[id] !== mine) return;
      this.stopParts[id].clear();
      this.update({ stopping: { ...this.state.stopping, [id]: false } });
      this.add('sistema', 'error', `não consegui parar o ${agent.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Responde a um pedido da fila. Numa pergunta com opções, ok = responder (com `answers`) e não = não quis responder.
   * false = não valeu: ele já não espera (respondido em outra tela, ou cancelado), ou as respostas não servem às perguntas.
   */
  answer(askId: number, ok: boolean, answers?: unknown): boolean {
    const ask = this.state.asks.find((a) => a.id === askId);
    const reply = this.answers.get(askId);
    if (!ask || !reply) return false;
    if (ask.questions && ok) {
      const clean = cleanAnswers(ask.questions, answers);
      if (!clean) return false;
      // inteira, sem corte: é o registro do que você respondeu (fica na conversa gravada)
      const said = ask.questions.map((q) => `${q.question} → ${clean[q.question]}`).join(' · ');
      this.add(ask.who, 'tool', `você respondeu: ${said}`);
      reply({ answers: clean });
      return true;
    }
    const what = ask.questions ? 'você não quis responder' : ok ? 'você permitiu' : 'você negou';
    this.add(ask.who, ok ? 'tool' : 'error', `${what}: ${truncate(ask.text)}`);
    reply(ok);
    return true;
  }

  /**
   * Responde ao pedido da vez pelo que você digitou. Permissão: só s ou n. Pergunta: o número da opção, o nome dela ou
   * um texto seu (e n para não responder). O que não decide nada não vale, e ele pergunta de novo.
   */
  answerText(value: string): void {
    const ask = this.state.asks[0];
    if (!ask) return;
    const reply = value.trim().toLowerCase();
    if (ask.questions) {
      const [only] = ask.questions;
      // "n" responde quando é o nome de uma opção: numa pergunta de sim ou não, "Não" é uma resposta
      const isOption = ask.questions.length === 1 && only.options.some((o) => o.label.trim().toLowerCase() === reply);
      if (NO.includes(reply) && !isOption) {
        this.answer(ask.id, false);
        return;
      }
      const answers = answersFromText(ask.questions, value);
      if (!answers) {
        const how = 'o número da opção, o nome dela ou um texto seu';
        this.add(
          'sistema',
          'error',
          ask.questions.length > 1
            ? `responda as ${ask.questions.length} perguntas separadas por ";" (${how}), ou n para não responder.`
            : `responda com ${how}, ou n para não responder.`,
        );
        return;
      }
      this.answer(ask.id, true, answers);
      return;
    }
    const ok = YES.includes(reply) ? true : NO.includes(reply) ? false : null;
    if (ok === null) {
      this.add('sistema', 'error', 'responda s para permitir ou n para negar.');
      return;
    }
    this.answer(ask.id, ok);
  }
}
