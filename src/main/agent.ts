import { randomUUID } from 'node:crypto';
import { effectiveMode, modelSettings } from '../shared/settings';
import { parseToolCall, textStopSequences } from '../shared/textProtocol';
import { TOOL_CATEGORY, TOOL_NAMES, enabledTools, nativeToolSchemas } from '../shared/tools';
import type {
  AgentEvent,
  ApprovalDecision,
  AssistantItem,
  Session,
  Settings,
  ToolArgs,
  ToolCategory,
  ToolName,
  ToolRun,
  UserItem,
} from '../shared/types';
import { parseLooseToolCall } from './looseCalls';
import type { ChatRequest, Ollama, OllamaToolCall } from './ollama';
import { findMentionedFiles, readAttachments } from './attachments';
import { findShownFiles } from './codeBlocks';
import type { ProcessManager } from './processes';
import { projectPrompt, scanProject } from './project';
import { CHARS_PER_TOKEN, buildMessages, buildSystemPrompt } from './prompt';
import { type PreparedTool, type ToolContext, prepareTool } from './tools';

export interface AgentHost {
  ollama: Ollama;
  settings(): Settings;
  emit(ev: AgentEvent): void;
  approve(sessionId: string, run: ToolRun): Promise<ApprovalDecision>;
  allowAlways(category: ToolCategory): void;
  save(session: Session): void;
  trash?(fullPath: string): Promise<void>;
  processes?: ProcessManager;
}

function normalizeArgs(raw: Record<string, unknown> | string | undefined): ToolArgs {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      obj = {};
    }
  }
  const out: ToolArgs = {};
  for (const [k, v] of Object.entries((obj as Record<string, unknown>) ?? {})) {
    if (v === null || v === undefined) continue;
    out[k] = typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v);
  }
  return out;
}

const INTENT =
  /\bI will\b|\bI'll\b|\blet me\b(?! know)|\blet's\b|\bnow I\b|\bnext,? I\b|сейчас|теперь я|давай(те)?|я (прочита|посмотр|откро|провер|найд|измен|исправ)|(?:^|\s)(добавим|сделаем|создадим|напишем|исправим|изменим|обновим|проверим|установим|запустим|прочитаем|посмотрим|откроем|перейдём|перейдем|займёмся|займемся|начнём|начнем)(?=[\s.,:!]|$)/i;

/** "Fix" nudges per run: after a failed step, or when a change was never applied. */
const MAX_FIX_NUDGES = 3;

/** "Continue" nudges per run: small models sometimes stall twice in one task. */
const MAX_CONTINUE_NUDGES = 2;

/** A fenced code block of at least a few lines: code the model showed instead of writing it to a file. */
export function showsCode(text: string): boolean {
  return [...text.matchAll(/```[\w.+-]*\r?\n([\s\S]*?)```/g)].some(
    m => m[1].split('\n').filter(l => l.trim()).length >= 4,
  );
}

/** The user asked to make or change something (not just to show or explain it). */
export function asksForChanges(text: string): boolean {
  const build = /созда|сдела|добав|исправ|напиш|реализ|допиш|перепиш|почин|запуст|начина|давай|build|create|make|add|write|implement|fix|refactor|start/i;
  const show = /покажи|объясни|пример|расскажи|как (?:сделать|написать)|\bshow\b|explain|example|how (?:to|do)/i;
  return build.test(text) && !show.test(text);
}

/** "Write it to a file" nudges per run. */
const MAX_WRITE_NUDGES = 2;

/** Small models often announce a tool call ("Now I'll read the file:") and then stop. */
export function promisesAction(text: string): boolean {
  const tail = text.trim().split(/(?<=[.!?])\s+/).pop() ?? '';
  return tail.endsWith(':') || (!/[!?]$/.test(tail) && INTENT.test(tail));
}

/** Ollama doesn't limit replies by default, and a looping small model would generate forever. */
const MAX_REPLY_TOKENS = 3072;
/** How much of a looping reply to keep in the chat. */
const LOOP_KEEP_CHARS = 1500;
/** Share of the context for the project summary and notes, and for files attached to a message. */
const PROJECT_SHARE = 0.15;
const ATTACH_SHARE = 0.3;

/** The same call failing this many times in a row ends the run. */
const MAX_SAME_FAILURES = 4;

