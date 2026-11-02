import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { remoteControlAtStartup } from '../src/claudeSettings.js';

function setup(files: Record<string, unknown>): { cwd: string; configDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duo-settings-'));
  const cwd = path.join(root, 'projeto');
  const configDir = path.join(root, 'config');
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return { cwd, configDir };
}

describe('remoteControlAtStartup', () => {
  it('segue o settings do usuário', () => {
    const { cwd, configDir } = setup({ 'config/settings.json': { remoteControlAtStartup: true } });
    expect(remoteControlAtStartup(cwd, configDir)).toBe(true);
  });

  it('sem nada configurado, desligado', () => {
    const { cwd, configDir } = setup({ 'config/settings.json': { model: 'x' } });
    expect(remoteControlAtStartup(cwd, configDir)).toBe(false);
  });

  it('o projeto vence o usuário, e o local vence o projeto', () => {
    const user = { 'config/settings.json': { remoteControlAtStartup: true } };
    const project = { 'projeto/.claude/settings.json': { remoteControlAtStartup: false } };
    const local = { 'projeto/.claude/settings.local.json': { remoteControlAtStartup: true } };
    let s = setup({ ...user, ...project });
    expect(remoteControlAtStartup(s.cwd, s.configDir)).toBe(false);
    s = setup({ ...user, ...project, ...local });
    expect(remoteControlAtStartup(s.cwd, s.configDir)).toBe(true);
  });

  it('arquivo quebrado não derruba nada: vale o próximo', () => {
    const { cwd, configDir } = setup({
      'projeto/.claude/settings.json': '{ quebrado',
      'config/settings.json': { remoteControlAtStartup: true },
    });
    expect(remoteControlAtStartup(cwd, configDir)).toBe(true);
  });
});
