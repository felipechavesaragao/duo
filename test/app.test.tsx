import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { App, footerText } from '../src/app.js';
import {
  ResumeFailedError,
  type Agent,
  type AgentCommand,
  type AgentId,
  type AgentEvent,
  type AgentStats,
  type EmitFn,
} from '../src/agents/types.js';
import { newSessionData, Recorder, SessionStore } from '../src/persist.js';

class FakeAgent implements Agent {
  prompts: string[] = [];
  resumeId: string | undefined = undefined;
  onSessionId?: (id: string) => void;
  askPermission?: Agent['askPermission'];
  askPeer?: Agent['askPeer'];
  stats: AgentStats = { subagents: 0 };
  onStats?: (stats: AgentStats) => void;
  commands: AgentCommand[] = [];
  onCommands?: (commands: AgentCommand[]) => void;
  models = [];
  async setModel() {}
  onOwnTurnEvent?: Agent['onOwnTurnEvent'];
  onOwnTurnReply?: Agent['onOwnTurnReply'];
  onRemoteMessage?: Agent['onRemoteMessage'];
  onNotice?: Agent['onNotice'];
  warmed = 0;
  /** próximas chamadas que devem falhar com "conversa não existe" */
  failResume = 0;
  /** respostas roteirizadas, na ordem; '!erro' faz aquela resposta falhar */
  script: string[] = [];
  /** demora de cada resposta, para dar tempo de digitar algo no meio */
  delayMs = 0;
  /** roda no meio do turno, antes da resposta (ex.: chamar o outro pela ferramenta do duo) */
  during?: () => Promise<void>;
  /** passos (e o fim deles) que o turno manda antes da resposta */
  events: AgentEvent[] = [];

  constructor(
    readonly id: AgentId,
    readonly name: string,
  ) {}

  async send(prompt: string, emit: EmitFn) {
    this.prompts.push(prompt);
    if (this.failResume > 0) {
      this.failResume--;
      this.resumeId = undefined;
      throw new ResumeFailedError('a conversa x não existe mais');
    }
    if (!this.resumeId) {
      this.resumeId = `sessao-${this.id}`;
      this.onSessionId?.(this.resumeId);
    }
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    await this.during?.();
    const scripted = this.script.shift();
    if (scripted === '!erro') throw new Error('caiu');
    emit({ kind: 'tool', text: 'Bash ls' });
    for (const ev of this.events) emit(ev);
    const answer = scripted ?? `${this.name} responde ${this.prompts.length}`;
    emit({ kind: 'text', text: answer });
    return answer;
  }
  reset() {
    this.resumeId = undefined;
  }
  warmUp() {
    this.warmed++;
  }
  async interrupt() {}
  dispose() {}
}

const fakes = () => ({ claude: new FakeAgent('claude', 'Claude'), codex: new FakeAgent('codex', 'Codex') });
const tmpStore = () => new SessionStore(fs.mkdtempSync(path.join(os.tmpdir(), 'duo-app-')));
const tick = () => new Promise((r) => setTimeout(r, 60));
async function type(stdin: { write: (s: string) => void }, text: string) {
  stdin.write(text);
  await tick();
  stdin.write('\r');
  await tick();
  await tick();
}
/** Espera a tela mostrar um texto (o brain leva vários turnos). */
async function waitFor(frames: string[], text: string, ms = 3000) {
  const t0 = Date.now();
  while (!frames.join('\n').includes(text)) {
    if (Date.now() - t0 > ms) throw new Error(`a tela não mostrou "${text}" em ${ms}ms`);
    await tick();
  }
}