/**
 * Identity of an action for spotting repeats. Commands are compared without their flags:
 * "pip install tensorflow -y" and "pip install tensorflow --force-reinstall" are the same attempt.
 */
export function actionKey(name: ToolName, args: ToolArgs): string {
  if (name === 'run_command' || name === 'start_process') {
    const words = String(args.command ?? '').toLowerCase().split(/\s+/);
    return `command:${words.filter(w => w && !w.startsWith('-')).join(' ')}`;
  }
  return `${name}:${JSON.stringify(args)}`;
}

/** True when the end of the text has already appeared at least twice in the last few thousand characters. */
export function isLooping(text: string): boolean {
  if (text.length < 1000) return false;
  const tail = text.slice(-200);
  const end = text.length - tail.length;
  let repeats = 0;
  for (let i = text.indexOf(tail, Math.max(0, text.length - 4000)); i !== -1 && i < end; i = text.indexOf(tail, i + 1)) {
    if (++repeats >= 2) return true;
  }
  return false;
}

/** A reply that is only a plan of actions ("1. Create server.js 2. Run it") with no tool call yet. */
export function looksLikePlan(text: string): boolean {
  return /^\s*(?:step\s*)?1[.):]\s+\S/im.test(text) && /creat|write|install|run|start|созда|напиш|установ|запуст|сдела/i.test(text);
}

/** Tool results that mean the step failed, so the model should not stop here. */
const FAILED_RESULT = /^ERROR:|^Exit code: (?:-|[1-9])|^Command timed out|already exited with code [1-9]|SYNTAX ERROR after this change/;

const NUDGES = {
  continue:
    'Continue: do the next step yourself now with a tool call. If the task is already completely done, give the final answer.',
  fix: 'The last step failed (see the error above). Do not hand the problem to the user: find the cause, fix it with your tools and continue the task.',
  retry:
    'Your last reply was empty: the tool call in it could not be read. Make the tool call again with valid arguments, or answer in text.',
  write:
    'You showed code in the chat instead of saving it. The user wants working files, not code to copy: write this code into a file with write_file now (pick a sensible path in the project), then continue the task: run or check it.',
  verify:
    'Before finishing: you changed code but did not check that it works. Check it yourself now: run the script or the tests; for a server, send a request to it (Invoke-WebRequest http://localhost:PORT/PATH -UseBasicParsing). Do not tell the user to check it. If you find errors, fix them. Then give the final answer.',
};

/** Files worth running after a change; editing notes or docs doesn't need a check. */
const CODE_FILE = /\.(m?[jt]sx?|cjs|py|json|ps1|bat|cmd|go|rs|java|kt|cs|rb|php|vue|svelte)$/i;

