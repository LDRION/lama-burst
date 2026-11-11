import type { ToolArgs, ToolName } from './types';

/**
 * Tool calling for models without native support: tools are described as XML-like tags
 * in the system prompt, and the model's reply is parsed for the first tag.
 */

export interface ParsedCall {
  name: ToolName;
  args: ToolArgs;
  /** Position of the opening tag; text before it is the model's visible message. */
  index: number;
}

const SYNTAX: Record<ToolName, string> = {
  list_dir: '<list_dir>FOLDER</list_dir>\n  List a folder. Use "." for the main folder.',
  read_file:
    '<read_file>FILE</read_file>\n  Read a text file. For part of a big file add line numbers: <read_file>FILE:START-END</read_file>',
  search: '<search>TEXT</search>\n  Find TEXT in file names and file contents (case-insensitive).',
  write_file: '<write_file path="FILE">\nFULL NEW CONTENT\n</write_file>\n  Create a file or overwrite it completely.',
  edit_file:
    '<edit_file path="FILE">\n<find>\nEXACT OLD TEXT\n</find>\n<replace>\nNEW TEXT\n</replace>\n</edit_file>\n  Replace one fragment of a file. The old text must match the file exactly: read the file first.\n  To add new code: put an existing line in find, and the same line plus the new code in replace.\n  Keep the style the file already uses (for example require/module.exports or import/export).',
  move_file: '<move_file>OLD_PATH -> NEW_PATH</move_file>\n  Rename or move a file or folder.',
  delete_file: '<delete_file>PATH</delete_file>\n  Delete a file or folder (it goes to the Recycle Bin).',
  run_command:
    '<run_command>COMMAND</run_command>\n  Run a PowerShell command in the main folder and wait for it to finish: install packages, run scripts and tests.',
  start_process:
    '<start_process>COMMAND</start_process>\n  Start a command that keeps running (a server, a watcher) in the background. Returns its ID and first output.',
  process_output:
    '<process_output>ID</process_output>\n  Show the latest output of a background process. To wait up to 120 seconds for it to finish (a long install): <process_output wait="120">ID</process_output>',
  stop_process: '<stop_process>ID</stop_process>\n  Stop a background process.',
};

export function textToolsPrompt(tools: ToolName[]): string {
  return [
    '# Tools',
    "You can act on the user's computer by writing a tool tag. Available tools:",
    '',
    tools.map(t => SYNTAX[t]).join('\n\n'),
    '',
    'How to use tools:',
    '- Write at most ONE tool tag per message, at the very end of the message, then stop and wait.',
    '- The result comes back to you in a <tool_result> message. Never write <tool_result> yourself.',
    '- Words in CAPITALS (FOLDER, FILE, PATH, TEXT, COMMAND...) are placeholders: replace them with real values. Paths are relative to the main folder.',
    '- Only use file names you have seen in the folder listing or in tool results. Never invent file names.',
    '- Never guess what is in a file: read it first.',
    '- Never show code to the user to copy: put it into the file yourself with write_file.',
    '- When the task is done, answer the user normally, without any tags.',
    ...(tools.includes('write_file') && tools.includes('run_command') ? EXAMPLE : []),
  ].join('\n');
}

/** A tiny worked exchange: small models follow an example much better than rules. */
const EXAMPLE = [
  '',
  'Example. The user asks: "Make hello.py that prints hi and run it". Your messages, one per step:',
  'Message 1:',
  'Plan: 1) create hello.py 2) run it 3) report.',
  '<write_file path="hello.py">',
  'print("hi")',
  '</write_file>',
  'Message 2 (after the result came back):',
  '<run_command>python hello.py</run_command>',
  'Message 3 (after the result came back):',
  'Done: hello.py prints "hi".',
  '(This is only an example of the format. Work on the real task of the user.)',
];

export function textStopSequences(tools: ToolName[]): string[] {
  return [...tools.map(t => `</${t}>`), '<tool_result'];
}

function attr(attrs: string, key: string): string | undefined {
  return attrs.match(new RegExp(`\\b${key}\\s*=\\s*["']([^"']*)["']`))?.[1];
}

function child(body: string, key: string): string | undefined {
  return body.match(new RegExp(`<${key}>([\\s\\S]*?)(?:</${key}>|$)`))?.[1];
}

/** Drop one leading and one trailing line break, which the tag layout adds around block content. */
function block(s: string): string {
  return s.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
}

function unwrapFence(s: string): string {
  const m = s.match(/^\s*```[\w.+-]*\r?\n([\s\S]*?)\r?\n?```\s*$/);
  return m ? m[1] : s;
}

