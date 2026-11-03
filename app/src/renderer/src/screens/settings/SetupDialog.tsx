// Окно первого запуска: что уже готово и одна кнопка, чтобы настроить остальное.
import { ArrowRight, Wand2, X } from 'lucide-react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/ui';
import { useStore } from '../../lib/store';
import { toolNeeded } from '../../lib/tools';
import { CheckButton, ChecksList, TOOL_INFO } from './parts';
import type { SettingsDraft } from './useSettingsDraft';
import { TOOL_NAMES, type ToolSetup } from './useToolSetup';

function NodeRow({ setup }: { setup: ToolSetup }) {
  const { node, current, errors, needsNode } = setup;
  const installing = current === 'node';
  const tone = installing || !node ? 'is-loading' : node.path ? 'is-ok' : errors.node || needsNode ? 'is-bad' : 'is-off';
  return (
    <div className={`setup-row ${tone}`}>
      <span className="setup-led" />
      <strong>Node.js</strong>
      <span className="setup-state">
        {installing ? (
          'Скачиваю и устанавливаю…'
        ) : !node ? (
          'Ищем…'
        ) : node.path ? (
          <span className="mono">{node.version}</span>
        ) : errors.node ? (
          errors.node
        ) : needsNode ? (
          'Не найден. Поставим в ~/.purpleflow/node'
        ) : (
          'Не нужен: все инструменты уже найдены'
        )}
      </span>
    </div>
  );
}

export function SetupDialog({
  draft,
  setup,
  onClose,
  onFinish,
}: {
  draft: SettingsDraft;
  setup: ToolSetup;
  onClose: () => void;
  onFinish: () => void;
}) {
  const { state } = useStore();
  const tools = state.tools;
  const { checks } = draft;
  const busy = setup.running || draft.checking;
  const close = () => !busy && onClose();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return createPortal(
    <div className="qs-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="qs setup" role="dialog" aria-modal aria-labelledby="setup-title">
        <header className="qs-head">
          <div>
            <h2 id="setup-title">Подготовим окружение</h2>
            <p>
              Node.js при необходимости поставим в отдельную папку, инструменты — глобально через npm, затем отправим агентам короткий
              проверочный запрос. Всё это можно сделать и позже на вкладке «Инструменты».
            </p>
          </div>
          <button className="qs-close" aria-label="Закрыть" disabled={busy} onClick={close}>
            <X size={16} />
          </button>
        </header>

        <div className="setup-rows">
          <NodeRow setup={setup} />
          {TOOL_NAMES.map((t) => {
            const info = tools?.[t];
            const ok = info?.path && !info.error;
            const needed = toolNeeded(t, draft.agents);
            const error = setup.errors[t];
            const installing = setup.current === t;
            return (
              <div
                key={t}
                className={`setup-row ${installing || !info ? 'is-loading' : ok ? 'is-ok' : error || needed ? 'is-bad' : 'is-off'}`}
              >
                <span className="setup-led" />
                <strong>{TOOL_INFO[t].title}</strong>
                <span className="setup-state">
                  {installing ? (
                    'Устанавливаю…'
                  ) : !info ? (
                    'Ищем…'
                  ) : ok ? (
                    <span className="mono">{info.version}</span>
                  ) : error ? (
                    error
                  ) : !needed ? (
                    'Не нужен: ни одна роль на нём не работает'
                  ) : t === 'git' ? (
                    `Не найден. Установка: ${TOOL_INFO.git.install}`
                  ) : (
                    <>
                      Не найден. Поставим: <code>{TOOL_INFO[t].install}</code>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>

        {draft.checking && <p className="setup-note">Проверяем подключение агентов…</p>}
        {checks && <ChecksList checks={checks} />}
        {checks?.some((c) => !c.ok) && (
          <p className="setup-note">
            Если агент просит войти, запустите <code>claude</code> или <code>codex</code> в терминале и выполните вход, либо войдите в
            аккаунт PurpleSchool и включите AI-прокси.
          </p>
        )}
        {draft.error && <p className="setup-error">{draft.error}</p>}

        <footer className="qs-foot">
          <Button tone="quiet" disabled={busy} onClick={close}>
            Позже
          </Button>
          {setup.missing.length > 0 || !tools ? (
            <Button tone="primary" icon={<Wand2 size={15} />} busy={busy} disabled={!tools} onClick={() => void setup.run()}>
              {Object.keys(setup.errors).length ? 'Повторить' : 'Настроить'}
            </Button>
          ) : (
            <>
              {!checks?.every((c) => c.ok) && <CheckButton draft={draft} />}
              <Button tone="primary" icon={<ArrowRight size={15} />} disabled={busy} onClick={onFinish}>
                Готово, к задаче
              </Button>
            </>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