describe('App', () => {
  it('roteia, mostra os dois e compartilha o contexto', async () => {
    const { claude, codex } = fakes();
    const { stdin, lastFrame, frames } = render(<App agents={{ claude, codex }} />);
    await tick();

    await type(stdin, 'oi claude');
    await type(stdin, '/codex revise'); // com / (principal)
    await type(stdin, '@todos ok'); // com @ também funciona

    expect(claude.prompts).toHaveLength(2);
    expect(codex.prompts).toHaveLength(2);
    expect(codex.prompts[0]).toContain('Claude responde 1'); // Codex viu a resposta do Claude
    expect(claude.prompts[1]).toContain('Codex responde 1'); // Claude viu a do Codex

    const all = frames.join('\n');
    expect(all).toContain('● Claude');
    expect(all).toContain('● Codex');
    expect(all).toContain('↳ Bash ls');
    expect(lastFrame()).toContain('/todos ›');
  });

  it('passos: o fim que deu certo não aparece; o que não deu, sim', async () => {
    const { claude, codex } = fakes();
    claude.events = [
      { kind: 'tool', text: '$ npm test', step: { id: 's1', full: '$ npm test' } },
      { kind: 'tool', text: '  ↳ ok', result: { of: 's1', ok: true } },
      { kind: 'tool', text: '$ npm run build', step: { id: 's2', full: '$ npm run build' } },
      { kind: 'tool', text: '  ↳ saiu com código 2', result: { of: 's2', ok: false, exitCode: 2 } },
    ];
    const { stdin, frames } = render(<App agents={{ claude, codex }} />);
    await tick();
    await type(stdin, 'oi');
    await waitFor(frames, 'Claude responde 1');
    const all = frames.join('\n');
    expect(all).toContain('↳ $ npm test');
    expect(all).toContain('↳   ↳ saiu com código 2');
    expect(all).not.toContain('↳ ok');
  });

  it('/privado desliga o compartilhamento', async () => {
    const { claude, codex } = fakes();
    const { stdin, lastFrame } = render(<App agents={{ claude, codex }} />);
    await tick();

    await type(stdin, '/privado');
    await type(stdin, 'oi');
    await type(stdin, '@codex oi');
    expect(codex.prompts[0]).toBe('oi');
    expect(lastFrame()).toContain('🔒 /codex ›');
  });

  it('grava a conversa e o `duo -c` retoma: tela, ids, modo e memória compartilhada', async () => {
    const store = tmpStore();
    const data = newSessionData('/projeto');
    const first = fakes();
    const app1 = render(<App agents={first} recorder={new Recorder(data, store)} />);
    await tick();
    await type(app1.stdin, 'oi claude');
    await type(app1.stdin, '/privado');
    app1.unmount();

    const saved = store.load(store.lastIdFor('/projeto')!)!;
    expect(saved.id).toBe(data.id);
    expect(saved.claudeSessionId).toBe('sessao-claude'); // id gravado assim que apareceu
    expect(saved.turns).toMatchObject([{ agent: 'claude', text: 'oi claude', status: 'done' }]);
    expect(saved.shared).toBe(false);
    expect(saved.screen.map((e) => e.text)).toContain('Claude responde 1');

    const second = fakes();
    const app2 = render(<App agents={second} recorder={new Recorder(saved, store)} resumed />);
    await tick();
    const shown = app2.frames.join('\n');
    expect(shown).toContain('Conversa retomada');
    expect(shown).toContain('Claude responde 1'); // a tela voltou
    expect(app2.lastFrame()).toContain('🔒 /claude ›'); // modo e destino voltaram

    await type(app2.stdin, '/compartilhado');
    await type(app2.stdin, '@codex o que ele disse?');
    expect(second.codex.prompts[0]).toContain('Claude responde 1'); // memória compartilhada voltou
    app2.unmount();
  });

  it('turno que estava rodando quando o duo fechou aparece como interrompido e NÃO é reenviado', async () => {
    const store = tmpStore();
    const data = newSessionData('/projeto');
    data.turns.push({ id: 1, agent: 'codex', text: 'faz o deploy', status: 'running' });
    data.nextTurn = 2;
    const agents = fakes();
    const app = render(<App agents={agents} recorder={new Recorder(data, store)} resumed />);
    await tick();

    const shown = app.frames.join('\n');
    expect(shown).toContain('interrompida');
    expect(shown).toContain('faz o deploy');
    expect(agents.codex.prompts).toHaveLength(0);
    expect(store.load(data.id)!.turns[0].status).toBe('interrupted');
    app.unmount();
  });

  it('conversa anterior que não existe mais: avisa, abre uma nova e manda de novo com a janela inteira', async () => {
    const { claude, codex } = fakes();
    const { stdin, frames } = render(<App agents={{ claude, codex }} />);
    await tick();
    await type(stdin, 'PEDIDO-UM');
    await type(stdin, '@codex PEDIDO-DOIS');

    claude.failResume = 1;
    await type(stdin, '@claude PEDIDO-TRES');
    expect(claude.prompts).toHaveLength(3); // 1 normal + tentativa que falhou + nova
    expect(claude.prompts[2]).toContain('não pôde ser retomada');
    expect(claude.prompts[2]).toContain('PEDIDO-UM'); // inclusive o que era só dele
    expect(claude.prompts[2]).toContain('Codex responde 1');
    expect(frames.join('\n')).toContain('não deu para retomar');
    expect(frames.join('\n')).toContain('Claude responde 3');
  });

  it('turno que falha não perde o contexto: ele vai de novo na próxima mensagem', async () => {
    const { claude, codex } = fakes();
    const { stdin } = render(<App agents={{ claude, codex }} />);
    await tick();
    await type(stdin, 'oi');
    const send = codex.send.bind(codex);
    codex.send = async (prompt: string) => {
      codex.prompts.push(prompt);
      throw new Error('caiu');
    };
    await type(stdin, '@codex primeira');
    codex.send = send;
    await type(stdin, '@codex segunda');
    expect(codex.prompts[0]).toContain('Claude responde 1');
    expect(codex.prompts[1]).toContain('Claude responde 1'); // não se perdeu com a falha
  });

  it('/novo descarta o que ainda era da conversa anterior: a fila não roda e nada aparece na nova', async () => {
    const store = tmpStore();
    const data = newSessionData('/projeto');
    const { claude, codex } = fakes();
    claude.delayMs = 1000;
    const { stdin, frames } = render(<App agents={{ claude, codex }} recorder={new Recorder(data, store)} />);
    await tick();
    await type(stdin, 'PRIMEIRA'); // rodando
    await type(stdin, 'SEGUNDA'); // na fila
    await type(stdin, '/novo');
    await new Promise((r) => setTimeout(r, 900)); // a primeira termina depois do /novo
    expect(claude.prompts).toHaveLength(1); // a da fila nunca saiu
    expect(claude.prompts[0]).toContain('PRIMEIRA');
    const shown = frames.join('\n');
    expect(shown).not.toContain('Claude responde');
    expect(shown).not.toContain('Bash ls');
    expect(shown).toContain('ainda estavam rodando ou na fila foram descartadas.'); // a linha quebra em "As 2"
    expect(store.load(data.id)!.turns.map((t) => t.status)).toEqual(['cancelled', 'cancelled']);

    await type(stdin, '@codex e agora?');
    expect(codex.prompts[0]).not.toContain('PRIMEIRA'); // a conversa nova começa limpa
    expect(codex.prompts[0]).not.toContain('SEGUNDA');
  });
});

