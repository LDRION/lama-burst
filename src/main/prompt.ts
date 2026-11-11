import { serializeToolCall, textToolsPrompt, toolResultMessage } from '../shared/textProtocol';
import { toolSubject } from '../shared/tools';
import type { ChatItem, EffectiveToolMode, ToolArgs, ToolName, ToolRun, UserItem } from '../shared/types';
import type { OllamaMessage } from './ollama';
import { folderOverview } from './tools';

/** Tool results older than this many assistant turns are trimmed to save context. */
const FULL_HISTORY_TURNS = 3;
const TRIM_LIMITS = {
  none: { result: Infinity, arg: Infinity },
  old: { result: 600, arg: 300 },
  hard: { result: 150, arg: 120 },
};
type Trim = keyof typeof TRIM_LIMITS;

/** Rough size estimate: mixed Russian/English text and code is ~3 characters per token. */
export const CHARS_PER_TOKEN = 3;

function workflowSection(tools: ToolName[], mode: EffectiveToolMode): string[] {
  const canRun = tools.includes('run_command');
  const canWrite = tools.includes('write_file');
  const lines = [
    '',
    '# How to work',
    '- Work autonomously until the task is completely done. Do the work yourself with tools: never ask the user to run commands, create files or check something for you.',
    mode === 'text'
      ? '- For a bigger task (a new project, a service, a feature), first write a short numbered plan in plain words, with NO tool tags inside the plan. Then, in the same message, write the tool tag for step 1 at the very end. Do the following steps one per message, in order.'
      : '- For a bigger task (a new project, a service, a feature), first write a short numbered plan, then carry it out step by step.',
    '- Do the steps in a sensible order: create files before running them, install packages before using them.',
  ];
  if (canWrite) {
    lines.push(
      '- In an existing project, first understand the code you will change: search for names from the task and read those files before editing.',
      "- Keep the project's structure, style and libraries. Change only what the task needs; do not rewrite working code. Use edit_file for existing files.",
    );
  }
  if (canRun) {
    lines.push(
      '- Install dependencies yourself (npm install PACKAGE, pip install PACKAGE).',
      '- Commands cannot answer questions. Add a "yes" flag only to tools that ask them: npm init -y, npx --yes create-vite@latest app --template react. pip install never asks: do not add -y to it.',
      '- Big installs (tensorflow, torch) can take many minutes. If a command is moved to the background, wait for it with process_output (wait_seconds 120) instead of starting it again.',
      '- Every command starts in the main folder. To work in a subfolder put both in one command: cd SUBFOLDER; COMMAND',
      '- After writing code, run it to check that it works: the project checks listed above, the script or the tests.',
    );
    if (tools.includes('start_process')) {
      lines.push(
        '- Start servers and other programs that keep running with start_process, never with run_command. Then check them, for example: Invoke-WebRequest http://localhost:PORT/PATH -UseBasicParsing',
        '- Stop background processes with stop_process when you no longer need them, unless the user wants the server to keep running.',
      );
    }
    lines.push('- When something fails, read the error, find the cause, fix it and try again. Do not give up after the first error.');
  } else if (canWrite) {
    lines.push('- After changing files, read them again to make sure the result is correct.');
  }
  lines.push('- At the end, give a short summary: what you did and how to run or use it.');
  return lines;
}

export async function buildSystemPrompt(opts: {
  folders: string[];
  mode: EffectiveToolMode;
  tools: ToolName[];
  userPrompt: string;
  /** Project summary and notes, already fitted to the context (see projectPrompt). */
  project?: string;
}): Promise<string> {
  const { folders, mode, tools } = opts;
  const parts = [
    "You are Lama Burst, a helpful assistant running locally on the user's Windows computer.",
    'Reply in the same language the user writes in. Be concise and accurate.',
    `Current date: ${new Date().toISOString().slice(0, 10)}.`,
  ];

  if (mode !== 'none') {
    parts.push('', '# Workspace', `Main folder: ${folders[0]}`);
    if (folders.length > 1) {
      parts.push('Other open folders (use absolute paths for them):', ...folders.slice(1).map(f => `- ${f}`));
    }
    parts.push('Files in the main folder (relative paths):', await folderOverview(folders[0]));
    parts.push('You can only access files inside the open folders.');
    if (opts.project) parts.push('', opts.project);
    if (mode === 'text') {
      parts.push('', textToolsPrompt(tools));
    } else {
      parts.push(
        '',
        '# Tools',
        'Use the provided tools to explore and change files. Never guess what is in a file: read it first.',
        'Only use file names you have seen in the folder listing or in tool results. Never invent file names.',
        'Before editing a file, read it. Use edit_file for small changes and write_file for new files.',
        'When the task is done, answer the user without calling tools.',
      );
      if (tools.includes('move_file')) parts.push('Use move_file to rename or move files and delete_file to delete them.');
    }
    if (tools.includes('run_command')) {
      parts.push(
        '',
        '# PowerShell',
        'Commands run in PowerShell on Windows, NOT bash. Use PowerShell syntax:',
        'New-Item -ItemType File (not touch), New-Item -ItemType Directory -Force (not mkdir -p), Get-ChildItem -Force (not ls -la),',
        'Get-Content (not cat), Select-String (not grep), Get-Command (not which), Remove-Item -Recurse (not rm -rf).',
        'For reading, creating, editing, renaming and deleting files prefer the file tools.',
      );
    }
    parts.push(...workflowSection(tools, mode));
  } else if (!folders.length) {
    parts.push(
      '',
      'No folder is open, so you cannot access files. If the user asks about their files, tell them to open a folder with the folder button.',
    );
  }

  if (opts.userPrompt.trim()) parts.push('', '# Instructions from the user', opts.userPrompt.trim());
  return parts.join('\n');
}

