import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconArrowUp, IconStop } from './icons';

export function Composer(props: {
  sessionId: string | null;
  disabled: boolean;
  busy: boolean;
  placeholder: string;
  hint: string;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [props.sessionId, props.busy]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || props.busy || props.disabled) return;
    props.onSend(t);
    setText('');
  };

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={props.placeholder}
          disabled={props.disabled}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {props.busy ? (
          <button className="send stop" onClick={props.onStop} title="Остановить">
            <IconStop size={16} />
          </button>
        ) : (
          <button className="send" onClick={submit} disabled={!text.trim() || props.disabled} title="Отправить (Enter)">
            <IconArrowUp size={18} />
          </button>
        )}
      </div>
      <div className="composer-hint">{props.hint}</div>
    </div>
  );
}
