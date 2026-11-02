import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `remoteControlAtStartup` do settings do Claude Code, com a precedência dele: local do projeto > projeto >
 * usuário. O terminal do Claude liga o Remote Control sozinho quando ele está true; o `claude -p` que o duo
 * usa ignora (medido em 02/11/2026, 2.1.316), então é o duo quem liga.
 */
export function remoteControlAtStartup(cwd: string, configDir = defaultConfigDir()): boolean {
  const files = [
    path.join(cwd, '.claude', 'settings.local.json'),
    path.join(cwd, '.claude', 'settings.json'),
    path.join(configDir, 'settings.json'),
  ];
  for (const file of files) {
    const value = readKey(file, 'remoteControlAtStartup');
    if (typeof value === 'boolean') return value;
  }
  return false;
}

function defaultConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Um campo do JSON; arquivo que falta ou não abre não conta. */
function readKey(file: string, key: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))?.[key];
  } catch {
    return undefined;
  }
}
