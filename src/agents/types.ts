export type AgentId = 'claude' | 'codex';

/** O que um agente avisa enquanto trabalha. */
export type AgentEvent =
  | { kind: 'text'; text: string } // um trecho de resposta pronto
  | { kind: 'tool'; text: string } // atividade: comando, edição de arquivo, busca...
  | { kind: 'error'; text: string }; // aviso de erro que não encerra o turno

export type EmitFn = (event: AgentEvent) => void;

/** A pergunta que o terminal do CLI faria (regra "ask" do settings, modo default...). */
export interface PermissionRequest {
  /** o que ele quer fazer, inteiro: "Bash git push origin master" */
  text: string;
  /** dispara quando o pedido deixa de valer (o processo caiu, o CLI desistiu): ninguém espera mais a resposta */
  signal: AbortSignal;
}

/** Um agente chamando o outro pela ferramenta do duo. */
export interface PeerRequest {
  /** a mensagem para o outro, inteira */
  text: string;
  /** dispara quando ninguém mais espera a resposta (o processo de quem chamou caiu, o CLI desistiu) */
  signal: AbortSignal;
}

/** Um comando do próprio agente (`/nome`), para a lista que aparece quando você digita `@cla /`. */
export interface AgentCommand {
  name: string;
  description: string;
  /** o argumento que ele espera, quando o CLI informa */
  hint?: string;
}

