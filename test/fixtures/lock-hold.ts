// Outro duo pegando a trava da mesma conversa: tenta, grava o resultado em <saída> e fica vivo (dono, se pegou)
// até o teste o matar. Uso: node --import tsx lock-hold.ts <raiz> <id> <saída>
import fs from 'node:fs';
import { SessionStore } from '../../src/persist.js';

const [root, id, out] = process.argv.slice(2) as [string, string, string];
const result = new SessionStore(root).lock(id);
fs.writeFileSync(out, JSON.stringify({ ...result, me: process.pid }));
setInterval(() => undefined, 1000);