function plain(s: string): string {
  return s.trim().replace(/^[`"']+|[`"']+$/g, '').trim();
}

function parseArgs(name: ToolName, attrs: string, body: string): ToolArgs {
  const pathArg = () => plain(attr(attrs, 'path') ?? child(body, 'path') ?? body);
  switch (name) {
    case 'list_dir':
      return { path: pathArg() || '.' };
    case 'read_file': {
      let p = pathArg();
      const range = p.match(/:(\d+)\s*-\s*(\d*)$/);
      if (!range) return { path: p };
      p = p.slice(0, range.index);
      return { path: p, start_line: Number(range[1]), end_line: range[2] ? Number(range[2]) : undefined };
    }
    case 'search':
      return {
        query: plain(attr(attrs, 'query') ?? child(body, 'query') ?? body),
        path: plain(attr(attrs, 'path') ?? '.') || '.',
      };
    case 'write_file': {
      const content = child(body, 'content') ?? body.replace(/<path>[\s\S]*?<\/path>/, '');
      return { path: plain(attr(attrs, 'path') ?? child(body, 'path') ?? ''), content: unwrapFence(block(content)) };
    }
    case 'edit_file': {
      // find/replace are normally child tags, but leaked native calls put them in attributes.
      const findChild = child(body, 'find') ?? child(body, 'old');
      const replaceChild = child(body, 'replace') ?? child(body, 'new');
      return {
        path: plain(attr(attrs, 'path') ?? child(body, 'path') ?? ''),
        find: findChild !== undefined ? block(findChild) : (attr(attrs, 'find') ?? ''),
        replace: replaceChild !== undefined ? block(replaceChild) : (attr(attrs, 'replace') ?? ''),
      };
    }
    case 'move_file': {
      let from = attr(attrs, 'path') ?? attr(attrs, 'from') ?? child(body, 'from') ?? child(body, 'path');
      let to = attr(attrs, 'to') ?? attr(attrs, 'new_path') ?? child(body, 'to') ?? child(body, 'new_path');
      if (from === undefined || to === undefined) {
        const parts = body.split(/\s*(?:->|→|=>)\s*/);
        if (parts.length >= 2) {
          from ??= parts[0];
          to ??= parts[1];
        } else if (from !== undefined) to = body;
        else from = body;
      }
      return { path: plain(from ?? ''), new_path: plain(to ?? '') };
    }
    case 'delete_file':
      return { path: pathArg() };
    case 'run_command':
    case 'start_process':
      return { command: unwrapFence(child(body, 'command') ?? body).trim().replace(/^`+|`+$/g, '') };
    case 'process_output':
    case 'stop_process': {
      const id = (attr(attrs, 'id') ?? child(body, 'id') ?? body).match(/\d+/)?.[0];
      const wait = name === 'process_output' ? (attr(attrs, 'wait') ?? attr(attrs, 'wait_seconds'))?.match(/\d+/)?.[0] : undefined;
      return wait ? { id: id ? Number(id) : undefined, wait_seconds: Number(wait) } : { id: id ? Number(id) : undefined };
    }
  }
}

/**
 * Finds the first tool tag. A missing closing tag is fine: generation is stopped on it.
 * A tag whose body contains another tool tag is a mention in prose ("I'll use the <write_file> tool:
 * <write_file path=...>"), so the real call after it is taken instead.
 */
export function parseToolCall(text: string, tools: ToolName[]): ParsedCall | null {
  if (!tools.length) return null;
  const names = tools.join('|');
  const open = new RegExp(`<(${names})(\\s[^>]*)?>`, 'g');
  const nested = new RegExp(`<(${names})[\\s>/]`);
  let fallback: ParsedCall | null = null;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const name = m[1] as ToolName;
    let attrs = m[2] ?? '';
    const start = m.index + m[0].length;
    let body = '';
    if (attrs.trimEnd().endsWith('/')) {
      attrs = attrs.trimEnd().slice(0, -1);
    } else {
      const close = text.indexOf(`</${name}>`, start);
      body = close === -1 ? text.slice(start) : text.slice(start, close);
    }
    const call = { name, args: parseArgs(name, attrs, body), index: m.index };
    if (!nested.test(body)) return call;
    fallback ??= call;
  }
  return fallback;
}

export function serializeToolCall(name: ToolName, args: ToolArgs): string {
  switch (name) {
    case 'list_dir':
      return `<list_dir>${args.path ?? '.'}</list_dir>`;
    case 'read_file':
      return `<read_file>${args.path}${args.start_line ? `:${args.start_line}-${args.end_line ?? ''}` : ''}</read_file>`;
    case 'search':
      return args.path && args.path !== '.'
        ? `<search path="${args.path}">${args.query}</search>`
        : `<search>${args.query}</search>`;
    case 'write_file':
      return `<write_file path="${args.path}">\n${args.content}\n</write_file>`;
    case 'edit_file':
      return `<edit_file path="${args.path}">\n<find>\n${args.find}\n</find>\n<replace>\n${args.replace}\n</replace>\n</edit_file>`;
    case 'move_file':
      return `<move_file>${args.path} -> ${args.new_path}</move_file>`;
    case 'delete_file':
      return `<delete_file>${args.path}</delete_file>`;
    case 'run_command':
      return `<run_command>${args.command}</run_command>`;
    case 'start_process':
      return `<start_process>${args.command}</start_process>`;
    case 'process_output':
      return args.wait_seconds
        ? `<process_output wait="${args.wait_seconds}">${args.id}</process_output>`
        : `<process_output>${args.id}</process_output>`;
    case 'stop_process':
      return `<stop_process>${args.id}</stop_process>`;
  }
}

export function toolResultMessage(name: ToolName, result: string): string {
  return `<tool_result tool="${name}">\n${result}\n</tool_result>`;
}

/** Text to show while streaming: everything before a tool tag, including one still being typed. */
export function visibleText(text: string, tools: ToolName[]): string {
  const m = new RegExp(`<(${tools.join('|')})[\\s>/]`).exec(text);
  if (m) return text.slice(0, m.index).trimEnd();
  const lt = text.lastIndexOf('<');
  if (lt !== -1) {
    const tail = text.slice(lt + 1);
    if (/^[a-z_]*$/.test(tail) && tools.some(t => t.startsWith(tail))) return text.slice(0, lt).trimEnd();
  }
  return text;
}
