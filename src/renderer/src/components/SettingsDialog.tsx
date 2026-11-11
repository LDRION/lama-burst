import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, modelSettings, shortModelName } from '../../../shared/settings';
import type { ModelInfo, ModelSettings, Permission, Settings, ToolMode, UpdateState } from '../../../shared/types';
import { api } from '../api';
import { IconX } from './icons';

function Segmented<T extends string>(props: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {props.options.map(([v, label]) => (
        <button
          key={v}
          role="radio"
          aria-checked={props.value === v}
          className={props.value === v ? 'on' : ''}
          onClick={() => props.onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function NumberField(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  const commit = () => {
    const n = Number(text.replace(',', '.'));
    const v = Number.isFinite(n) ? Math.min(props.max, Math.max(props.min, n)) : props.value;
    setText(String(v));
    props.onChange(v);
  };
  return (
    <input
      className="input num"
      inputMode="decimal"
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => e.key === 'Enter' && commit()}
      step={props.step}
    />
  );
}

const PERM_FULL: [Permission, string][] = [
  ['ask', 'Спрашивать'],
  ['auto', 'Автоматически'],
  ['off', 'Выключено'],
];

export function SettingsDialog(props: {
  settings: Settings;
  update: UpdateState | null;
  model: ModelInfo | undefined;
  modelName: string;
  onClose: () => void;
  onSave: (s: Settings) => void;
}) {
  const [draft, setDraft] = useState<Settings>(() => structuredClone(props.settings));
  const [checked, setChecked] = useState('');
  const name = props.modelName;
  const ms = modelSettings(draft, name, props.model);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [props]);

  const setPerm = (k: keyof Settings['permissions'], v: Permission) =>
    setDraft(d => ({ ...d, permissions: { ...d.permissions, [k]: v } }));
  const setModel = (patch: Partial<ModelSettings>) =>
    setDraft(d => ({ ...d, models: { ...d.models, [name]: { ...d.models[name], ...patch } } }));
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setDraft(d => ({ ...d, [k]: v }));

  const nativeCapable = props.model?.capabilities.includes('tools');

  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-label="Настройки">
        <div className="modal-head">
          <h2>Настройки</h2>
          <button className="icon-btn" onClick={props.onClose} title="Закрыть">
            <IconX />
          </button>
        </div>

        <div className="modal-body">
          <section>
            <h3>Что модели можно делать</h3>
            <div className="row">
              <label>Чтение файлов и поиск</label>
              <Segmented
                value={draft.permissions.read}
                options={[
                  ['auto', 'Автоматически'],
                  ['ask', 'Спрашивать'],
                ]}
                onChange={v => setPerm('read', v)}
              />
            </div>
            <div className="row">
              <label>Создание и правка файлов</label>
              <Segmented value={draft.permissions.write} options={PERM_FULL} onChange={v => setPerm('write', v)} />
            </div>
            <div className="row">
              <label>Команды PowerShell</label>
              <Segmented value={draft.permissions.run} options={PERM_FULL} onChange={v => setPerm('run', v)} />
            </div>
            <p className="note">
              Файловые инструменты работают только внутри открытых папок. Команды PowerShell запускаются в главной
              папке, но с вашими правами, поэтому опасные команды (удаление, перезагрузка, git push и т.п.) всегда
              требуют подтверждения.
            </p>
          </section>

          {name && (
            <section>
              <h3>
                Модель <span className="mono">{shortModelName(name)}</span>
              </h3>
              <div className="row">
                <label>Инструменты</label>
                <Segmented<ToolMode>
                  value={ms.toolMode}
                  options={[
                    ['auto', 'Авто'],
                    ['native', 'Нативно'],
                    ['text', 'Через промпт'],
                    ['off', 'Выкл'],
                  ]}
                  onChange={v => setModel({ toolMode: v })}
                />
              </div>
              <p className="note">
                {nativeCapable
                  ? 'Модель заявляет встроенную поддержку инструментов. Если она путается или пишет вызовы текстом, попробуйте «Через промпт».'
                  : 'У модели нет встроенной поддержки инструментов: в режиме «Авто» они описываются в промпте специальными тегами.'}
              </p>
              <div className="row">
                <label>Контекст, токенов</label>
                <NumberField
                  value={ms.numCtx}
                  min={1024}
                  max={props.model?.contextLength ?? 262144}
                  onChange={v => setModel({ numCtx: v })}
                />
              </div>
              <p className="note">
                {props.model?.contextLength ? `Максимум модели: ${props.model.contextLength.toLocaleString('ru')}. ` : ''}
                Больше контекст — модель помнит больше, но нужно больше видеопамяти и работает медленнее.
              </p>
              <div className="row">
                <label>Температура</label>
                <NumberField value={ms.temperature} min={0} max={2} step={0.1} onChange={v => setModel({ temperature: v })} />
              </div>
              <p className="note">Для работы с файлами лучше 0.1–0.4: модель меньше фантазирует.</p>
            </section>
          )}

          <section>
            <h3>Свои инструкции</h3>
            <textarea
              className="input"
              rows={4}
              placeholder="Добавляются к системному промпту. Например: «Отвечай кратко», «Пиши код на TypeScript»."
              value={draft.systemPrompt}
              onChange={e => set('systemPrompt', e.target.value)}
            />
          </section>

          <section>
            <h3>Агент</h3>
            <div className="row">
              <label>Шагов на один ответ, максимум</label>
              <NumberField value={draft.maxSteps} min={1} max={100} onChange={v => set('maxSteps', v)} />
            </div>
            <div className="row">
              <label>Вывод инструмента, символов</label>
              <NumberField
                value={draft.maxToolOutputChars}
                min={1000}
                max={200000}
                onChange={v => set('maxToolOutputChars', v)}
              />
            </div>
            <div className="row">
              <label>Таймаут команды, секунд</label>
              <NumberField
                value={draft.commandTimeoutSec}
                min={5}
                max={3600}
                onChange={v => set('commandTimeoutSec', v)}
              />
            </div>
          </section>

          <section>
            <h3>Ollama</h3>
            <div className="row">
              <label>Адрес сервера</label>
              <input
                className="input"
                value={draft.ollamaUrl}
                placeholder={DEFAULT_SETTINGS.ollamaUrl}
                onChange={e => set('ollamaUrl', e.target.value.trim() || DEFAULT_SETTINGS.ollamaUrl)}
              />
            </div>
          </section>

          <section>
            <h3>Обновления</h3>
            <div className="row">
              <label>Устанавливать новые версии</label>
              <Segmented
                value={draft.autoUpdate ? 'on' : 'off'}
                options={[
                  ['on', 'Автоматически'],
                  ['off', 'Выключено'],
                ]}
                onChange={v => set('autoUpdate', v === 'on')}
              />
            </div>
            <div className="row">
              <label>Папка со сборками</label>
              <input
                className="input"
                value={draft.updateDir}
                placeholder={props.update?.dir ?? ''}
                onChange={e => set('updateDir', e.target.value.trim())}
              />
            </div>
            <div className="row">
              <label>
                Версия {props.update?.current ?? '…'}
                {checked && ` · ${checked}`}
              </label>
              <button
                className="btn small"
                onClick={async () => {
                  const u = await api.checkUpdate();
                  setChecked(u.available ? `готова ${u.available}` : 'новых версий нет');
                }}
              >
                Проверить сейчас
              </button>
            </div>
            <p className="note">
              {props.update?.installed === false
                ? 'Эта копия запущена без установки, поэтому обновляться сама не может. Установите Lama Burst установщиком из папки со сборками один раз.'
                : 'Lama Burst раз в минуту проверяет папку со сборками. Новая версия ставится сама при закрытии приложения, или сразу по кнопке «Обновить сейчас».'}
            </p>
          </section>
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={props.onClose}>
            Отмена
          </button>
          <button className="btn primary" onClick={() => props.onSave(draft)}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}
