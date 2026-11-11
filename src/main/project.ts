import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { ProjectSummary } from '../shared/types';
import { SEARCH_SKIP_DIRS } from './tools';

/**
 * A quick, model-free look at a project: stack, commands, key files, notes. Small models can't
 * read a whole codebase into 8–16k of context, so they get this summary up front and read
 * the rest on demand.
 */
export interface ProjectInfo extends ProjectSummary {
  description?: string;
  /** The same warnings in English, for the model's prompt (ProjectSummary.warnings are for the UI). */
  modelWarnings: string[];
  dependencies: string[];
  keyFiles: string[];
  readme?: string;
  notes: { file: string; text: string }[];
  git?: { branch: string; changed: number; recent: string[] };
  files: { total: number; byExt: [string, number][]; more: boolean };
}

/** Project notes for the model, like CLAUDE.md for Claude Code. LAMA.md is written by "Изучить проект". */
export const NOTES_FILES = ['LAMA.md', 'AGENTS.md', 'CLAUDE.md'];

const NODE_STACK: Record<string, string> = {
  typescript: 'TypeScript',
  react: 'React',
  next: 'Next.js',
  vue: 'Vue',
  svelte: 'Svelte',
  '@angular/core': 'Angular',
  'react-native': 'React Native',
  expo: 'Expo',
  electron: 'Electron',
  vite: 'Vite',
  express: 'Express',
  fastify: 'Fastify',
  '@nestjs/core': 'NestJS',
  koa: 'Koa',
  'socket.io': 'Socket.IO',
  mongoose: 'MongoDB',
  mongodb: 'MongoDB',
  prisma: 'Prisma',
  '@prisma/client': 'Prisma',
  pg: 'PostgreSQL',
  redis: 'Redis',
  ioredis: 'Redis',
  telegraf: 'Telegram bot',
  grammy: 'Telegram bot',
  'node-telegram-bot-api': 'Telegram bot',
  openai: 'OpenAI API',
  '@anthropic-ai/sdk': 'Anthropic API',
  tailwindcss: 'Tailwind',
  jest: 'Jest',
  vitest: 'Vitest',
  mocha: 'Mocha',
  '@playwright/test': 'Playwright',
};

const PY_STACK: Record<string, string> = {
  django: 'Django',
  flask: 'Flask',
  fastapi: 'FastAPI',
  aiogram: 'Telegram bot (aiogram)',
  'python-telegram-bot': 'Telegram bot',
  pytest: 'pytest',
  numpy: 'NumPy',
  pandas: 'pandas',
  torch: 'PyTorch',
  tensorflow: 'TensorFlow',
  sqlalchemy: 'SQLAlchemy',
  streamlit: 'Streamlit',
  openai: 'OpenAI API',
  anthropic: 'Anthropic API',
};

const KEY_FILE_CANDIDATES = [
  'README.md',
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'next.config.js',
  'next.config.mjs',
  'electron.vite.config.ts',
  'src/index.ts',
  'src/index.js',
  'src/main.ts',
  'src/main.tsx',
  'src/main.js',
  'src/App.tsx',
  'src/App.jsx',
  'src/App.vue',
  'src/app.ts',
  'src/app.js',
  'src/server.ts',
  'src/server.js',
  'app/page.tsx',
  'index.ts',
  'index.js',
  'server.ts',
  'server.js',
  'app.js',
  'main.py',
  'app.py',
  'bot.py',
  'manage.py',
  'go.mod',
  'Cargo.toml',
  'Dockerfile',
  'docker-compose.yml',
  '.env.example',
];

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

async function readText(p: string, max = 200_000): Promise<string | undefined> {
  try {
    const stat = await fs.stat(p);
    if (!stat.isFile() || stat.size > max) return undefined;
    return (await fs.readFile(p, 'utf8')).replace(/^﻿/, '');
  } catch {
    return undefined;
  }
}

function git(folder: string, args: string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('git', ['-C', folder, ...args], { timeout: 3000, windowsHide: true }, (err, stdout) =>
      resolve(err ? undefined : stdout.trim()),
    );
  });
}

async function countFiles(folder: string, limit = 5000) {
  const byExt = new Map<string, number>();
  let total = 0;
  const stack = [folder];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SEARCH_SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(path.join(dir, e.name));
        continue;
      }
      if (++total > limit) return { total: limit, byExt: [...byExt].sort((a, b) => b[1] - a[1]), more: true };
      const ext = path.extname(e.name).toLowerCase() || e.name;
      byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
    }
  }
  return { total, byExt: [...byExt].sort((a, b) => b[1] - a[1]), more: false };
}

