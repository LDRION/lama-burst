import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ProcessInfo } from '../shared/types';
import { clip, killTree, shellHint, spawnPowerShell } from './shell';

const MAX_BUFFER = 64 * 1024;

interface Proc extends ProcessInfo {
  child: ChildProcessWithoutNullStreams;
  output: string;
  done: Promise<void>;
  /** Who is watching the output live (a process_output call that waits). */
  listeners: Set<(text: string) => void>;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/** Long-running commands (servers, watchers) started by the model, numbered per chat. */
export class ProcessManager {
  private procs: Proc[] = [];

  constructor(private onChange: () => void = () => {}) {}

  list(sessionId?: string): ProcessInfo[] {
    return this.procs
      .filter(p => !sessionId || p.sessionId === sessionId)
      .map(({ sessionId, id, command, running, exitCode, startedAt }) => ({
        sessionId,
        id,
        command,
        running,
        exitCode,
        startedAt,
      }));
  }

  private find(sessionId: string, id: number): Proc {
    const p = this.procs.find(x => x.sessionId === sessionId && x.id === id);
    if (p) return p;
    const known = this.list(sessionId).map(x => `#${x.id} ${x.running ? 'running' : 'exited'}: ${x.command}`);
    throw new Error(`No process #${id}. ${known.length ? `Known processes: ${known.join('; ')}` : 'No processes were started.'}`);
  }

  async start(sessionId: string, cwd: string, command: string, waitMs: number, maxChars: number): Promise<string> {
    const { child, cleanup } = await spawnPowerShell(command, cwd);
    const proc = this.track(sessionId, command, child, cleanup, '');
    await Promise.race([proc.done, sleep(waitMs)]);
    const out = proc.output.trim();
    const head = proc.running
      ? `Started process #${proc.id}. It keeps running in the background (output below is from the first ${seconds(waitMs)}). ` +
        `Use process_output with id ${proc.id} to see new output, and stop_process with id ${proc.id} when you are done.`
      : `Process #${proc.id} already exited with code ${proc.exitCode}.`;
    return `${head}\nOutput:\n${out ? clip(out, maxChars) : '(no output yet)'}${shellHint(out)}`;
  }

  /** Takes over a command that was started in the foreground but turned out to be a server. */
  adopt(
    sessionId: string,
    command: string,
    child: ChildProcessWithoutNullStreams,
    cleanup: () => Promise<void>,
    output: string,
  ): number {
    return this.track(sessionId, command, child, cleanup, output).id;
  }

  private track(
    sessionId: string,
    command: string,
    child: ChildProcessWithoutNullStreams,
    cleanup: () => Promise<void>,
    output: string,
  ): Proc {
    const id = 1 + Math.max(0, ...this.procs.filter(p => p.sessionId === sessionId).map(p => p.id));
    let finished!: () => void;
    const proc: Proc = {
      sessionId,
      id,
      command,
      running: true,
      exitCode: null,
      startedAt: Date.now(),
      child,
      output,
      done: new Promise(r => (finished = r)),
      listeners: new Set(),
    };
    const append = (b: Buffer) => {
      const text = b.toString('utf8');
      proc.output = (proc.output + text).slice(-MAX_BUFFER);
      for (const l of proc.listeners) l(text);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', e => append(Buffer.from(`\nFailed to start PowerShell: ${e.message}`)));
    child.on('close', code => {
      proc.running = false;
      proc.exitCode = code;
      void cleanup();
      finished();
      this.onChange();
    });
    this.procs.push(proc);
    this.onChange();
    return proc;
  }

  /** Status and latest output; with waitSeconds, first waits for the process to finish (up to that long). */
  async output(
    sessionId: string,
    id: number,
    maxChars: number,
    waitSeconds = 0,
    signal?: AbortSignal,
    onOutput?: (text: string) => void,
  ): Promise<string> {
    const p = this.find(sessionId, id);
    if (p.running && waitSeconds > 0) {
      const aborted = new Promise<void>(r => signal?.addEventListener('abort', () => r(), { once: true }));
      if (onOutput) p.listeners.add(onOutput);
      try {
        await Promise.race([p.done, sleep(waitSeconds * 1000), aborted]);
      } finally {
        if (onOutput) p.listeners.delete(onOutput);
      }
    }
    const status = p.running
      ? `still running (for ${seconds(Date.now() - p.startedAt)} so far)`
      : `exited with code ${p.exitCode}`;
    const out = p.output.trim();
    const tail = out.length > maxChars ? `[... earlier output omitted ...]\n${out.slice(-maxChars)}` : out;
    return `Process #${id} (${p.command}): ${status}.\nRecent output:\n${tail || '(no output)'}${shellHint(out)}`;
  }

  async stop(sessionId: string, id: number): Promise<string> {
    const p = this.find(sessionId, id);
    if (!p.running) return `Process #${id} had already exited with code ${p.exitCode}.`;
    killTree(p.child.pid);
    await Promise.race([p.done, sleep(5000)]);
    return `Stopped process #${id}.`;
  }

  stopSession(sessionId: string) {
    for (const p of this.procs) if (p.sessionId === sessionId && p.running) killTree(p.child.pid);
  }

  stopAll() {
    for (const p of this.procs) if (p.running) killTree(p.child.pid);
  }
}
