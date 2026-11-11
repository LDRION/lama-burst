import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findMentionedFiles, readAttachments } from './attachments';
import { projectPrompt, scanProject } from './project';

function makeDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lama-burst-project-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const nodeProject = () =>
  makeDir({
    'package.json': JSON.stringify({
      name: 'shop-api',
      description: 'REST API for the shop',
      scripts: { dev: 'nodemon src/server.js', test: 'vitest run', lint: 'eslint .', build: 'tsc' },
      dependencies: { express: '^4', mongoose: '^8' },
      devDependencies: { typescript: '^5', vitest: '^4' },
    }),
    'tsconfig.json': '{}',
    'pnpm-lock.yaml': '',
    'src/server.js': 'require("./routes")',
    'src/routes.js': 'module.exports = router;\n// GET /hello\n',
    'README.md': '![badge](x.svg)\n# Shop API\n\nOrders and payments.\n',
    'CLAUDE.md': '- Use async/await, no callbacks.\n- Commit messages in English.',
  });

describe('scanProject', () => {
  it('reads a Node project: stack, commands, notes and missing dependencies', async () => {
    const info = await scanProject(nodeProject());
    expect(info.name).toBe('shop-api');
    expect(info.stack).toEqual(expect.arrayContaining(['Node.js', 'Express', 'MongoDB', 'TypeScript', 'Vitest']));
    expect(info.packageManager).toBe('pnpm');
    expect(info.run).toEqual(['pnpm dev']);
    expect(info.checks).toEqual(['pnpm test', 'pnpm lint', 'pnpm build']);
    expect(info.modelWarnings[0]).toMatch(/no node_modules.*pnpm install/);
    expect(info.warnings[0]).toMatch(/Зависимости не установлены/);
    expect(info.notesFile).toBe('CLAUDE.md');
    expect(info.keyFiles).toEqual(expect.arrayContaining(['README.md', 'package.json', 'src/server.js']));
    expect(info.readme).not.toContain('badge');
  });

  it('reads a Python project and warns about a missing venv', async () => {
    const info = await scanProject(
      makeDir({ 'requirements.txt': 'fastapi==0.115\nuvicorn[standard]>=0.30\npytest\n', 'main.py': 'print(1)' }),
    );
    expect(info.stack).toEqual(expect.arrayContaining(['Python', 'FastAPI', 'pytest']));
    expect(info.run).toEqual(['python main.py']);
    expect(info.checks).toEqual(['python -m pytest']);
    expect(info.modelWarnings.join(' ')).toMatch(/python -m venv \.venv/);
  });

  it('uses the venv when there is one', async () => {
    const info = await scanProject(makeDir({ 'requirements.txt': 'flask\n', 'app.py': '', '.venv/pyvenv.cfg': '' }));
    expect(info.run).toEqual(['.venv\\Scripts\\python app.py']);
    expect(info.warnings).toEqual([]);
  });

  it('handles an empty folder', async () => {
    const info = await scanProject(makeDir({}));
    expect(info.stack).toEqual([]);
    expect(info.files.total).toBe(0);
  });
});

describe('projectPrompt', () => {
  it('puts facts first, then notes, within the limit', async () => {
    const info = await scanProject(nodeProject());
    const full = projectPrompt(info, 5000);
    expect(full).toMatch(/^# Project\nName: shop-api — REST API for the shop/);
    expect(full).toContain('Checks (run them after changes): pnpm test | pnpm lint | pnpm build');
    expect(full).toContain('# Project notes (follow them)\n## CLAUDE.md\n- Use async/await');
    const short = projectPrompt(info, 400);
    expect(short.length).toBeLessThanOrEqual(400);
    expect(short).toContain('Name: shop-api');
  });

  it('falls back to the README when there are no notes', async () => {
    const info = await scanProject(makeDir({ 'README.md': '# Tool\nDoes things.', 'index.js': '' }));
    expect(projectPrompt(info, 3000)).toContain('# README (beginning)\n# Tool\nDoes things.');
  });
});

describe('attachments', () => {
  it('finds files mentioned by path or by a unique name', async () => {
    const dir = nodeProject();
    const files = await findMentionedFiles(
      'Добавь маршрут /health в routes.js и поправь src/server.js, версия 0.4.2, см. https://x.com/a.js',
      [dir],
    );
    expect(files.map(f => path.relative(dir, f))).toEqual([path.join('src', 'routes.js'), path.join('src', 'server.js')]);
  });

  it('ignores ambiguous names and missing files', async () => {
    const dir = makeDir({ 'a/index.js': '', 'b/index.js': '' });
    expect(await findMentionedFiles('открой index.js и nope.ts', [dir])).toEqual([]);
  });

  it('reads attachments within the budget, cutting at whole lines', async () => {
    const dir = makeDir({ 'big.js': Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n') });
    const [a] = await readAttachments([path.join(dir, 'big.js')], [dir], 200);
    expect(a.path).toBe('big.js');
    expect(a.content.length).toBeLessThanOrEqual(200);
    expect(a.content.endsWith('\n')).toBe(false);
    expect(a.note).toMatch(/^lines 1-\d+ of 500/);
  });
});
