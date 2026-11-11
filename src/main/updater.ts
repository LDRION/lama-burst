import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Updates from a local folder: electron-builder writes each build to release/<version>/ with
 * a latest.yml next to the installer. The repo is private, so there is no public feed to
 * download from; the app watches the folder the builds land in instead.
 */
export interface UpdateCandidate {
  version: string;
  installer: string;
  sha512: string;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

export function parseLatestYml(text: string): { version: string; path: string; sha512: string } | null {
  const field = (name: string) => text.match(new RegExp(`^${name}:\\s*'?([^'\\r\\n]+)'?\\s*$`, 'm'))?.[1].trim();
  const version = field('version');
  const file = field('path');
  const sha512 = field('sha512');
  return version && file && sha512 ? { version, path: file, sha512 } : null;
}

/** The newest build in the folder (or its subfolders) that is newer than the running version. */
export async function findUpdate(dir: string, current: string): Promise<UpdateCandidate | null> {
  if (!dir) return null;
  const subdirs = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const places = [dir, ...subdirs.filter(d => d.isDirectory()).map(d => path.join(dir, d.name))];
  let best: UpdateCandidate | null = null;
  for (const place of places) {
    const yml = await fs.readFile(path.join(place, 'latest.yml'), 'utf8').catch(() => null);
    const meta = yml ? parseLatestYml(yml) : null;
    if (!meta || compareVersions(meta.version, current) <= 0) continue;
    if (best && compareVersions(meta.version, best.version) <= 0) continue;
    const installer = path.join(place, meta.path);
    if (existsSync(installer)) best = { version: meta.version, installer, sha512: meta.sha512 };
  }
  return best;
}

/** A build that is still being written, or a damaged one, must never be installed. */
export async function verifyInstaller(c: UpdateCandidate): Promise<boolean> {
  return new Promise(resolve => {
    const hash = createHash('sha512');
    createReadStream(c.installer)
      .on('data', d => hash.update(d))
      .on('error', () => resolve(false))
      .on('end', () => resolve(hash.digest('base64') === c.sha512));
  });
}

/** Runs the NSIS installer. Silent mode updates the existing per-user install in place. */
export function runInstaller(installer: string, opts: { silent: boolean; relaunch: boolean }) {
  const args = [...(opts.silent ? ['/S'] : []), ...(opts.relaunch ? ['--force-run'] : [])];
  spawn(installer, args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
}

/** Installed by the NSIS installer (not a win-unpacked copy): only then can it update itself in place. */
export function isInstalled(execPath: string, productName: string): boolean {
  return existsSync(path.join(path.dirname(execPath), `Uninstall ${productName}.exe`));
}
