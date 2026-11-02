import { describe, expect, it } from 'vitest';
import { CodexAgent, shortenCommand } from '../src/agents/codex.js';

describe('CodexAgent.threadParams', () => {
  it('por padrão roda livre: sem aprovações e sem sandbox', () => {
    expect(new CodexAgent({ cwd: 'C:\\x' }).threadParams()).toEqual({
      cwd: 'C:\\x',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
  });

  it('com --codex-sandbox fica restrito ao modo escolhido, ainda sem perguntar nada', () => {
    const params = new CodexAgent({ sandbox: 'workspace-write' }).threadParams();
    expect(params).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'never' });
  });
});

describe('shortenCommand', () => {
  it('tira o invólucro do PowerShell', () => {
    expect(shortenCommand(`"C:\\WINDOWS\\powershell.exe" -Command 'echo oi'`)).toBe('echo oi');
    expect(shortenCommand(`"C:\\WINDOWS\\powershell.exe" -Command "Get-Content 'a.txt'"`)).toBe(`Get-Content 'a.txt'`);
    expect(shortenCommand(`"C:\\WINDOWS\\system32\\cmd.exe" /c 'dir /a'`)).toBe('dir /a');
    expect(shortenCommand('git status')).toBe('git status');
  });
});
