import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImageInput } from '../agents/types.js';
import { cleanAnswers, type Duo, type DuoState } from '../core.js';
import { NAMES } from '../display.js';
import type { ModelBody, ServerEvents, Snapshot, Status } from './protocol.js';

/**
 * A janela do duo: um servidor só para este computador (127.0.0.1) que entrega a página e liga ela ao duo.
 * Os agentes rodam comandos na sua máquina, então quem fala com este servidor manda neles. Por isso:
 * - a chave de acesso vai no endereço que o duo abre; ela vira um cookie HttpOnly e SameSite=Strict e sai do endereço;
 * - sem o cookie certo, nada responde (nem a página);
 * - o Host tem de ser 127.0.0.1 ou localhost nesta porta: um site com DNS apontado para cá não passa;
 * - POST só com o Origin desta página e corpo JSON: um formulário de outro site não passa;
 * - a página não roda script de fora nem embutido (CSP), e mostra o que os agentes escrevem como texto, nunca HTML;
 * - print colado só entra se o conteúdo for mesmo uma imagem do tipo declarado, e volta só por um nome aleatório.
 */

/** Onde o `npm run build` deixa a página montada. Vale rodando de src/gui (tsx) ou de dist/gui. */
export const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/gui/public');

const PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>duo</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="/app.js"></script>
</body>
</html>
`;

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const MAX_BODY = 1_000_000;
const KEEPALIVE_MS = 15_000;

/** Prints por mensagem, e o tamanho de cada um: em base64 cabe nos 5 MB por imagem do Claude. */
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 3_750_000;
/** a mensagem com os prints (base64 cresce 4/3) */
const MAX_SUBMIT_BODY = MAX_BODY + Math.ceil((MAX_IMAGES * MAX_IMAGE_BYTES * 4) / 3);

/** O tipo de cada imagem aceita: a extensão do arquivo e como o arquivo começa. */
const IMAGE_TYPES: Record<ImageInput['mediaType'], { ext: string; magic: (b: Buffer) => boolean }> = {
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/gif': { ext: 'gif', magic: (b) => /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1')) },
  'image/webp': {
    ext: 'webp',
    magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
};
const IMAGE_NAME = /^\/imagem\/([0-9a-f]{32}\.(png|jpg|gif|webp))$/;
const EXT_TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export interface GuiOptions {
  /** onde estão o app.js e o app.css (padrão: PUBLIC_DIR) */
  publicDir?: string;
  /** a chave de acesso (padrão: uma aleatória) */
  token?: string;
  /** a porta (padrão: uma livre) */
  port?: number;
  /** onde ficam os prints colados (padrão: uma pasta no temp do sistema) */
  imagesDir?: string;
}

export interface Gui {
  /** o endereço com a chave: é por ele que a janela entra */
  url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function loadFiles(dir: string): Record<string, { body: Buffer; type: string }> {
  const read = (name: string, type: string) => {
    const file = path.join(dir, name);
    try {
      return { body: fs.readFileSync(file), type };
    } catch {
      throw new Error(`a janela do duo não foi montada (falta ${file}): rode npm run build`);
    }
  };
  return {
    '/app.js': read('app.js', 'text/javascript; charset=utf-8'),
    '/app.css': read('app.css', 'text/css; charset=utf-8'),
  };
}

function cookieOf(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function readJson(req: http.IncomingMessage, max: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        reject(new HttpError(413, 'mensagem grande demais'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'corpo não é JSON'));
      }
    });
    req.on('error', reject);
  });
}

const statusOf = (s: DuoState): Status => ({
  target: s.target,
  shared: s.shared,
  busy: s.busy,
  asks: s.asks,
  stats: s.stats,
  brain: s.brain,
  tasks: s.tasks,
  runningSince: s.runningSince,
  lastSignal: s.lastSignal,
  tools: s.tools,
  peerWait: s.peerWait,
  stopping: s.stopping,
});

/** O pedido do seletor: de quem, e ao menos uma coisa a trocar. Se o agente oferece aquilo, o duo confere. */
function isModelBody(body: any): body is ModelBody {
  const optional = (v: unknown, type: 'string' | 'boolean') =>
    v === undefined || (typeof v === type && (type === 'boolean' || ((v as string).length > 0 && (v as string).length <= 200)));
  return (
    (body?.agent === 'claude' || body?.agent === 'codex') &&
    optional(body.model, 'string') &&
    optional(body.effort, 'string') &&
    optional(body.fast, 'boolean') &&
    (body.model !== undefined || body.effort !== undefined || body.fast !== undefined)
  );
}

/** Um objeto de textos (as respostas, pergunta → resposta). Se servem às perguntas, o duo confere. */
function isTextRecord(v: unknown): v is Record<string, string> {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((a) => typeof a === 'string')
  );
}

/** Confere os prints que vieram na mensagem e devolve cada um decodificado. Nada é gravado aqui. */
function parseImages(raw: unknown): { type: ImageInput['mediaType']; body: Buffer }[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_IMAGES) {
    throw new HttpError(400, `no máximo ${MAX_IMAGES} prints por mensagem`);
  }
  return raw.map((img) => {
    const type = img?.mediaType as ImageInput['mediaType'];
    if (!Object.hasOwn(IMAGE_TYPES, type) || typeof img?.data !== 'string' || !BASE64.test(img.data)) {
      throw new HttpError(400, 'print inválido');
    }
    const body = Buffer.from(img.data, 'base64');
    if (body.length === 0 || body.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'print grande demais');
    if (!IMAGE_TYPES[type].magic(body)) throw new HttpError(400, 'o print não é uma imagem do tipo que diz ser');
    return { type, body };
  });
}

/** Sobe o servidor da janela e liga ele ao duo. Quem chama decide quando abrir a janela e chamar `duo.start()`. */
export async function startGui(duo: Duo, opts: GuiOptions = {}): Promise<Gui> {
  const files = loadFiles(opts.publicDir ?? PUBLIC_DIR);
  const token = opts.token ?? randomBytes(32).toString('hex');
  const imagesDir = opts.imagesDir ?? path.join(os.tmpdir(), 'duo-imagens');
  const clients = new Set<http.ServerResponse>();
  let port = 0;

  const sameToken = (value: string | null | undefined) =>
    typeof value === 'string' &&
    value.length === token.length &&
    timingSafeEqual(Buffer.from(value), Buffer.from(token));

  const send = <K extends keyof ServerEvents>(res: http.ServerResponse, name: K, data: ServerEvents[K]) => {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcast = <K extends keyof ServerEvents>(name: K, data: ServerEvents[K]) => {
    for (const res of clients) send(res, name, data);
  };
  const snapshot = (): Snapshot => ({
    ...duo.getState(),
    names: { claude: NAMES.claude, codex: NAMES.codex }, // o nome da tela (Cla e Fog), não o do produto
    cwd: duo.cwd,
  });

  let lastCommands = duo.getState().commands;
  let lastModels = duo.getState().models;
  let lastStatus = JSON.stringify(statusOf(duo.getState()));
  const off = duo.subscribe((ev) => {
    switch (ev.type) {
      case 'entry':
        broadcast('entry', ev.entry);
        return;
      case 'clear':
        broadcast('clear', null);
        return;
      case 'change': {
        const state = duo.getState();
        if (state.commands !== lastCommands) {
          lastCommands = state.commands;
          broadcast('commands', state.commands);
        }
        if (state.models !== lastModels) {
          lastModels = state.models;
          broadcast('models', state.models);
        }
        const status = JSON.stringify(statusOf(state));
        if (status !== lastStatus) {
          lastStatus = status;
          broadcast('status', statusOf(state));
        }
        return;
      }
      case 'quit':
        broadcast('quit', null);
        for (const res of clients) res.end();
        clients.clear();
        return;
    }
  });

  const keepalive = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, KEEPALIVE_MS);
  keepalive.unref();

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'endereço não permitido');
    const url = new URL(req.url ?? '/', `http://${host}`);
    const cookie = `duo-${port}`;

    // A chave no endereço vira o cookie, e a página volta sem ela (não fica no histórico nem na barra).
    if (req.method === 'GET' && url.searchParams.has('t')) {
      if (!sameToken(url.searchParams.get('t'))) throw new HttpError(403, 'chave errada');
      res.writeHead(303, {
        ...SECURITY_HEADERS,
        'Set-Cookie': `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        Location: '/',
      });
      res.end();
      return;
    }
    if (!sameToken(cookieOf(req, cookie))) {
      throw new HttpError(403, 'sem acesso: abra pelo endereço que o duo mostrou no terminal');
    }

    if (req.method === 'GET') {
      if (url.pathname === '/') {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
      }
      const file = files[url.pathname];
      if (file) {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': file.type });
        res.end(file.body);
        return;
      }
      const image = url.pathname.match(IMAGE_NAME);
      if (image) {
        let body: Buffer;
        try {
          body = fs.readFileSync(path.join(imagesDir, image[1]));
        } catch {
          throw new HttpError(404, 'esse print não existe mais');
        }
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': EXT_TYPE[image[2]] });
        res.end(body);
        return;
      }
      if (url.pathname === '/events') {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8' });
        send(res, 'snapshot', snapshot());
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      throw new HttpError(404, 'não existe');
    }

    if (req.method === 'POST') {
      if (req.headers.origin !== `http://${host}`) throw new HttpError(403, 'origem não permitida');
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
        throw new HttpError(415, 'o corpo tem de ser JSON');
      }
      const body = await readJson(req, url.pathname === '/api/submit' ? MAX_SUBMIT_BODY : MAX_BODY);
      let ok: boolean;
      if (url.pathname === '/api/submit' && typeof body?.text === 'string') {
        // os prints vão para o disco: o Codex lê pelo caminho, o Claude recebe o conteúdo, e a janela mostra de novo
        const pasted = parseImages(body.images);
        const images: ImageInput[] = [];
        // a mensagem não foi (comando recusado, ou o disco falhou no meio): não fica print solto
        const drop = () => images.forEach((img) => fs.rmSync(img.path, { force: true }));
        try {
          if (pasted.length > 0) fs.mkdirSync(imagesDir, { recursive: true });
          for (const { type, body: content } of pasted) {
            const file = path.join(imagesDir, `${randomBytes(16).toString('hex')}.${IMAGE_TYPES[type].ext}`);
            images.push({ path: file, mediaType: type }); // antes de gravar: um arquivo pela metade também sai
            fs.writeFileSync(file, content);
          }
          ok = duo.submit(body.text, images);
        } catch (err) {
          drop();
          throw err;
        }
        if (!ok) drop();
      } else if (
        url.pathname === '/api/answer' &&
        Number.isInteger(body?.id) &&
        typeof body?.ok === 'boolean' &&
        (body.answers === undefined || isTextRecord(body.answers))
      ) {
        // Responder uma pergunta com opções pede uma resposta para cada uma, e nenhuma a mais: o que não serve é pedido
        // inválido (400). Já respondido (aqui ou no terminal) ou cancelado continua sendo { ok: false }.
        const ask = duo.getState().asks.find((a) => a.id === body.id);
        if (ask?.questions && body.ok && !cleanAnswers(ask.questions, body.answers)) {
          throw new HttpError(400, 'as respostas não servem às perguntas: responda cada uma');
        }
        ok = duo.answer(body.id, body.ok, body.answers);
      } else if (url.pathname === '/api/parar' && (body?.agent === 'claude' || body?.agent === 'codex')) {
        void duo.interrupt(body.agent);
        ok = true;
      } else if (url.pathname === '/api/modelo' && isModelBody(body)) {
        const { agent, model, effort, fast } = body;
        void duo.setModel(agent, { model, effort, fast });
        ok = true;
      } else {
        throw new HttpError(400, 'pedido inválido');
      }
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
      return;
    }

    throw new HttpError(405, 'método não permitido');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) {
        res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end(err instanceof HttpError ? err.message : 'erro no duo');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    close: () =>
      new Promise<void>((resolve) => {
        off();
        clearInterval(keepalive);
        for (const res of clients) res.end();
        clients.clear();
        server.close(() => resolve());
        server.closeIdleConnections();
        setTimeout(() => server.closeAllConnections(), 1000).unref();
      }),
  };
}
