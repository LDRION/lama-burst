import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { ProcessManager } from './processes';

describe('ProcessManager', () => {
  it('runs a command in the background, shows its output and stops it', async () => {
    let changes = 0;
    const pm = new ProcessManager(() => changes++);
    const started = await pm.start(
      's1',
      os.tmpdir(),
      'Write-Output "server ready"; while ($true) { Start-Sleep -Milliseconds 200 }',
      2500,
      4000,
    );
    expect(started).toContain('Started process #1');
    expect(started).toContain('server ready');
    expect(pm.list('s1')).toMatchObject([{ id: 1, running: true }]);
    expect(await pm.output('s1', 1, 4000)).toMatch(/still running \(for \d+s so far\)/);

    expect(await pm.stop('s1', 1)).toBe('Stopped process #1.');
    expect(pm.list('s1')[0].running).toBe(false);
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it('reports a command that exits right away, numbering per chat', async () => {
    const pm = new ProcessManager();
    await pm.start('a', os.tmpdir(), 'exit 0', 5000, 4000);
    const out = await pm.start('a', os.tmpdir(), 'Write-Error "port in use"; exit 1', 5000, 4000);
    expect(out).toContain('Process #2 already exited with code 1');
    expect(out).toContain('port in use');
    expect((await pm.start('b', os.tmpdir(), 'exit 0', 5000, 4000)).startsWith('Process #1')).toBe(true);
  });

  it('stops a node server together with its PowerShell parent', async () => {
    const pm = new ProcessManager();
    const out = await pm.start(
      'n',
      os.tmpdir(),
      'node -e "require(\'http\').createServer((q, s) => s.end(\'ok\')).listen(0, () => console.log(\'up\'))"',
      3000,
      4000,
    );
    expect(out).toContain('up');
    const started = Date.now();
    expect(await pm.stop('n', 1)).toBe('Stopped process #1.');
    expect(Date.now() - started).toBeLessThan(4000);
    expect(pm.list('n')[0].running).toBe(false);
  });

  it('waits for a long process to finish when asked', async () => {
    const pm = new ProcessManager();
    await pm.start('w', os.tmpdir(), 'Start-Sleep -Seconds 2; Write-Output finished', 300, 4000);
    const started = Date.now();
    const seen: string[] = [];
    const out = await pm.output('w', 1, 4000, 30, undefined, t => seen.push(t));
    expect(seen.join('')).toContain('finished');
    expect(out).toContain('exited with code 0');
    expect(out).toContain('finished');
    expect(Date.now() - started).toBeLessThan(10000);
  });

  it('stops waiting when the user presses stop', async () => {
    const pm = new ProcessManager();
    await pm.start('a', os.tmpdir(), 'Start-Sleep -Seconds 30', 300, 4000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const started = Date.now();
    expect(await pm.output('a', 1, 4000, 60, ac.signal)).toContain('still running');
    expect(Date.now() - started).toBeLessThan(5000);
    await pm.stop('a', 1);
  });

  it('explains unknown process ids', async () => {
    const pm = new ProcessManager();
    await expect(pm.output('s', 7, 100)).rejects.toThrow(/No process #7. No processes were started/);
  });
});
