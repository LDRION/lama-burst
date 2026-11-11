import { useEffect, useLayoutEffect, useRef } from 'react';
import { STUDY_PROMPT } from '../../../shared/prompts';
import { shortModelName } from '../../../shared/settings';
import { visibleText } from '../../../shared/textProtocol';
import { TOOL_NAMES } from '../../../shared/tools';
import type {
  AssistantItem,
  ChatItem,
  EffectiveToolMode,
  Permission,
  ProjectSummary,
  Settings,
  UserItem,
} from '../../../shared/types';
import { basename } from '../api';
import { IconAlert, IconCheck, IconFile, IconFolderPlus, IconRefresh, IconSpark, Logo } from './icons';
import { Markdown } from './Markdown';
import { ToolCard } from './ToolCard';

/** While streaming, hide tool calls that a broken template leaks as text; they are parsed at the end. */
function streamingText(item: AssistantItem): string {
  const text = visibleText(item.text, TOOL_NAMES);
  const leak = text.search(/<\|?tool_call|<?call:[a-z_]+\{|```json\s*\{\s*"name"|\{\s*"name"\s*:/);
  return leak === -1 ? text : text.slice(0, leak).trimEnd();
}

function Typing() {
  return (
    <div className="typing" aria-label="Модель думает">
      <span />
      <span />
      <span />
    </div>
  );
}

function AssistantMessage(props: {
  item: AssistantItem;
  streaming: boolean;
  last: boolean;
  live: Record<string, string>;
}) {
  const { item, streaming, last } = props;
  const text = streaming ? streamingText(item) : item.text;
  const empty = !text && !item.tools.length && !item.error && !item.thinking && !item.notice;
  if (empty && !streaming) return null;
  return (
    <div className="msg assistant">
      {item.thinking && (
        <details className="thinking">
          <summary>Размышления</summary>
          <div className="thinking-body">{item.thinking}</div>
        </details>
      )}
      {text && <Markdown text={text} />}
      {streaming && empty && <Typing />}
      {item.tools.length > 0 && (
        <div className="tools">
          {item.tools.map(run => (
            <ToolCard key={run.id} run={run} live={props.live[run.id]} />
          ))}
        </div>
      )}
      {item.error && (
        <div className="callout error">
          <IconAlert size={15} /> {item.error}
        </div>
      )}
      {item.notice && <div className="callout notice">{item.notice}</div>}
      {last && item.stats && !streaming && (
        <div className="msg-meta">
          {shortModelName(item.model)} · {item.stats.tokensPerSec.toFixed(1)} ток/с
        </div>
      )}
    </div>
  );
}

const AUTO_TEXT = {
  continue: 'Модель пообещала действие, но не выполнила его. Lama Burst попросил её продолжить.',
  fix: 'Последний шаг закончился ошибкой, а модель остановилась. Lama Burst попросил её разобраться и исправить.',
  verify: 'Модель не проверила результат своей работы. Lama Burst попросил её проверить, что всё работает.',
  retry: 'Ответ модели пришёл пустым (похоже, вызов инструмента не распознался). Lama Burst попросил повторить.',
  write: 'Модель показала код в чате вместо того, чтобы записать его в файл. Lama Burst попросил записать и продолжить.',
};

function UserMessage({ item }: { item: UserItem }) {
  if (item.auto) {
    return (
      <div className="msg auto">
        <IconRefresh size={13} /> {AUTO_TEXT[item.autoReason ?? 'continue']}
      </div>
    );
  }
  return (
    <div className="msg user">
      <div className="bubble">{item.text}</div>
      {!!item.attachments?.length && (
        <div className="attachments" title="Эти файлы упомянуты в сообщении, и модель сразу получила их содержимое">
          {item.attachments.map(a => (
            <span key={a.path} className="attachment">
              <IconFile size={12} /> {a.path}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const SUGGESTIONS = ['Кратко опиши, что это за проект', 'Найди все TODO и перечисли их'];

function ProjectCard({ project }: { project: ProjectSummary }) {
  return (
    <div className="project-card">
      <div className="project-name">{project.name}</div>
      {project.stack.length > 0 && (
        <div className="project-stack">
          {project.stack.join(' · ')}
          {project.packageManager && ` · ${project.packageManager}`}
        </div>
      )}
      {project.run.length > 0 && (
        <div className="project-line">
          <span>Запуск</span> <code>{project.run.join('  ·  ')}</code>
        </div>
      )}
      {project.checks.length > 0 && (
        <div className="project-line">
          <span>Проверки</span> <code>{project.checks.join('  ·  ')}</code>
        </div>
      )}
      <div className={`project-notes ${project.notesFile ? 'ok' : ''}`}>
        {project.notesFile ? (
          <>
            <IconCheck size={13} /> Модель читает заметки проекта из <b>{project.notesFile}</b> в каждом чате
          </>
        ) : (
          'Заметок о проекте пока нет: модель знает только то, что Lama Burst определил сам'
        )}
      </div>
      {project.warnings.map(w => (
        <div key={w} className="project-warning">
          <IconAlert size={13} /> {w}
        </div>
      ))}
    </div>
  );
}

const PERMISSION_TEXT: Record<Permission, string> = {
  auto: 'автоматически',
  ask: 'с вашего разрешения',
  off: 'выключено',
};

function EmptyState(props: {
  folders: string[];
  model: string;
  mode: EffectiveToolMode;
  settings: Settings;
  project: ProjectSummary | null;
  onPickFolders: () => void;
  onSend: (text: string) => void;
}) {
  const { folders, settings, mode, project } = props;
  const study = project?.notesFile?.toLowerCase() === 'lama.md' ? 'Обновить заметки о проекте' : 'Изучить проект';
  return (
    <div className="empty">
      <Logo size={56} />
      <h1>Чем займёмся?</h1>
      {folders.length ? (
        <>
          <p>
            Модель работает в папке <b>{basename(folders[0])}</b>
            {folders.length > 1 && ` и ещё ${folders.length - 1}`}.
          </p>
          {project && mode !== 'none' && <ProjectCard project={project} />}
          <ul className="perm-summary">
            <li>Чтение файлов: {PERMISSION_TEXT[settings.permissions.read]}</li>
            <li>Изменение файлов: {PERMISSION_TEXT[settings.permissions.write]}</li>
            <li>Команды PowerShell: {PERMISSION_TEXT[settings.permissions.run]}</li>
          </ul>
          {mode === 'text' && props.model && (
            <p className="hint">
              У {shortModelName(props.model)} нет встроенной поддержки инструментов, поэтому Lama Burst объясняет их
              модели прямо в промпте.
            </p>
          )}
          {mode === 'none' && <p className="hint">Инструменты для этой модели выключены в настройках.</p>}
          <div className="suggestions">
            {mode !== 'none' && settings.permissions.write !== 'off' && (
              <button
                className="chip accent"
                onClick={() => props.onSend(STUDY_PROMPT)}
                disabled={!props.model}
                title="Модель изучит проект и запишет заметки в LAMA.md. Они будут подхватываться в каждом новом чате."
              >
                <IconSpark size={14} /> {study}
              </button>
            )}
            {SUGGESTIONS.map(s => (
              <button key={s} className="chip" onClick={() => props.onSend(s)} disabled={!props.model}>
                {s}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <p>Откройте папку, и модель сможет читать и править файлы в ней. Можно просто перетащить папку в окно.</p>
          <button className="btn primary big" onClick={props.onPickFolders}>
            <IconFolderPlus /> Открыть папку
          </button>
          <p className="hint">Без папки получится обычный чат с моделью.</p>
        </>
      )}
    </div>
  );
}

export function Chat(props: {
  sessionId: string | null;
  items: ChatItem[];
  live: Record<string, string>;
  busy: boolean;
  folders: string[];
  model: string;
  mode: EffectiveToolMode;
  settings: Settings;
  project: ProjectSummary | null;
  onPickFolders: () => void;
  onSend: (text: string) => void;
}) {
  const { items, busy } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    stick.current = true;
  }, [props.sessionId]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  if (!items.length) {
    return (
      <div className="chat">
        <EmptyState {...props} />
      </div>
    );
  }

  return (
    <div
      className="chat"
      ref={scroller}
      onScroll={e => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}
    >
      <div className="chat-inner">
        {items.map((item, i) => {
          const isLast = i === items.length - 1;
          if (item.role === 'user') {
            return <UserMessage key={item.id} item={item} />;
          }
          const next = items[i + 1];
          const turnEnd = !next || (next.role === 'user' && !next.auto);
          return (
            <AssistantMessage key={item.id} item={item} streaming={busy && isLast} last={turnEnd} live={props.live} />
          );
        })}
      </div>
    </div>
  );
}