/** Uma imagem que vai junto da mensagem (um print colado na janela), já gravada em disco. */
export interface ImageInput {
  /** caminho do arquivo: o Codex lê por ele, o Claude recebe o conteúdo */
  path: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

/** Algo que o agente pôs para rodar além da resposta: um subagente ou um comando em segundo plano. */
export interface AgentTask {
  id: string;
  kind: 'subagente' | 'comando';
  /** o que ela faz, como o CLI descreveu */
  title: string;
  /** o tipo do subagente (general-purpose, devil-advocate...) ou o modelo dele, quando o CLI informa */
  detail?: string;
  /** o que ela está fazendo agora (o último progresso que o CLI mandou) */
  activity?: string;
  /** quando começou e o último sinal de vida (início ou progresso), em ms desde 1970 */
  startedAt: number;
  lastAt: number;
}

/** Um modelo que o agente oferece, como o próprio CLI informa: o menu do seletor da janela. */
export interface AgentModel {
  /** o que vai para o CLI ao escolher (o Claude aceita apelidos: "opus", "default") */
  id: string;
  /** o modelo em que esse id dá, como o CLI informa o modelo em uso */
  resolved: string;
  name: string;
  description: string;
  /** os níveis de esforço que ele aceita, na ordem do CLI; vazio = não tem esforço para escolher */
  efforts: string[];
  /** o esforço que ele usa quando ninguém escolheu, quando o CLI informa */
  defaultEffort?: string;
  /** tem modo rápido, e o duo consegue ligar */
  fast: boolean;
}

/** O que trocar no seletor da janela: o que fica de fora continua como está. */
export interface ModelChoice {
  model?: string;
  effort?: string;
  fast?: boolean;
}

/** O que o rodapé mostra de cada um. */
export interface AgentStats {
  /** modelo em uso, como o CLI informou; undefined = ainda não sabe (antes da primeira mensagem) */
  model?: string;
  /** o id da lista escolhido no duo (pelo seletor ou pela opção de linha de comando); undefined = o padrão do CLI */
  selected?: string;
  /** esforço em uso; undefined = não sabe, ou o modelo não tem */
  effort?: string;
  /** modo rápido ligado; undefined = não sabe, ou o modelo não tem */
  fast?: boolean;
  /** tokens no contexto da conversa principal, pela última chamada ao modelo (subagentes não contam) */
  contextTokens?: number;
  /** tamanho da janela de contexto do modelo */
  contextWindow?: number;
  /** subagentes rodando agora */
  subagents: number;
}

export interface Agent {
  readonly id: AgentId;
  readonly name: string;
  readonly stats: AgentStats;
  /** chamado a cada mudança em `stats` */
  onStats?: (stats: AgentStats) => void;
  /** comandos do agente (do Claude, os do CLI; do Codex, as skills); vazio até ele subir */
  readonly commands: AgentCommand[];
  /** chamado quando a lista de comandos muda */
  onCommands?: (commands: AgentCommand[]) => void;
  /** os modelos que ele oferece; vazio até ele subir */
  readonly models: AgentModel[];
  /** chamado quando a lista de modelos chega ou muda */
  onModels?: (models: AgentModel[]) => void;
  /**
   * Troca o modelo, o esforço ou o modo rápido, sem abrir turno; vale para as próximas mensagens e para os
   * processos que ele subir depois (o /novo, uma queda). Resolve com `stats` já mostrando o que ficou; rejeita com o
   * motivo. Quem chama manda só o que veio em `models` (o esforço da lista do modelo, o rápido só se ele tem).
   */
  setModel(choice: ModelChoice): Promise<void>;
  /** chamado quando um subagente ou comando em segundo plano começa, dá sinal de vida ou termina: a lista toda */
  onTasks?: (tasks: AgentTask[]) => void;
  /** chamado a cada coisa que chega do processo dele: é o sinal de vida que mostra se ele está travado */
  onSignal?: () => void;
  /** sobe o processo já, sem mandar nada: a lista de comandos carrega antes da primeira mensagem */
  warmUp(): void;
  /** id da conversa no CLI de origem (session_id do Claude / thread_id do Codex); undefined = ainda não começou */
  readonly resumeId: string | undefined;
  /** chamado assim que o id da conversa aparece ou muda: o duo grava na hora */
  onSessionId?: (id: string) => void;
  /** pergunta a você se ele pode fazer algo; resolve true = permitido. Sem ele, o pedido é negado. */
  askPermission?: (req: PermissionRequest) => Promise<boolean>;
  /** fala com o outro agente da janela; resolve com a resposta dele. Sem ele, o agente não ganha a ferramenta. */
  askPeer?: (req: PeerRequest) => Promise<string>;
  /**
   * Turno que o próprio CLI abre, sem mensagem do duo (o Claude é avisado de que um subagente ou comando em
   * segundo plano terminou e continua sozinho): `onOwnTurnEvent` recebe o que ele faz; `onOwnTurnReply`, a resposta.
   * `tasksShared` = o turno foi aberto por tarefas em segundo plano e todas foram lançadas em mensagens no modo
   * compartilhado (true) ou não (false); undefined = não veio de tarefa conhecida. `fromApp` = uma mensagem sua pelo
   * app (`onRemoteMessage` fora de um turno do duo) abriu este turno ou entrou nele. Texto vazio = o turno terminou sem
   * resposta em texto (só ferramenta): não há o que registrar, mas o turno acabou.
   */
  onOwnTurnEvent?: EmitFn;
  onOwnTurnReply?: (text: string, tasksShared?: boolean, fromApp?: boolean) => void;
  /**
   * Mensagem que entrou na conversa por fora do duo: você digitou no app, pelo Remote Control. `inDuoTurn` = ele a
   * leu no meio de um turno do duo, que é quem a responde; senão (ou sem a informação) ela abre (ou entra em) um
   * turno dele.
   */
  onRemoteMessage?: (text: string, inDuoTurn?: boolean) => void;
  /** aviso sobre o agente fora de qualquer turno (o Remote Control ligou, ou não ligou) */
  onNotice?: EmitFn;
  /**
   * Manda uma mensagem. Resolve com a resposta final em texto. Mensagens são enfileiradas. `shared` = o modo do duo
   * em que ela foi (padrão: compartilhado): o agente só guarda, e devolve em `onOwnTurnReply` se uma tarefa lançada
   * nela abrir um turno sozinho. `images` = prints que vão junto da mensagem.
   */
  send(prompt: string, emit: EmitFn, shared?: boolean, images?: ImageInput[]): Promise<string>;
  /** Esquece a conversa: a próxima mensagem começa uma sessão nova. */
  reset(): void;
  /** Encerra processos filhos. */
  dispose(): void;
}

/**
 * A conversa guardada não existe mais no CLI (apagada, outra máquina...). O agente já esqueceu
 * o id, então a próxima mensagem abre uma conversa nova. Só é lançado diante da mensagem exata
 * de "não encontrei" de cada CLI; qualquer outra falha não faz o duo abandonar a conversa.
 */
export class ResumeFailedError extends Error {
  readonly resumeFailed = true;
}

/** Junta a mudança em `stats` e avisa só se algo mudou. */
export function patchStats(agent: Agent & { stats: AgentStats }, patch: Partial<AgentStats>): void {
  const keys = Object.keys(patch) as (keyof AgentStats)[];
  if (keys.every((k) => agent.stats[k] === patch[k])) return;
  Object.assign(agent.stats, patch);
  agent.onStats?.({ ...agent.stats });
}

/** Fila simples: garante uma mensagem por vez para cada agente. */
export function createQueue() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const p = chain.then(job, job);
    chain = p.catch(() => undefined);
    return p;
  };
}

/** Quando continuar e quando parar o vaivém com o outro agente (vai na instrução de cada um). */
export function peerLoopHint(other: string): string {
  return (
    `Numa revisão ou discussão com o ${other}, persista no vaivém: resolva o que ele apontou (corrija, ou rebata com ` +
    `prova) e chame de novo, até ele concordar sem ressalvas (convergiram) ou ficar claro que não vão convergir; aí ` +
    `pare e leve a divergência ao usuário. Não pare no meio esperando o usuário mandar continuar. Se o projeto tem um ` +
    `protocolo próprio de revisão (rodadas, limites), siga o dele.`
  );
}

export function truncate(s: string, max = 120): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}
