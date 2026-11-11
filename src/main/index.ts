import { BrowserWindow, app, dialog, ipcMain, nativeTheme, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import icon from '../../resources/icon.png?asset';
import type {
  AgentEvent,
  ApprovalDecision,
  AssistantItem,
  ModelsResult,
  ProjectSummary,
  Session,
  Settings,
  UpdateState,
  UserItem,
} from '../shared/types';
import { runAgent, type AgentHost } from './agent';
import { Ollama } from './ollama';
import { ProcessManager } from './processes';
import { scanProject } from './project';
import { Store } from './store';
import { type UpdateCandidate, findUpdate, isInstalled, runInstaller, verifyInstaller } from './updater';

const NEW_CHAT_TITLE = 'Новый чат';

let win: BrowserWindow | null = null;
let store: Store;
let ollama: Ollama;
const running = new Map<string, AbortController>();
const approvals = new Map<string, { sessionId: string; resolve: (d: ApprovalDecision) => void }>();

function emit(ev: AgentEvent) {
  if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev);
}

const processes = new ProcessManager(() => emit({ type: 'processes', processes: processes.list() }));

const UPDATE_CHECK_MS = 60_000;
let pendingUpdate: UpdateCandidate | null = null;
let installingUpdate = false;

function updateState(): UpdateState {
  return {
    current: app.getVersion(),
    available: pendingUpdate?.version,
    installed: isInstalled(process.execPath, app.getName()),
    dir: store.settings.updateDir || __RELEASE_DIR__,
  };
}

/** Looks for a newer verified build; runs every minute, and the user can trigger it from the settings. */
async function checkForUpdate(): Promise<UpdateState> {
  if (!app.isPackaged) return updateState();
  const found = await findUpdate(updateState().dir, app.getVersion()).catch(() => null);
  if (!found) pendingUpdate = null;
  else if (found.version !== pendingUpdate?.version && (await verifyInstaller(found))) pendingUpdate = found;
  const state = updateState();
  emit({ type: 'update', update: state });
  return state;
}

function emitSessions() {
  emit({ type: 'sessions', sessions: store.list() });
}

const host: AgentHost = {
  get ollama() {
    return ollama;
  },
  settings: () => store.settings,
  emit,
  save: s => store.save(s),
  trash: p => shell.trashItem(p),
  processes,
  approve: (sessionId, run) =>
    new Promise(resolve => {
      approvals.set(run.id, { sessionId, resolve });
      if (win && !win.isFocused()) win.flashFrame(true);
    }),
  allowAlways: category => {
    const settings = store.updateSettings({ permissions: { ...store.settings.permissions, [category]: 'auto' } });
    emit({ type: 'settings', settings });
  },
};

function denyPending(sessionId: string) {
  for (const [id, a] of approvals) {
    if (a.sessionId !== sessionId) continue;
    approvals.delete(id);
    a.resolve('deny');
  }
}

function startAgent(session: Session) {
  const ac = new AbortController();
  running.set(session.id, ac);
  emit({ type: 'busy', sessionId: session.id, busy: true });
  runAgent(session, host, ac.signal)
    .catch(e => {
      const item: AssistantItem = {
        id: randomUUID(),
        role: 'assistant',
        text: '',
        tools: [],
        model: session.model,
        mode: 'none',
        error: e instanceof Error ? e.message : String(e),
        time: Date.now(),
      };
      session.items.push(item);
      emit({ type: 'item', sessionId: session.id, item });
    })
    .finally(() => {
      running.delete(session.id);
      denyPending(session.id);
      store.save(session);
      emit({ type: 'busy', sessionId: session.id, busy: false });
      emitSessions();
    });
}

function requireSession(id: string): Session {
  const s = store.get(id);
  if (!s) throw new Error('Чат не найден');
  return s;
}

