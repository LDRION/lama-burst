import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compareVersions, findUpdate, isInstalled, parseLatestYml, verifyInstaller } from './updater';

function release(dir: string, version: string, content = `installer ${version}`, sha?: string) {
  const sub = path.join(dir, version);
  fs.mkdirSync(sub, { recursive: true });
  const file = `Lama-Burst-Setup-${version}.exe`;
  fs.writeFileSync(path.join(sub, file), content);
  const sha512 = sha ?? createHash('sha512').update(content).digest('base64');
  fs.writeFileSync(
    path.join(sub, 'latest.yml'),
    `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: ${sha512}\n    size: 10\npath: ${file}\nsha512: ${sha512}\nreleaseDate: '2026-10-13T19:38:14.923Z'\n`,
  );
  return path.join(sub, file);
}

describe('updater', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('0.3.1', '0.3.1')).toBe(0);
    expect(compareVersions('1.0', '1.0.1')).toBe(-1);
  });

  it('parses latest.yml from electron-builder', () => {
    expect(parseLatestYml("version: 0.3.1\npath: Lama-Burst-Setup-0.3.1.exe\nsha512: abc==\nreleaseDate: '2026'\n")).toEqual({
      version: '0.3.1',
      path: 'Lama-Burst-Setup-0.3.1.exe',
      sha512: 'abc==',
    });
  });

  it('finds the newest build that is newer than the running one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lama-burst-rel-'));
    release(dir, '0.3.1');
    const newest = release(dir, '0.10.0');
    release(dir, '0.4.0');
    expect(await findUpdate(dir, '0.3.1')).toMatchObject({ version: '0.10.0', installer: newest });
    expect(await findUpdate(dir, '0.10.0')).toBeNull();
    expect(await findUpdate(path.join(dir, 'missing'), '0.1.0')).toBeNull();
  });

  it('rejects an installer whose checksum does not match', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lama-burst-rel-'));
    release(dir, '1.0.0', 'complete installer');
    release(dir, '2.0.0', 'half-written', 'wrong==');
    const good = await findUpdate(dir, '0.9.0');
    expect(good?.version).toBe('2.0.0');
    expect(await verifyInstaller(good!)).toBe(false);
    expect(await verifyInstaller((await findUpdate(path.join(dir, '1.0.0'), '0.9.0'))!)).toBe(true);
  });

  it('tells an installed copy from an unpacked one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lama-burst-inst-'));
    const exe = path.join(dir, 'Lama Burst.exe');
    expect(isInstalled(exe, 'Lama Burst')).toBe(false);
    fs.writeFileSync(path.join(dir, 'Uninstall Lama Burst.exe'), '');
    expect(isInstalled(exe, 'Lama Burst')).toBe(true);
  });
});
