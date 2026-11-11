import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n[... ${text.length - max} characters omitted ...]\n${text.slice(-tail)}`;
}

const RISKY_COMMANDS = [
  /\b(remove-item|rm|rmdir|rd|del|erase|ri)\b/i,
  /\bformat-volume\b|\bformat(\.com)?\s+[a-z]:/i,
  /\b(clear-disk|initialize-disk|diskpart|bcdedit)\b/i,
  /\b(stop-computer|restart-computer|shutdown)\b/i,
  /\b(set-executionpolicy|remove-itemproperty|set-itemproperty|new-itemproperty)\b/i,
  /\breg(\.exe)?\s+(add|delete|import)\b/i,
  /\b(stop-process|kill|taskkill)\b/i,
  /\|\s*(iex|invoke-expression)\b/i,
  /\bgit\s+(push|reset\s+--hard|clean\b)/i,
  /\b(move-item|mv|move)\b[^|]*\s[a-z]:\\/i,
];

export function isRiskyCommand(command: string): boolean {
  return RISKY_COMMANDS.some(r => r.test(command));
}

const COMMAND_NOT_FOUND =
  /is not recognized as (?:the |a )?name of a cmdlet|CommandNotFoundException|A parameter cannot be found that matches parameter name/i;

const SHELL_HINT =
  'Hint: this is PowerShell on Windows, not bash. Rewrite Linux commands in PowerShell: ' +
  'touch -> New-Item -ItemType File, mkdir -p -> New-Item -ItemType Directory -Force, ls -la -> Get-ChildItem -Force, ' +
  'cat -> Get-Content, grep -> Select-String, which -> Get-Command, rm -rf -> Remove-Item -Recurse -Force. ' +
  'If a program seems missing, check it with Get-Command before telling the user to install it or change PATH.';

const MISSING_FILE = /Cannot find module '([^']+)'|can't open file '([^']+)'|No such file or directory: '([^']+)'/;

/** Appended to command output for mistakes small models make again and again. */
export function shellHint(output: string): string {
  const hints: string[] = [];
  if (COMMAND_NOT_FOUND.test(output)) hints.push(SHELL_HINT);
  const m = output.match(MISSING_FILE);
  const missing = m?.[1] ?? m?.[2] ?? m?.[3];
  if (missing && /^[@\w][\w.-]*(\/[\w.-]+)?$/.test(missing) && !/\.\w+$/.test(missing)) {
    hints.push(`Hint: the package "${missing}" is not installed. Install it first: npm install ${missing}`);
  } else if (missing) {
    hints.push(
      `Hint: the file ${missing} does not exist. Check what exists with list_dir and create the file with write_file before running it.`,
    );
  }
  const pip = output.match(/No matching distribution found for ([^\s]+)/);
  if (pip) {
    hints.push(
      `Hint: pip has no build of "${pip[1]}" for this Python version or platform. Check "python --version" and which Python versions the package supports. Retrying the same install will not help.`,
    );
  }
  return hints.map(h => `\n\n${h}`).join('');
}

let shellPath: string | undefined;
function powershell(): string {
  if (!shellPath) {
    const found = spawnSync('where.exe', ['pwsh.exe'], { encoding: 'utf8', windowsHide: true });
    shellPath = found.status === 0 ? found.stdout.split(/\r?\n/)[0].trim() : 'powershell.exe';
  }
  return shellPath;
}

export function killTree(pid: number | undefined) {
  if (!pid) return;
  spawnSync('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
}

/**
 * Runs a command through a temporary .ps1 file: no quoting problems, UTF-8 output,
 * no profile and no prompts (stdin is closed).
 */
export async function spawnPowerShell(
  command: string,
  cwd: string,
): Promise<{ child: ChildProcessWithoutNullStreams; cleanup: () => Promise<void> }> {
  const dir = path.join(os.tmpdir(), 'lama-burst');
  await fs.mkdir(dir, { recursive: true });
  const script = path.join(dir, `cmd-${randomUUID()}.ps1`);
  const prelude =
    "$ProgressPreference = 'SilentlyContinue'\n" +
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n' +
    '$OutputEncoding = [System.Text.Encoding]::UTF8\n';
  // With -File, PowerShell exits with 0 even when a program like node or npm failed: pass its code on.
  const epilogue = '$__lbOk = $?\nif ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $__lbOk) { exit 1 }\n';
  // BOM so that Windows PowerShell 5.1 reads the script as UTF-8.
  await fs.writeFile(script, '﻿' + prelude + command + '\n' + epilogue, 'utf8');
  const child = spawn(
    powershell(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { cwd, windowsHide: true },
  );
  child.stdin.end();
  return { child, cleanup: () => fs.rm(script, { force: true }) };
}