describe('o Claude chama o Codex', () => {
  it('vira um turno do Codex na janela e a resposta volta para o Claude, sem repetir no contexto dele', async () => {
    const { claude, codex } = fakes();
    const { stdin, frames } = render(<App agents={{ claude, codex }} />);
    await tick();
    await type(stdin, 'faz o plano');

    const answer = await claude.askPeer!({ text: 'revisa o plano', signal: new AbortController().signal });
    expect(answer).toBe('Codex responde 1');
    expect(codex.prompts[0]).toContain('[duo] O Claude chamou você pela ferramenta do duo');
    expect(codex.prompts[0]).toContain('### Claude\nClaude responde 1'); // o contexto da janela foi junto
    expect(codex.prompts[0]).toMatch(/Mensagem do Claude para você:\n[\s\S]*revisa o plano$/);
    const shown = frames.join('\n');
    expect(shown).toContain('[para o Codex] revisa o plano');
    expect(shown).toContain('Codex responde 1');

    await type(stdin, 'e agora?');
    expect(claude.prompts[1]).toBe('e agora?'); // a resposta já tinha chegado pela ferramenta
  });

  it('o Codex chama o Claude pelo mesmo caminho', async () => {
    const { claude, codex } = fakes();
    const { frames } = render(<App agents={{ claude, codex }} />);
    await tick();
    const answer = await codex.askPeer!({ text: 'confere o teste', signal: new AbortController().signal });
    expect(answer).toBe('Claude responde 1');
    expect(claude.prompts[0]).toContain('[duo] O Codex chamou você pela ferramenta do duo');
    expect(frames.join('\n')).toContain('[para o Claude] confere o teste');
  });

  it('quem está esperando não pode ser chamado de volta: recusa em vez de travar os dois', async () => {
    const { claude, codex } = fakes();
    render(<App agents={{ claude, codex }} />);
    await tick();
    const signal = new AbortController().signal;
    let refused = '';
    codex.during = async () => {
      codex.during = undefined;
      // no meio da resposta ao Claude, o Codex tenta chamá-lo de volta
      await codex.askPeer!({ text: 'uma dúvida', signal }).catch((e: Error) => (refused = e.message));
    };
    expect(await claude.askPeer!({ text: 'revisa', signal })).toBe('Codex responde 1');
    expect(refused).toContain('o Claude está esperando uma resposta sua');
    expect(claude.prompts).toHaveLength(0); // a chamada de volta não entrou na fila do Claude

    // terminou a chamada: o Codex pode chamar o Claude normalmente
    expect(await codex.askPeer!({ text: 'agora sim', signal })).toBe('Claude responde 1');
  });

  it('o Codex falha: a ferramenta recebe o erro', async () => {
    const { claude, codex } = fakes();
    codex.script = ['!erro'];
    render(<App agents={{ claude, codex }} />);
    await tick();
    await expect(claude.askPeer!({ text: 'oi', signal: new AbortController().signal })).rejects.toThrow(
      'o Codex não conseguiu responder',
    );
  });
});

