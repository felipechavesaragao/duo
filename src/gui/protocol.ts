import type { AgentCommand, AgentId, ImageInput } from '../agents/types.js';
import type { DuoState, Entry } from '../core.js';

/** O que passa entre o duo e a janela. Só tipos: a janela importa sem levar nada de Node. */

/** Tudo de uma vez: ao conectar, e de novo a cada reconexão. */
export interface Snapshot extends DuoState {
  names: Record<AgentId, string>;
  cwd: string;
}

/** O estado que muda sem linha nova na tela. A lista de comandos vai à parte (é grande e quase não muda). */
export type Status = Pick<
  DuoState,
  'target' | 'shared' | 'busy' | 'asks' | 'stats' | 'brain' | 'tasks' | 'runningSince' | 'lastSignal'
>;

/** Eventos do servidor (SSE em /events): o nome do evento e o que vai no `data`, em JSON. */
export interface ServerEvents {
  snapshot: Snapshot;
  entry: Entry;
  clear: null;
  status: Status;
  commands: Record<AgentId, AgentCommand[]>;
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

/** POST /api/answer */
export interface AnswerBody {
  id: number;
  ok: boolean;
}
