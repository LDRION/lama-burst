import { useEffect, useRef, useState } from 'react';
import { effectiveMode, modelSettings, shortModelName } from '../../../shared/settings';
import type { ModelInfo, Settings } from '../../../shared/types';
import { formatBytes } from '../api';
import { IconCheck, IconChevronDown } from './icons';

export function toolBadge(info: ModelInfo | undefined, settings: Settings): { text: string; kind: string } {
  if (!info) return { text: 'не найдена', kind: 'off' };
  const mode = effectiveMode(modelSettings(settings, info.name, info).toolMode, info, true);
  if (mode === 'native') return { text: 'инструменты', kind: 'native' };
  if (mode === 'text') return { text: 'инструменты через промпт', kind: 'text' };
  return { text: 'без инструментов', kind: 'off' };
}

export function ModelPicker(props: {
  models: ModelInfo[];
  value: string;
  settings: Settings;
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = props.models.find(m => m.name === props.value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const badge = toolBadge(current, props.settings);

  return (
    <div className="picker" ref={root}>
      <button className="picker-btn" onClick={() => setOpen(o => !o)} disabled={!props.models.length}>
        <span className="picker-name">{props.value ? shortModelName(props.value) : 'Нет моделей'}</span>
        {props.value && <span className={`badge ${badge.kind}`}>{badge.text}</span>}
        <IconChevronDown size={14} />
      </button>
      {open && (
        <div className="picker-menu" role="listbox">
          {props.models.map(m => {
            const b = toolBadge(m, props.settings);
            return (
              <button
                key={m.name}
                role="option"
                aria-selected={m.name === props.value}
                className={`picker-item ${m.name === props.value ? 'active' : ''}`}
                onClick={() => {
                  props.onChange(m.name);
                  setOpen(false);
                }}
              >
                <span className="picker-item-main">
                  <span className="picker-item-name" title={m.name}>
                    {shortModelName(m.name)}
                  </span>
                  <span className="picker-item-meta">
                    {[m.parameterSize, formatBytes(m.size), m.quantization].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className={`badge ${b.kind}`}>{b.text}</span>
                <span className="picker-check">{m.name === props.value && <IconCheck size={14} />}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
