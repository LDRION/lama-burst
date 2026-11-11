import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { AssistantItem, Session, Settings, UserItem } from '../shared/types';
import { actionKey, isLooping, promisesAction, runAgent, type AgentHost } from './agent';
import type { ChatChunk, ChatRequest, Ollama } from './ollama';

describe('isLooping', () => {
  it('detects a reply stuck repeating itself', () => {
    const chunk = 'The server is running on port 3000. Let me check it again with a request to make sure. ';
    expect(isLooping('Plan: start the server.\n' + chunk.repeat(30))).toBe(true);
  });

  it('accepts long normal text and code', () => {
    const code = Array.from({ length: 200 }, (_, i) => `app.get('/route${i}', (req, res) => res.send('${i}'));`).join('\n');
    expect(isLooping(code)).toBe(false);
    expect(isLooping('short')).toBe(false);
  });
});

describe('promisesAction', () => {
  it('detects a reply that announces a tool call and stops', () => {
    expect(promisesAction('The search found nothing. I will now read the entire file to see what is there.')).toBe(true);
    expect(promisesAction('Сейчас прочитаю файл plan.md.')).toBe(true);
    expect(promisesAction('Let me check the folder:')).toBe(true);
    expect(promisesAction('Пакет установлен. Теперь добавим маршрут GET /health и проверим работу API.')).toBe(true);
  });

  it('accepts normal final answers', () => {
    expect(promisesAction('Созвон в среду в 15:00.')).toBe(false);
    expect(promisesAction('Done. I updated the version to 0.5.0.')).toBe(false);
    expect(promisesAction('Let me know if you need anything else!')).toBe(false);
  });
});

type Reply = string | { text: string; doneReason: string };

/** A model that answers with the given replies in order. Text tool mode unless `tools` is passed. */
function scriptedModel(replies: Reply[], caps: string[] = ['completion']) {
  const requests: ChatRequest[] = [];
  const ollama = {
    getModel: async () => ({
      name: 'fake',
      size: 0,
      family: '',
      parameterSize: '',
      quantization: '',
      capabilities: caps,
      stop: [],
    }),
    async *chat(req: ChatRequest): AsyncGenerator<ChatChunk> {
      requests.push(req);
      const r = replies.shift() ?? 'No more replies.';
      const { text, doneReason } = typeof r === 'string' ? { text: r, doneReason: 'stop' } : r;
      yield { message: { content: text } };
      yield { done: true, done_reason: doneReason, prompt_eval_count: 100, eval_count: 10, eval_duration: 1e9 };
    },
  } as unknown as Ollama;
  return { ollama, requests };
}

async function run(replies: Reply[], text: string, mode: 'text' | 'native' = 'text') {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'lama-burst-agent-'));
  const settings: Settings = { ...DEFAULT_SETTINGS, permissions: { read: 'auto', write: 'auto', run: 'auto' } };
  const { ollama, requests } = scriptedModel(replies, mode === 'native' ? ['completion', 'tools'] : ['completion']);
  const session: Session = {
    id: 's',
    title: '',
    model: 'fake',
    folders: [folder],
    items: [{ id: 'u', role: 'user', text, time: 0 }],
    createdAt: 0,
    updatedAt: 0,
  };
  const host: AgentHost = {
    ollama,
    settings: () => settings,
    emit: () => {},
    approve: async () => 'allow',
    allowAlways: () => {},
    save: () => {},
  };
  await runAgent(session, host, new AbortController().signal);
  return { folder, session, requests };
}

