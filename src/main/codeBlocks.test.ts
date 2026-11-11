import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findShownFiles } from './codeBlocks';

const reply = `1) Create a file named convert.py in the main folder and write the following code:

\`\`\`python
def c_to_f(c):
    return c * 9 / 5 + 32
\`\`\`

2) Create a file named test_convert.py and write:

\`\`\`python
import unittest
from convert import c_to_f
\`\`\`

3) Run the tests with: python test_convert.py

\`\`\`bash
python test_convert.py
\`\`\``;

describe('findShownFiles', () => {
  it('turns named code blocks into new files and skips commands', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lama-burst-blocks-'));
    const files = findShownFiles(reply, [dir]);
    expect(files.map(f => f.path)).toEqual(['convert.py', 'test_convert.py']);
    expect(files[0].content).toBe('def c_to_f(c):\n    return c * 9 / 5 + 32');
  });

  it('never targets existing files, non-text files or names inside other code', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lama-burst-blocks-'));
    fs.writeFileSync(path.join(dir, 'convert.py'), 'existing');
    expect(findShownFiles(reply, [dir]).map(f => f.path)).toEqual(['test_convert.py']);
    const tricky = 'Load it:\n```python\nmodel = load("model.h5")\nprint(model)\n```\nThen:\n```python\nx = 1\ny = 2\n```';
    expect(findShownFiles(tricky, [dir])).toEqual([]);
    expect(findShownFiles('Save as app.js:\n```python\nprint(1)\nprint(2)\n```', [dir])).toEqual([]);
  });
});
