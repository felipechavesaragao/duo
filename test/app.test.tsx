import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { App } from '../src/app.js';
import { ResumeFailedError, type Agent, type AgentId, type EmitFn } from '../src/agents/types.js';
import { newSessionData, Recorder, SessionStore } from '../src/persist.js';

class FakeAgent implements Agent {
  prompts: string[] = [];
  resumeId: string | undefined = undefined;
  onSessionId?: (id: string) => void;
  /** próximas chamadas que devem falhar com "conversa não existe" */
  failResume = 0;
  /** respostas roteirizadas, na ordem; '!erro' faz aquela resposta falhar */
  script: string[] = [];
  /** demora de cada resposta, para dar tempo de digitar algo no meio */
  delayMs = 0;

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
    const scripted = this.script.shift();
    if (scripted === '!erro') throw new Error('caiu');
    emit({ kind: 'tool', text: 'Bash ls' });
    const answer = scripted ?? `${this.name} responde ${this.prompts.length}`;
    emit({ kind: 'text', text: answer });
    return answer;
  }
  reset() {
    this.resumeId = undefined;
  }
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
    claude.delayMs = 200;
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
});
