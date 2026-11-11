import fs from 'node:fs/promises';
import path from 'node:path';
import type { Attachment } from '../shared/types';
import { SEARCH_SKIP_DIRS, resolvePath } from './tools';

const MAX_FILES = 3;
const MAX_FILE_SIZE = 1024 * 1024;
const INDEX_LIMIT = 5000;

/** "src/routes.js", "App.tsx", "package.json" — but not "0.4.2", "e.g." or URLs. */
export const PATH_LIKE = /(?<![\w/\\:.])(?:[\w@.-]+[\\/])*[\w@-][\w@.-]*\.[a-z][a-z0-9]{0,7}(?![\w/\\])/gi;

async function fileIndex(root: string): Promise<string[]> {
  const files: string[] = [];
  const stack = [root];
  while (stack.length && files.length < INDEX_LIMIT) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SEARCH_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(full);
      } else if (e.isFile()) files.push(full);
    }
  }
  return files;
}

async function isTextFile(full: string): Promise<boolean> {
  const stat = await fs.stat(full).catch(() => null);
  return !!stat?.isFile() && stat.size <= MAX_FILE_SIZE;
}

/** Existing files of the project that the message mentions, by relative path or by a unique file name. */
export async function findMentionedFiles(text: string, folders: string[]): Promise<string[]> {
  if (!folders.length) return [];
  const found: string[] = [];
  let index: string[] | undefined;
  for (const m of text.matchAll(PATH_LIKE)) {
    if (found.length >= MAX_FILES) break;
    const token = m[0].replace(/^\.[\\/]/, '');
    if (/^\d[\d.]*$/.test(token.replace(/\.[a-z]+$/i, ''))) continue;
    let full: string | undefined;
    try {
      const candidate = resolvePath(folders, token);
      if (await isTextFile(candidate)) full = candidate;
    } catch {
      // outside the folders: ignore
    }
    if (!full && !/[\\/]/.test(token)) {
      index ??= await fileIndex(folders[0]);
      const same = index.filter(f => path.basename(f).toLowerCase() === token.toLowerCase());
      if (same.length === 1 && (await isTextFile(same[0]))) full = same[0];
    }
    if (full && !found.some(f => f.toLowerCase() === full!.toLowerCase())) found.push(full);
  }
  return found;
}

/** Reads the files, splitting the budget between them and cutting at whole lines. */
export async function readAttachments(files: string[], folders: string[], budgetChars: number): Promise<Attachment[]> {
  const out: Attachment[] = [];
  const per = Math.floor(budgetChars / Math.max(files.length, 1));
  const main = path.resolve(folders[0]);
  for (const full of files) {
    const buf = await fs.readFile(full).catch(() => null);
    if (!buf || buf.subarray(0, 8000).includes(0)) continue;
    const lines = buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/);
    let content = '';
    let shown = 0;
    for (const line of lines) {
      if (content.length + line.length + 1 > per && shown > 0) break;
      content += (shown ? '\n' : '') + line;
      shown++;
    }
    const rel = path.relative(main, full);
    out.push({
      path: rel.startsWith('..') ? full : rel.split(path.sep).join('/'),
      content,
      note: shown < lines.length ? `lines 1-${shown} of ${lines.length}; read the rest with read_file` : undefined,
    });
  }
  return out;
}
