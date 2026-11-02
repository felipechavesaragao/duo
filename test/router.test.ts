import { describe, expect, it } from 'vitest';
import { ALIASES, COMMAND_NAMES, COMMANDS, parseInput } from '../src/router.js';

describe('parseInput com / (principal)', () => {
  it('/fog, /cla, /todos e os nomes longos mandam para quem foi chamado', () => {
    expect(parseInput('/fog revisa', 'claude')).toEqual({ type: 'ask', targets: ['codex'], prompt: 'revisa', newDefault: 'codex' });
    expect(parseInput('/Cla faz', 'codex')).toMatchObject({ targets: ['claude'], prompt: 'faz' });
    expect(parseInput('/todos opinem', 'claude')).toMatchObject({ targets: ['claude', 'codex'], newDefault: 'todos' });
    expect(parseInput('/claude oi', 'codex')).toMatchObject({ targets: ['claude'] });
    expect(parseInput('/codex oi', 'claude')).toMatchObject({ targets: ['codex'] });
    expect(parseInput('/x oi', 'claude')).toMatchObject({ targets: ['codex'] });
    expect(parseInput('/ambos oi', 'claude')).toMatchObject({ targets: ['claude', 'codex'] });
  });
  it('/fog sozinho só troca o padrão', () => {
    expect(parseInput('/fog', 'claude')).toEqual({ type: 'ask', targets: [], prompt: '', newDefault: 'codex' });
  });
  it('comando do agente depois do nome vai inteiro para ele', () => {
    expect(parseInput('/cla /init', 'codex')).toMatchObject({ targets: ['claude'], prompt: '/init' });
    expect(parseInput('@fog /review agora', 'claude')).toMatchObject({ targets: ['codex'], prompt: '/review agora' });
  });
  it('pontuação grudada no nome não quebra', () => {
    expect(parseInput('/fog?', 'claude')).toMatchObject({ targets: ['codex'], prompt: '?' });
    expect(parseInput('/codex, revisa isso', 'claude')).toMatchObject({ targets: ['codex'], prompt: 'revisa isso' });
  });
  it('os comandos do duo continuam valendo', () => {
    expect(parseInput('/sair', 'claude')).toEqual({ type: 'quit' });
    expect(parseInput('/novo', 'claude')).toEqual({ type: 'new' });
    expect(parseInput('/limpar', 'claude')).toEqual({ type: 'clear' });
    expect(parseInput('/ajuda', 'claude')).toEqual({ type: 'help' });
  });
  it('desconhecido avisa e não manda nada: /xyz, / sozinho, nomes herdados do objeto', () => {
    expect(parseInput('/xyz', 'claude')).toMatchObject({ type: 'invalid' });
    expect(parseInput('/init', 'claude')).toMatchObject({ type: 'invalid' }); // comando do agente precisa do nome antes
    expect(parseInput('/', 'claude')).toMatchObject({ type: 'invalid' });
    expect(parseInput('/constructor', 'claude')).toMatchObject({ type: 'invalid' });
    expect(parseInput('@toString oi', 'claude')).toMatchObject({ type: 'invalid' });
  });
  it('⛔ nenhum comando do duo tem o nome de um apelido', () => {
    expect(COMMAND_NAMES).toEqual(expect.arrayContaining([...Object.keys(COMMANDS), 'brain']));
    expect(COMMAND_NAMES.filter((name) => Object.hasOwn(ALIASES, name))).toEqual([]);
  });
});

describe('/brain e /parar', () => {
  it('/brain /cla e /brain /fog dizem quem começa', () => {
    expect(parseInput('/brain /cla qual banco usar?', 'codex')).toEqual({ type: 'brain', first: 'claude', prompt: 'qual banco usar?' });
    expect(parseInput('/brain /fog revisa o plano', 'claude')).toEqual({ type: 'brain', first: 'codex', prompt: 'revisa o plano' });
    expect(parseInput('/brain @codex, revisa', 'claude')).toMatchObject({ first: 'codex', prompt: 'revisa' });
    expect(parseInput('/BRAIN /Claude oi\nlinha 2', 'codex')).toMatchObject({ first: 'claude', prompt: 'oi\nlinha 2' });
  });
  it('sem quem começa, com /todos ou sem pergunta: avisa como usar', () => {
    expect(parseInput('/brain', 'claude')).toMatchObject({ type: 'invalid' });
    expect(parseInput('/brain qual banco?', 'claude')).toMatchObject({ type: 'invalid' });
    expect(parseInput('/brain /todos qual banco?', 'claude')).toMatchObject({ type: 'invalid' });
    expect(parseInput('/brain /gpt qual banco?', 'claude')).toMatchObject({ type: 'invalid' });
    expect(parseInput('/brain /cla', 'claude')).toMatchObject({ type: 'invalid', message: expect.stringContaining('falta a pergunta') });
  });
  it('/parar', () => {
    expect(parseInput('/parar', 'claude')).toEqual({ type: 'stop' });
  });
});

describe('parseInput com @ (continua funcionando)', () => {
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
