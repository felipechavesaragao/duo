import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/core.js';
import { blocksOf, stepStatus } from '../web/blocks.js';

let id = 0;
const line = (e: Omit<Entry, 'id'>): Entry => ({ ...e, id: ++id });

describe('janela: blocos da conversa', () => {
  it('o fim vai para o passo dele; o nome que a linha escondida levava passa para a próxima do mesmo agente', () => {
    const blocks = blocksOf([
      line({ who: 'claude', kind: 'tool', text: '$ npm test', label: true, step: { id: 's1', full: '$ npm test' } }),
      line({ who: 'codex', kind: 'text', text: 'enquanto isso', label: true }),
      // o fim do s1 chega depois do Codex: leva o nome (mudou quem falava), mas não aparece
      line({ who: 'claude', kind: 'tool', text: '  ↳ saiu com código 1', label: true, result: { of: 's1', ok: false, exitCode: 1 } }),
      line({ who: 'claude', kind: 'text', text: 'falhou um teste', label: false }),
      // o fim que deu certo de um passo que não está na tela também não aparece
      line({ who: 'codex', kind: 'tool', text: '  ↳ ok', label: true, result: { of: 'antes', ok: true } }),
      line({ who: 'codex', kind: 'text', text: 'vi', label: false }),
    ]);
    expect(blocks).toHaveLength(4);
    const [group, codex, claude, codex2] = blocks;
    if (!('tools' in group)) throw new Error('o passo devia virar um grupo');
    expect(group.tools).toHaveLength(1);
    expect(group.tools[0].result).toEqual({ of: 's1', ok: false, exitCode: 1 });
    expect(stepStatus(group.tools[0])).toEqual({ mark: '✗', tone: 'fail', why: 'código 1' });
    expect('entry' in codex && codex.entry.text).toBe('enquanto isso');
    expect('entry' in claude && claude.entry).toMatchObject({ text: 'falhou um teste', label: true });
    expect('entry' in codex2 && codex2.entry).toMatchObject({ text: 'vi', label: true });
  });
});