describe('turno que o agente abre sozinho', () => {
  it('aparece na janela e o outro recebe a resposta como contexto', async () => {
    const { claude, codex } = fakes();
    const { stdin, frames } = render(<App agents={{ claude, codex }} />);
    await tick();
    // um subagente em segundo plano terminou e o Claude continuou sem mensagem nenhuma
    claude.onOwnTurnEvent!({ kind: 'tool', text: 'Read devil.md' });
    claude.onOwnTurnEvent!({ kind: 'text', text: 'O DEVIL APROVOU' });
    claude.onOwnTurnReply!('O DEVIL APROVOU');
    await tick();
    const shown = frames.join('\n');
    expect(shown).toContain('Read devil.md');
    expect(shown).toContain('O DEVIL APROVOU');

    await type(stdin, '/codex e você?');
    expect(codex.prompts[0]).toContain('### Claude\nO DEVIL APROVOU');
  });

  it('o que você digita no app (Remote Control) aparece como seu, e o outro recebe como contexto', async () => {
    const { claude, codex } = fakes();
    const { stdin, frames } = render(<App agents={{ claude, codex }} />);
    await tick();
    claude.onNotice!({ kind: 'text', text: 'Claude no Remote Control: https://claude.ai/code/session_x' });
    claude.onRemoteMessage!('OI DO CELULAR');
    claude.onOwnTurnReply!('RESPOSTA NO CELULAR');
    await tick();
    const shown = frames.join('\n');
    expect(shown).toContain('Claude no Remote Control: https://claude.ai/code/session_x');
    expect(shown).toContain('[pelo app, para o Claude] OI DO CELULAR');

    await type(stdin, '/codex viu?');
    expect(codex.prompts[0]).toContain('usuário → Claude\nOI DO CELULAR');
    expect(codex.prompts[0]).toContain('### Claude\nRESPOSTA NO CELULAR');
  });

  it('a resposta segue o modo de quando o turno começou, mesmo que você troque antes de ela chegar', async () => {
    const { claude, codex } = fakes();
    const { stdin } = render(<App agents={{ claude, codex }} />);
    await tick();
    // pelo app, no privado; a resposta chega depois de você voltar ao compartilhado
    await type(stdin, '/privado');
    claude.onRemoteMessage!('SEGREDO DO CELULAR');
    await type(stdin, '/compartilhado');
    claude.onOwnTurnEvent!({ kind: 'text', text: 'RESPOSTA DO SEGREDO' });
    claude.onOwnTurnReply!('RESPOSTA DO SEGREDO');
    // tarefa lançada numa mensagem privada; depois, já no compartilhado, uma pública ao mesmo agente; aí a tarefa
    // termina: o adaptador diz que ela veio da privada
    await type(stdin, '/privado');
    await type(stdin, '@claude lança a tarefa');
    await type(stdin, '/compartilhado');
    await type(stdin, '@claude pergunta pública');
    claude.onOwnTurnEvent!({ kind: 'text', text: 'TAREFA PRIVADA PRONTA' });
    claude.onOwnTurnReply!('TAREFA PRIVADA PRONTA', false);
    // sem origem conhecida, depois de uma mensagem privada a ele: não compartilha
    claude.onOwnTurnReply!('SEM ORIGEM', undefined);
    // tarefa que veio de mensagem compartilhada: compartilha
    claude.onOwnTurnReply!('TAREFA PUBLICA PRONTA', true);

    await type(stdin, '@codex viu algo?');
    expect(codex.prompts[0]).not.toContain('SEGREDO');
    expect(codex.prompts[0]).not.toContain('TAREFA PRIVADA');
    expect(codex.prompts[0]).not.toContain('SEM ORIGEM');
    expect(codex.prompts[0]).not.toContain('lança a tarefa');
    expect(codex.prompts[0]).toContain('pergunta pública');
    expect(codex.prompts[0]).toContain('TAREFA PUBLICA PRONTA');
  });

  it('turno dele só de ferramenta encerra o modo dele: o seguinte começa com o modo da hora dele', async () => {
    const { claude, codex } = fakes();
    const { stdin } = render(<App agents={{ claude, codex }} />);
    await tick();
    // primeiro turno, no compartilhado: só ferramenta, e o adaptador avisa o fim com texto vazio
    claude.onOwnTurnEvent!({ kind: 'tool', text: 'Read saida.txt' });
    claude.onOwnTurnReply!('', true);
    // o segundo começa no privado; você volta ao compartilhado antes de ele responder
    await type(stdin, '/privado');
    claude.onOwnTurnEvent!({ kind: 'text', text: 'SEGUNDO TURNO' });
    await type(stdin, '/compartilhado');
    claude.onOwnTurnReply!('SEGUNDO TURNO', true);

    await type(stdin, '@codex viu algo?');
    expect(codex.prompts[0]).not.toContain('SEGUNDO TURNO');
  });

  it('sem origem conhecida: conta o privado da conversa retomada e o que veio pelo app', async () => {
    // retomada: a conversa já tinha uma mensagem privada ao Claude
    const data = newSessionData('/projeto');
    data.log.items.push({ from: 'voce', to: ['claude'], text: 'segredo antigo', onlyFor: ['claude'] });
    const first = fakes();
    const app1 = render(<App agents={first} recorder={new Recorder(data)} resumed />);
    await tick();
    first.claude.onOwnTurnReply!('SEM ORIGEM NA RETOMADA', undefined);
    await type(app1.stdin, '@codex viu algo?');
    expect(first.codex.prompts[0]).not.toContain('SEM ORIGEM NA RETOMADA');
    app1.unmount();

    // conversa nova: a única coisa privada foi pelo app (Remote Control)
    const second = fakes();
    const app2 = render(<App agents={second} />);
    await tick();
    await type(app2.stdin, '/privado');
    second.claude.onRemoteMessage!('segredo do celular');
    second.claude.onOwnTurnReply!('resposta do celular');
    await type(app2.stdin, '/compartilhado');
    second.claude.onOwnTurnReply!('SEM ORIGEM DEPOIS DO APP', undefined);
    await type(app2.stdin, '@codex viu algo?');
    expect(second.codex.prompts[0]).not.toContain('segredo do celular');
    expect(second.codex.prompts[0]).not.toContain('SEM ORIGEM DEPOIS DO APP');
  });
});

