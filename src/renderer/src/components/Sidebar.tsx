import { useState } from 'react';
import { shortModelName } from '../../../shared/settings';
import type { SessionMeta } from '../../../shared/types';
import { basename } from '../api';
import { IconGear, IconPlus, IconTrash, Logo, Spinner } from './icons';

function groupOf(ts: number): string {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  if (ts >= day.getTime()) return 'Сегодня';
  if (ts >= day.getTime() - 86400000) return 'Вчера';
  if (ts >= day.getTime() - 7 * 86400000) return 'Неделя';
  return 'Раньше';
}

export function Sidebar(props: {
  sessions: SessionMeta[];
  currentId: string | null;
  busy: Record<string, boolean>;
  ollama: { ok: boolean; loading: boolean; count: number };
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onSettings: () => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  let lastGroup = '';

  return (
    <aside className="sidebar">
      <div className="brand">
        <Logo size={26} />
        <span>Lama Burst</span>
      </div>
      <button className="new-chat" onClick={props.onNew}>
        <IconPlus /> Новый чат
        <kbd>Ctrl+N</kbd>
      </button>

      <nav className="sessions" onMouseLeave={() => setConfirm(null)}>
        {!props.sessions.length && <div className="sessions-empty">Здесь появятся ваши чаты</div>}
        {props.sessions.map(s => {
          const group = groupOf(s.updatedAt);
          const header = group !== lastGroup ? <div className="sessions-group">{group}</div> : null;
          lastGroup = group;
          const sub = [s.folders[0] && basename(s.folders[0]), s.model && shortModelName(s.model)].filter(Boolean);
          return (
            <div key={s.id}>
              {header}
              <div
                className={`session ${s.id === props.currentId ? 'active' : ''}`}
                onClick={() => props.onSelect(s.id)}
                role="button"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && props.onSelect(s.id)}
              >
                <div className="session-text">
                  <div className="session-title">{s.title}</div>
                  <div className="session-sub">{sub.join(' · ')}</div>
                </div>
                {props.busy[s.id] ? (
                  <Spinner size={12} />
                ) : (
                  <button
                    className={`session-del ${confirm === s.id ? 'confirm' : ''}`}
                    title={confirm === s.id ? 'Нажмите ещё раз, чтобы удалить' : 'Удалить чат'}
                    onClick={e => {
                      e.stopPropagation();
                      if (confirm === s.id) {
                        setConfirm(null);
                        props.onDelete(s.id);
                      } else setConfirm(s.id);
                    }}
                  >
                    {confirm === s.id ? 'Удалить?' : <IconTrash size={14} />}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        <div className={`ollama-status ${props.ollama.loading ? 'loading' : props.ollama.ok ? 'ok' : 'err'}`}>
          <span className="dot" />
          {props.ollama.loading
            ? 'Подключаюсь к Ollama…'
            : props.ollama.ok
              ? `Ollama · моделей: ${props.ollama.count}`
              : 'Ollama недоступна'}
        </div>
        <button className="icon-btn" onClick={props.onSettings} title="Настройки (Ctrl+,)">
          <IconGear size={17} />
        </button>
      </div>
    </aside>
  );
}
