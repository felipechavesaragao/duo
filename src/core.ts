import path from 'node:path';
import {
  createQueue,
  ResumeFailedError,
  truncate,
  type Agent,
  type AgentCommand,
  type AgentId,
  type AgentStats,
  type AgentTask,
  type EmitFn,
  type ImageInput,
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
  /** tem um /brain rodando */
  brain: boolean;
  /** o que cada um pôs para rodar em segundo plano (subagentes, comandos) */
  tasks: Record<AgentId, AgentTask[]>;
  /** desde quando o turno de cada um está rodando, em ms (null = parado) */
  runningSince: Record<AgentId, number | null>;
  /** quando chegou a última coisa do processo de cada um, em ms (null = nada ainda): sem sinal há muito = travado? */
  lastSignal: Record<AgentId, number | null>;
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
}

/** De quanto em quanto tempo o último sinal é atualizado: chega coisa do processo o tempo todo. */
const SIGNAL_STEP_MS = 1000;

const YES = ['s', 'sim'];
const NO = ['n', 'não', 'nao'];

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
  /** Chamadas em andamento de cada um ao outro, pela ferramenta do duo. */
  private readonly calling: Record<AgentId, number> = { claude: 0, codex: 0 };
  /** O brain em andamento (só um por vez). `stop` = /parar: encerra depois da resposta em andamento. */
  private brain: { stop: boolean } | null = null;
  /** quem responde cada pedido de permissão da fila */
  private readonly answers = new Map<number, (ok: boolean) => void>();
  private started = false;
  private state: DuoState;
  private readonly listeners = new Set<(ev: DuoEvent) => void>();

  constructor({ agents, recorder, resumed = false }: DuoOptions) {
    this.agents = agents;
    this.rec = recorder ?? new Recorder(newSessionData(process.cwd()));
    this.resumed = resumed;
    this.log = new SharedLog(this.rec.data.log);
    // Na retomada, a tela volta como estava.
    const restored = this.rec.data.screen.map((e) => ({ ...e, id: this.nextId++ }));
    this.lastWho = restored.at(-1)?.who ?? null;
    this.state = {
      entries: restored,
      target: this.rec.data.target,
      shared: this.rec.data.shared,
      busy: { claude: 0, codex: 0 },
      asks: [],
      stats: { claude: { ...agents.claude.stats }, codex: { ...agents.codex.stats } },
      commands: { claude: agents.claude.commands, codex: agents.codex.commands },
      brain: false,
      tasks: { claude: [], codex: [] },
      runningSince: { claude: null, codex: null },
      lastSignal: { claude: null, codex: null },
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

  private add(who: Who, kind: Entry['kind'], text: string, images?: string[]): void {
    const label = this.lastWho !== who;
    this.lastWho = who;
    const entry: ScreenEntry = images?.length ? { who, kind, text, label, images } : { who, kind, text, label };
    this.rec.data.screen.push(entry);
    this.rec.saveSoon();
    const shown = { ...entry, id: this.nextId++ };
    this.update({ entries: [...this.state.entries, shown] }, { type: 'entry', entry: shown });
  }

  private setBusy(id: AgentId, delta: number): void {
    this.update({ busy: { ...this.state.busy, [id]: this.state.busy[id] + delta } });
  }

  /** O turno dele (o da fila, ou um que ele abriu sozinho) começou ou acabou. Começar conta como sinal. */
  private setRunning(id: AgentId, part: 'duo' | 'own', value: boolean): void {
    this.running[id][part] = value;
    const on = this.running[id].duo || this.running[id].own;
    if (on === (this.state.runningSince[id] !== null)) return;
    const now = Date.now();
    this.update({
      runningSince: { ...this.state.runningSince, [id]: on ? now : null },
      ...(on ? { lastSignal: { ...this.state.lastSignal, [id]: now } } : {}),
    });
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
      agent.onTasks = (list) => this.update({ tasks: { ...this.state.tasks, [agent.id]: list } });
      agent.onSignal = () => this.signal(agent.id);
      // turno que ele abriu sozinho (terminou um subagente em segundo plano): aparece e entra na janela como os outros
      agent.onOwnTurnEvent = (ev) => {
        this.own[agent.id] ??= { shared: rec.data.shared };
        this.setRunning(agent.id, 'own', true);
        this.add(agent.id, ev.kind, ev.text);
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
      agent.askPermission = ({ text, signal }) =>
        new Promise<boolean>((resolve) => {
          const ask: Ask = { id: this.nextAsk++, who: agent.id, text };
          const drop = () => {
            this.answers.delete(ask.id);
            this.update({ asks: this.state.asks.filter((a) => a !== ask) });
          };
          const cancel = () => {
            drop();
            this.add(agent.id, 'error', `pedido de permissão cancelado: ${truncate(text)}`);
            resolve(false);
          };
          this.answers.set(ask.id, (ok) => {
            signal.removeEventListener('abort', cancel);
            drop();
            resolve(ok);
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
        // Se o outro está esperando este, a chamada ficaria na fila atrás do turno que espera: os dois travariam.
        if (this.calling[to] > 0) {
          throw new Error(
            `o ${agents[to].name} está esperando uma resposta sua (ele te chamou); chamá-lo agora travaria os dois. ` +
              `Termine esta resposta primeiro; se precisar perguntar algo a ele, pergunte nela.`,
          );
        }
        this.calling[agent.id]++;
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
          const answer = await this.runTurn(to, turnId, prompt, sharedNow, { msgIndex, call: { from: agent.id, signal } });
          if (answer === null) {
            throw new Error(`o ${agents[to].name} não conseguiu responder; o erro aparece na janela do duo`);
          }
          return answer;
        } finally {
          this.calling[agent.id]--;
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
    this.setBusy(id, +1);
    return this.queues[id](async (): Promise<string | null> => {
      for (let attempt = 0; ; attempt++) {
        if (stale()) return null;
        const prepared = myLog.prepare(id, text, sharedTurn, msgIndex, call?.from);
        setTurn(data, turnId, 'running');
        rec.saveNow();
        try {
          const emit: EmitFn = (ev) => {
            if (!stale()) this.add(id, ev.kind, ev.text);
          };
          this.setRunning(id, 'duo', true);
          const answer = await agents[id].send(prepared.prompt, emit, sharedTurn, images);
          if (stale()) return null;
          myLog.delivered(id, prepared);
          // quem chamou só recebeu a resposta se ainda esperava; senão ela vai no contexto dele
          myLog.agentReply(id, answer, sharedTurn, call && !call.signal.aborted ? call.from : undefined);
          setTurn(data, turnId, 'done');
          return answer;
        } catch (e) {
          if (stale()) return null; // o /novo derrubou o processo: o erro não é desta conversa
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
        const answer =
          n === 1
            ? await this.runTurn(who, turnId, brainOpening(who, question), true, { msgIndex })
            : await this.runTurn(who, turnId, brainReview(who), true);
        if (this.session !== epoch) return; // /novo: o brain era da conversa anterior
        if (answer === null) {
          this.add('sistema', 'error', `🧠 brain parou: a resposta do ${name(who)} falhou.`);
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
        this.update({ brain: false, runningSince: { claude: null, codex: null } });
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
        this.add('voce', 'text', shown, images.map((img) => path.basename(img.path)));
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

  /** Responde a um pedido da fila. false = ele já não espera (respondido em outra tela, ou cancelado). */
  answer(askId: number, ok: boolean): boolean {
    const ask = this.state.asks.find((a) => a.id === askId);
    const reply = this.answers.get(askId);
    if (!ask || !reply) return false;
    this.add(ask.who, ok ? 'tool' : 'error', `${ok ? 'você permitiu' : 'você negou'}: ${truncate(ask.text)}`);
    reply(ok);
    return true;
  }

  /** Responde ao pedido da vez pelo que você digitou. Só s ou n: qualquer outra coisa não decide nada e ele pergunta de novo. */
  answerText(value: string): void {
    const ask = this.state.asks[0];
    if (!ask) return;
    const reply = value.trim().toLowerCase();
    const ok = YES.includes(reply) ? true : NO.includes(reply) ? false : null;
    if (ok === null) {
      this.add('sistema', 'error', 'responda s para permitir ou n para negar.');
      return;
    }
    this.answer(ask.id, ok);
  }
}
