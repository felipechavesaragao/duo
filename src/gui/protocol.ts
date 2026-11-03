import type { AgentCommand, AgentId, AgentModel, ImageInput, ModelChoice } from '../agents/types.js';
import type { DuoState, Entry } from '../core.js';

/** O que passa entre o duo e a janela. Só tipos: a janela importa sem levar nada de Node. */

/** Tudo de uma vez: ao conectar, e de novo a cada reconexão. */
export interface Snapshot extends DuoState {
  names: Record<AgentId, string>;
  cwd: string;
}

/** O estado que muda sem linha nova na tela. As listas de comandos e de modelos vão à parte (são grandes e quase não mudam). */
export type Status = Pick<
  DuoState,
  | 'target'
  | 'shared'
  | 'busy'
  | 'asks'
  | 'stats'
  | 'brain'
  | 'tasks'
  | 'runningSince'
  | 'lastSignal'
  | 'tools'
  | 'peerWait'
  | 'stopping'
>;

/** Eventos do servidor (SSE em /events): o nome do evento e o que vai no `data`, em JSON. */
export interface ServerEvents {
  snapshot: Snapshot;
  entry: Entry;
  clear: null;
  status: Status;
  commands: Record<AgentId, AgentCommand[]>;
  models: Record<AgentId, AgentModel[]>;
  /** /sair: o duo encerrou */
  quit: null;
}

/** Um print colado na caixa de texto, em base64 (sem o prefixo `data:`). */
export interface PastedImage {
  mediaType: ImageInput['mediaType'];
  data: string;
}

/** POST /api/submit */
export interface SubmitBody {
  text: string;
  images?: PastedImage[];
}

/** POST /api/modelo: o seletor da janela. O resultado aparece na conversa. */
export interface ModelBody extends ModelChoice {
  agent: AgentId;
}

/** POST /api/parar: o botão Parar de um agente no painel. O resultado aparece na conversa. */
export interface StopBody {
  agent: AgentId;
}

/** POST /api/answer */
export interface AnswerBody {
  id: number;
  ok: boolean;
}
