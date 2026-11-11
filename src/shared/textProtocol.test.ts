import { describe, expect, it } from 'vitest';
import { parseToolCall, serializeToolCall, visibleText } from './textProtocol';
import { TOOL_NAMES } from './tools';

const all = TOOL_NAMES;

describe('parseToolCall', () => {
  it('parses a closed tag and keeps the text before it', () => {
    const r = parseToolCall('Let me look.\n<read_file>docs/plan.md</read_file>', all);
    expect(r).toMatchObject({ name: 'read_file', args: { path: 'docs/plan.md' } });
    expect('Let me look.\n<read_file>docs/plan.md</read_file>'.slice(0, r!.index)).toBe('Let me look.\n');
  });

  it('accepts a tag cut off by the stop sequence', () => {
    expect(parseToolCall('<list_dir>.', all)).toMatchObject({ name: 'list_dir', args: { path: '.' } });
    expect(parseToolCall('<list_dir>', all)).toMatchObject({ args: { path: '.' } });
  });

  it('accepts a nested <path> and quoted paths', () => {
    expect(parseToolCall('<read_file><path>a/b.txt</path></read_file>', all)?.args.path).toBe('a/b.txt');
    expect(parseToolCall('<read_file>"a b.txt"</read_file>', all)?.args.path).toBe('a b.txt');
  });

  it('parses line ranges', () => {
    expect(parseToolCall('<read_file>src/app.ts:10-40</read_file>', all)?.args).toEqual({
      path: 'src/app.ts',
      start_line: 10,
      end_line: 40,
    });
    expect(parseToolCall('<read_file>C:\\x\\app.ts</read_file>', all)?.args).toEqual({ path: 'C:\\x\\app.ts' });
  });

  it('parses write_file and unwraps a code fence', () => {
    const r = parseToolCall('<write_file path="hello.py">\n```python\nprint("hi")\n```\n', all);
    expect(r?.args).toEqual({ path: 'hello.py', content: 'print("hi")' });
  });

  it('keeps write_file content verbatim, including indentation', () => {
    const r = parseToolCall('<write_file path="a.ts">\n  const a = 1;\n\n  const b = 2;\n</write_file>', all);
    expect(r?.args.content).toBe('  const a = 1;\n\n  const b = 2;');
  });

  it('parses edit_file blocks', () => {
    const text = '<edit_file path="a.txt">\n<find>\nold line\n</find>\n<replace>\nnew line\n</replace>\n';
    expect(parseToolCall(text, all)?.args).toEqual({ path: 'a.txt', find: 'old line', replace: 'new line' });
  });

  it('parses edit_file with find/replace as attributes (leaked native calls)', () => {
    const text = '<edit_file path="r.js" find="const a = 1;" replace="const a = 2;">';
    expect(parseToolCall(text, all)?.args).toEqual({ path: 'r.js', find: 'const a = 1;', replace: 'const a = 2;' });
  });

  it('parses commands without touching < and > inside them', () => {
    const r = parseToolCall('<run_command>Get-ChildItem | Where-Object { $_.Length -gt 0 } > out.txt</run_command>', all);
    expect(r?.args.command).toBe('Get-ChildItem | Where-Object { $_.Length -gt 0 } > out.txt');
  });

  it('parses move_file in arrow, attribute and child forms', () => {
    const want = { path: 'a.txt', new_path: 'docs/b.txt' };
    expect(parseToolCall('<move_file>a.txt -> docs/b.txt</move_file>', all)?.args).toEqual(want);
    expect(parseToolCall('<move_file>"a.txt" → "docs/b.txt"', all)?.args).toEqual(want);
    expect(parseToolCall('<move_file path="a.txt">docs/b.txt</move_file>', all)?.args).toEqual(want);
    expect(parseToolCall('<move_file><from>a.txt</from><to>docs/b.txt</to></move_file>', all)?.args).toEqual(want);
    expect(parseToolCall('<delete_file>old/</delete_file>', all)?.args).toEqual({ path: 'old/' });
  });

  it('skips a tag mentioned in prose and takes the real call', () => {
    const text = 'Let\'s create the file using the <write_file> tool:\n\n<write_file path="server.js">\nconst a = 1;\n';
    const r = parseToolCall(text, all);
    expect(r?.args).toEqual({ path: 'server.js', content: 'const a = 1;' });
    expect(text.slice(0, r!.index)).toContain('using the <write_file> tool:');
    const r2 = parseToolCall('I will use <run_command> later. First: <list_dir>.</list_dir>', all);
    expect(r2).toMatchObject({ name: 'list_dir', args: { path: '.' } });
  });

  it('reads process ids written loosely', () => {
    expect(parseToolCall('<stop_process>#3</stop_process>', all)?.args).toEqual({ id: 3 });
    expect(parseToolCall('<process_output>process 12', all)?.args).toEqual({ id: 12 });
    expect(parseToolCall('<process_output wait="120">3</process_output>', all)?.args).toEqual({ id: 3, wait_seconds: 120 });
  });

  it('ignores disabled tools and plain text', () => {
    expect(parseToolCall('<run_command>dir</run_command>', ['read_file'])).toBeNull();
    expect(parseToolCall('Nothing to do here.', all)).toBeNull();
  });

  it('round-trips through serializeToolCall', () => {
    const cases = [
      { name: 'list_dir', args: { path: 'src' } },
      { name: 'read_file', args: { path: 'a.md', start_line: 5, end_line: 9 } },
      { name: 'search', args: { query: 'TODO', path: '.' } },
      { name: 'write_file', args: { path: 'x.txt', content: 'line 1\nline 2' } },
      { name: 'edit_file', args: { path: 'x.txt', find: 'a', replace: 'b' } },
      { name: 'move_file', args: { path: 'x.txt', new_path: 'y/x.txt' } },
      { name: 'delete_file', args: { path: 'y' } },
      { name: 'start_process', args: { command: 'npm run dev' } },
      { name: 'process_output', args: { id: 2 } },
      { name: 'process_output', args: { id: 2, wait_seconds: 120 } },
      { name: 'stop_process', args: { id: 2 } },
      { name: 'run_command', args: { command: 'git status' } },
    ] as const;
    for (const c of cases) {
      expect(parseToolCall(serializeToolCall(c.name, c.args), all)).toMatchObject({ name: c.name, args: c.args });
    }
  });
});

describe('visibleText', () => {
  it('hides a tool tag and a tag still being typed', () => {
    expect(visibleText('Reading.\n<read_file>a', all)).toBe('Reading.');
    expect(visibleText('Reading.\n<read_fi', all)).toBe('Reading.');
    expect(visibleText('Use a <b>tag</b> here', all)).toBe('Use a <b>tag</b> here');
  });
});