describe('lista de comandos de cada agente', () => {
  it('"@cla /co" mostra os do Claude que batem; Tab completa e o comando vai puro', async () => {
    const { claude, codex } = fakes();
    claude.commands = [
      { name: 'context', description: 'Mostra o uso de contexto' },
      { name: 'compact', description: 'Resume a conversa' },
      { name: 'init', description: 'Cria o CLAUDE.md' },
    ];
    const { stdin, lastFrame } = render(<App agents={{ claude, codex }} />);
    await tick();
    expect([claude.warmed, codex.warmed]).toEqual([1, 1]); // os dois sobem ao abrir
    await type(stdin, '/codex opina'); // contexto para o Claude receber depois
    stdin.write('@cla /co');
    await tick();
    const frame = lastFrame()!;
    expect(frame).toContain('/context');
    expect(frame).toContain('Mostra o uso de contexto');
    expect(frame).toContain('/compact');
    expect(frame).not.toContain('/init');

    stdin.write('\t');
    await tick();
    expect(lastFrame()).toContain('› @cla /context');
    expect(lastFrame()).not.toContain('Tab completa'); // nome escolhido: a lista sai
    await type(stdin, 'agora'); // o cursor foi para o fim
    expect(claude.prompts.at(-1)).toBe('/context agora'); // sem o contexto na frente: roda como comando
  });

  it('as skills do Codex chegam depois de abrir, e a lista acompanha', async () => {
    const { claude, codex } = fakes();
    const { stdin, lastFrame } = render(<App agents={{ claude, codex }} />);
    await tick();
    stdin.write('@fog /');
    await tick();
    expect(lastFrame()).toContain('os comandos do Codex ainda não carregaram');
    codex.onCommands!([{ name: 'review-agent', description: 'Acha bugs' }]);
    await tick();
    expect(lastFrame()).toContain('/review-agent');
    expect(lastFrame()).toContain('Acha bugs');
  });
});

