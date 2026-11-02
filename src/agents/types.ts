export type AgentId = 'claude' | 'codex';

/** O que um agente avisa enquanto trabalha. */
export type AgentEvent =
  | { kind: 'text'; text: string } // um trecho de resposta pronto
  | { kind: 'tool'; text: string } // atividade: comando, edição de arquivo, busca...
  | { kind: 'error'; text: string }; // aviso de erro que não encerra o turno

export type EmitFn = (event: AgentEvent) => void;

export interface Agent {
  readonly id: AgentId;
  readonly name: string;
  /** id da conversa no CLI de origem (session_id do Claude / thread_id do Codex); undefined = ainda não começou */
  readonly resumeId: string | undefined;
  /** chamado assim que o id da conversa aparece ou muda: o duo grava na hora */
  onSessionId?: (id: string) => void;
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

/** Fila simples: garante uma mensagem por vez para cada agente. */
export function createQueue() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const p = chain.then(job, job);
    chain = p.catch(() => undefined);
    return p;
  };
}

export function truncate(s: string, max = 120): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}
