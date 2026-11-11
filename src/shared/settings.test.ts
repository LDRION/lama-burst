import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_VERSION, mergeSettings, migrateSettings } from './settings';

describe('migrateSettings', () => {
  it('raises the old default command timeout', () => {
    expect(migrateSettings({ commandTimeoutSec: 60 })).toEqual({ commandTimeoutSec: 300, version: SETTINGS_VERSION });
  });

  it('raises the old default step limit', () => {
    expect(migrateSettings({ version: 2, maxSteps: 20 }).maxSteps).toBe(50);
    expect(migrateSettings({ version: 2, maxSteps: 30 }).maxSteps).toBe(30);
  });

  it('keeps a timeout the user chose', () => {
    expect(migrateSettings({ commandTimeoutSec: 120 }).commandTimeoutSec).toBe(120);
    expect(migrateSettings({ version: 2, commandTimeoutSec: 60 }).commandTimeoutSec).toBe(60);
  });

  it('gives a fresh install the defaults', () => {
    expect(mergeSettings(DEFAULT_SETTINGS, migrateSettings({}))).toEqual(DEFAULT_SETTINGS);
  });
});
