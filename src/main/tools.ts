import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { structuredPatch } from 'diff';
import type { DiffLine, ToolArgs, ToolName } from '../shared/types';
import type { ProcessManager } from './processes';
import { clip, isRiskyCommand, killTree, shellHint, spawnPowerShell } from './shell';

export class ToolError extends Error {}

export interface ToolContext {
  folders: string[];
  maxOutputChars: number;
  commandTimeoutSec: number;
  signal?: AbortSignal;
  /** Moves a path to the Recycle Bin. Without it delete_file deletes permanently. */
  trash?: (fullPath: string) => Promise<void>;
  sessionId?: string;
  processes?: ProcessManager;
  /** Live output of a running command, for the UI. */
  onOutput?: (text: string) => void;
}

export interface PreparedTool {
  diff?: DiffLine[];
  /** Actions that ask for confirmation even when their category is auto-approved. */
  risky?: boolean;
  /** Harmless actions that never ask, like reading a background process's output. */
  safe?: boolean;
  run: () => Promise<string>;
}

export const SEARCH_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'release', '.venv', 'venv',
  '__pycache__', '.next', '.cache', '.turbo', 'coverage',
]);
const MAX_LIST_ENTRIES = 300;
const MAX_SEARCH_RESULTS = 80;
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_FILE_SIZE = 1024 * 1024;
const MAX_READ_SIZE = 20 * 1024 * 1024;
const MAX_DIFF_LINES = 400;

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

/** Real path of the deepest existing part of `p`, so junctions and symlinks can't lead outside. */
function realExisting(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(cur), ...rest);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

