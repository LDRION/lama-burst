export type ToolName =
  | 'list_dir'
  | 'read_file'
  | 'search'
  | 'write_file'
  | 'edit_file'
  | 'move_file'
  | 'delete_file'
  | 'run_command'
  | 'start_process'
  | 'process_output'
  | 'stop_process';
export type ToolCategory = 'read' | 'write' | 'run';
export type Permission = 'auto' | 'ask' | 'off';
export type ToolMode = 'auto' | 'native' | 'text' | 'off';
export type EffectiveToolMode = 'native' | 'text' | 'none';

export interface ModelInfo {
  name: string;
  size: number;
  family: string;
  parameterSize: string;
  quantization: string;
  capabilities: string[];
  contextLength?: number;
  stop: string[];
}

export interface ModelSettings {
  toolMode: ToolMode;
  numCtx: number;
  temperature: number;
}

export interface Settings {
  version: number;
  ollamaUrl: string;
  systemPrompt: string;
  permissions: Record<ToolCategory, Permission>;
  maxSteps: number;
  maxToolOutputChars: number;
  commandTimeoutSec: number;
  defaultModel: string;
  models: Record<string, Partial<ModelSettings>>;
  /** Install new builds from the release folder automatically. */
  autoUpdate: boolean;
  /** Where new builds appear; empty means the release folder of the project the app was built from. */
  updateDir: string;
}

export type ToolStatus = 'queued' | 'awaiting' | 'running' | 'done' | 'error' | 'denied';

export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'sep';
  text: string;
}

export type ToolArgs = Record<string, string | number | undefined>;

export interface ToolRun {
  id: string;
  name: ToolName;
  args: ToolArgs;
  status: ToolStatus;
  result?: string;
  diff?: DiffLine[];
  risky?: boolean;
  /** Created by the app from a code block the model only showed in its reply. */
  fromText?: boolean;
}

export interface Stats {
  promptTokens: number;
  outputTokens: number;
  tokensPerSec: number;
  numCtx: number;
}

export interface UserItem {
  id: string;
  role: 'user';
  text: string;
  time: number;
  /** Sent by the app, not typed by the user. */
  auto?: boolean;
  /** Why the app sent it: the model stopped mid-task, gave up after an error, never checked its code, or sent an empty reply. */
  autoReason?: 'continue' | 'fix' | 'verify' | 'retry' | 'write';
  /** Files mentioned in the message, attached so the model doesn't have to look for them. */
  attachments?: Attachment[];
}

export interface Attachment {
  path: string;
  content: string;
  note?: string;
}

/** What the app found out about the open folder by itself, without the model. */
export interface ProjectSummary {
  name: string;
  stack: string[];
  packageManager?: string;
  run: string[];
  checks: string[];
  warnings: string[];
  notesFile?: string;
}

export interface AssistantItem {
  id: string;
  role: 'assistant';
  text: string;
  thinking?: string;
  tools: ToolRun[];
  model: string;
  mode: EffectiveToolMode;
  stats?: Stats;
  error?: string;
  notice?: string;
  time: number;
}

export type ChatItem = UserItem | AssistantItem;

export interface Session {
  id: string;
  title: string;
  model: string;
  folders: string[];
  items: ChatItem[];
  createdAt: number;
  updatedAt: number;
}

export type SessionMeta = Omit<Session, 'items'>;

export type ApprovalDecision = 'allow' | 'always' | 'deny';

export type AgentEvent =
  | { type: 'item'; sessionId: string; item: ChatItem }
  | { type: 'delta'; sessionId: string; itemId: string; text?: string; thinking?: string }
  | { type: 'toolOutput'; sessionId: string; itemId: string; toolId: string; text: string }
  | { type: 'busy'; sessionId: string; busy: boolean }
  | { type: 'sessions'; sessions: SessionMeta[] }
  | { type: 'settings'; settings: Settings }
  | { type: 'processes'; processes: ProcessInfo[] }
  | { type: 'update'; update: UpdateState };

export interface UpdateState {
  current: string;
  /** A newer verified build that is ready to install. */
  available?: string;
  /** Installed with the installer; a win-unpacked copy can't update itself in place. */
  installed: boolean;
  /** Folder that is checked for new builds. */
  dir: string;
}

export interface ProcessInfo {
  sessionId: string;
  id: number;
  command: string;
  running: boolean;
  exitCode: number | null;
  startedAt: number;
}

export interface ModelsResult {
  ok: boolean;
  models: ModelInfo[];
  error?: string;
}
