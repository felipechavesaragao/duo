import { describe, expect, it } from 'vitest';
import { CodexAgent, shortenCommand } from '../src/agents/codex.js';

describe('CodexAgent.buildArgs', () => {
  it('por padrão roda livre: sem sandbox e sem aprovações', () => {
    const args = new CodexAgent({}).buildArgs();
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--sandbox');
    expect(args.at(-1)).toBe('-'); // prompt vem pelo stdin
  });

  it('com --codex-sandbox fica restrito ao modo escolhido', () => {
    const args = new CodexAgent({ sandbox: 'workspace-write' }).buildArgs();
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write']));
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
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
