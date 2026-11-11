import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../shared/tools';
import { parseLooseToolCall } from './looseCalls';

describe('parseLooseToolCall', () => {
  it('recovers Gemma-style calls with plain quotes and a stray brace', () => {
    const text = 'Editing.\n<call:edit_file{find:"0.4.2",path:"docs/plan.md",replace:"0.5.0"}}/>';
    const r = parseLooseToolCall(text, TOOL_NAMES);
    expect(r).toMatchObject({ name: 'edit_file', args: { find: '0.4.2', path: 'docs/plan.md', replace: '0.5.0' } });
    expect(text.slice(0, r!.index).trim()).toBe('Editing.');
  });

  it('recovers Gemma-style calls with <|"|> string delimiters', () => {
    const r = parseLooseToolCall('<|tool_call>call:read_file{path:<|"|>a, b.txt<|"|>}<tool_call|>', TOOL_NAMES);
    expect(r).toMatchObject({ name: 'read_file', args: { path: 'a, b.txt' }, index: 0 });
  });

  it('recovers JSON calls inside a fence or tags', () => {
    const fenced = 'Sure.\n```json\n{"name": "list_dir", "arguments": {"path": "."}}\n```';
    const r = parseLooseToolCall(fenced, TOOL_NAMES);
    expect(r).toMatchObject({ name: 'list_dir', args: { path: '.' } });
    expect(fenced.slice(0, r!.index).trim()).toBe('Sure.');
    expect(
      parseLooseToolCall('<tool_call>{"name":"search","parameters":{"query":"x"}}</tool_call>', TOOL_NAMES),
    ).toMatchObject({ name: 'search', args: { query: 'x' }, index: 0 });
  });

  it('ignores unknown tools and prose', () => {
    expect(parseLooseToolCall('call:format_disk{drive:"C"}', TOOL_NAMES)).toBeNull();
    expect(parseLooseToolCall('The "name" of the file is unknown.', TOOL_NAMES)).toBeNull();
  });
});
