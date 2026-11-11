import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { TOOL_CATEGORY, TOOL_LABEL, toolSubject } from '../../../shared/tools';
import type { ApprovalDecision, DiffLine, ToolCategory, ToolName, ToolRun } from '../../../shared/types';
import { api } from '../api';
import {
  IconAlert,
  IconBan,
  IconCheck,
  IconChevron,
  IconFile,
  IconFilePlus,
  IconList,
  IconMove,
  IconPencil,
  IconPlay,
  IconSearch,
  IconStop,
  IconTerminal,
  IconTrash,
  Spinner,
} from './icons';

const TOOL_ICON: Record<ToolName, ReactNode> = {
  list_dir: <IconList />,
  read_file: <IconFile />,
  search: <IconSearch />,
  write_file: <IconFilePlus />,
  edit_file: <IconPencil />,
  move_file: <IconMove />,
  delete_file: <IconTrash />,
  run_command: <IconTerminal />,
  start_process: <IconPlay />,
  process_output: <IconTerminal />,
  stop_process: <IconStop size={16} />,
};

const RISK_TEXT: Partial<Record<ToolName, string>> = {
  run_command: 'Команда может удалить данные или изменить систему. Проверьте её внимательно.',
  start_process: 'Команда может удалить данные или изменить систему. Проверьте её внимательно.',
  delete_file: 'Удаление: файл или папка отправится в корзину Windows. Проверьте путь.',
};

const ALWAYS_LABEL: Record<ToolCategory, string> = {
  read: 'Всегда разрешать чтение',
  write: 'Всегда разрешать изменения',
  run: 'Всегда разрешать команды',
};

function StatusIcon({ status }: { status: ToolRun['status'] }) {
  switch (status) {
    case 'queued':
      return <span className="tool-queued">в очереди</span>;
    case 'running':
      return <Spinner />;
    case 'done':
      return <IconCheck size={15} />;
    case 'error':
      return <IconAlert size={15} />;
    case 'denied':
      return <IconBan size={15} />;
    case 'awaiting':
      return <span className="tool-awaiting">ждёт разрешения</span>;
  }
}

export function DiffView({ lines }: { lines: DiffLine[] }) {
  if (!lines.length) return <div className="diff-empty">Файл не изменится</div>;
  return (
    <div className="diff">
      {lines.map((l, i) => (
        <div key={i} className={`dl ${l.type}`}>
          <span className="dl-sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : l.type === 'sep' ? '' : ' '}</span>
          <span className="dl-text">{l.text || ' '}</span>
        </div>
      ))}
    </div>
  );
}

function ApprovalBar({ run }: { run: ToolRun }) {
  const [sent, setSent] = useState(false);
  const decide = (d: ApprovalDecision) => {
    setSent(true);
    api.approve(run.id, d);
  };
  return (
    <div className="approval">
      <button className="btn primary" disabled={sent} onClick={() => decide('allow')} autoFocus>
        Разрешить
      </button>
      {!run.risky && (
        <button className="btn" disabled={sent} onClick={() => decide('always')}>
          {ALWAYS_LABEL[TOOL_CATEGORY[run.name]]}
        </button>
      )}
      <button className="btn ghost-danger" disabled={sent} onClick={() => decide('deny')}>
        Отклонить
      </button>
    </div>
  );
}

/** Tail of a command's output while it runs, scrolled to the latest line. */
function LiveOutput({ text }: { text: string }) {
  const ref = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  // Progress bars redraw a line with \r: show only its latest state.
  const shown = text.replace(/\r\n/g, '\n').replace(/[^\n]*\r/g, '');
  return (
    <pre className="tool-live" ref={ref}>
      {shown.trimEnd()}
    </pre>
  );
}

export function ToolCard({ run, live }: { run: ToolRun; live?: string }) {
  const [open, setOpen] = useState(run.status === 'awaiting');
  useEffect(() => {
    if (run.status === 'awaiting') setOpen(true);
  }, [run.status]);

  const subject = toolSubject(run.name, run.args);
  const firstLine = run.result?.split('\n')[0].replace(/^ERROR:\s*/, '') ?? '';
  const showResult = run.result !== undefined && run.status !== 'awaiting';

  return (
    <div className={`tool status-${run.status}`}>
      <button className="tool-head" onClick={() => setOpen(o => !o)}>
        <span className="tool-icon">{TOOL_ICON[run.name] ?? <IconFile />}</span>
        <span className="tool-label">{TOOL_LABEL[run.name] ?? run.name}</span>
        {run.fromText && (
          <span className="tool-from-text" title="Модель показала этот код в ответе, а Lama Burst записал его в файл">
            из ответа
          </span>
        )}
        <span className="tool-subject" title={subject}>
          {subject}
        </span>
        <span className="tool-status">
          <StatusIcon status={run.status} />
        </span>
        <IconChevron size={14} open={open} />
      </button>
      {!open && run.status === 'error' && <div className="tool-oneline">{firstLine}</div>}
      {run.status === 'running' && live && <LiveOutput text={live} />}
      {open && (
        <div className="tool-body">
          {run.risky && run.status === 'awaiting' && (
            <div className="callout warn">
              <IconAlert size={15} /> {RISK_TEXT[run.name] ?? 'Действие может удалить данные. Проверьте его внимательно.'}
            </div>
          )}
          {(run.name === 'run_command' || run.name === 'start_process' || run.name === 'move_file') && (
            <pre className="tool-command">{subject}</pre>
          )}
          {run.diff && <DiffView lines={run.diff} />}
          {run.status === 'awaiting' && <ApprovalBar run={run} />}
          {showResult && <pre className="tool-result">{run.result || '(пусто)'}</pre>}
        </div>
      )}
    </div>
  );
}
