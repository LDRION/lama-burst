import { describe, expect, it } from 'vitest';
import type { AssistantItem, ChatItem } from '../shared/types';
import { buildMessages } from './prompt';

const items: [ChatItem, AssistantItem, AssistantItem] = [
  { id: '1', role: 'user', text: 'When is the call?', time: 0 },
  {
    id: '2',
    role: 'assistant',
    text: 'Checking.',
    model: 'm',
    mode: 'text',
    time: 0,
    tools: [{ id: 't', name: 'read_file', args: { path: 'plan.md' }, status: 'done', result: 'Call on Wednesday' }],
  },
  { id: '3', role: 'assistant', text: 'On Wednesday.', model: 'm', mode: 'text', time: 0, tools: [] },
];

describe('buildMessages', () => {
  it('renders tool calls as tags and results as user messages in text mode', () => {
    expect(buildMessages(items, 'text')).toEqual([
      { role: 'user', content: expect.stringMatching(/^When is the call\?\n\n\(Act with tool tags, one per message\./) },
      { role: 'assistant', content: 'Checking.\n\n<read_file>plan.md</read_file>' },
      { role: 'user', content: '<tool_result tool="read_file">\nCall on Wednesday\n</tool_result>' },
      { role: 'assistant', content: 'On Wednesday.' },
    ]);
  });

  it('renders the same history with native tool messages', () => {
    expect(buildMessages(items, 'native')).toEqual([
      { role: 'user', content: 'When is the call?' },
      {
        role: 'assistant',
        content: 'Checking.',
        tool_calls: [{ function: { name: 'read_file', arguments: { path: 'plan.md' } } }],
      },
      { role: 'tool', tool_name: 'read_file', content: 'Call on Wednesday' },
      { role: 'assistant', content: 'On Wednesday.' },
    ]);
  });

  it('keeps the current task when the history does not fit the context', () => {
    const big = 'x'.repeat(3000);
    const step = (id: string): AssistantItem => ({
      id,
      role: 'assistant',
      text: `step ${id}`,
      model: 'm',
      mode: 'text',
      time: 0,
      tools: [{ id: `t${id}`, name: 'read_file', args: { path: `${id}.txt` }, status: 'done', result: big }],
    });
    const history: ChatItem[] = [
      { id: 'u0', role: 'user', text: 'old question', time: 0 },
      step('a'),
      { id: 'u1', role: 'user', text: 'Build the service', time: 0 },
      step('b'),
      step('c'),
      step('d'),
      step('e'),
      step('f'),
    ];
    const msgs = buildMessages(history, 'text', 9000);
    const text = msgs.map(m => m.content).join('\n');
    expect(text).not.toContain('old question');
    expect(msgs[0].content).toContain('Build the service');
    expect(msgs[0].content).toContain('[Earlier conversation was omitted');
    expect(text).toContain('step f');
    expect(text).toContain('step e');
    expect(msgs.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(9000);
    expect(buildMessages(history, 'text').length).toBeGreaterThan(msgs.length);
  });

  it('shows attached files in full only for the current task', () => {
    const history: ChatItem[] = [
      { id: 'u1', role: 'user', text: 'fix a.js', time: 0, attachments: [{ path: 'a.js', content: 'let a = 1;' }] },
      { id: 'a1', role: 'assistant', text: 'Done.', model: 'm', mode: 'text', time: 0, tools: [] },
      { id: 'u2', role: 'user', text: 'now b.js', time: 0, attachments: [{ path: 'b.js', content: 'let b = 2;' }] },
    ];
    const msgs = buildMessages(history, 'text');
    expect(msgs[0].content).toBe('fix a.js\n\n[Attached earlier: a.js]');
    expect(msgs[2].content).toContain('[File b.js, attached because the message mentions it]\n```\nlet b = 2;\n```');
  });

  it('trims old tool output and skips failed empty replies', () => {
    const long = 'x'.repeat(5000);
    const many: ChatItem[] = [
      { ...items[1], tools: [{ ...items[1].tools[0], result: long }] },
      { id: 'e', role: 'assistant', text: '', model: 'm', mode: 'text', time: 0, tools: [], error: 'boom' },
      items[2],
      items[2],
      items[2],
    ];
    const msgs = buildMessages(many, 'text');
    expect(msgs[1].content.length).toBeLessThan(800);
    expect(msgs).toHaveLength(5);
  });
});
