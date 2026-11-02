import { describe, expect, it } from 'vitest';
import type { AgentId } from '../src/agents/types.js';
import { SharedLog } from '../src/shared.js';

/** Faz o que o duo faz quando dá certo: registra, monta o prompt de cada um e marca como entregue. */
function turn(log: SharedLog, to: AgentId[], text: string, shared = true): Record<AgentId, string> {
  const idx = log.userMessage(to, text, shared);
  const out = {} as Record<AgentId, string>;
  for (const id of to) {
    const p = log.prepare(id, text, shared, idx);
    out[id] = p.prompt;
    log.delivered(id, p);
  }
  return out;
}

describe('SharedLog', () => {
  it('cada um recebe o que perdeu, uma vez só', () => {
    const log = new SharedLog();
    const p1 = turn(log, ['claude'], 'escreva a função');
    expect(p1.claude).toContain('janela de terminal compartilhada'); // apresentação no 1º turno
    expect(p1.claude).not.toContain('Contexto da janela'); // nada perdido ainda
    log.agentReply('claude', 'function soma(a, b) { return a + b }', true);

    const p2 = turn(log, ['codex'], 'revise');
    expect(p2.codex).toContain('usuário → Claude\nescreva a função');
    expect(p2.codex).toContain('### Claude\nfunction soma');
    expect(p2.codex).toMatch(/Mensagem do usuário para você:\nrevise$/);
    log.agentReply('codex', 'falta tipagem', true);

    const p3 = turn(log, ['claude'], 'corrija');
    expect(p3.claude).toContain('usuário → Codex\nrevise');
    expect(p3.claude).toContain('### Codex\nfalta tipagem');
    expect(p3.claude).not.toContain('escreva a função'); // já tinha visto
    expect(p3.claude).not.toContain('function soma'); // é dele mesmo
    expect(p3.claude).not.toContain('janela de terminal compartilhada'); // apresentação só uma vez

    expect(turn(log, ['claude'], 'valeu').claude).toBe('valeu'); // nada novo: mensagem pura
  });

  it('@todos: os dois recebem a mesma mensagem e depois veem a resposta do outro', () => {
    const log = new SharedLog();
    turn(log, ['claude', 'codex'], 'opinem');
    log.agentReply('claude', 'opinião A', true);
    log.agentReply('codex', 'opinião B', true);
    const next = turn(log, ['claude', 'codex'], 'e agora?');
    expect(next.claude).toContain('opinião B');
    expect(next.claude).not.toContain('opinião A');
    expect(next.claude).not.toContain('opinem');
    expect(next.codex).toContain('opinião A');
    expect(next.codex).not.toContain('opinião B');
  });

  it('@todos: quem começa depois NÃO vê a resposta do outro à mesma mensagem', () => {
    const log = new SharedLog();
    const idx = log.userMessage(['claude', 'codex'], 'opinem', true);
    const c = log.prepare('claude', 'opinem', true, idx);
    log.delivered('claude', c);
    log.agentReply('claude', 'OPINIAO-DO-CLAUDE', true); // o Claude respondeu antes de o Codex começar

    const x = log.prepare('codex', 'opinem', true, idx); // o Codex estava ocupado e só começa agora
    expect(x.prompt).not.toContain('OPINIAO-DO-CLAUDE');
    log.delivered('codex', x);
    log.agentReply('codex', 'OPINIAO-DO-CODEX', true);

    // na mensagem seguinte cada um vê o que o outro respondeu
    const next = turn(log, ['claude', 'codex'], 'e agora?');
    expect(next.codex).toContain('### Claude\nOPINIAO-DO-CLAUDE');
    expect(next.claude).toContain('### Codex\nOPINIAO-DO-CODEX');
  });

  it('resposta que chega depois do Enter fica para a próxima mensagem', () => {
    const log = new SharedLog();
    turn(log, ['claude'], 'PEDIDO-A');
    const idx = log.userMessage(['codex'], 'PEDIDO-B', true); // mandado enquanto o Claude ainda trabalhava
    log.agentReply('claude', 'RESPOSTA-A', true);
    const p = log.prepare('codex', 'PEDIDO-B', true, idx);
    expect(p.prompt).toContain('usuário → Claude\nPEDIDO-A');
    expect(p.prompt).not.toContain('RESPOSTA-A');
    log.delivered('codex', p);
    expect(turn(log, ['codex'], 'e ele?').codex).toContain('### Claude\nRESPOSTA-A'); // não se perdeu
  });

  it('modo privado manda a mensagem pura', () => {
    const log = new SharedLog();
    turn(log, ['claude'], 'a', false);
    log.agentReply('claude', 'b', false);
    expect(turn(log, ['codex'], 'c', false).codex).toBe('c');
  });

  it('o que foi dito no privado não vaza quando volta para o compartilhado', () => {
    const log = new SharedLog();
    turn(log, ['claude'], 'pergunta aberta');
    log.agentReply('claude', 'resposta aberta', true);
    turn(log, ['claude'], 'segredo', false);
    log.agentReply('claude', 'resposta secreta', false);
    turn(log, ['codex'], 'oi no privado', false);
    log.agentReply('codex', 'oi de volta', false);

    const codex = turn(log, ['codex'], 'e aí?').codex;
    expect(codex).toContain('pergunta aberta');
    expect(codex).toContain('resposta aberta');
    expect(codex).not.toContain('segredo');
    expect(codex).not.toContain('resposta secreta');

    const claude = turn(log, ['claude'], 'e você?').claude;
    expect(claude).toContain('usuário → Codex\ne aí?');
    expect(claude).not.toContain('oi no privado');
    expect(claude).not.toContain('oi de volta');
  });

  it('contexto só conta como entregue depois da resposta: se o turno falhar, vai de novo', () => {
    const log = new SharedLog();
    turn(log, ['claude'], 'tarefa');
    log.agentReply('claude', 'FEITO-PELO-CLAUDE', true);

    const i1 = log.userMessage(['codex'], 'revise', true);
    const falhou = log.prepare('codex', 'revise', true, i1);
    expect(falhou.prompt).toContain('FEITO-PELO-CLAUDE');
    // o turno falhou: delivered() não é chamado

    const i2 = log.userMessage(['codex'], 'tenta de novo', true);
    const p2 = log.prepare('codex', 'tenta de novo', true, i2);
    expect(p2.prompt).toContain('FEITO-PELO-CLAUDE'); // não se perdeu
    expect(p2.prompt).toContain('janela de terminal compartilhada'); // a apresentação também volta
  });

  it('mensagem ainda na fila não aparece como contexto antes da hora', () => {
    const log = new SharedLog();
    const i1 = log.userMessage(['claude'], 'PRIMEIRA', true);
    log.userMessage(['claude'], 'SEGUNDA', true); // enviada enquanto a primeira esperava
    const p = log.prepare('claude', 'PRIMEIRA', true, i1);
    expect(p.prompt).not.toContain('SEGUNDA');
  });

  it('retomada: o estado volta do JSON e continua de onde parou', () => {
    const log = new SharedLog();
    turn(log, ['claude'], 'oi');
    log.agentReply('claude', 'RESPOSTA-ANTES-DE-FECHAR', true);

    const reaberto = new SharedLog(JSON.parse(JSON.stringify(log.state)));
    const p = turn(reaberto, ['codex'], 'o que ele disse?').codex;
    expect(p).toContain('RESPOSTA-ANTES-DE-FECHAR');
    expect(turn(reaberto, ['codex'], 'e agora?').codex).toBe('e agora?');
  });

  it('forget: quem perdeu a memória recebe a janela inteira, até o que ele mesmo disse', () => {
    const log = new SharedLog();
    turn(log, ['claude'], 'PEDIDO-AO-CLAUDE');
    log.agentReply('claude', 'RESPOSTA-DO-CLAUDE', true);
    turn(log, ['codex'], 'PEDIDO-AO-CODEX');
    log.agentReply('codex', 'RESPOSTA-DO-CODEX', true);

    log.forget('claude');
    const idx = log.userMessage(['claude'], 'ZEBRA', true);
    const p = log.prepare('claude', 'ZEBRA', true, idx);
    expect(p.prompt).toContain('não pôde ser retomada');
    expect(p.prompt).toContain('usuário → Claude\nPEDIDO-AO-CLAUDE');
    expect(p.prompt).toContain('você (Claude), antes\nRESPOSTA-DO-CLAUDE');
    expect(p.prompt).toContain('RESPOSTA-DO-CODEX');
    expect(p.prompt.split('ZEBRA').length - 1).toBe(1); // a mensagem atual aparece uma vez só, no fim

    log.delivered('claude', p);
    log.agentReply('claude', 'ok', true);
    expect(turn(log, ['claude'], 'seguinte').claude).toBe('seguinte'); // amnésia curada
  });
});