describe('rodapé', () => {
  it('texto de cada um: modelo, contexto e subagentes', () => {
    expect(footerText({ subagents: 0 })).toBe('modelo ? · — tokens · sem agent');
    expect(footerText({ model: 'claude-opus-5-5', contextTokens: 64_300, contextWindow: 1_000_000, subagents: 1 })).toBe(
      'claude-opus-5-5 · 64k/1M tokens (6%) · 1 agent rodando',
    );
    expect(footerText({ model: 'gpt-6.1-sol', contextTokens: 950, contextWindow: 1_500_000, subagents: 2 })).toBe(
      'gpt-6.1-sol · 950/1,5M tokens (0%) · 2 agents rodando',
    );
    expect(footerText({ model: 'x', contextTokens: 12_000, subagents: 0 })).toBe('x · 12k tokens · sem agent');
  });

  it('mostra os dois e acompanha cada mudança', async () => {
    const { claude, codex } = fakes();
    claude.stats = { model: 'claude-opus-5-5', subagents: 0 };
    const { lastFrame } = render(<App agents={{ claude, codex }} />);
    await tick();
    expect(lastFrame()).toContain('Claude claude-opus-5-5 · — tokens · sem agent\nCodex  modelo ? · — tokens · sem agent');
    codex.onStats!({ model: 'gpt-6.1-sol', contextTokens: 17_000, contextWindow: 475_000, subagents: 1 });
    await tick();
    expect(lastFrame()).toContain('Codex  gpt-6.1-sol · 17k/475k tokens (4%) · 1 agent rodando');
  });
});

