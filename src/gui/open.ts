import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Navegadores que abrem em modo app (janela própria, sem abas nem barra de endereço), na ordem de preferência. */
function appBrowsers(): string[] {
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA];
    return roots
      .filter((r): r is string => Boolean(r))
      .flatMap((r) => [
        path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]);
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
}

/**
 * Abre a janela do duo: Edge ou Chrome em modo app; sem nenhum dos dois, o navegador padrão.
 * Não espera nem acompanha: a janela continua aberta se o duo fechar, e o endereço também fica no terminal.
 */
export function openWindow(url: string): void {
  const exe = appBrowsers().find((p) => fs.existsSync(p));
  const [cmd, args, verbatim]: [string, string[], boolean] = exe
    ? [exe, [`--app=${url}`, '--window-size=1440,900'], false]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url], true]
      : process.platform === 'darwin'
        ? ['open', [url], false]
        : ['xdg-open', [url], false];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: verbatim });
  child.on('error', () => undefined);
  child.unref();
}
