// Monta a página da janela (web/) em dist/gui/public: app.js e app.css, com o React dentro.
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';

const at = (p) => fileURLToPath(new URL(p, import.meta.url));

await esbuild.build({
  entryPoints: { app: at('../web/main.tsx') },
  outdir: at('../dist/gui/public'),
  tsconfig: at('../web/tsconfig.json'),
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2020',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
