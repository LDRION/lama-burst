import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, mergeSettings, migrateSettings } from '../shared/settings';
import type { Session, SessionMeta, Settings } from '../shared/types';

function writeJson(file: string, data: unknown) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

export class Store {
  private settingsFile: string;
  private sessionsDir: string;
  private sessions = new Map<string, Session>();
  settings: Settings;

  constructor(dir: string) {
    this.settingsFile = path.join(dir, 'settings.json');
    this.sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    const saved = readJson<Partial<Settings>>(this.settingsFile);
    this.settings = mergeSettings(DEFAULT_SETTINGS, migrateSettings(saved ?? {}));
    if (saved && saved.version !== this.settings.version) writeJson(this.settingsFile, this.settings);
    for (const f of fs.readdirSync(this.sessionsDir)) {
      if (!f.endsWith('.json')) continue;
      const s = readJson<Session>(path.join(this.sessionsDir, f));
      if (s?.id) this.sessions.set(s.id, this.recover(s));
    }
  }

  /** Tool calls interrupted by closing the app must not stay "awaiting" forever. */
  private recover(s: Session): Session {
    for (const item of s.items) {
      if (item.role !== 'assistant') continue;
      for (const t of item.tools) {
        if (t.status === 'queued' || t.status === 'awaiting' || t.status === 'running') {
          t.status = 'denied';
          t.result ??= 'Interrupted: the app was closed.';
        }
      }
    }
    return s;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.settings = mergeSettings(this.settings, patch);
    writeJson(this.settingsFile, this.settings);
    return this.settings;
  }

  list(): SessionMeta[] {
    return [...this.sessions.values()]
      .map(({ items: _items, ...meta }) => meta)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  save(session: Session) {
    session.updatedAt = Date.now();
    this.sessions.set(session.id, session);
    writeJson(path.join(this.sessionsDir, `${session.id}.json`), session);
  }

  delete(id: string) {
    this.sessions.delete(id);
    fs.rmSync(path.join(this.sessionsDir, `${id}.json`), { force: true });
  }
}
