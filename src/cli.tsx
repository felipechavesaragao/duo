#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { parseArgs } from 'node:util';
import { App } from './app.js';
import { ClaudeAgent } from './agents/claude.js';
import { CodexAgent } from './agents/codex.js';
import { remoteControlAtStartup } from './claudeSettings.js';
import { newSessionData, Recorder, SessionStore, type SessionData } from './persist.js';
import type { Target } from './router.js';

const USAGE = `duo — Claude Code e Codex na mesma janela

uso: duo [opções]

  -c, --continuar                  continua a última conversa desta pasta
  --para <claude|codex|todos>      destino padrão inicial (padrão: claude)
  --claude-permission <modo>       default | acceptEdits | plan | bypassPermissions (padrão: o do seu settings.json)
  --codex-sandbox <modo>           read-only | workspace-write | danger-full-access (padrão: livre, sem sandbox)
  --claude-model <modelo>          modelo do Claude
  --codex-model <modelo>           modelo do Codex
  --yolo                           Claude em bypassPermissions e Codex sem sandbox, ignorando as duas opções
                                   acima (as regras deny e ask do settings do Claude continuam valendo)
  -h, --help                       esta ajuda

Os dois trabalham na pasta onde você rodou o duo. As conversas ficam salvas em ~/.duo/.`;

const { values } = parseArgs({
  options: {
    continuar: { type: 'boolean', short: 'c', default: false },
    para: { type: 'string' },
    'claude-permission': { type: 'string' },
    'codex-sandbox': { type: 'string' },
    'claude-model': { type: 'string' },
    'codex-model': { type: 'string' },
    yolo: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const TARGETS: Target[] = ['claude', 'codex', 'todos'];
if (values.para !== undefined && !TARGETS.includes(values.para as Target)) {
  console.error(`--para aceita ${TARGETS.join(', ')} (veio "${values.para}").`);
  process.exit(1);
}

const cwd = process.cwd();
const store = new SessionStore();

let data: SessionData | undefined;
if (values.continuar) {
  const last = store.lastIdFor(cwd);
  data = last ? store.load(last) : undefined;
  if (!data) console.log('Nenhuma conversa anterior nesta pasta: abrindo uma nova.');
}
const resumed = data !== undefined;
data ??= newSessionData(cwd);
if (values.para !== undefined) data.target = values.para as Target;

const lock = store.lock(data.id);
if (!lock.ok) {
  console.error(
    lock.stuck
      ? `A trava dessa conversa ficou pela metade: o duo que a tomava fechou no meio. Se nenhum outro duo está com ela ` +
          `aberta, apague ${lock.stuck} e rode de novo; ou rode só "duo" para abrir uma nova.`
      : `Essa conversa já está aberta em outro duo (processo ${lock.pid}). Feche aquele primeiro, ou rode só "duo" para abrir uma nova.`,
  );
  process.exit(1);
}
const recorder = new Recorder(data, store);

const agents = {
  claude: new ClaudeAgent({
    permissionMode: values.yolo ? 'bypassPermissions' : values['claude-permission'],
    model: values['claude-model'],
    resumeId: data.claudeSessionId,
    // como no terminal: se o seu settings liga o Remote Control, a conversa do Claude aparece no app
    remoteControl: remoteControlAtStartup(process.cwd()),
  }),
  codex: new CodexAgent({
    sandbox: values.yolo ? undefined : values['codex-sandbox'],
    model: values['codex-model'],
    resumeId: data.codexThreadId,
  }),
};

// Ao sair (por /sair, Ctrl+C ou erro): grava, solta a trava e fecha os processos filhos.
process.on('exit', () => {
  recorder.close();
  Object.values(agents).forEach((a) => a.dispose());
});

const app = render(<App agents={agents} recorder={recorder} resumed={resumed} />);
await app.waitUntilExit();
process.exit(0);
