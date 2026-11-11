import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { AssistantItem, Session, Settings, ToolMode } from '../shared/types';
import { runAgent, type AgentHost } from './agent';
import { Ollama } from './ollama';
import { ProcessManager } from './processes';
import { STUDY_PROMPT } from '../shared/prompts';

/**
 * Runs the real agent loop against local Ollama models.
 * $env:LIVE_MODELS = "qwen2.5:7b,hf.co/..."; npx vitest run src/main/agent.live.test.ts
 */
const models = (process.env.LIVE_MODELS ?? '').split(',').filter(Boolean);

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lama-burst-live-'));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(
    path.join(dir, 'docs', 'plan.md'),
    '# План на неделю\r\n- Понедельник: дописать парсер вебхуков\r\n- Среда: созвон с клиентом Ромашка в 15:00\r\n- Пятница: релиз версии 0.4.2\r\n',
  );
  fs.writeFileSync(path.join(dir, 'readme.txt'), 'Тестовый проект\r\n');
  return dir;
}

/** "model#text" forces text tool mode for that model. */
async function ask(spec: string, folder: string, text: string, overrides: Partial<Settings> = {}) {
  const [model, toolMode] = spec.split('#') as [string, ToolMode | undefined];
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    permissions: { read: 'auto', write: 'auto', run: 'auto' },
    models: toolMode ? { [model]: { toolMode } } : {},
    ...overrides,
  };
  const session: Session = {
    id: 's',
    title: '',
    model,
    folders: [folder],
    items: [{ id: 'u', role: 'user', text, time: 0 }],
    createdAt: 0,
    updatedAt: 0,
  };
  const processes = new ProcessManager();
  const host: AgentHost = {
    ollama: new Ollama(() => settings.ollamaUrl),
    settings: () => settings,
    // $env:LIVE_LOG = "path": stream everything the model writes, to see a run that hangs.
    emit: ev => {
      if (!process.env.LIVE_LOG) return;
      if (ev.type === 'delta' && ev.text) fs.appendFileSync(process.env.LIVE_LOG, ev.text);
      if (ev.type === 'item' && ev.item.role === 'assistant') {
        for (const t of ev.item.tools.filter(t => t.result)) {
          fs.appendFileSync(process.env.LIVE_LOG, `\n--- ${t.name} -> ${t.result!.slice(0, 300)}\n`);
        }
      }
    },
    approve: async () => 'allow',
    allowAlways: () => {},
    save: () => {},
    processes,
  };
  try {
    await runAgent(session, host, new AbortController().signal);
  } finally {
    processes.stopAll();
  }
  for (const item of session.items) {
    if (item.role === 'user') {
      if (item.auto) console.log(`[${model}] >> auto: ${item.autoReason}`);
      continue;
    }
    const calls = item.tools.map(
      t => `${t.name}(${JSON.stringify(t.args).slice(0, 160)}) -> ${t.status}: ${t.result?.replace(/\s+/g, ' ').slice(0, 140)}`,
    );
    console.log(`[${model}] [${item.mode}] ${item.text.slice(0, 300)}${item.error ? ` ERROR ${item.error}` : ''}\n  ${calls.join('\n  ')}`);
  }
  return session.items.filter((i): i is AssistantItem => i.role === 'assistant');
}

/** A small existing project: express API with routes in a separate file, dependencies not installed. */
function makeExistingProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lama-burst-existing-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify(
      {
        name: 'notes-api',
        description: 'Small API for notes',
        scripts: { start: 'node src/server.js', test: 'node test.js' },
        dependencies: { express: '^4.21.0' },
      },
      null,
      2,
    ),
    'README.md': '# notes-api\n\nSmall API for notes. Routes live in src/routes.js, the app is created in src/server.js.\n',
    'src/server.js': [
      "const express = require('express');",
      "const routes = require('./routes');",
      '',
      'const app = express();',
      'app.use(express.json());',
      "app.use('/', routes);",
      '',
      'const port = process.env.PORT || 3921;',
      'if (require.main === module) app.listen(port, () => console.log(`notes-api listening on ${port}`));',
      'module.exports = app;',
      '',
    ].join('\n'),
    'src/routes.js': [
      "const { Router } = require('express');",
      '',
      'const router = Router();',
      'const notes = [];',
      '',
      "router.get('/hello', (req, res) => res.send('hi'));",
      "router.get('/notes', (req, res) => res.json(notes));",
      "router.post('/notes', (req, res) => {",
      '  notes.push(req.body);',
      '  res.status(201).json(req.body);',
      '});',
      '',
      'module.exports = router;',
      '',
    ].join('\n'),
    'test.js': [
      "const http = require('http');",
      "const app = require('./src/server');",
      'const server = app.listen(0, () => {',
      '  const { port } = server.address();',
      "  http.get(`http://127.0.0.1:${port}/hello`, res => {",
      "    let body = '';",
      '    res.on(\'data\', d => (body += d));',
      "    res.on('end', () => {",
      "      console.log(body === 'hi' ? 'ok /hello' : 'FAIL /hello');",
      '      server.close();',
      "      process.exitCode = body === 'hi' ? 0 : 1;",
      '    });',
      '  });',
      '});',
      '',
    ].join('\n'),
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

