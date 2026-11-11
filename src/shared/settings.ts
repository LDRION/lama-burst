import type { EffectiveToolMode, ModelInfo, ModelSettings, Settings, ToolMode } from './types';

export const SETTINGS_VERSION = 4;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  ollamaUrl: 'http://localhost:11434',
  systemPrompt: '',
  permissions: { read: 'auto', write: 'ask', run: 'ask' },
  maxSteps: 50,
  maxToolOutputChars: 8000,
  commandTimeoutSec: 300,
  defaultModel: '',
  models: {},
  autoUpdate: true,
  updateDir: '',
};

/** Upgrades settings saved by older versions. */
export function migrateSettings(saved: Partial<Settings>): Partial<Settings> {
  const s = { ...saved };
  // v2: the default command timeout went from 60s to 300s so that package installs can finish.
  if ((s.version ?? 1) < 2 && s.commandTimeoutSec === 60) s.commandTimeoutSec = 300;
  // v3: autonomous tasks (write code, install, run, fix) need more steps than 20.
  if ((s.version ?? 1) < 3 && s.maxSteps === 20) s.maxSteps = 50;
  s.version = SETTINGS_VERSION;
  return s;
}

/** Agentic work fills the context fast; 16k fits a 7–12B model on an 8 GB GPU. */
export const DEFAULT_NUM_CTX = 16384;

export function modelSettings(settings: Settings, name: string, info?: ModelInfo): ModelSettings {
  const own = settings.models[name] ?? {};
  return {
    toolMode: own.toolMode ?? 'auto',
    numCtx: own.numCtx ?? Math.min(info?.contextLength ?? DEFAULT_NUM_CTX, DEFAULT_NUM_CTX),
    temperature: own.temperature ?? 0.3,
  };
}

export function effectiveMode(mode: ToolMode, info: ModelInfo | undefined, hasFolders: boolean): EffectiveToolMode {
  if (!hasFolders || mode === 'off') return 'none';
  if (mode === 'native' || mode === 'text') return mode;
  return info?.capabilities.includes('tools') ? 'native' : 'text';
}

export function shortModelName(name: string): string {
  return (name.replace(/^hf\.co\//, '').split('/').pop() ?? name).replace(/:latest$/, '');
}

export function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    permissions: { ...base.permissions, ...patch.permissions },
    models: { ...base.models, ...patch.models },
  };
}
