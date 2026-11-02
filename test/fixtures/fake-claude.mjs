// Claude falso para os testes: fala o protocolo do `claude -p --input-format/--output-format stream-json`.
// --resume sumiu  → imita o claude real com id inexistente (medido em 02/11/2026, 2.1.316):
//                   result de erro SEM init, stderr "No conversation found...", sai com 1.
import readline from 'node:readline';

const args = process.argv.slice(2);
const i = args.indexOf('--resume');
const resume = i >= 0 ? args[i + 1] : undefined;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (resume === 'sumiu') {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 0, session_id: resume });
  process.stderr.write(`No conversation found with session ID: ${resume}\n`);
  setTimeout(() => process.exit(1), 50);
} else {
  const sid = resume ?? 'sessao-nova';
  let n = 0;
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (++n === 1) out({ type: 'system', subtype: 'init', session_id: sid });
    out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: `eco: ${msg.message.content}` }] } });
    out({ type: 'result', subtype: 'success', is_error: false, session_id: sid, result: 'ok' });
  });
}