describe('runAgent', () => {
  it('sends the model back to run code it wrote but never ran', async () => {
    const { folder, session, requests } = await run(
      [
        '<write_file path="app.js">\nconsole.log(6 * 7)\n</write_file>',
        'Готово, создал app.js.',
        '<run_command>node app.js</run_command>',
        'Проверил: скрипт выводит 42.',
      ],
      'Сделай скрипт, который печатает 6*7',
    );
    expect(fs.readFileSync(path.join(folder, 'app.js'), 'utf8')).toBe('console.log(6 * 7)');
    const nudge = session.items.find((i): i is UserItem => i.role === 'user' && !!i.auto);
    expect(nudge?.autoReason).toBe('verify');
    const steps = session.items.filter((i): i is AssistantItem => i.role === 'assistant');
    expect(steps.flatMap(s => s.tools).map(t => t.name)).toEqual(['write_file', 'run_command']);
    expect(steps[2].tools[0].result).toMatch(/Exit code: 0\n42/);
    expect(steps.at(-1)?.text).toBe('Проверил: скрипт выводит 42.');
    expect(requests).toHaveLength(4);
  });

  it('sends the model back to fix a failed step instead of giving up', async () => {
    const { session, requests } = await run(
      [
        '<run_command>node server.js</run_command>',
        'Похоже, вы запускаете не из той папки. Проверьте путь.',
        '<write_file path="server.js">\nconsole.log("up")\n</write_file>',
        '<run_command>node server.js</run_command>',
        'Сервер запускается и пишет up.',
      ],
      'Запусти server.js',
    );
    const steps = session.items.filter((i): i is AssistantItem => i.role === 'assistant');
    expect(steps[0].tools[0].result).toMatch(/^Exit code: 1/);
    expect(session.items.find(i => i.role === 'user' && i.auto)).toMatchObject({ autoReason: 'fix' });
    expect(steps.at(-1)?.text).toBe('Сервер запускается и пишет up.');
    expect(requests).toHaveLength(5);
  });

  it('asks again after an empty reply with a swallowed tool call', async () => {
    const { session } = await run(['', '<list_dir>.</list_dir>', 'Пусто.'], 'Что в папке?');
    expect(session.items.find(i => i.role === 'user' && i.auto)).toMatchObject({ autoReason: 'retry' });
    expect(session.items.filter((i): i is AssistantItem => i.role === 'assistant').at(-1)?.text).toBe('Пусто.');
  });

  it('recovers native tool calls that leaked into the text as tags', async () => {
    const { folder, session } = await run(
      [
        'Создаю файл.\n<tools>\n<write_file path="hi.txt">\nhello\n</write_file>',
        'Записал hi.txt.',
      ],
      'Сделай файл hi.txt со словом hello',
      'native',
    );
    const first = session.items.find((i): i is AssistantItem => i.role === 'assistant')!;
    expect(first.tools[0]).toMatchObject({ name: 'write_file', status: 'done' });
    expect(first.text).toBe('Создаю файл.');
    expect(fs.readFileSync(path.join(folder, 'hi.txt'), 'utf8')).toBe('hello');
  });

  it('does not let the model finish while its change was never applied', async () => {
    const edit = (find: string, replace: string) =>
      `<edit_file path="r.js">\n<find>\n${find}\n</find>\n<replace>\n${replace}\n</replace>\n</edit_file>`;
    const { folder, session } = await run(
      [
        '<write_file path="r.js">\nmodule.exports = 1;\n</write_file>',
        edit('export default 1;', 'x'),
        '<run_command>node -e "1"</run_command>',
        'Готово, маршрут добавлен.',
        edit('module.exports = 1;', 'module.exports = 2;'),
        '<run_command>node r.js</run_command>',
        'Теперь точно готово.',
      ],
      'Поменяй экспорт на 2',
    );
    const nudge = session.items.find((i): i is UserItem => i.role === 'user' && !!i.auto);
    expect(nudge?.autoReason).toBe('fix');
    expect(nudge?.text).toMatch(/NOT done: your changes to r\.js were not applied/);
    expect(fs.readFileSync(path.join(folder, 'r.js'), 'utf8')).toBe('module.exports = 2;');
  });

  it('makes the model save code it only showed in the chat', async () => {
    const shown = 'Вот код:\n```python\nimport sys\n\ndef main():\n    print(len(sys.argv))\n\nmain()\n```\nГотово, запустите его.';
    const { folder, session } = await run(
      [
        shown,
        '<write_file path="count.py">\nimport sys\n\ndef main():\n    print(len(sys.argv))\n\nmain()\n</write_file>',
        '<run_command>python count.py</run_command>',
        'Скрипт работает и печатает 1.',
      ],
      'Сделай скрипт count.py, который печатает число аргументов',
    );
    expect(session.items.find(i => i.role === 'user' && i.auto)).toMatchObject({ autoReason: 'write' });
    expect(fs.existsSync(path.join(folder, 'count.py'))).toBe(true);
  });

  it('writes new files the model described with code blocks instead of tool calls', async () => {
    const { folder, session } = await run(
      [
        'Create a file named calc.py and write the following code:\n```python\ndef add(a, b):\n    return a + b\n```',
        '<run_command>python -c "import calc; print(calc.add(2, 3))"</run_command>',
        'Работает: 2 + 3 = 5.',
      ],
      'Сделай модуль calc.py со сложением и проверь его',
    );
    const first = session.items.find((i): i is AssistantItem => i.role === 'assistant')!;
    expect(first.tools[0]).toMatchObject({ name: 'write_file', fromText: true, status: 'done' });
    expect(first.text).toContain('*(код записан в файл calc.py)*');
    expect(fs.readFileSync(path.join(folder, 'calc.py'), 'utf8')).toBe('def add(a, b):\n    return a + b');
    expect(session.items.some(i => i.role === 'user' && i.auto)).toBe(false);
  });

  it('lets the model show code when the user only asked to see it', async () => {
    const { session } = await run(
      ['Пример:\n```js\nconst a = 1;\nconst b = 2;\nconst c = a + b;\nconsole.log(c);\n```'],
      'Покажи пример сложения в JS',
    );
    expect(session.items.some(i => i.role === 'user' && i.auto)).toBe(false);
  });

  it('nudges a model that only wrote a plan', async () => {
    const { session } = await run(
      ['План:\n1. Создать hello.txt\n2. Проверить', '<write_file path="hello.txt">\nhi\n</write_file>', 'Готово.'],
      'Сделай hello.txt',
    );
    expect(session.items.find(i => i.role === 'user' && i.auto)).toMatchObject({ autoReason: 'continue' });
  });

  it('does not ask to verify edits of notes and docs', async () => {
    const { session, requests } = await run(
      ['<write_file path="notes.md">\n- milk\n</write_file>', 'Записал.'],
      'Запиши список покупок',
    );
    expect(session.items.some(i => i.role === 'user' && i.auto)).toBe(false);
    expect(requests).toHaveLength(2);
  });

  it('cuts a looping reply and stops', async () => {
    const { session, requests } = await run(['Проверяю сервер снова и снова, чтобы убедиться. '.repeat(40)], 'Проверь');
    const last = session.items.at(-1) as AssistantItem;
    expect(last.error).toMatch(/повторять/);
    expect(last.text.length).toBeLessThan(1600);
    expect(requests).toHaveLength(1);
  });

  it('never writes half a file when the reply hit the length limit', async () => {
    const { folder, session } = await run(
      [
        { text: '<write_file path="big.js">\nconst a = 1;\nconst b =', doneReason: 'length' },
        '<write_file path="big.js">\nconst a = 1;\n</write_file>',
        '<run_command>node big.js</run_command>',
        'Готово.',
      ],
      'Сделай big.js',
    );
    const first = (session.items[1] as AssistantItem).tools[0];
    expect(first.status).toBe('error');
    expect(first.result).toMatch(/cut off at the length limit/);
    expect(session.items.some(i => i.role === 'user' && i.autoReason === 'fix')).toBe(false);
    expect(fs.readFileSync(path.join(folder, 'big.js'), 'utf8')).toBe('const a = 1;');
  });

  it('stops a model that repeats the same failing call', async () => {
    const { session, requests } = await run(Array(10).fill('<run_command>node index.js</run_command>'), 'Запусти');
    const steps = session.items.filter((i): i is AssistantItem => i.role === 'assistant');
    expect(steps).toHaveLength(4);
    expect(steps[0].tools[0].result).toContain('the file');
    expect(steps[1].tools[0].result).toContain('NOTE: this is attempt 2 of the same action');
    expect(steps.at(-1)?.notice).toMatch(/зациклилась/);
    expect(requests).toHaveLength(4);
  });

  it('treats the same command with other flags as a repeat', async () => {
    expect(actionKey('run_command', { command: 'pip install tensorflow -y --no-cache-dir' })).toBe(
      actionKey('run_command', { command: 'pip install tensorflow --force-reinstall' }),
    );
    expect(actionKey('run_command', { command: 'pip install numpy' })).not.toBe(
      actionKey('run_command', { command: 'pip install tensorflow' }),
    );
    const { session } = await run(
      Array(5)
        .fill(0)
        .map((_, i) => `<run_command>node missing.js --try${i}</run_command>`),
      'Запусти',
    );
    const steps = session.items.filter((i): i is AssistantItem => i.role === 'assistant');
    expect(steps).toHaveLength(4);
    expect(steps.at(-1)?.notice).toMatch(/зациклилась/);
  });

  it('stops after the step limit', async () => {
    const { session } = await run(Array(60).fill('<list_dir>.</list_dir>'), 'Смотри папку бесконечно');
    const steps = session.items.filter((i): i is AssistantItem => i.role === 'assistant');
    expect(steps).toHaveLength(DEFAULT_SETTINGS.maxSteps);
    expect(steps.at(-1)?.notice).toMatch(/лимит шагов/);
  });
});