function trimArgs(args: ToolArgs, trim: Trim): ToolArgs {
  const max = TRIM_LIMITS[trim].arg;
  if (max === Infinity) return args;
  const out: ToolArgs = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'string' && v.length > max ? `${v.slice(0, max)}…` : v;
  }
  return out;
}

function resultOf(run: ToolRun, trim: Trim): string {
  const r = run.result ?? '';
  const max = TRIM_LIMITS[trim].result;
  return r.length > max ? `${r.slice(0, max)}\n[... older output trimmed ...]` : r;
}

/** Small models follow the end of the conversation more than a long system prompt. */
const TEXT_MODE_REMINDER =
  '(Act with tool tags, one per message. To create or change a file write <write_file path="FILE">...</write_file> or <edit_file>, never just show code.)';

function renderUser(item: UserItem, withFiles: boolean, remind = false): string {
  const text = remind ? `${item.text}\n\n${TEXT_MODE_REMINDER}` : item.text;
  const files = item.attachments ?? [];
  if (!files.length) return text;
  if (!withFiles) return `${item.text}\n\n[Attached earlier: ${files.map(f => f.path).join(', ')}]`;
  const blocks = files.map(
    f => `[File ${f.path}${f.note ? ` (${f.note})` : ''}, attached because the message mentions it]\n\`\`\`\n${f.content}\n\`\`\``,
  );
  return [text, ...blocks].join('\n\n');
}

function renderItem(item: ChatItem, mode: EffectiveToolMode, trim: Trim, current = false): OllamaMessage[] {
  if (item.role === 'user') return [{ role: 'user', content: renderUser(item, current, current && mode === 'text') }];
  const tools = item.tools.filter(t => t.result !== undefined);
  if (!item.text && !tools.length) return [];

  if (mode === 'native') {
    const msg: OllamaMessage = { role: 'assistant', content: item.text };
    if (tools.length) {
      msg.tool_calls = tools.map(t => ({ function: { name: t.name, arguments: trimArgs(t.args, trim) } }));
    }
    return [msg, ...tools.map(t => ({ role: 'tool' as const, tool_name: t.name, content: resultOf(t, trim) }))];
  }
  if (mode === 'text') {
    const calls = tools.map(t => serializeToolCall(t.name, trimArgs(t.args, trim)));
    const out: OllamaMessage[] = [{ role: 'assistant', content: [item.text, ...calls].filter(Boolean).join('\n\n') }];
    if (tools.length) {
      out.push({ role: 'user', content: tools.map(t => toolResultMessage(t.name, resultOf(t, trim))).join('\n\n') });
    }
    return out;
  }
  const notes = tools.map(t => `[${t.name} ${toolSubject(t.name, t.args)}]\n${resultOf(t, trim === 'none' ? 'old' : trim)}`);
  return [{ role: 'assistant', content: [item.text, ...notes].filter(Boolean).join('\n\n') }];
}

function sizeOf(msgs: OllamaMessage[]): number {
  return msgs.reduce((n, m) => n + m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
}

/**
 * Turns the chat into Ollama messages for the current tool mode. History is always rebuilt
 * from items, so a chat can switch between native and text tool calling mid-way.
 *
 * When the history doesn't fit `budgetChars`, it is shrunk so that the current task survives
 * (Ollama would otherwise silently drop the oldest messages, including the task itself):
 * older conversation goes first, then tool output is trimmed hard, then the oldest steps
 * of the current task are dropped. The last two steps always stay intact.
 */
export function buildMessages(items: ChatItem[], mode: EffectiveToolMode, budgetChars = Infinity): OllamaMessage[] {
  const assistantCount = items.filter(i => i.role === 'assistant').length;
  // Attached files are shown in full only for the current task, earlier ones are just named.
  const current = items.findLastIndex(i => i.role === 'user' && !i.auto);
  let seen = 0;
  const groups = items
    .map((item, i) => {
      if (item.role === 'assistant') seen++;
      const old = item.role === 'assistant' && assistantCount - seen >= FULL_HISTORY_TURNS;
      return { item, msgs: renderItem(item, mode, old ? 'old' : 'none', i === current) };
    })
    .filter(g => g.msgs.length);

  const total = () => groups.reduce((n, g) => n + sizeOf(g.msgs), 0);
  if (total() <= budgetChars) return groups.flatMap(g => g.msgs);

  let task = Math.max(0, groups.findLastIndex(g => g.item.role === 'user' && !g.item.auto));
  let droppedBefore = false;
  while (task > 0 && total() > budgetChars) {
    groups.shift();
    task--;
    droppedBefore = true;
  }
  if (total() > budgetChars) {
    for (let i = task + 1; i < groups.length - 2; i++) groups[i].msgs = renderItem(groups[i].item, mode, 'hard');
  }
  let droppedSteps = false;
  while (total() > budgetChars && groups.length - task > 3) {
    groups.splice(task + 1, 1);
    droppedSteps = true;
  }

  const taskItem = groups[task]?.item;
  if (taskItem?.role === 'user' && (droppedBefore || droppedSteps)) {
    const before = droppedBefore ? '[Earlier conversation was omitted to fit the context window.]\n\n' : '';
    const after = droppedSteps
      ? '\n\n[Some earlier steps of this task were omitted to fit the context window. Check the current state of files instead of relying on memory.]'
      : '';
    groups[task].msgs = [{ role: 'user', content: before + renderUser(taskItem, true, mode === 'text') + after }];
  }
  return groups.flatMap(g => g.msgs);
}