function registerIpc() {
  ipcMain.handle('models:list', async (): Promise<ModelsResult> => {
    try {
      return { ok: true, models: await ollama.listModels() };
    } catch (e) {
      return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.handle('settings:get', () => store.settings);
  ipcMain.handle('settings:update', (_e, patch: Partial<Settings>) => store.updateSettings(patch));

  ipcMain.handle('sessions:list', () => store.list());
  ipcMain.handle('sessions:get', (_e, id: string) => store.get(id) ?? null);
  ipcMain.handle('sessions:running', () => [...running.keys()]);
  ipcMain.handle('sessions:create', (_e, init: { model: string; folders: string[] }) => {
    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      title: NEW_CHAT_TITLE,
      model: init.model,
      folders: init.folders,
      items: [],
      createdAt: now,
      updatedAt: now,
    };
    store.save(session);
    emitSessions();
    return session;
  });
  ipcMain.handle('sessions:update', (_e, id: string, patch: Partial<Pick<Session, 'model' | 'folders' | 'title'>>) => {
    const s = requireSession(id);
    Object.assign(s, patch);
    store.save(s);
    emitSessions();
  });
  ipcMain.handle('sessions:delete', (_e, id: string) => {
    running.get(id)?.abort();
    denyPending(id);
    processes.stopSession(id);
    store.delete(id);
    emitSessions();
  });

  ipcMain.handle('agent:send', (_e, sessionId: string, text: string) => {
    const session = requireSession(sessionId);
    if (running.has(sessionId)) throw new Error('Модель ещё отвечает');
    const item: UserItem = { id: randomUUID(), role: 'user', text, time: Date.now() };
    session.items.push(item);
    if (session.title === NEW_CHAT_TITLE) session.title = text.replace(/\s+/g, ' ').trim().slice(0, 60);
    store.save(session);
    emit({ type: 'item', sessionId, item });
    emitSessions();
    startAgent(session);
  });
  ipcMain.handle('agent:stop', (_e, sessionId: string) => {
    running.get(sessionId)?.abort();
    denyPending(sessionId);
  });
  ipcMain.handle('agent:approve', (_e, toolId: string, decision: ApprovalDecision) => {
    const a = approvals.get(toolId);
    approvals.delete(toolId);
    a?.resolve(decision);
  });

  ipcMain.handle('folders:pick', async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'multiSelections'] });
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle('folders:filter', (_e, paths: string[]) =>
    paths.filter(p => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    }),
  );
  ipcMain.handle('project:info', async (_e, folder: string): Promise<ProjectSummary | null> => {
    const p = await scanProject(folder).catch(() => null);
    if (!p) return null;
    const { name, stack, packageManager, run, checks, warnings, notesFile } = p;
    return { name, stack, packageManager, run, checks, warnings, notesFile };
  });
  ipcMain.handle('processes:list', () => processes.list());
  ipcMain.handle('processes:stop', (_e, sessionId: string, id: number) => processes.stop(sessionId, id));
  ipcMain.handle('shell:openPath', (_e, p: string) => shell.openPath(p));

  ipcMain.handle('update:check', () => checkForUpdate());
  ipcMain.handle('update:apply', () => {
    if (!pendingUpdate) return;
    installingUpdate = true;
    // An installed copy updates in place silently; a win-unpacked copy gets the normal installer once.
    runInstaller(pendingUpdate.installer, { silent: updateState().installed, relaunch: true });
    app.quit();
  });
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'Lama Burst',
    icon,
    backgroundColor: dark ? '#131316' : '#f7f7f5',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenu(null);
  win.once('ready-to-show', () => win?.show());
  win.on('focus', () => win?.flashFrame(false));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools();
  });

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

// Portable mode / isolated test runs: keep settings and chats in a custom folder.
if (process.env.LAMA_BURST_DATA) app.setPath('userData', path.resolve(process.env.LAMA_BURST_DATA));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.ldrion.lamaburst');
    store = new Store(app.getPath('userData'));
    ollama = new Ollama(() => store.settings.ollamaUrl);
    registerIpc();
    createWindow();
    setTimeout(checkForUpdate, 5000);
    setInterval(checkForUpdate, UPDATE_CHECK_MS);
  });

  app.on('window-all-closed', () => app.quit());

  // Not window-all-closed: it is skipped when the app quits by app.quit(), leaving servers orphaned.
  app.on('will-quit', () => {
    for (const ac of running.values()) ac.abort();
    processes.stopAll();
    // Like browsers: a downloaded update is installed quietly when the app closes.
    if (pendingUpdate && !installingUpdate && store.settings.autoUpdate && updateState().installed) {
      runInstaller(pendingUpdate.installer, { silent: true, relaunch: false });
    }
  });
}
