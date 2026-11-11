import { describe, expect, it } from 'vitest';
import { shellHint } from './shell';

describe('shellHint', () => {
  it('says to create a file that does not exist', () => {
    const out = "Error: Cannot find module 'C:\\Temp\\proj\\index.js'\n    at Module._resolveFilename";
    expect(shellHint(out)).toContain('the file C:\\Temp\\proj\\index.js does not exist');
    expect(shellHint("python: can't open file 'C:\\p\\app.py': [Errno 2]")).toContain('create the file with write_file');
  });

  it('says to install a missing package', () => {
    expect(shellHint("Error: Cannot find module 'express'")).toContain('npm install express');
    expect(shellHint("Error: Cannot find module '@fastify/cors'")).toContain('npm install @fastify/cors');
  });

  it('explains a package without a build for this Python', () => {
    const out = 'ERROR: Could not find a version that satisfies the requirement tensorflow\nERROR: No matching distribution found for tensorflow';
    expect(shellHint(out)).toContain('pip has no build of "tensorflow"');
  });

  it('stays silent for normal output', () => {
    expect(shellHint('Server listening on 3000')).toBe('');
  });
});
