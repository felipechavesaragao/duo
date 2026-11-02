import { describe, expect, it } from 'vitest';
import { BRAIN_MAX, brainOpening, brainReview, brainVerdict, otherOf } from '../src/brain.js';

describe('brainVerdict', () => {
  it('lê a marca da última linha', () => {
    expect(brainVerdict('concordo com tudo\n[CONCORDO]')).toBe('concordo');
    expect(brainVerdict('muda o nome\n\n[DISCORDO]\n')).toBe('discordo');
  });
  it('aceita negrito, código, minúsculas e ponto final', () => {
    expect(brainVerdict('ok\n**[CONCORDO]**')).toBe('concordo');
    expect(brainVerdict('ok\n`[concordo]`')).toBe('concordo');
    expect(brainVerdict('ok\n[ CONCORDO ].')).toBe('concordo');
  });
  it('sem marca na última linha não é acordo', () => {
    expect(brainVerdict('Concordo com tudo.')).toBeNull();
    expect(brainVerdict('[CONCORDO]\nmas mudaria o nome')).toBeNull(); // a marca precisa fechar a resposta
    expect(brainVerdict('[CONCORDO] em parte')).toBeNull();
    expect(brainVerdict('')).toBeNull();
  });
});

describe('textos do brain', () => {
  it('a abertura leva a pergunta, avisa quem avalia e o limite', () => {
    const t = brainOpening('claude', 'qual banco usar?');
    expect(t).toContain('Codex vai avaliar');
    expect(t).toContain(`no máximo ${BRAIN_MAX} respostas`);
    expect(t.endsWith('qual banco usar?')).toBe(true);
  });
  it('a avaliação aponta a resposta do outro e as duas marcas', () => {
    const t = brainReview('codex');
    expect(t).toContain('A última resposta do Claude');
    expect(t).toContain('[CONCORDO]');
    expect(t).toContain('[DISCORDO]');
  });
  it('otherOf troca de lado', () => {
    expect(otherOf('claude')).toBe('codex');
    expect(otherOf('codex')).toBe('claude');
  });
});
