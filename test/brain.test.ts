import { describe, expect, it } from 'vitest';
import {
  BRAIN_MAX,
  brainAlone,
  brainConfront,
  brainMissing,
  brainOpener,
  brainOpening,
  brainReview,
  brainVerdict,
  otherOf,
} from '../src/brain.js';

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
    expect(brainVerdict('depende\n[FALTA: o volume de dados]')).toBeNull(); // dizer que falta não é concordar
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

describe('brainMissing (jeito novo)', () => {
  it('a informação que falta, da última linha', () => {
    expect(brainMissing('depende\n[FALTA: o volume de dados]')).toBe('o volume de dados');
    expect(brainMissing('depende\n\n  [ falta :  o prazo ]  \n')).toBe('o prazo');
  });
  it('negrito ou código em volta saem; o texto de dentro fica como está', () => {
    expect(brainMissing('x\n**[FALTA: o nome_da_tabela]**')).toBe('o nome_da_tabela');
    expect(brainMissing('x\n`[FALTA: o *glob* usado]`.')).toBe('o *glob* usado');
    expect(brainMissing('x\n[FALTA: o valor de lista[0]]')).toBe('o valor de lista[0]');
  });
  it('sem a marca fechando a resposta, ou sem dizer o que falta: null', () => {
    expect(brainMissing('falta o volume de dados')).toBeNull();
    expect(brainMissing('[FALTA: o prazo]\nmas dá para chutar')).toBeNull();
    expect(brainMissing('[FALTA: o prazo] e o custo')).toBeNull();
    expect(brainMissing('[FALTA:  ]')).toBeNull();
    expect(brainMissing('[FALTA]')).toBeNull();
    expect(brainMissing('ok\n[CONCORDO]')).toBeNull();
  });
});

describe('textos do brain (jeito novo)', () => {
  it('quem abre o confronto é o destino padrão; com /todos, o Claude', () => {
    expect(brainOpener('claude')).toBe('claude');
    expect(brainOpener('codex')).toBe('codex');
    expect(brainOpener('todos')).toBe('claude');
  });
  it('a abertura leva a pergunta, diz que cada um responde sem ver o outro, o confronto, a marca de falta e o limite', () => {
    const t = brainAlone('claude', 'qual banco usar?');
    expect(t).toContain('Você e o Codex vão responder a esta pergunta cada um por si');
    expect(t).toContain('nenhum dos dois vê a resposta do outro');
    expect(t).toContain('Depois vem o confronto');
    expect(t).toContain('[FALTA: <a informação>]');
    expect(t).toContain(`no máximo ${BRAIN_MAX} respostas no total, contando estas duas`);
    expect(t.endsWith('qual banco usar?')).toBe(true);
    expect(brainAlone('codex', 'x')).toContain('Você e o Claude');
  });
  it('o confronto leva a resposta avaliada no próprio prompt, e as três marcas', () => {
    const t = brainConfront('codex', 'use Postgres\n[FALTA: o orçamento]');
    expect(t).toContain('Confronto');
    expect(t).toContain('A resposta do Claude que você avalia é a última dele no brain');
    expect(t).toContain('de fora do brain, ela não conta');
    expect(t).toContain('=====\nuse Postgres\n[FALTA: o orçamento]\n=====\nAvalie essa resposta.');
    expect(t).toContain('[CONCORDO]');
    expect(t).toContain('[DISCORDO]');
    expect(t).toContain('[FALTA: <a informação>]');
    expect(t).toContain('falta uma informação e você concorda que falta');
  });
  it('resposta longa vai cortada como no contexto: o começo e o fim', () => {
    const long = `COMEÇO${'x'.repeat(10_000)}FIM`;
    const t = brainConfront('claude', long);
    expect(t).toContain('COMEÇO');
    expect(t).toContain('FIM\n=====');
    expect(t).toContain('caracteres cortados');
    expect(t.length).toBeLessThan(6_000);
  });
});