/** Starts the edited app and requests a route, independently of what the model claims. */
function requestRoute(dir: string, route: string): { status: number; body: string } {
  const script = `const http=require('http');const app=require('./src/server');const s=app.listen(0,()=>{http.get('http://127.0.0.1:'+s.address().port+'${route}',r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>{console.log(JSON.stringify({status:r.statusCode,body:b}));s.close();});});});`;
  return JSON.parse(execFileSync('node', ['-e', script], { cwd: dir, encoding: 'utf8', timeout: 20000 }).trim());
}

describe.skipIf(!models.length)('live agent', () => {
  for (const model of models) {
    it(`${model}: answers from a file`, { timeout: 300000 }, async () => {
      const steps = await ask(model, makeProject(), 'Когда у меня созвон с клиентом? Посмотри в моих файлах.');
      const read = steps.flatMap(s => s.tools).filter(t => t.status === 'done' && t.name !== 'list_dir');
      expect(read.length).toBeGreaterThan(0);
      expect(steps.at(-1)!.text).toMatch(/15[:.]00|15 ч|три часа|3 PM/i);
    });

    it(`${model}: edits a file`, { timeout: 300000 }, async () => {
      const dir = makeProject();
      await ask(model, dir, 'В файле docs/plan.md замени версию релиза 0.4.2 на 0.5.0.');
      const after = fs.readFileSync(path.join(dir, 'docs', 'plan.md'), 'utf8');
      expect(after).toContain('релиз версии 0.5.0');
      expect(after).toContain('созвон с клиентом Ромашка в 15:00');
    });

    it(`${model}: creates a file`, { timeout: 300000 }, async () => {
      const dir = makeProject();
      await ask(model, dir, 'Создай файл notes/todo.md со списком из двух пунктов: купить молоко, позвонить маме.');
      expect(fs.readFileSync(path.join(dir, 'notes', 'todo.md'), 'utf8')).toMatch(/молоко/i);
    });

    it(`${model}: renames a file`, { timeout: 300000 }, async () => {
      const dir = makeProject();
      await ask(model, dir, 'Переименуй readme.txt в about.txt.');
      expect(fs.readdirSync(dir).sort()).toEqual(['about.txt', 'docs']);
    });

    it(`${model}: creates an empty file with a command`, { timeout: 300000 }, async () => {
      const dir = makeProject();
      await ask(model, dir, 'Создай пустой файл empty.log командой в терминале.');
      expect(fs.existsSync(path.join(dir, 'empty.log'))).toBe(true);
    });

    it(`${model}: builds, runs and checks an HTTP service`, { timeout: 900000 }, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lama-burst-svc-'));
      const steps = await ask(
        model,
        dir,
        'Создай простой HTTP-сервис на Node.js без внешних зависимостей в файле server.js: на GET /ping он отвечает JSON {"ok":true}, порт 3917. Запусти его, проверь запросом, что он работает, и останови.',
      );
      const calls = steps.flatMap(s => s.tools);
      expect(fs.existsSync(path.join(dir, 'server.js'))).toBe(true);
      expect(calls.some(t => t.name === 'start_process' && t.status === 'done')).toBe(true);
      expect(calls.some(t => /ok/i.test(t.result ?? '') && /Invoke-WebRequest|Invoke-RestMethod|curl|iwr|irm/i.test(String(t.args.command ?? '')))).toBe(true);
    });

    it(`${model}: waits for a long install instead of restarting it`, { timeout: 900000 }, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lama-burst-slow-'));
      fs.writeFileSync(
        path.join(dir, 'slow-install.ps1'),
        '1..8 | ForEach-Object { Write-Output "Downloading fakepkg part $_ of 8 (50 MB)"; Start-Sleep -Seconds 5 }\nWrite-Output "Successfully installed fakepkg-2.20.0"\n',
      );
      const steps = await ask(
        model,
        dir,
        'Установи пакет запуском скрипта ./slow-install.ps1 (это долгая установка, минуту-две). Дождись окончания и скажи, какая версия установилась.',
        { commandTimeoutSec: 15 },
      );
      const calls = steps.flatMap(s => s.tools);
      const runs = calls.filter(t => /slow-install/.test(String(t.args.command ?? '')));
      expect(runs.length).toBe(1);
      expect(calls.some(t => t.name === 'process_output' && /Successfully installed/.test(t.result ?? ''))).toBe(true);
      expect(steps.at(-1)!.text).toMatch(/2\.20\.0/);
    });

    it(`${model}: writes a module with tests into files and runs them`, { timeout: 900000 }, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lama-burst-py-'));
      const steps = await ask(
        model,
        dir,
        'Давай начнём новый проект: конвертер температур на Python. Сделай модуль convert.py с функциями c_to_f и f_to_c и тесты test_convert.py на unittest. Запусти тесты и убедись, что они проходят.',
      );
      const calls = steps.flatMap(s => s.tools);
      expect(fs.existsSync(path.join(dir, 'convert.py'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'test_convert.py'))).toBe(true);
      expect(calls.some(t => t.name === 'run_command' && /unittest|pytest|test_convert/.test(String(t.args.command)))).toBe(true);
      execFileSync('python', ['-m', 'unittest', '-q'], { cwd: dir, stdio: 'pipe', timeout: 30000 });
    });

    it(`${model}: changes an existing project without breaking it`, { timeout: 900000 }, async () => {
      const dir = makeExistingProject();
      const steps = await ask(
        model,
        dir,
        'Добавь в API маршрут GET /health, который отвечает JSON {"status":"ok"}. Существующие маршруты не ломай. Проверь, что всё работает.',
      );
      const calls = steps.flatMap(s => s.tools);
      console.log(`[${model}] installed deps: ${fs.existsSync(path.join(dir, 'node_modules', 'express'))}`);
      if (!fs.existsSync(path.join(dir, 'node_modules', 'express'))) execFileSync('npm', ['install'], { cwd: dir, shell: true });
      expect(fs.readFileSync(path.join(dir, 'src', 'routes.js'), 'utf8') + fs.readFileSync(path.join(dir, 'src', 'server.js'), 'utf8')).toMatch(/\/health/);
      expect(requestRoute(dir, '/health')).toMatchObject({ status: 200 });
      expect(JSON.parse(requestRoute(dir, '/health').body)).toEqual({ status: 'ok' });
      expect(requestRoute(dir, '/hello')).toEqual({ status: 200, body: 'hi' });
      expect(calls.some(t => t.name === 'edit_file' || t.name === 'write_file')).toBe(true);
    });

    it(`${model}: studies a project and writes LAMA.md`, { timeout: 900000 }, async () => {
      const dir = makeExistingProject();
      await ask(model, dir, STUDY_PROMPT);
      const notes = fs.readFileSync(path.join(dir, 'LAMA.md'), 'utf8');
      console.log(`[${model}] LAMA.md:\n${notes.slice(0, 1500)}`);
      expect(notes).toMatch(/express/i);
      expect(notes).toMatch(/routes\.js/);
      expect(fs.readFileSync(path.join(dir, 'src', 'routes.js'), 'utf8')).not.toMatch(/health/);
    });

    it(`${model}: installs a dependency and builds an express app`, { timeout: 900000 }, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lama-burst-express-'));
      await ask(
        model,
        dir,
        'Создай проект Node.js на express: установи express, сделай index.js с маршрутом GET /hello, который отвечает текстом hi, на порту 3918. Запусти, проверь запросом и останови.',
      );
      expect(fs.existsSync(path.join(dir, 'node_modules', 'express'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'index.js'), 'utf8')).toMatch(/express/);
    });
  }
});