/** Batches live command output so the UI gets a few updates per second, not one per chunk. */
function batcher(send: (text: string) => void) {
  let buf = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (buf) send(buf);
    buf = '';
  };
  return {
    push: (text: string) => {
      buf += text;
      timer ??= setTimeout(flush, 250);
    },
    flush,
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runAgent(session: Session, host: AgentHost, signal: AbortSignal): Promise<void> {
  const settings = host.settings();
  const info = await host.ollama.getModel(session.model);
  const ms = modelSettings(settings, session.model, info);
  const mode = effectiveMode(ms.toolMode, info, session.folders.length > 0);
  const tools = mode === 'none' ? [] : enabledTools(settings.permissions);
  const contextChars = ms.numCtx * CHARS_PER_TOKEN;
  const project = mode === 'none' ? undefined : await scanProject(session.folders[0]).catch(() => undefined);
  const system = await buildSystemPrompt({
    folders: session.folders,
    mode,
    tools,
    userPrompt: settings.systemPrompt,
    project: project && projectPrompt(project, Math.min(8000, Math.max(1500, contextChars * PROJECT_SHARE))),
  });

  // Files the user mentioned in the new message go straight into it, saving the model a few steps.
  const task = session.items.findLast((i): i is UserItem => i.role === 'user' && !i.auto);
  if (task && !task.attachments && mode !== 'none') {
    const files = await findMentionedFiles(task.text, session.folders).catch(() => []);
    task.attachments = await readAttachments(files, session.folders, Math.min(12000, contextChars * ATTACH_SHARE));
    if (task.attachments.length) host.emit({ type: 'item', sessionId: session.id, item: task });
  }
  const ctx: ToolContext = {
    folders: session.folders,
    maxOutputChars: settings.maxToolOutputChars,
    commandTimeoutSec: settings.commandTimeoutSec,
    signal,
    trash: host.trash,
    sessionId: session.id,
    processes: host.processes,
  };
  // Leave a quarter of the context for the reply; native tool schemas also take space.
  const overhead = system.length + (mode === 'native' ? JSON.stringify(nativeToolSchemas(tools)).length : 0);
  const budget = Math.max(4000, ms.numCtx * CHARS_PER_TOKEN * 0.75 - overhead);
  const emitItem = (item: AssistantItem) => host.emit({ type: 'item', sessionId: session.id, item });
  let continues = 0;
  let verifyNudged = false;
  let codeChanged = false;
  let lastFailed = false;
  let fixNudges = 0;
  /** Files whose last change failed or broke the syntax, by lower-cased path. */
  const brokenEdits = new Map<string, string>();
  let retries = 0;
  let writes = 0;
  const failures = new Map<string, number>();

  for (let step = 0; ; step++) {
    if (step >= settings.maxSteps) {
      const last = session.items[session.items.length - 1];
      if (last?.role === 'assistant') {
        last.notice = `Достигнут лимит шагов (${settings.maxSteps}). Напишите «продолжай», чтобы модель продолжила.`;
        emitItem(last);
      }
      break;
    }

    const messages = [{ role: 'system' as const, content: system }, ...buildMessages(session.items, mode, budget)];
    const item: AssistantItem = {
      id: randomUUID(),
      role: 'assistant',
      text: '',
      tools: [],
      model: session.model,
      mode,
      time: Date.now(),
    };
    session.items.push(item);
    emitItem(item);

    const req: ChatRequest = {
      model: session.model,
      messages,
      options: { temperature: ms.temperature, num_ctx: ms.numCtx, num_predict: MAX_REPLY_TOKENS },
      keep_alive: '15m',
    };
    if (mode === 'native') req.tools = nativeToolSchemas(tools);
    if (mode === 'text') req.options!.stop = [...(info?.stop ?? []), ...textStopSequences(tools)];

    const nativeCalls: OllamaToolCall[] = [];
    const cut = new AbortController();
    let looped = false;
    let truncated = false;
    try {
      for await (const chunk of host.ollama.chat(req, AbortSignal.any([signal, cut.signal]))) {
        const m = chunk.message;
        if (m?.thinking) {
          item.thinking = (item.thinking ?? '') + m.thinking;
          host.emit({ type: 'delta', sessionId: session.id, itemId: item.id, thinking: m.thinking });
        }
        if (m?.content) {
          item.text += m.content;
          host.emit({ type: 'delta', sessionId: session.id, itemId: item.id, text: m.content });
          if (isLooping(item.text)) {
            looped = true;
            cut.abort();
            break;
          }
        }
        if (m?.tool_calls?.length) nativeCalls.push(...m.tool_calls);
        if (chunk.done) {
          truncated = chunk.done_reason === 'length';
          const seconds = (chunk.eval_duration ?? 0) / 1e9;
          item.stats = {
            promptTokens: chunk.prompt_eval_count ?? 0,
            outputTokens: chunk.eval_count ?? 0,
            tokensPerSec: seconds > 0 ? (chunk.eval_count ?? 0) / seconds : 0,
            numCtx: ms.numCtx,
          };
        }
      }
    } catch (e) {
      if (signal.aborted) item.notice = 'Остановлено.';
      else if (!looped) item.error = errorText(e);
      if (!looped) {
        emitItem(item);
        break;
      }
    }
    if (looped) {
      item.text = `${item.text.slice(0, LOOP_KEEP_CHARS).trimEnd()}…`;
      item.error = 'Модель начала повторять одно и то же, ответ остановлен.';
      emitItem(item);
      break;
    }

    let calls: { name: string; args: ToolArgs }[] = [];
    if (mode === 'text') {
      const parsed = parseToolCall(item.text, tools);
      if (parsed) {
        item.text = item.text.slice(0, parsed.index).trimEnd();
        calls = [parsed];
      }
    } else if (mode === 'native') {
      calls = nativeCalls.map(c => ({
        name: c.function.name.split('.').pop() ?? c.function.name,
        args: normalizeArgs(c.function.arguments),
      }));
    }
    // Native tool calls that leaked into the text (some re-quantized GGUFs, e.g. abliterated ones,
    // emit <write_file ...> or {"name": ...} instead of using Ollama's tool channel).
    if (!calls.length && mode === 'native') {
      const tagged = parseToolCall(item.text, tools);
      if (tagged) {
        // Drop the call and any wrapper the model opened before it (<tools>, <tool_call>, a ```json fence).
        item.text = item.text
          .slice(0, tagged.index)
          .replace(/(?:<\|?\/?tool_?(?:call|s)\|?>|```\w*)\s*$/gi, '')
          .trimEnd();
        calls = [tagged];
      }
    }
    if (!calls.length && mode !== 'none') {
      const loose = parseLooseToolCall(item.text, tools);
      if (loose) {
        item.text = item.text.slice(0, loose.index);
        calls = [{ name: loose.name, args: normalizeArgs(loose.args) }];
      }
    }
    let fromText = false;
    if (!calls.length && mode !== 'none' && !truncated && tools.includes('write_file') && asksForChanges(task?.text ?? '')) {
      // "Create convert.py with this code: ```...```" — do what the model described instead of asking again.
      const shown = findShownFiles(item.text, session.folders);
      if (shown.length) {
        fromText = true;
        calls = shown.map(f => ({ name: 'write_file', args: { path: f.path, content: f.content } }));
        for (const f of shown) item.text = item.text.replace(f.block, `*(код записан в файл ${f.path})*`);
      }
    }
    item.text = item.text.trim();
    item.tools = calls.map(c => ({
      id: randomUUID(),
      name: c.name as ToolName,
      args: c.args,
      status: 'queued',
      ...(fromText ? { fromText: true } : {}),
    }));
    if (truncated && mode === 'text' && item.tools.length) {
      // The tag was cut by the length limit, not closed by the model: never write half a file.
      for (const t of item.tools) {
        t.status = 'error';
        t.result = `ERROR: your message was cut off at the length limit (${MAX_REPLY_TOKENS} tokens) before the tool call was complete, so nothing was done. Split the work: write smaller files, or create a file in parts with write_file and then edit_file.`;
      }
    } else if (truncated) {
      item.notice = 'Ответ модели оборвался по лимиту длины.';
    }
    if (item.stats && item.stats.promptTokens + item.stats.outputTokens >= item.stats.numCtx * 0.95) {
      item.notice = 'Контекст модели почти заполнен: Lama Burst сокращает старые шаги. Для длинных задач увеличьте контекст в настройках.';
    }
    emitItem(item);
    if (!item.tools.length) {
      let reason: UserItem['autoReason'];
      // A promise counts only mid-task, so a friendly "I'll be glad to help" in a plain chat doesn't trigger it.
      const stalled = step > 0 ? promisesAction(item.text) : looksLikePlan(item.text);
      // Ollama swallows a tool call it cannot parse, leaving a reply with tokens but no text.
      const swallowed = !item.text && !item.thinking && (item.stats?.outputTokens ?? 0) > 0;
      if (mode !== 'none' && swallowed && retries < 2) {
        retries++;
        reason = 'retry';
      } else if (
        mode !== 'none' &&
        writes < MAX_WRITE_NUDGES &&
        tools.includes('write_file') &&
        showsCode(item.text) &&
        asksForChanges(task?.text ?? '')
      ) {
        writes++;
        reason = 'write';
      } else if (continues < MAX_CONTINUE_NUDGES && mode !== 'none' && stalled) {
        continues++;
        reason = 'continue';
      } else if (mode !== 'none' && (lastFailed || brokenEdits.size) && fixNudges < MAX_FIX_NUDGES) {
        fixNudges++;
        reason = 'fix';
      } else if (!verifyNudged && codeChanged && tools.includes('run_command') && !signal.aborted) {
        verifyNudged = true;
        reason = 'verify';
      }
      if (!reason) break;
      const nudge: UserItem = {
        id: randomUUID(),
        role: 'user',
        text:
          reason === 'verify' && project?.checks.length
            ? `${NUDGES.verify} This project's checks: ${project.checks.join(', ')}.`
            : reason === 'fix' && brokenEdits.size && !lastFailed
              ? `The task is NOT done: your changes to ${[...brokenEdits.values()].join(', ')} were not applied or left a syntax error. Read the file, fix it with edit_file using the exact text, then check again. Do not say it is done before that.`
              : NUDGES[reason],
        time: Date.now(),
        auto: true,
        autoReason: reason,
      };
      session.items.push(nudge);
      host.emit({ type: 'item', sessionId: session.id, item: nudge });
      continue;
    }

    let denied = false;
    for (const run of item.tools) {
      if (run.status === 'error') continue;
      if (denied || signal.aborted) {
        run.status = 'denied';
        run.result = 'Skipped: the user stopped this action.';
        continue;
      }
      if (!TOOL_NAMES.includes(run.name) || !tools.includes(run.name)) {
        run.status = 'error';
        run.result = `ERROR: unknown or disabled tool "${run.name}". Available tools: ${tools.join(', ')}.`;
        emitItem(item);
        continue;
      }

      let prepared: PreparedTool;
      try {
        prepared = await prepareTool(run.name, run.args, ctx);
      } catch (e) {
        run.status = 'error';
        run.result = `ERROR: ${errorText(e)}`;
        emitItem(item);
        continue;
      }
      run.diff = prepared.diff;
      run.risky = prepared.risky;

      const category = TOOL_CATEGORY[run.name];
      if ((host.settings().permissions[category] === 'ask' && !prepared.safe) || prepared.risky) {
        run.status = 'awaiting';
        emitItem(item);
        host.save(session);
        const decision = await host.approve(session.id, run);
        if (decision === 'deny') {
          run.status = 'denied';
          run.result = 'The user denied this action.';
          denied = true;
          emitItem(item);
          continue;
        }
        if (decision === 'always') host.allowAlways(category);
      }

      run.status = 'running';
      emitItem(item);
      const live = batcher(text =>
        host.emit({ type: 'toolOutput', sessionId: session.id, itemId: item.id, toolId: run.id, text }),
      );
      ctx.onOutput = live.push;
      try {
        run.result = await prepared.run();
        run.status = 'done';
        // Starting a server is not a check yet: only a command (a request, the tests) counts.
        if ((run.name === 'write_file' || run.name === 'edit_file') && CODE_FILE.test(String(run.args.path))) {
          codeChanged = true;
        } else if (run.name === 'run_command') {
          codeChanged = false;
        }
      } catch (e) {
        run.status = 'error';
        run.result = `ERROR: ${errorText(e)}`;
      } finally {
        live.flush();
        ctx.onOutput = undefined;
      }
      emitItem(item);
    }

    // Small models can repeat the same failing call forever ("node index.js" without ever creating it).
    let stuck = false;
    for (const t of item.tools) {
      if (t.status !== 'done' && t.status !== 'error') continue;
      const key = actionKey(t.name, t.args);
      if (t.status !== 'error' && !FAILED_RESULT.test(t.result ?? '')) {
        failures.delete(key);
        continue;
      }
      const n = (failures.get(key) ?? 0) + 1;
      failures.set(key, n);
      if (n >= 2) {
        t.result += `\n\nNOTE: this is attempt ${n} of the same action and it failed again. Repeating it, even with other flags, will not help: read the error, find the cause (check the files with list_dir) and change your approach.`;
      }
      if (n >= MAX_SAME_FAILURES) stuck = true;
    }
    if (stuck) {
      item.notice = 'Модель зациклилась: одно и то же действие несколько раз подряд закончилось той же ошибкой. Подскажите ей, что делать дальше.';
      emitItem(item);
      host.save(session);
      break;
    }
    emitItem(item);
    lastFailed = item.tools.some(t => t.status === 'error' || FAILED_RESULT.test(t.result ?? ''));
    // A file whose change failed stays "broken" until a later change to it succeeds.
    for (const t of item.tools) {
      if (t.name !== 'edit_file' && t.name !== 'write_file') continue;
      const p = String(t.args.path ?? '');
      if (t.status === 'error' || FAILED_RESULT.test(t.result ?? '')) brokenEdits.set(p.toLowerCase(), p);
      else if (t.status === 'done') brokenEdits.delete(p.toLowerCase());
    }
    host.save(session);
    if (denied || signal.aborted) break;
  }
  host.save(session);
}