export function resolvePath(folders: string[], input: unknown): string {
  if (!folders.length) throw new ToolError('No folder is open. Ask the user to open a folder first.');
  let raw = String(input ?? '').trim().replace(/^["'`]+|["'`]+$/g, '');
  // Small models often write "/docs/a.md" meaning the project root, not the drive root.
  if (/^[\\/](?![\\/])/.test(raw)) raw = raw.replace(/^[\\/]+/, '');
  if (!raw) raw = '.';
  const full = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(folders[0], raw);
  const roots = folders.map(f => path.resolve(f));
  if (!roots.some(r => isInside(r, full))) {
    throw new ToolError(`Access denied: "${raw}" is outside the open folders.`);
  }
  const real = realExisting(full);
  if (!roots.some(r => isInside(realExisting(r), real))) {
    throw new ToolError(`Access denied: "${raw}" links to a location outside the open folders.`);
  }
  return full;
}

/** Path as the model should see it: relative to the main folder when possible. */
function display(folders: string[], full: string): string {
  const main = path.resolve(folders[0]);
  if (!isInside(main, full)) return full;
  return path.relative(main, full).split(path.sep).join('/') || '.';
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function fsError(e: unknown, p: unknown): ToolError {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return new ToolError(`Not found: "${p}". Use list_dir to see what exists.`);
  if (code === 'EISDIR') return new ToolError(`"${p}" is a folder, not a file.`);
  if (code === 'ENOTDIR') return new ToolError(`"${p}" is a file, not a folder.`);
  if (code === 'EACCES' || code === 'EPERM') return new ToolError(`Permission denied: "${p}".`);
  if (code === 'EBUSY') return new ToolError(`"${p}" is locked by another program.`);
  return new ToolError(`Failed to access "${p}": ${(e as Error)?.message ?? e}`);
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function toLine(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

async function listDir(ctx: ToolContext, args: ToolArgs): Promise<string> {
  const dir = resolvePath(ctx.folders, args.path ?? '.');
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(async e => {
    throw isMissing(e) ? await notFound(ctx.folders, dir, args.path) : fsError(e, args.path);
  });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const shown = entries.slice(0, MAX_LIST_ENTRIES);
  const lines = await Promise.all(
    shown.map(async e => {
      if (e.isDirectory()) return `${e.name}/`;
      const size = await fs.stat(path.join(dir, e.name)).then(s => formatSize(s.size), () => '?');
      return `${e.name}  (${size})`;
    }),
  );
  if (entries.length > shown.length) lines.push(`[... and ${entries.length - shown.length} more]`);
  return `${display(ctx.folders, dir)}:\n${lines.join('\n') || '(empty folder)'}`;
}

async function readFile(ctx: ToolContext, args: ToolArgs): Promise<string> {
  const file = resolvePath(ctx.folders, args.path);
  const stat = await fs.stat(file).catch(async e => {
    throw isMissing(e) ? await notFound(ctx.folders, file, args.path) : fsError(e, args.path);
  });
  if (stat.isDirectory()) throw new ToolError(`"${args.path}" is a folder. Use list_dir instead.`);
  if (stat.size > MAX_READ_SIZE) throw new ToolError(`"${args.path}" is too large (${formatSize(stat.size)}).`);
  const buf = await fs.readFile(file).catch(e => {
    throw fsError(e, args.path);
  });
  if (isBinary(buf)) throw new ToolError(`"${args.path}" is a binary file and cannot be read as text.`);
  const lines = buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
  const total = lines.length;
  const start = Math.min(toLine(args.start_line) ?? 1, total);
  const end = Math.min(Math.max(toLine(args.end_line) ?? total, start), total);

  let out = '';
  let last = start - 1;
  for (let i = start - 1; i < end; i++) {
    const next = out ? `${out}\n${lines[i]}` : lines[i];
    if (next.length > ctx.maxOutputChars && i > start - 1) break;
    out = next.length > ctx.maxOutputChars ? next.slice(0, ctx.maxOutputChars) : next;
    last = i + 1;
  }
  const partial = start > 1 || last < total;
  const header = partial ? `[lines ${start}-${last} of ${total}]\n` : '';
  const footer = last < end ? `\n[... truncated. Read the rest by requesting lines ${last + 1}-${total}.]` : '';
  return header + out + footer;
}

async function search(ctx: ToolContext, args: ToolArgs): Promise<string> {
  const query = String(args.query ?? '').trim();
  if (!query) throw new ToolError('"query" is required.');
  const root = resolvePath(ctx.folders, args.path || '.');
  const needle = query.toLowerCase();
  const results: string[] = [];
  let files = 0;
  let limited = false;
  const stack = [root];

  outer: while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = display(ctx.folders, full);
      if (e.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(e.name)) continue;
        if (e.name.toLowerCase().includes(needle)) results.push(`${rel}/  (folder name)`);
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (++files > MAX_SEARCH_FILES) {
        limited = true;
        break outer;
      }
      if (e.name.toLowerCase().includes(needle)) results.push(`${rel}  (file name)`);
      const size = await fs.stat(full).then(s => s.size, () => Infinity);
      if (size > MAX_SEARCH_FILE_SIZE) continue;
      const buf = await fs.readFile(full).catch(() => null);
      if (!buf || isBinary(buf)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(needle)) continue;
        results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        if (results.length >= MAX_SEARCH_RESULTS) {
          limited = true;
          break outer;
        }
      }
    }
  }
  if (!results.length) return `No matches for "${query}".`;
  const out = results.join('\n') + (limited ? '\n[... more matches not shown, refine the query]' : '');
  return clip(out, ctx.maxOutputChars);
}

export function makeDiff(before: string, after: string): DiffLine[] {
  const patch = structuredPatch('a', 'b', before.replace(/\r\n/g, '\n'), after.replace(/\r\n/g, '\n'), '', '', {
    context: 3,
  });
  const lines: DiffLine[] = [];
  for (const h of patch.hunks) {
    lines.push({ type: 'sep', text: `@@ строки ${h.newStart}–${h.newStart + Math.max(h.newLines - 1, 0)}` });
    for (const l of h.lines) {
      if (l.startsWith('\\')) continue;
      lines.push({ type: l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx', text: l.slice(1) });
    }
  }
  if (lines.length > MAX_DIFF_LINES) {
    const more = lines.length - MAX_DIFF_LINES;
    lines.length = MAX_DIFF_LINES;
    lines.push({ type: 'sep', text: `… ещё ${more} строк` });
  }
  return lines;
}

/** Finds the single place to replace: exact match first, then line by line ignoring indentation. */
export function locate(text: string, find: string): { start: number; end: number } {
  const first = text.indexOf(find);
  if (first !== -1) {
    if (text.indexOf(find, first + 1) !== -1) {
      throw new ToolError('The "find" text occurs more than once. Include more surrounding lines so it is unique.');
    }
    return { start: first, end: first + find.length };
  }
  const want = find.split('\n').map(l => l.trim());
  while (want.length && !want[0]) want.shift();
  while (want.length && !want[want.length - 1]) want.pop();
  if (want.length) {
    const lines = text.split('\n');
    const offsets: number[] = [];
    let pos = 0;
    for (const l of lines) {
      offsets.push(pos);
      pos += l.length + 1;
    }
    const matches: number[] = [];
    for (let i = 0; i + want.length <= lines.length; i++) {
      if (want.every((w, j) => lines[i + j].trim() === w)) matches.push(i);
    }
    if (matches.length > 1) {
      throw new ToolError('The "find" text occurs more than once. Include more surrounding lines so it is unique.');
    }
    if (matches.length === 1) {
      const i = matches[0];
      const lastLine = i + want.length - 1;
      return { start: offsets[i], end: offsets[lastLine] + lines[lastLine].length };
    }
  }
  throw new ToolError('The "find" text was not found in the file. Read the file again and copy the exact text.');
}

const PY_SYNTAX_CHECK = 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])';

/** Syntax error in a file the model just wrote, or '' — caught right away instead of at the next test run. */
export async function syntaxCheck(file: string): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, ''));
      return '';
    } catch (e) {
      return `Invalid JSON: ${(e as Error).message}`;
    }
  }
  const check: [string, string[]] | null = ['.js', '.cjs', '.mjs'].includes(ext)
    ? ['node', ['--check', file]]
    : ext === '.py'
      ? ['python', ['-c', PY_SYNTAX_CHECK, file]]
      : null;
  if (!check) return '';
  return new Promise(resolve =>
    execFile(check[0], check[1], { timeout: 15000, windowsHide: true }, (err, _out, stderr) => {
      // A missing node or python is not the model's mistake.
      if (!err || (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve('');
      resolve(clip(String(stderr).trim() || err.message, 1200));
    }),
  );
}

async function syntaxNote(file: string): Promise<string> {
  const error = await syntaxCheck(file);
  return error ? `\n\nSYNTAX ERROR after this change, fix it before anything else:\n${error}` : '';
}

async function readExisting(file: string, p: unknown): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw fsError(e, p);
  }
}

