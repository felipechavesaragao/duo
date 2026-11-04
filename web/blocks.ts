// Como a conversa vira blocos na janela: as ações seguidas de um agente num grupo, e o fim de cada passo pendurado
// no passo dele. Sem DOM: o teste importa daqui.
import { STEP_STOPPED, STEP_UNFINISHED, type StepResult } from '../src/agents/types.js';
import type { Entry } from '../src/core.js';
import type { Who } from '../src/persist.js';

/** Uma ação na conversa e, quando é um passo que já acabou, como ele acabou. */
export type StepRow = { entry: Entry; result?: StepResult };

export type Block = { key: number; entry: Entry } | { key: number; who: Who; label: boolean; tools: StepRow[] };

/**
 * Ações seguidas do mesmo agente viram um grupo só, que abre com um clique. O fim de cada passo chega numa linha
 * própria, depois dele: ela não aparece, vai para a linha do passo (o ✓, ou o motivo de não ter dado certo).
 */
export function blocksOf(entries: Entry[]): Block[] {
  const out: Block[] = [];
  /** os passos ainda sem fim, pelo id: o fim vai para o último que apareceu com esse id */
  const open = new Map<string, StepRow>();
  /** o fim escondido abria a vez do agente: a próxima linha dele leva o nome no lugar */
  let carry: Who | undefined;
  for (const raw of entries) {
    const end = raw.result;
    const row = end && open.get(end.of);
    if (end && (row || end.ok)) {
      if (row) {
        row.result = end;
        open.delete(end.of);
      }
      if (raw.label) carry = raw.who;
      continue;
    }
    const entry = carry === raw.who && !raw.label ? { ...raw, label: true } : raw;
    carry = undefined;
    const prev = out.at(-1);
    if (entry.kind === 'tool') {
      const step: StepRow = { entry };
      if (entry.step) open.set(entry.step.id, step);
      if (prev && 'tools' in prev && prev.who === entry.who && !entry.label) {
        prev.tools.push(step);
        continue;
      }
      out.push({ key: entry.id, who: entry.who, label: entry.label, tools: [step] });
    } else {
      out.push({ key: entry.id, entry });
    }
  }
  return out;
}

/** O que a linha de um passo mostra de como ele acabou; undefined = não é passo, ou ainda não acabou. */
export function stepStatus({ entry, result }: StepRow): { mark: string; tone: 'ok' | 'fail' | 'off'; why?: string } | undefined {
  if (!entry.step || !result) return undefined;
  if (result.ok) {
    const files = result.files ?? [];
    return { mark: '✓', tone: 'ok', why: files.length === 1 ? files[0].change : files.length ? `${files.length} arquivos` : undefined };
  }
  if (result.exitCode !== undefined) return { mark: '✗', tone: 'fail', why: `código ${result.exitCode}` };
  if (result.note === STEP_STOPPED || result.note === STEP_UNFINISHED) return { mark: '–', tone: 'off', why: result.note };
  return { mark: '✗', tone: 'fail', why: result.note ?? 'falhou' };
}
