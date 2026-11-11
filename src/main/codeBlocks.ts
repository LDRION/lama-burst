import fs from 'node:fs';
import path from 'node:path';
import { PATH_LIKE } from './attachments';
import { resolvePath } from './tools';

/**
 * Chat-tuned models often answer "Create a file convert.py with this code:" followed by a code
 * block, instead of writing the file. Such blocks are turned into write_file calls, but only for
 * files that don't exist yet: a block may be just a fragment, and must never overwrite a file.
 */
export interface ShownFile {
  path: string;
  content: string;
  /** The code block as it appears in the reply, to replace it with a short note. */
  block: string;
}

const LANGS: Record<string, string[]> = {
  py: ['python', 'py'],
  js: ['javascript', 'js', 'node'],
  mjs: ['javascript', 'js'],
  cjs: ['javascript', 'js'],
  ts: ['typescript', 'ts'],
  tsx: ['tsx', 'typescript', 'jsx'],
  jsx: ['jsx', 'javascript'],
  json: ['json'],
  html: ['html'],
  css: ['css'],
  md: ['markdown', 'md'],
  ps1: ['powershell', 'ps1', 'pwsh'],
  sh: ['bash', 'sh', 'shell'],
  yml: ['yaml', 'yml'],
  yaml: ['yaml', 'yml'],
  sql: ['sql'],
  txt: ['text', 'txt', 'plaintext'],
};

/** Source and text files only: a name like model.h5 or logo.png next to code is not where the code goes. */
const TEXT_EXTS = new Set([
  ...Object.keys(LANGS),
  'go', 'rs', 'java', 'kt', 'cs', 'rb', 'php', 'vue', 'svelte', 'scss', 'toml', 'ini', 'xml', 'c', 'cpp', 'h', 'swift', 'bat', 'cmd', 'env',
]);

/** Code language of the fence must not contradict the file extension (```python for app.js is not that file). */
function fits(file: string, lang: string): boolean {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!TEXT_EXTS.has(ext)) return false;
  if (!lang) return true;
  const allowed = LANGS[ext];
  return !allowed || allowed.includes(lang.toLowerCase());
}

export function findShownFiles(text: string, folders: string[]): ShownFile[] {
  if (!folders.length) return [];
  const byPath = new Map<string, ShownFile>();
  let prevEnd = 0;
  for (const m of text.matchAll(/```([\w.+-]*)\r?\n([\s\S]*?)```/g)) {
    // The file is named right before the block ("Create a file named convert.py ... code:"),
    // in the prose since the previous block, never inside another block's code.
    const before = text.slice(Math.max(prevEnd, m.index! - 300), m.index);
    prevEnd = m.index! + m[0].length;
    const content = m[2].replace(/\r?\n$/, '');
    // One line is usually a command to run ("python test.py"), not a file.
    if (content.split('\n').filter(l => l.trim()).length < 2) continue;
    const names = [...before.matchAll(PATH_LIKE)].map(n => n[0].replace(/^\.[\\/]/, ''));
    const name = names.at(-1);
    if (!name || !fits(name, m[1])) continue;
    let full: string;
    try {
      full = resolvePath(folders, name);
    } catch {
      continue;
    }
    if (fs.existsSync(full)) continue;
    byPath.set(full.toLowerCase(), { path: name, content, block: m[0] });
  }
  return [...byPath.values()];
}