describe('pedido de permissão', () => {
  it('a caixa de texto vira a pergunta, responde em ordem e devolve o que você digitava', async () => {
    const { claude, codex } = fakes();
    const { stdin, lastFrame, frames } = render(<App agents={{ claude, codex }} />);
    await tick();
    stdin.write('rascunho meu');
    await tick();

    const signal = new AbortController().signal;
    const first = claude.askPermission!({ text: 'Bash git push origin HEAD:master', signal });
    const second = codex.askPermission!({ text: 'Bash git push origin producao', signal });
    await tick();
    expect(lastFrame()).toContain('? Claude pede permissão (+1 na fila): Bash git push origin HEAD:master');
    expect(lastFrame()).toContain('permitir? s/n ›');

    await type(stdin, 'segue'); // não é s nem n: não decide nada
    expect(frames.join('\n')).toContain('responda s para permitir ou n para negar');
    await type(stdin, 's');
    expect(await first).toBe(true);
    expect(lastFrame()).toContain('? Codex pede permissão: Bash git push origin producao');
    await type(stdin, 'n');
    expect(await second).toBe(false);

    const all = frames.join('\n');
    expect(all).toContain('você permitiu: Bash git push origin HEAD:master');
    expect(all).toContain('você negou: Bash git push origin producao');
    expect(lastFrame()).toContain('/claude › rascunho meu');
  });

  it('pedido cancelado (o processo caiu) sai da tela e vale como não', async () => {
    const { claude, codex } = fakes();
    const { lastFrame, frames } = render(<App agents={{ claude, codex }} />);
    await tick();
    const ctrl = new AbortController();
    const pending = claude.askPermission!({ text: 'Bash git push', signal: ctrl.signal });
    await tick();
    expect(lastFrame()).toContain('pede permissão');
    ctrl.abort();
    expect(await pending).toBe(false);
    await tick();
    expect(lastFrame()).not.toContain('pede permissão');
    expect(frames.join('\n')).toContain('pedido de permissão cancelado: Bash git push');
  });

  it('o que você digitou para um pedido cancelado não responde o próximo', async () => {
    const { claude, codex } = fakes();
    const { stdin, lastFrame } = render(<App agents={{ claude, codex }} />);
    await tick();
    const ctrl = new AbortController();
    const first = claude.askPermission!({ text: 'Bash git push origin um', signal: ctrl.signal });
    const second = codex.askPermission!({ text: 'Bash git push origin dois', signal: new AbortController().signal });
    let decided = false;
    void second.then(() => (decided = true));
    await tick();
    stdin.write('s'); // ainda sem Enter
    await tick();
    ctrl.abort(); // o primeiro sai: o processo caiu
    expect(await first).toBe(false);
    await tick();
    expect(lastFrame()).toContain('? Codex pede permissão: Bash git push origin dois');
    stdin.write('\r');
    await tick();
    expect(decided).toBe(false);
    expect(lastFrame()).toContain('permitir? s/n ›');
  });
});

