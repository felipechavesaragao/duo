import { spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { killTree } from '../src/agents/process.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('killTree', () => {
  it('encerra um processo que não sairia sozinho, e não reclama de processo que já saiu', async () => {
    const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise((r) => proc.once('spawn', r));
    const exited = new Promise((r) => proc.once('exit', r));
    killTree(proc);
    await expect(Promise.race([exited.then(() => 'saiu'), new Promise((r) => setTimeout(() => r('vivo'), 5000))])).resolves.toBe(
      'saiu',
    );
    expect(() => killTree(proc)).not.toThrow();
  });

  it.skipIf(process.platform !== 'win32')('no Windows, leva a árvore junto: o neto também morre (codex.cmd → node)', async () => {
    const child = `const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      console.log(c.pid); setInterval(() => {}, 1000);`;
    const proc = spawn(process.execPath, ['-e', child], { stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = Number(await new Promise<string>((r) => proc.stdout!.once('data', (d) => r(String(d).trim()))));
    try {
      expect(alive(grandchild)).toBe(true);
      killTree(proc);
      await vi.waitFor(() => expect(alive(grandchild)).toBe(false), { timeout: 5000 });
    } finally {
      if (alive(grandchild)) process.kill(grandchild);
    }
  });
});
