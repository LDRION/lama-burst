import type { ToolName } from '../shared/types';

/**
 * Many GGUF imports have chat templates that Ollama can't parse tool calls from, so the call
 * ends up in plain text. This recovers the two common shapes:
 *   Gemma:  <|tool_call>call:read_file{path:<|"|>a.txt<|"|>}<tool_call|>   or   call:read_file{path:"a.txt"}
 *   JSON:   {"name": "read_file", "arguments": {"path": "a.txt"}}   (often inside <tool_call> or ```json)
 */

export interface LooseCall {
  name: ToolName;
  args: Record<string, unknown>;
  /** Where the visible text should be cut. */
  index: number;
}

function balancedObject(text: string, open: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

function parseLooseObject(s: string): Record<string, unknown> | null {
  const attempts = [
    s,
    s
      .replace(/<\|"\|>([\s\S]*?)<\|"\|>/g, (_, v: string) => JSON.stringify(v))
      .replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":'),
  ];
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // try the next form
    }
  }
  return null;
}

/** Cut position: also drop the wrapper that opened the call, like "<|tool_call>", "<" or "```json". */
function cutIndex(text: string, at: number): number {
  const before = text.slice(0, at);
  const wrapper = before.match(/(?:<\|?tool_call\|?>|```(?:json)?|<)\s*$/);
  return wrapper ? at - wrapper[0].length : at;
}

export function parseLooseToolCall(text: string, tools: ToolName[]): LooseCall | null {
  if (!tools.length) return null;
  const names = tools.join('|');

  const gemma = new RegExp(`call:(${names})\\s*\\{`).exec(text);
  if (gemma) {
    const obj = balancedObject(text, gemma.index + gemma[0].length - 1);
    const args = obj && parseLooseObject(obj);
    if (args) return { name: gemma[1] as ToolName, args, index: cutIndex(text, gemma.index) };
  }

  const json = new RegExp(`"name"\\s*:\\s*"(${names})"`).exec(text);
  if (json) {
    const open = text.lastIndexOf('{', json.index);
    const obj = open === -1 ? null : balancedObject(text, open);
    const parsed = obj ? parseLooseObject(obj) : null;
    const args = parsed?.arguments ?? parsed?.parameters ?? {};
    const argsObj = typeof args === 'string' ? parseLooseObject(args) : args;
    if (parsed && argsObj && typeof argsObj === 'object') {
      return { name: json[1] as ToolName, args: argsObj as Record<string, unknown>, index: cutIndex(text, open) };
    }
  }
  return null;
}
