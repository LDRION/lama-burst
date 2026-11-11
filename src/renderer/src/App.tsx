import { useCallback, useEffect, useRef, useState } from 'react';
import { effectiveMode, modelSettings, shortModelName } from '../../shared/settings';
import type {
  AgentEvent,
  ChatItem,
  ModelInfo,
  ProcessInfo,
  ProjectSummary,
  Session,
  SessionMeta,
  Settings,
  UpdateState,
} from '../../shared/types';
import { api, basename, formatTokens } from './api';
import { Chat } from './components/Chat';
import { Composer } from './components/Composer';
import { IconFolder, IconFolderPlus, IconRefresh, IconSpark, IconStop, IconX } from './components/icons';
import { ModelPicker } from './components/ModelPicker';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';

function upsert(s: Session, item: ChatItem): Session {
  const i = s.items.findIndex(x => x.id === item.id);
  const items = i === -1 ? [...s.items, item] : s.items.map((x, j) => (j === i ? item : x));
  return { ...s, items };
}

function applyDelta(s: Session, ev: Extract<AgentEvent, { type: 'delta' }>): Session {
  return {
    ...s,
    items: s.items.map(x =>
      x.id === ev.itemId && x.role === 'assistant'
        ? { ...x, text: x.text + (ev.text ?? ''), thinking: ev.thinking ? (x.thinking ?? '') + ev.thinking : x.thinking }
        : x,
    ),
  };
}

const LIVE_OUTPUT_CHARS = 6000;

function pickDefaultModel(models: ModelInfo[], preferred: string): string {
  if (models.some(m => m.name === preferred)) return preferred;
  return (models.find(m => m.capabilities.includes('tools')) ?? models[0])?.name ?? '';
}

