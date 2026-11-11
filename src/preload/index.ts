import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  AgentEvent,
  ApprovalDecision,
  ModelsResult,
  ProcessInfo,
  ProjectSummary,
  Session,
  SessionMeta,
  Settings,
  UpdateState,
} from '../shared/types';

const api = {
  listModels: (): Promise<ModelsResult> => ipcRenderer.invoke('models:list'),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:update', patch),

  listSessions: (): Promise<SessionMeta[]> => ipcRenderer.invoke('sessions:list'),
  getSession: (id: string): Promise<Session | null> => ipcRenderer.invoke('sessions:get', id),
  runningSessions: (): Promise<string[]> => ipcRenderer.invoke('sessions:running'),
  createSession: (init: { model: string; folders: string[] }): Promise<Session> =>
    ipcRenderer.invoke('sessions:create', init),
  updateSession: (id: string, patch: Partial<Pick<Session, 'model' | 'folders' | 'title'>>): Promise<void> =>
    ipcRenderer.invoke('sessions:update', id, patch),
  deleteSession: (id: string): Promise<void> => ipcRenderer.invoke('sessions:delete', id),

  send: (sessionId: string, text: string): Promise<void> => ipcRenderer.invoke('agent:send', sessionId, text),
  stop: (sessionId: string): Promise<void> => ipcRenderer.invoke('agent:stop', sessionId),
  approve: (toolId: string, decision: ApprovalDecision): Promise<void> =>
    ipcRenderer.invoke('agent:approve', toolId, decision),

  projectInfo: (folder: string): Promise<ProjectSummary | null> => ipcRenderer.invoke('project:info', folder),
  checkUpdate: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  applyUpdate: (): Promise<void> => ipcRenderer.invoke('update:apply'),
  listProcesses: (): Promise<ProcessInfo[]> => ipcRenderer.invoke('processes:list'),
  stopProcess: (sessionId: string, id: number): Promise<string> => ipcRenderer.invoke('processes:stop', sessionId, id),

  pickFolders: (): Promise<string[]> => ipcRenderer.invoke('folders:pick'),
  filterFolders: (paths: string[]): Promise<string[]> => ipcRenderer.invoke('folders:filter', paths),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('shell:openPath', p),

  onEvent: (cb: (ev: AgentEvent) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, ev: AgentEvent) => cb(ev);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
};

export type Api = typeof api;

contextBridge.exposeInMainWorld('api', api);