async function prepareWrite(ctx: ToolContext, args: ToolArgs): Promise<PreparedTool> {
  if (!args.path) throw new ToolError('"path" is required.');
  const file = resolvePath(ctx.folders, args.path);
  const before = await readExisting(file, args.path);
  let after = String(args.content ?? '');
  if (before?.includes('\r\n') && !after.includes('\r\n')) after = after.replace(/\n/g, '\r\n');
  return {
    diff: makeDiff(before ?? '', after),
    run: async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, after, 'utf8').catch(e => {
        throw fsError(e, args.path);
      });
      const lines = after.split('\n').length;
      return `${before === null ? 'Created' : 'Overwrote'} ${display(ctx.folders, file)} (${lines} lines).${await syntaxNote(file)}`;
    },
  };
}

async function prepareEdit(ctx: ToolContext, args: ToolArgs): Promise<PreparedTool> {
  if (!args.path) throw new ToolError('"path" is required.');
  const file = resolvePath(ctx.folders, args.path);
  const before = await readExisting(file, args.path);
  if (before === null) {
    const e = await notFound(ctx.folders, file, args.path);
    throw new ToolError(`${e.message}. To create a new file use write_file.`);
  }
  const crlf = before.includes('\r\n');
  const text = before.replace(/\r\n/g, '\n');
  const find = String(args.find ?? '').replace(/\r\n/g, '\n');
  const replace = String(args.replace ?? '').replace(/\r\n/g, '\n');
  if (!find.trim()) throw new ToolError('"find" is empty. Provide the exact text to replace.');
  let start: number;
  let end: number;
  try {
    ({ start, end } = locate(text, find));
  } catch (e) {
    // Small models guess "find" instead of reading the file: hand them the real text right away.
    if (!/not found/.test((e as Error).message)) throw e;
    const shown = clip(text, Math.min(ctx.maxOutputChars, 6000));
    throw new ToolError(
      `${(e as Error).message}\nCurrent content of ${display(ctx.folders, file)} — copy the exact lines for "find" from here:\n\`\`\`\n${shown}\n\`\`\``,
    );
  }
  // "find" without indentation but "replace" with it: the model meant the whole line.
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  if (/^[ \t]/.test(replace) && !/^[ \t]/.test(find) && /^[ \t]*$/.test(text.slice(lineStart, start))) {
    start = lineStart;
  }
  const next = text.slice(0, start) + replace + text.slice(end);
  if (next === text) throw new ToolError('"find" and "replace" are identical, nothing to change.');
  const after = crlf ? next.replace(/\n/g, '\r\n') : next;
  return {
    diff: makeDiff(text, next),
    run: async () => {
      const current = await readExisting(file, args.path);
      if (current !== before) throw new ToolError('The file changed while waiting for approval. Read it again.');
      await fs.writeFile(file, after, 'utf8').catch(e => {
        throw fsError(e, args.path);
      });
      return `Edited ${display(ctx.folders, file)}.${await syntaxNote(file)}`;
    },
  };
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

async function existingStat(ctx: ToolContext, full: string, p: unknown) {
  return fs.stat(full).catch(async e => {
    throw isMissing(e) ? await notFound(ctx.folders, full, p) : fsError(e, p);
  });
}

async function prepareMove(ctx: ToolContext, args: ToolArgs): Promise<PreparedTool> {
  if (!args.path) throw new ToolError('"path" is required.');
  if (!args.new_path) throw new ToolError('"new_path" is required: the new name or the folder to move into.');
  const from = resolvePath(ctx.folders, args.path);
  let to = resolvePath(ctx.folders, args.new_path);
  if (ctx.folders.some(f => samePath(f, from))) throw new ToolError('Cannot move an open folder itself.');
  await existingStat(ctx, from, args.path);

  // "docs/" or an existing folder means "move into it", like mv does.
  const intoFolder =
    /[\\/]$/.test(String(args.new_path)) ||
    (!samePath(from, to) && (await fs.stat(to).then(s => s.isDirectory(), () => false)));
  if (intoFolder) to = path.join(to, path.basename(from));

  const caseOnly = samePath(from, to);
  if (from === to) throw new ToolError('The old and new paths are the same.');
  if (!caseOnly && (await fs.stat(to).then(() => true, () => false))) {
    throw new ToolError(`"${display(ctx.folders, to)}" already exists. Choose another name or delete it first.`);
  }
  if (!caseOnly && isInside(from, to)) throw new ToolError('Cannot move a folder into itself.');

  return {
    run: async () => {
      await fs.mkdir(path.dirname(to), { recursive: true });
      try {
        await fs.rename(from, to);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw fsError(e, args.path);
        await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false });
        await fs.rm(from, { recursive: true, force: true });
      }
      return `Moved ${display(ctx.folders, from)} -> ${display(ctx.folders, to)}.`;
    },
  };
}

