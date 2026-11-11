import type { Permission, ToolArgs, ToolCategory, ToolName } from './types';

export const TOOL_NAMES: ToolName[] = [
  'list_dir',
  'read_file',
  'search',
  'write_file',
  'edit_file',
  'move_file',
  'delete_file',
  'run_command',
  'start_process',
  'process_output',
  'stop_process',
];

export const TOOL_CATEGORY: Record<ToolName, ToolCategory> = {
  list_dir: 'read',
  read_file: 'read',
  search: 'read',
  write_file: 'write',
  edit_file: 'write',
  move_file: 'write',
  delete_file: 'write',
  run_command: 'run',
  start_process: 'run',
  process_output: 'run',
  stop_process: 'run',
};

export const TOOL_LABEL: Record<ToolName, string> = {
  list_dir: 'Список файлов',
  read_file: 'Чтение файла',
  search: 'Поиск',
  write_file: 'Запись файла',
  edit_file: 'Правка файла',
  move_file: 'Переименование',
  delete_file: 'Удаление',
  run_command: 'Команда PowerShell',
  start_process: 'Фоновый процесс',
  process_output: 'Вывод процесса',
  stop_process: 'Остановка процесса',
};

export function enabledTools(permissions: Record<ToolCategory, Permission>): ToolName[] {
  return TOOL_NAMES.filter(t => permissions[TOOL_CATEGORY[t]] !== 'off');
}

/** The argument shown next to the tool name in the UI. */
export function toolSubject(name: ToolName, args: ToolArgs): string {
  if (name === 'run_command' || name === 'start_process') return String(args.command ?? '');
  if (name === 'process_output' && args.wait_seconds) return `#${args.id ?? '?'}, ждать до ${args.wait_seconds} с`;
  if (name === 'process_output' || name === 'stop_process') return `#${args.id ?? '?'}`;
  if (name === 'search') return String(args.query ?? '');
  if (name === 'move_file') return `${args.path ?? ''} → ${args.new_path ?? ''}`;
  const p = String(args.path ?? '.');
  if (name === 'read_file' && args.start_line) return `${p}:${args.start_line}-${args.end_line ?? ''}`;
  return p;
}

const DESCRIPTIONS: Record<ToolName, string> = {
  list_dir: 'List files and folders in a directory. Folders end with "/".',
  read_file: 'Read a text file. Optionally pass start_line and end_line (1-based) to read part of a large file.',
  search: 'Case-insensitive search for text in file names and file contents under a folder. Returns matching lines as path:line: text.',
  write_file: 'Create a new file or completely overwrite an existing one with the given content.',
  edit_file:
    'Replace one exact fragment of an existing file. "find" must match the current file text exactly and occur only once: read the file first. To add new code, put an existing line in "find" and the same line followed by the new code in "replace". Keep the style the file already uses (for example require/module.exports or import/export).',
  move_file: 'Rename or move a file or folder inside the open folders. If new_path is an existing folder, the item is moved into it.',
  delete_file: 'Delete a file or folder. It goes to the Recycle Bin, and the user always confirms deletions.',
  run_command:
    'Run a PowerShell command in the main folder, wait for it to finish and return its output. Use it for installing packages, running scripts and tests, git. Do not use it for servers or watchers that never finish: use start_process.',
  start_process:
    'Start a long-running PowerShell command in the background (a web server, a dev server, a watcher). Returns its process id and the first seconds of output; the process keeps running.',
  process_output:
    'Show the status and the latest output of a background process. With wait_seconds it first waits up to that long for the process to finish: use it to wait for a long install or build.',
  stop_process: 'Stop a background process started with start_process.',
};

interface JsonSchemaProp {
  type: 'string' | 'integer';
  description: string;
}

const PARAMS: Record<ToolName, { properties: Record<string, JsonSchemaProp>; required: string[] }> = {
  list_dir: {
    properties: { path: { type: 'string', description: 'Folder path, relative to the main folder. Use "." for the main folder.' } },
    required: ['path'],
  },
  read_file: {
    properties: {
      path: { type: 'string', description: 'File path, relative to the main folder.' },
      start_line: { type: 'integer', description: 'First line to read (optional).' },
      end_line: { type: 'integer', description: 'Last line to read (optional).' },
    },
    required: ['path'],
  },
  search: {
    properties: {
      query: { type: 'string', description: 'Text to look for.' },
      path: { type: 'string', description: 'Folder to search in (optional, default ".").' },
    },
    required: ['query'],
  },
  write_file: {
    properties: {
      path: { type: 'string', description: 'File path, relative to the main folder.' },
      content: { type: 'string', description: 'Full new content of the file.' },
    },
    required: ['path', 'content'],
  },
  edit_file: {
    properties: {
      path: { type: 'string', description: 'File path, relative to the main folder.' },
      find: { type: 'string', description: 'Exact existing text to replace.' },
      replace: { type: 'string', description: 'New text.' },
    },
    required: ['path', 'find', 'replace'],
  },
  move_file: {
    properties: {
      path: { type: 'string', description: 'Current path of the file or folder.' },
      new_path: { type: 'string', description: 'New path (new name, or a folder to move into).' },
    },
    required: ['path', 'new_path'],
  },
  delete_file: {
    properties: { path: { type: 'string', description: 'Path of the file or folder to delete.' } },
    required: ['path'],
  },
  run_command: {
    properties: { command: { type: 'string', description: 'PowerShell command to run.' } },
    required: ['command'],
  },
  start_process: {
    properties: { command: { type: 'string', description: 'PowerShell command that keeps running.' } },
    required: ['command'],
  },
  process_output: {
    properties: {
      id: { type: 'integer', description: 'Process number.' },
      wait_seconds: { type: 'integer', description: 'Wait up to this many seconds for the process to finish (optional, max 300).' },
    },
    required: ['id'],
  },
  stop_process: {
    properties: { id: { type: 'integer', description: 'Process number returned by start_process.' } },
    required: ['id'],
  },
};

export function nativeToolSchemas(tools: ToolName[]) {
  return tools.map(name => ({
    type: 'function' as const,
    function: {
      name,
      description: DESCRIPTIONS[name],
      parameters: { type: 'object' as const, ...PARAMS[name] },
    },
  }));
}