function ContextMeter({ items }: { items: ChatItem[] }) {
  const last = [...items].reverse().find(i => i.role === 'assistant' && i.stats);
  if (!last || last.role !== 'assistant' || !last.stats) return null;
  const used = last.stats.promptTokens + last.stats.outputTokens;
  const pct = Math.min(100, Math.round((used / last.stats.numCtx) * 100));
  return (
    <div
      className={`ctx-meter ${pct > 85 ? 'hot' : ''}`}
      title={`Контекст: ${used.toLocaleString('ru')} из ${last.stats.numCtx.toLocaleString('ru')} токенов`}
    >
      <div className="ctx-bar">
        <div style={{ width: `${pct}%` }} />
      </div>
      <span>
        {formatTokens(used)} / {formatTokens(last.stats.numCtx)}
      </span>
    </div>
  );
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsState, setModelsState] = useState<{ loading: boolean; error?: string }>({ loading: true });
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [draft, setDraft] = useState<{ model: string; folders: string[] }>({ model: '', folders: [] });
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  /** Live output of running commands, by tool call id. */
  const [live, setLive] = useState<Record<string, string>>({});
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const currentId = useRef<string | null>(null);

  const loadModels = useCallback(async () => {
    setModelsState({ loading: true });
    const res = await api.listModels();
    setModels(res.models);
    setModelsState({ loading: false, error: res.ok ? undefined : res.error });
    return res.models;
  }, []);

  useEffect(() => {
    const off = api.onEvent(ev => {
      if (ev.type === 'sessions') setSessions(ev.sessions);
      else if (ev.type === 'settings') setSettings(ev.settings);
      else if (ev.type === 'processes') setProcesses(ev.processes);
      else if (ev.type === 'update') setUpdate(ev.update);
      else if (ev.type === 'busy') setBusy(b => ({ ...b, [ev.sessionId]: ev.busy }));
      else if (ev.type === 'toolOutput') {
        setLive(l => ({ ...l, [ev.toolId]: ((l[ev.toolId] ?? '') + ev.text).slice(-LIVE_OUTPUT_CHARS) }));
      } else if (ev.sessionId === currentId.current) {
        setSession(s => (s ? (ev.type === 'item' ? upsert(s, ev.item) : applyDelta(s, ev)) : s));
      }
    });
    (async () => {
      const [s, list, running, procs] = await Promise.all([
        api.getSettings(),
        api.listSessions(),
        api.runningSessions(),
        api.listProcesses(),
      ]);
      setProcesses(procs);
      api.checkUpdate().then(setUpdate);
      setSettings(s);
      setSessions(list);
      setBusy(Object.fromEntries(running.map(id => [id, true])));
      const ms = await loadModels();
      setDraft(d => ({ ...d, model: pickDefaultModel(ms, s.defaultModel) }));
    })();
    return off;
  }, [loadModels]);

  const model = session?.model ?? draft.model;
  const folders = session?.folders ?? draft.folders;
  const modelInfo = models.find(m => m.name === model);
  const isBusy = !!(session && busy[session.id]);
  const mainFolder = folders[0];

  // Re-read after each run too: the model may have just written LAMA.md or installed dependencies.
  useEffect(() => {
    if (!mainFolder) {
      setProject(null);
      return;
    }
    let alive = true;
    const refresh = () => api.projectInfo(mainFolder).then(p => alive && setProject(p));
    refresh();
    // Files may change outside the app (a project copied into the folder): re-read when the window is back.
    window.addEventListener('focus', refresh);
    return () => {
      alive = false;
      window.removeEventListener('focus', refresh);
    };
  }, [mainFolder, isBusy]);
  const mode = settings
    ? effectiveMode(modelSettings(settings, model, modelInfo).toolMode, modelInfo, folders.length > 0)
    : 'none';

  const guard = async (fn: () => Promise<unknown>) => {
    try {
      setError(null);
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    }
  };

  const changeModel = (name: string) =>
    guard(async () => {
      if (session) {
        await api.updateSession(session.id, { model: name });
        setSession(s => s && { ...s, model: name });
      } else setDraft(d => ({ ...d, model: name }));
      setSettings(await api.updateSettings({ defaultModel: name }));
    });

  const changeFolders = (next: string[]) =>
    guard(async () => {
      if (session) {
        await api.updateSession(session.id, { folders: next });
        setSession(s => s && { ...s, folders: next });
      } else setDraft(d => ({ ...d, folders: next }));
    });

  const addFolders = (paths: string[]) => {
    const next = [...folders];
    for (const p of paths) if (!next.some(f => f.toLowerCase() === p.toLowerCase())) next.push(p);
    if (next.length !== folders.length) changeFolders(next);
  };

  const pickFolders = async () => addFolders(await api.pickFolders());

  const send = (text: string) =>
    guard(async () => {
      let s = session;
      if (!s) {
        s = await api.createSession({ model, folders });
        currentId.current = s.id;
        setSession(s);
      }
      await api.send(s.id, text);
    });

  const openSession = (id: string) =>
    guard(async () => {
      const s = await api.getSession(id);
      currentId.current = s?.id ?? null;
      setSession(s);
    });

  const newChat = useCallback(() => {
    setDraft({ model, folders });
    currentId.current = null;
    setSession(null);
  }, [model, folders]);

  const deleteSession = (id: string) =>
    guard(async () => {
      await api.deleteSession(id);
      if (session?.id === id) newChat();
    });

  const saveSettings = (next: Settings) =>
    guard(async () => {
      const urlChanged = next.ollamaUrl !== settings?.ollamaUrl;
      setSettings(await api.updateSettings(next));
      setSettingsOpen(false);
      if (urlChanged) await loadModels();
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newChat();
      } else if (e.ctrlKey && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newChat]);

  if (!settings) return <div className="boot" />;

  const hint = !model
    ? 'Нет доступной модели'
    : `${shortModelName(model)} · ${
        mode === 'none'
          ? folders.length
            ? 'инструменты выключены'
            : 'без папки — обычный чат'
          : mode === 'native'
            ? 'нативные инструменты'
            : 'инструменты через промпт'
      } · Enter — отправить, Shift+Enter — новая строка`;

  return (
    <div
      className="app"
      onDragOver={e => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={e => {
        if (!e.relatedTarget) setDragging(false);
      }}
      onDrop={async e => {
        e.preventDefault();
        setDragging(false);
        const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
        addFolders(await api.filterFolders(paths));
      }}
    >
      <Sidebar
        sessions={sessions}
        currentId={session?.id ?? null}
        busy={busy}
        ollama={{ ok: !modelsState.error, loading: modelsState.loading, count: models.length }}
        onSelect={openSession}
        onNew={newChat}
        onDelete={deleteSession}
        onSettings={() => setSettingsOpen(true)}
      />

      <main className="main">
        <header className="topbar">
          <ModelPicker models={models} value={model} settings={settings} onChange={changeModel} />
          <div className="folders">
            {folders.map((f, i) => (
              <div key={f} className={`folder-chip ${i === 0 ? 'is-primary' : ''}`} title={`${f}\nНажмите, чтобы открыть в Проводнике`}>
                <button className="folder-open" onClick={() => api.openPath(f)}>
                  <IconFolder size={14} />
                  <span>{basename(f)}</span>
                </button>
                <button className="folder-remove" onClick={() => changeFolders(folders.filter(x => x !== f))} title="Закрыть папку">
                  <IconX size={12} />
                </button>
              </div>
            ))}
            <button className="btn small ghost" onClick={pickFolders} title="Открыть папку">
              <IconFolderPlus size={15} /> {folders.length ? '' : 'Открыть папку'}
            </button>
          </div>
          <div className="spacer" />
          {processes
            .filter(p => p.running && p.sessionId === session?.id)
            .map(p => (
              <div key={p.id} className="proc-chip" title={`Фоновый процесс #${p.id}\n${p.command}`}>
                <span className="proc-dot" />
                <span className="proc-cmd">{p.command}</span>
                <button
                  className="proc-stop"
                  onClick={() => guard(() => api.stopProcess(p.sessionId, p.id))}
                  title="Остановить процесс"
                >
                  <IconStop size={11} />
                </button>
              </div>
            ))}
          {session && <ContextMeter items={session.items} />}
        </header>

        {update?.available && (
          <div className="banner update">
            <IconSpark size={15} />
            <span>
              {update.installed
                ? `Готова новая версия Lama Burst ${update.available} (сейчас ${update.current}). Она установится сама, когда вы закроете приложение.`
                : `Готова версия ${update.available}. Эта копия запущена без установки, поэтому обновляться сама не может: установите Lama Burst один раз, дальше обновления будут ставиться автоматически.`}
            </span>
            <button
              className="btn small primary"
              onClick={() => api.applyUpdate()}
              disabled={Object.values(busy).some(Boolean)}
              title={Object.values(busy).some(Boolean) ? 'Дождитесь, пока модель закончит' : undefined}
            >
              {update.installed ? 'Обновить сейчас' : 'Установить'}
            </button>
          </div>
        )}
        {modelsState.error && (
          <div className="banner error">
            <span>{modelsState.error}</span>
            <button className="btn small" onClick={loadModels}>
              <IconRefresh size={14} /> Повторить
            </button>
          </div>
        )}
        {!modelsState.error && !modelsState.loading && !models.length && (
          <div className="banner">
            В Ollama нет моделей. Скачайте любую в PowerShell, например: <code>ollama pull qwen2.5:7b</code>
            <button className="btn small" onClick={loadModels}>
              <IconRefresh size={14} /> Обновить
            </button>
          </div>
        )}
        {error && (
          <div className="banner error">
            <span>{error}</span>
            <button className="icon-btn" onClick={() => setError(null)}>
              <IconX size={14} />
            </button>
          </div>
        )}

        <Chat
          sessionId={session?.id ?? null}
          items={session?.items ?? []}
          live={live}
          project={project}
          busy={isBusy}
          folders={folders}
          model={model}
          mode={mode}
          settings={settings}
          onPickFolders={pickFolders}
          onSend={send}
        />

        {!folders.length && model && !!session?.items.length && (
          <div className="no-folder">
            <IconFolder size={14} />
            <span>Папка не открыта: модель может только отвечать в чате, создавать и править файлы она не сможет.</span>
            <button className="btn small" onClick={pickFolders}>
              Открыть папку
            </button>
          </div>
        )}

        <Composer
          sessionId={session?.id ?? null}
          disabled={!model}
          busy={isBusy}
          placeholder={folders.length ? `Попросите что-нибудь сделать в «${basename(folders[0])}»…` : 'Напишите сообщение…'}
          hint={hint}
          onSend={send}
          onStop={() => session && api.stop(session.id)}
        />
      </main>

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          update={update}
          model={modelInfo}
          modelName={model}
          onClose={() => setSettingsOpen(false)}
          onSave={saveSettings}
        />
      )}
      {dragging && (
        <div className="drop-overlay">
          <IconFolderPlus size={40} />
          <div>Отпустите, чтобы открыть папку</div>
        </div>
      )}
    </div>
  );
}