async function countTree(dir: string, limit = 10000): Promise<{ files: number; dirs: number; more: boolean }> {
  let files = 0;
  let dirs = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (files + dirs >= limit) return { files, dirs, more: true };
      if (e.isDirectory()) {
        dirs++;
        stack.push(path.join(current, e.name));
      } else files++;
    }
  }
  return { files, dirs, more: false };
}

async function prepareDelete(ctx: ToolContext, args: ToolArgs): Promise<PreparedTool> {
  if (!args.path) throw new ToolError('"path" is required.');
  const target = resolvePath(ctx.folders, args.path);
  if (ctx.folders.some(f => samePath(f, target))) throw new ToolError('Cannot delete an open folder itself.');
  const stat = await existingStat(ctx, target, args.path);

  let preview: DiffLine[];
  if (stat.isDirectory()) {
    const t = await countTree(target);
    preview = [{ type: 'sep', text: `Папка целиком: файлов ${t.files}${t.more ? '+' : ''}, подпапок ${t.dirs}` }];
  } else {
    const buf = stat.size <= MAX_READ_SIZE ? await fs.readFile(target).catch(() => null) : null;
    if (!buf || isBinary(buf)) {
      preview = [{ type: 'sep', text: `Двоичный файл, ${formatSize(stat.size)}` }];
    } else {
      const lines = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
      preview = [{ type: 'sep', text: buf.length ? `Файл целиком, строк: ${lines.length}` : 'Пустой файл' }];
      if (buf.length) preview.push(...lines.slice(0, MAX_DIFF_LINES).map(text => ({ type: 'del' as const, text })));
      if (lines.length > MAX_DIFF_LINES) preview.push({ type: 'sep', text: `… ещё ${lines.length - MAX_DIFF_LINES} строк` });
    }
  }

  return {
    diff: preview,
    risky: true,
    run: async () => {
      const shown = display(ctx.folders, target);
      if (ctx.trash) {
        await ctx.trash(target).catch(e => {
          throw new ToolError(`Could not move "${shown}" to the Recycle Bin: ${(e as Error).message}`);
        });
        return `Moved ${shown} to the Recycle Bin.`;
      }
      await fs.rm(target, { recursive: true }).catch(e => {
        throw fsError(e, args.path);
      });
      return `Deleted ${shown}.`;
    },
  };
}