function readmeExcerpt(text: string, max = 1200): string {
  const lines = text
    .split(/\r?\n/)
    .filter(l => !/^\s*(!\[|<img|\[!\[)/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return lines.length > max ? `${lines.slice(0, max)}…` : lines;
}

function pyDeps(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && !l.startsWith('-'))
    .map(l => l.split(/[<>=!~;\[ ]/)[0].toLowerCase())
    .filter(Boolean);
}

export async function scanProject(folder: string): Promise<ProjectInfo> {
  const at = (p: string) => path.join(folder, p);
  const info: ProjectInfo = {
    name: path.basename(folder),
    stack: [],
    run: [],
    checks: [],
    warnings: [],
    modelWarnings: [],
    notesFile: undefined,
    dependencies: [],
    keyFiles: [],
    notes: [],
    files: { total: 0, byExt: [], more: false },
  };
  const stack = new Set<string>();
  const warn = (model: string, user: string) => {
    info.modelWarnings.push(model);
    info.warnings.push(user);
  };

  // Node.js
  const pkgText = await readText(at('package.json'));
  if (pkgText) {
    let pkg: {
      name?: string;
      description?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    } = {};
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      warn('package.json is not valid JSON.', 'package.json повреждён: это не корректный JSON.');
    }
    if (pkg.name) info.name = pkg.name;
    info.description = pkg.description;
    stack.add('Node.js');
    const deps = Object.keys(pkg.dependencies ?? {});
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    info.dependencies.push(...deps, ...devDeps);
    for (const d of [...deps, ...devDeps]) if (NODE_STACK[d]) stack.add(NODE_STACK[d]);
    if (await exists(at('tsconfig.json'))) stack.add('TypeScript');

    const pm = (await exists(at('pnpm-lock.yaml')))
      ? 'pnpm'
      : (await exists(at('yarn.lock')))
        ? 'yarn'
        : (await exists(at('bun.lockb'))) || (await exists(at('bun.lock')))
          ? 'bun'
          : 'npm';
    info.packageManager = pm;
    const runScript = (s: string) =>
      pm === 'npm' ? (s === 'test' || s === 'start' ? `npm ${s}` : `npm run ${s}`) : pm === 'bun' ? `bun run ${s}` : `${pm} ${s}`;
    const scripts = pkg.scripts ?? {};
    for (const s of ['dev', 'start', 'serve']) if (scripts[s]) info.run.push(runScript(s));
    for (const s of ['test', 'typecheck', 'type-check', 'lint', 'build']) {
      if (scripts[s] && !/no test specified/.test(scripts[s])) info.checks.push(runScript(s));
    }
    if (deps.length + devDeps.length && !(await exists(at('node_modules')))) {
      warn(
        `Dependencies are not installed (no node_modules): run "${pm} install" before running anything.`,
        `Зависимости не установлены (нет node_modules). Модель поставит их сама командой ${pm} install.`,
      );
    }
  }

  // Python
  const reqText = await readText(at('requirements.txt'));
  const pyproject = await readText(at('pyproject.toml'));
  const isPython =
    reqText !== undefined || pyproject !== undefined || (await exists(at('manage.py'))) || (await exists(at('main.py'))) || (await exists(at('app.py')));
  if (isPython) {
    stack.add('Python');
    const deps = [...(reqText ? pyDeps(reqText) : [])];
    if (pyproject) {
      const name = pyproject.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
      if (name && !pkgText) info.name = name;
      const list = pyproject.match(/dependencies\s*=\s*\[([\s\S]*?)\]/)?.[1];
      if (list) deps.push(...[...list.matchAll(/["']([^"']+)["']/g)].map(m => pyDeps(m[1])[0]).filter(Boolean));
    }
    info.dependencies.push(...deps);
    for (const d of deps) if (PY_STACK[d]) stack.add(PY_STACK[d]);
    const venv = (await exists(at('.venv'))) ? '.venv' : (await exists(at('venv'))) ? 'venv' : undefined;
    const python = venv ? `${venv}\\Scripts\\python` : 'python';
    info.packageManager ??= (await exists(at('poetry.lock'))) ? 'poetry' : (await exists(at('uv.lock'))) ? 'uv' : 'pip';
    if (await exists(at('manage.py'))) info.run.push(`${python} manage.py runserver`);
    else if (await exists(at('main.py'))) info.run.push(`${python} main.py`);
    else if (await exists(at('app.py'))) info.run.push(`${python} app.py`);
    else if (await exists(at('bot.py'))) info.run.push(`${python} bot.py`);
    if (deps.includes('pytest') || (await exists(at('tests'))) || (await exists(at('pytest.ini')))) {
      info.checks.push(`${python} -m pytest`);
    }
    if (deps.length && !venv) {
      warn(
        'No virtual environment (.venv): create one with "python -m venv .venv" and install packages with ".venv\\Scripts\\pip install ..." instead of installing them globally.',
        'Нет виртуального окружения .venv: модель создаст его, чтобы не ставить пакеты в системный Python.',
      );
    }
  }

  // Other ecosystems
  if (await exists(at('go.mod'))) {
    stack.add('Go');
    info.checks.push('go build ./...', 'go test ./...');
  }
  if (await exists(at('Cargo.toml'))) {
    stack.add('Rust');
    info.checks.push('cargo build', 'cargo test');
  }
  const top = await fs.readdir(folder).catch(() => [] as string[]);
  if (top.some(f => /\.(csproj|sln)$/i.test(f))) {
    stack.add('.NET');
    info.checks.push('dotnet build');
  }
  if (top.includes('composer.json')) stack.add('PHP');
  if (top.includes('Gemfile')) stack.add('Ruby');
  if (top.includes('Dockerfile') || top.includes('docker-compose.yml')) stack.add('Docker');
  info.stack = [...stack];

  for (const f of KEY_FILE_CANDIDATES) if (await exists(at(f))) info.keyFiles.push(f);

  const readmeName = top.find(f => /^readme(\.md|\.txt)?$/i.test(f));
  const readme = readmeName ? await readText(at(readmeName)) : undefined;
  if (readme) info.readme = readmeExcerpt(readme);

  for (const f of NOTES_FILES) {
    const name = top.find(t => t.toLowerCase() === f.toLowerCase());
    const text = name ? await readText(at(name), 100_000) : undefined;
    if (name && text?.trim()) info.notes.push({ file: name, text: text.trim() });
  }
  info.notesFile = info.notes[0]?.file;

  const branch = await git(folder, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch) {
    const status = (await git(folder, ['status', '--porcelain'])) ?? '';
    const log = (await git(folder, ['log', '-5', '--format=%s'])) ?? '';
    info.git = {
      branch,
      changed: status ? status.split('\n').length : 0,
      recent: log ? log.split('\n') : [],
    };
  }
  info.files = await countFiles(folder);
  return info;
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 40))}\n[... truncated to fit the context ...]` : text;
}

/** Project section of the system prompt, most important facts first, within maxChars. */
export function projectPrompt(info: ProjectInfo, maxChars: number): string {
  const facts = [
    '# Project',
    `Name: ${info.name}${info.description ? ` — ${info.description}` : ''}`,
  ];
  if (info.stack.length) facts.push(`Stack: ${info.stack.join(', ')}${info.packageManager ? ` (${info.packageManager})` : ''}`);
  if (info.run.length) facts.push(`Run: ${info.run.join(' | ')}`);
  if (info.checks.length) facts.push(`Checks (run them after changes): ${info.checks.join(' | ')}`);
  for (const w of info.modelWarnings) facts.push(`WARNING: ${w}`);
  if (info.keyFiles.length) facts.push(`Key files: ${info.keyFiles.join(', ')}`);
  if (info.dependencies.length) {
    const shown = info.dependencies.slice(0, 20);
    facts.push(`Dependencies: ${shown.join(', ')}${info.dependencies.length > shown.length ? ', …' : ''}`);
  }
  if (info.files.total) {
    const exts = info.files.byExt.slice(0, 6).map(([e, n]) => `${e} ${n}`);
    facts.push(`Source files: ${info.files.total}${info.files.more ? '+' : ''} (${exts.join(', ')})`);
  }
  if (info.git) {
    facts.push(
      `Git: branch ${info.git.branch}, ${info.git.changed} uncommitted changes` +
        (info.git.recent.length ? `; recent commits: ${info.git.recent.slice(0, 3).join(' / ')}` : ''),
    );
  }

  let out = facts.join('\n');
  if (out.length >= maxChars) return clipText(out, maxChars);

  const rest = maxChars - out.length;
  if (info.notes.length) {
    const notes = info.notes.map(n => `## ${n.file}\n${n.text}`).join('\n\n');
    out += `\n\n# Project notes (follow them)\n${clipText(notes, rest - 40)}`;
  } else if (info.readme && rest > 300) {
    out += `\n\n# README (beginning)\n${clipText(info.readme, rest - 40)}`;
  }
  return out;
}
