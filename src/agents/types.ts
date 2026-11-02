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

/** O que o rodapé mostra de cada um. */
export interface AgentStats {
  /** modelo em uso, como o CLI informou; undefined = ainda não sabe (antes da primeira mensagem) */
  model?: string;
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
   */
  onOwnTurnEvent?: EmitFn;
  onOwnTurnReply?: (text: string) => void;
  /** mensagem que entrou na conversa por fora do duo: você digitou no app, pelo Remote Control */
  onRemoteMessage?: (text: string) => void;
  /** aviso sobre o agente fora de qualquer turno (o Remote Control ligou, ou não ligou) */
  onNotice?: EmitFn;
  /** Manda uma mensagem. Resolve com a resposta final em texto. Mensagens são enfileiradas. */
  send(prompt: string, emit: EmitFn): Promise<string>;
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