describe('/brain', () => {
  it('quem foi marcado responde, o outro avalia vendo a resposta, e param quando um concorda', async () => {
    const { claude, codex } = fakes();
    claude.script = ['PROPOSTA-A', 'aceito o ajuste\n[CONCORDO]'];
    codex.script = ['troque o banco\n[DISCORDO]'];
    const { stdin, frames } = render(<App agents={{ claude, codex }} />);
    await tick();
    await type(stdin, '/brain /cla qual banco usar?');
    await waitFor(frames, 'concordaram');

    expect(claude.prompts).toHaveLength(2);
    expect(codex.prompts).toHaveLength(1);
    expect(claude.prompts[0]).toContain('[duo · brain] Você responde primeiro');
    expect(claude.prompts[0]).toContain('qual banco usar?');
    expect(codex.prompts[0]).toContain('qual banco usar?'); // a pergunta, pelo contexto
    expect(codex.prompts[0]).toContain('### Claude\nPROPOSTA-A'); // e a resposta que ele avalia
    expect(codex.prompts[0]).toContain('A última resposta do Claude');
    expect(claude.prompts[1]).toContain('### Codex\ntroque o banco');
    expect(claude.prompts[1]).not.toContain('PROPOSTA-A'); // a dele mesmo não volta
    expect(frames.join('\n')).toContain('o Claude concordou com o Codex (3 respostas)');
  });

  it('/brain /fog: o Codex começa', async () => {
    const { claude, codex } = fakes();
    codex.script = ['PLANO-DO-CODEX'];
    claude.script = ['perfeito\n[CONCORDO]'];
    const { stdin, frames } = render(<App agents={{ claude, codex }} />);
    await tick();
    await type(stdin, '/brain /fog revisa o plano');
    await waitFor(frames, 'concordaram');
    expect(codex.prompts).toHaveLength(1);
    expect(claude.prompts[0]).toContain('### Codex\nPLANO-DO-CODEX');
    expect(frames.join('\n')).toContain('o Claude concordou com o Codex (2 respostas)');
  });

  it('sem acordo para no limite de 6 respostas, 3 de cada', async () => {
    const { claude, codex } = fakes();
    claude.script = Array(3).fill('não\n[DISCORDO]');
    codex.script = Array(3).fill('também não\n[DISCORDO]');
    const { stdin, frames } = render(<App agents={{ claude, codex }} />);
    await tick();
    await type(stdin, '/brain /cla discutam');
    await waitFor(frames, 'sem acordo em 6 respostas');
    expect(claude.prompts).toHaveLength(3);
    expect(codex.prompts).toHaveLength(3);
  });

  it('/parar encerra depois da resposta em andamento', async () => {
    const { claude, codex } = fakes();
    codex.delayMs = 400;
    const { stdin, frames } = render(<App agents={{ claude, codex }} />);
    await tick();
    await type(stdin, '/brain /fog pensa nisso');
    await type(stdin, '/parar'); // o Codex ainda está respondendo
    await waitFor(frames, 'brain encerrado por você depois de 1 resposta');
    await new Promise((r) => setTimeout(r, 300));
    expect(codex.prompts).toHaveLength(1);
    expect(claude.prompts).toHaveLength(0); // não chamou o outro
  });

  it('resposta que falha encerra o brain; outro /brain no meio é recusado', async () => {
    const { claude, codex } = fakes();
    claude.delayMs = 1000; // folga: o segundo /brain tem de chegar com o primeiro ainda rodando
    claude.script = ['PROPOSTA'];
    codex.script = ['!erro'];
    const { stdin, frames } = render(<App agents={{ claude, codex }} />);
    await tick();
    await type(stdin, '/brain /cla primeiro');
    await type(stdin, '/brain /fog segundo');
    expect(frames.join('\n')).toContain('já tem um brain rodando');
    await waitFor(frames, 'brain parou: a resposta do Codex falhou');
    expect(claude.prompts).toHaveLength(1);
  });

  it('/novo no meio: o brain da conversa anterior para calado, e outro pode começar', async () => {
    const { claude, codex } = fakes();
    claude.delayMs = 600;
    const { stdin, frames } = render(<App agents={{ claude, codex }} />);
    await tick();
    await type(stdin, '/brain /cla pensa nisso');
    await type(stdin, '/novo');
    await new Promise((r) => setTimeout(r, 700)); // a resposta do Claude chega depois do /novo
    expect(codex.prompts).toHaveLength(0); // não passou a vez
    expect(frames.join('\n')).not.toContain('brain parou');
    await type(stdin, '/brain /fog de novo');
    expect(frames.join('\n')).not.toContain('já tem um brain rodando');
  });
});