/** Output of a program that has started serving and will not exit by itself. */
const SERVER_READY =
  /listening|running (?:on|at)|server (?:is )?(?:running|started|ready)|started server|ready in \d|(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}|Uvicorn running|compiled successfully/i;
/** How long a "server is ready" command must keep running before it is moved to the background. */
const SERVER_SETTLE_MS = 2500;

async function runCommand(ctx: ToolContext, command: string): Promise<string> {
  const { child, cleanup } = await spawnPowerShell(command, ctx.folders[0]);
  let adopted = false;
  try {
    return await new Promise<string>(resolve => {
      const chunks: Buffer[] = [];
      let size = 0;
      let readyAt = 0;
      const text = () => Buffer.concat(chunks).toString('utf8');
      const collect = (b: Buffer) => {
        if (size < 2 * 1024 * 1024) chunks.push(b);
        size += b.length;
        const s = b.toString('utf8');
        ctx.onOutput?.(s);
        if (!readyAt && SERVER_READY.test(s)) readyAt = Date.now();
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);

      let reason = '';
      const stop = (why: string) => {
        reason = why;
        killTree(child.pid);
      };
      const onAbort = () => stop('stopped by the user');
      ctx.signal?.addEventListener('abort', onAbort);

      /** Keeps the command running as a background process instead of blocking or killing it. */
      const handOver = (head: (id: number) => string): boolean => {
        if (!ctx.processes || !ctx.sessionId) return false;
        clearInterval(watch);
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        child.stdout.off('data', collect);
        child.stderr.off('data', collect);
        adopted = true;
        // Hand over the raw text: trimming the last newline would glue it to the next output line.
        const id = ctx.processes.adopt(ctx.sessionId, command, child, cleanup, text());
        const output = text().trim();
        const tail = output.length > ctx.maxOutputChars ? `[...]\n${output.slice(-ctx.maxOutputChars)}` : output;
        resolve(`${head(id)}\nOutput so far:\n${tail || '(no output yet)'}`);
        return true;
      };

      // Long installs and downloads must not be killed and restarted: they continue in the background.
      const timer = setTimeout(() => {
        const moved = handOver(
          id =>
            `The command is still running after ${ctx.commandTimeoutSec}s (big downloads and installs can take a long time). ` +
            `It was NOT stopped: it keeps running in the background as process #${id}. ` +
            `Wait for it with process_output (id ${id}, wait_seconds 120) and do NOT start it again. ` +
            `Use stop_process only if it is stuck.`,
        );
        if (!moved) {
          stop(
            `timed out after ${ctx.commandTimeoutSec}s. If this is a server or another program that keeps running, start it with start_process instead`,
          );
        }
      }, ctx.commandTimeoutSec * 1000);

      // A server started with run_command would block until the timeout: hand it over to the background.
      const watch = setInterval(() => {
        if (!readyAt || Date.now() - readyAt < SERVER_SETTLE_MS) return;
        handOver(
          id =>
            `The command keeps running (it looks like a server), so it was moved to the background as process #${id}. ` +
            `Use process_output with id ${id} to see new output and stop_process with id ${id} to stop it.`,
        );
      }, 500);

      const finish = (head: string) => {
        if (adopted) return;
        clearInterval(watch);
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
        const output = text().trim();
        resolve(`${head}\n${output ? clip(output, ctx.maxOutputChars) : '(no output)'}${shellHint(output)}`);
      };
      child.on('error', e => finish(`Failed to start PowerShell: ${e.message}`));
      child.on('close', code => finish(reason ? `Command ${reason}.` : `Exit code: ${code ?? 'unknown'}`));
    });
  } finally {
    if (!adopted) await cleanup();
  }
}

/** How long start_process waits before returning the first output of a background command. */
const BACKGROUND_WAIT_MS = 8000;
/** process_output can wait for a long install to finish, but not forever. */
const MAX_PROCESS_WAIT_SEC = 300;

