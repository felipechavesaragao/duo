// Codex falso para os testes: fala o protocolo do `codex exec --json [resume <id>] -`.
// resume sumiu   → imita o codex real com id inexistente (medido em 02/11/2026, 0.166.0):
//                  nada no stdout, stderr "no rollout found for thread id", sai com 1 (sem ler o stdin).
// resume ocupada → conversa aberta em outro processo ("already has an active writer").
// prompt com QUEBRA → escreve uma mensagem e cai antes do turn.completed.
const args = process.argv.slice(2);
const r = args.indexOf('resume');
const resume = r >= 0 ? args[r + 1] : undefined;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (resume === 'sumiu') {
  process.stderr.write(`Error: thread/resume: thread/resume failed: no rollout found for thread id ${resume} (code -32600)\n`);
  process.exit(1);
}
if (resume === 'ocupada') {
  process.stderr.write(`thread-store conflict: thread ${resume} already has an active writer\n`);
  process.exit(1);
}

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  out({ type: 'thread.started', thread_id: resume ?? 'thread-nova' });
  out({ type: 'turn.started' });
  out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: `eco: ${input}` } });
  if (input.includes('QUEBRA')) process.exit(2);
  out({ type: 'turn.completed', usage: {} });
});
