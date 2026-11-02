import { describe, expect, it } from 'vitest';
import { parseInput } from '../src/router.js';

describe('parseInput', () => {
  it('sem prefixo vai para o destino padrão', () => {
    expect(parseInput('oi', 'codex')).toEqual({ type: 'ask', targets: ['codex'], prompt: 'oi', newDefault: 'codex' });
  });
  it('@todos manda para os dois e vira o padrão', () => {
    expect(parseInput('@todos  revisem', 'claude')).toEqual({
      type: 'ask',
      targets: ['claude', 'codex'],
      prompt: 'revisem',
      newDefault: 'todos',
    });
  });
  it('atalhos @c, @x, @cla e @fog', () => {
    expect(parseInput('@x faz', 'claude')).toMatchObject({ targets: ['codex'] });
    expect(parseInput('@C faz', 'codex')).toMatchObject({ targets: ['claude'] });
    expect(parseInput('@cla faz', 'codex')).toMatchObject({ targets: ['claude'] });
    expect(parseInput('@Fog faz', 'claude')).toMatchObject({ targets: ['codex'] });
    expect(parseInput('@fog', 'claude')).toEqual({ type: 'ask', targets: [], prompt: '', newDefault: 'codex' });
  });
  it('@codex sozinho só troca o padrão', () => {
    expect(parseInput('@codex', 'claude')).toEqual({ type: 'ask', targets: [], prompt: '', newDefault: 'codex' });
  });
  it('pontuação grudada no nome não quebra a menção', () => {
    expect(parseInput('@fog?', 'claude')).toMatchObject({ type: 'ask', targets: ['codex'], prompt: '?' });
    expect(parseInput('@codex?', 'claude')).toMatchObject({ type: 'ask', targets: ['codex'], prompt: '?' });
    expect(parseInput('@codex, revisa isso', 'claude')).toMatchObject({ targets: ['codex'], prompt: 'revisa isso' });
    expect(parseInput('@cla: oi', 'codex')).toMatchObject({ targets: ['claude'], prompt: 'oi' });
    expect(parseInput('@todos!', 'claude')).toMatchObject({ targets: ['claude', 'codex'], prompt: '!' });
  });
  it('mensagem com várias linhas', () => {
    expect(parseInput('@claude linha1\nlinha2', 'codex')).toMatchObject({ prompt: 'linha1\nlinha2' });
  });
  it('menção desconhecida e comando desconhecido', () => {
    expect(parseInput('@gpt oi', 'claude')).toMatchObject({ type: 'invalid' });
    expect(parseInput('/xyz', 'claude')).toMatchObject({ type: 'invalid' });
  });
  it('/privado e /compartilhado', () => {
    expect(parseInput('/privado', 'claude')).toEqual({ type: 'share', on: false });
    expect(parseInput('/compartilhado', 'claude')).toEqual({ type: 'share', on: true });
  });
  it('vazio não faz nada', () => {
    expect(parseInput('   ', 'claude')).toBeNull();
  });
});