function processId(args: ToolArgs): number {
  const id = Number(String(args.id ?? '').replace(/^#/, ''));
  if (!Number.isInteger(id) || id < 1) throw new ToolError('"id" must be the process number, like 1.');
  return id;
}

function requireProcesses(ctx: ToolContext): { processes: ProcessManager; sessionId: string } {
  if (!ctx.processes || !ctx.sessionId) throw new ToolError('Background processes are not available here.');
  if (!ctx.folders.length) throw new ToolError('No folder is open. Ask the user to open a folder first.');
  return { processes: ctx.processes, sessionId: ctx.sessionId };
}

export async function prepareTool(name: ToolName, args: ToolArgs, ctx: ToolContext): Promise<PreparedTool> {
  switch (name) {
    case 'list_dir':
      return { run: () => listDir(ctx, args) };
    case 'read_file':
      return { run: () => readFile(ctx, args) };
    case 'search':
      return { run: () => search(ctx, args) };
    case 'write_file':
      return prepareWrite(ctx, args);
    case 'edit_file':
      return prepareEdit(ctx, args);
    case 'move_file':
      return prepareMove(ctx, args);
    case 'delete_file':
      return prepareDelete(ctx, args);
    case 'run_command': {
      const command = String(args.command ?? '').trim();
      if (!command) throw new ToolError('"command" is required.');
      if (!ctx.folders.length) throw new ToolError('No folder is open. Ask the user to open a folder first.');
      return { risky: isRiskyCommand(command), run: () => runCommand(ctx, command) };
    }
    case 'start_process': {
      const command = String(args.command ?? '').trim();
      if (!command) throw new ToolError('"command" is required.');
      const { processes, sessionId } = requireProcesses(ctx);
      return {
        risky: isRiskyCommand(command),
        run: () => processes.start(sessionId, ctx.folders[0], command, BACKGROUND_WAIT_MS, ctx.maxOutputChars),
      };
    }
    case 'process_output': {
      const id = processId(args);
      const { processes, sessionId } = requireProcesses(ctx);
      const wait = Math.min(Math.max(Number(args.wait_seconds) || 0, 0), MAX_PROCESS_WAIT_SEC);
      return {
        safe: true,
        run: () => processes.output(sessionId, id, ctx.maxOutputChars, wait, ctx.signal, ctx.onOutput),
      };
    }
    case 'stop_process': {
      const id = processId(args);
      const { processes, sessionId } = requireProcesses(ctx);
      return { safe: true, run: () => processes.stop(sessionId, id) };
    }
    default:
      throw new ToolError(`Unknown tool "${name}".`);
  }
}

async function sortedEntries(dir: string) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
  return entries?.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
}

/**
 * Two-level listing of the main folder with full relative paths, for the system prompt:
 * small models find files much better when they see real names from the start.
 */
export async function folderOverview(folder: string, limit = 60, perFolder = 10): Promise<string> {
  const top = await sortedEntries(folder);
  if (!top) return '(folder is not accessible)';
  if (!top.length) return '(empty folder)';
  const lines: string[] = [];
  for (const e of top) {
    if (lines.length >= limit) {
      lines.push(`... and more (use list_dir)`);
      break;
    }
    if (!e.isDirectory()) {
      lines.push(e.name);
      continue;
    }
    lines.push(`${e.name}/`);
    if (SEARCH_SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
    const inner = (await sortedEntries(path.join(folder, e.name))) ?? [];
    for (const c of inner.slice(0, perFolder)) lines.push(`${e.name}/${c.name}${c.isDirectory() ? '/' : ''}`);
    if (inner.length > perFolder) lines.push(`${e.name}/... (${inner.length - perFolder} more)`);
  }
  return lines.join('\n');
}

/** "Not found" with the real contents of the nearest existing folder, so the model can correct itself. */
async function notFound(folders: string[], full: string, p: unknown): Promise<ToolError> {
  let dir = path.dirname(full);
  while (!(await fs.stat(dir).then(s => s.isDirectory(), () => false))) {
    const parent = path.dirname(dir);
    if (parent === dir) return new ToolError(`Not found: "${p}".`);
    dir = parent;
  }
  const entries = (await sortedEntries(dir)) ?? [];
  const names = entries.slice(0, 30).map(e => (e.isDirectory() ? `${e.name}/` : e.name));
  return new ToolError(
    `Not found: "${p}". Do not invent file names. Existing entries in "${display(folders, dir)}": ${names.join(', ') || '(empty)'}`,
  );
}
