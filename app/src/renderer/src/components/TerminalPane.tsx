// Панель «Терминал» чата: вкладки оболочек в папке проекта (или рабочей папке чата без проекта). Сами терминалы
// живут в lib/terminals — панель показывает активный и подгоняет его под свой размер.
import { useEffect, useRef } from 'react';
import { Plus, RotateCw, SquareTerminal, X } from 'lucide-react';
import { attachTerminal, closeTerminal, fitTerminal, newTerminal, selectTerminal, useChatTerms } from '../lib/terminals';
import { Button } from './ui';

export function TerminalPane({ chatId, cwd }: { chatId: string; cwd: string | null }) {
  const terms = useChatTerms(chatId);
  const host = useRef<HTMLDivElement>(null);
  const cur = terms.tabs.find((t) => t.key === terms.active) ?? terms.tabs[0];

  // Открыли панель, а терминалов нет — сразу первый, как в редакторе.
  useEffect(() => {
    if (cwd && !terms.tabs.length) newTerminal(chatId, cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, cwd]);

  // Показанный терминал — в панель; размер панели меняется — терминал подстраивается. Папка чата приходит не сразу,
  // а до неё места под терминал нет: эффект ждёт её, иначе при повторном открытии панели терминал не возвращался.
  const key = cur?.key;
  const ready = Boolean(cwd);
  useEffect(() => {
    const el = host.current;
    if (!el || !key) return;
    attachTerminal(chatId, key, el);
    const ro = new ResizeObserver(() => fitTerminal(key));
    ro.observe(el);
    return () => ro.disconnect();
  }, [chatId, key, ready]);

  if (!cwd) return null;
  return (
    <div className="browser term-pane">
      <div className="browser-tabs" role="tablist" aria-label="Терминалы">
        {terms.tabs.map((t) => {
          const on = t.key === cur?.key;
          return (
            <div key={t.key} className={`browser-tab ${on ? 'is-on' : ''}`} title={t.title}>
              <button
                type="button"
                role="tab"
                aria-selected={on}
                className="browser-tab-main"
                onClick={() => selectTerminal(chatId, t.key)}
              >
                <SquareTerminal size={13} />
                <span className="browser-tab-title">{t.exited ? `${t.title} · завершён` : t.title}</span>
              </button>
              <button
                type="button"
                className="browser-tab-close"
                aria-label={`Закрыть терминал ${t.title}`}
                onClick={() => closeTerminal(chatId, t.key)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="browser-tab-new"
          aria-label="Новый терминал"
          title="Новый терминал"
          onClick={() => newTerminal(chatId, cwd)}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="term-stage">
        <div className="term-slot" ref={host} />
        {cur?.exited && (
          <div className="term-exited">
            <Button
              tone="ghost"
              icon={<RotateCw size={14} />}
              onClick={() => {
                closeTerminal(chatId, cur.key);
                newTerminal(chatId, cwd);
              }}
            >
              Новый терминал
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
