// Вкладка «Сессия» правой панели чата и индикатор контекста на свёрнутой панели.
import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy, FoldVertical } from 'lucide-react';
import type { ChatFile } from '@purpleflow/core';
import { Button } from '../components/ui';
import { bridge, cleanErr } from '../lib/api';
import { chatSession, mcpStatus, type ChatSessionSummary } from '../lib/chatSession';
import { shortPath, tokens, when } from '../lib/format';

/** Кольцо заполнения контекста: свёрнутая панель и заголовок карточки. */
export function ContextRing({ pct, size = 22 }: { pct?: number; size?: number }) {
  const r = (size - 4) / 2;
  const len = 2 * Math.PI * r;
  const tone = pct == null ? '' : pct >= 85 ? 'is-high' : pct >= 60 ? 'is-mid' : '';
  return (
    <svg className={`ctx-ring ${tone}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="ctx-ring-track" cx={size / 2} cy={size / 2} r={r} />
      {pct != null && (
        <circle
          className="ctx-ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeDasharray={`${(len * Math.max(pct, 2)) / 100} ${len}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </svg>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ses-row">
      <span className="ses-label">{label}</span>
      <span className="ses-value">{children}</span>
    </div>
  );
}

function CopyValue({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ses-copy"
      title={done ? 'Скопировано' : 'Копировать'}
      aria-label="Копировать"
      onClick={() =>
        void navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      <code>{value}</code>
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

/** «Сжать контекст»: /compact в сессии claude — переписка остаётся, агент помнит её в пересказе. */
function CompactButton({ chat, busy }: { chat: ChatFile; busy: boolean }) {
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ход сжатия закончился — кнопка снова доступна.
  useEffect(() => {
    if (!busy) setCompacting(false);
  }, [busy]);
  if (chat.agent !== 'claude' || chat.session?.agent !== 'claude') return null;
  return (
    <>
      <Button
        tone="quiet"
        className="ses-compact"
        icon={<FoldVertical size={14} />}
        busy={compacting}
        disabled={busy && !compacting}
        title={busy && !compacting ? 'Агент отвечает — сожмите после ответа' : 'Пересказать переписку и освободить окно модели'}
        onClick={() => {
          setError(null);
          setCompacting(true);
          bridge.core.compactChat(chat.id).catch((e) => {
            setCompacting(false);
            setError(cleanErr(e));
          });
        }}
      >
        {compacting ? 'Сжимаю…' : 'Сжать контекст'}
      </Button>
      {error && <p className="ses-note">{error}</p>}
    </>
  );
}

function ContextCard({ s, chat, busy }: { s: ChatSessionSummary; chat: ChatFile; busy: boolean }) {
  const c = s.context;
  const agent = chat.agent;
  return (
    <section className="ses-card">
      <div className="ses-card-head">
        <h3>Контекст</h3>
        <CompactButton chat={chat} busy={busy} />
      </div>
      {c ? (
        <>
          <div className="ses-ctx">
            <ContextRing pct={c.pct} size={44} />
            <div>
              <div className="ses-ctx-num">
                {tokens(c.used)}
                {c.window ? <span> из {tokens(c.window)}</span> : null}
              </div>
              <div className="ses-hint">
                {c.pct != null ? `занято ${c.pct}% окна модели` : 'размер окна модели станет известен после ответа'}
              </div>
            </div>
          </div>
          {c.pct != null && c.pct >= 85 && (
            <p className="ses-note">
              Окно почти заполнено — скоро агент сожмёт переписку сам. Можно сжать сейчас кнопкой «Сжать контекст».
            </p>
          )}
          {s.compacted && <p className="ses-note">В этой сессии контекст уже сжимался.</p>}
        </>
      ) : (
        <p className="ses-hint">
          {agent === 'codex'
            ? 'codex не сообщает, сколько контекста занято.'
            : s.answers
              ? 'Последний ответ не сообщил о контексте.'
              : 'Появится после первого ответа агента.'}
        </p>
      )}
    </section>
  );
}

/** Вкладка «Сессия»: контекст, агент и окружение. */
export function ChatSessionPane({ chat, model, busy }: { chat: ChatFile; model: string; busy: boolean }) {
  const s = chatSession(chat);
  const folder = chat.projectPath ?? s.cwd;
  return (
    <div className="ses">
      <ContextCard s={s} chat={chat} busy={busy} />

      <section className="ses-card">
        <h3>Агент</h3>
        <Row label="Агент">{chat.agent}</Row>
        <Row label="Модель">
          {s.model && s.model !== model ? (
            <>
              {s.model} <span className="ses-hint">· выбрана {model || 'по умолчанию'}</span>
            </>
          ) : (
            model || s.model || 'по умолчанию CLI'
          )}
        </Row>
        <Row label="Режим">{chat.edits ? 'Правки — может менять файлы' : 'Вопросы — только чтение'}</Row>
        {s.version && <Row label="Версия CLI">{s.version}</Row>}
        <Row label="Сессия CLI">
          {chat.session ? <CopyValue value={chat.session.id} /> : <span className="ses-hint">начнётся с первым сообщением</span>}
        </Row>
      </section>

      <section className="ses-card">
        <h3>Окружение</h3>
        <Row label={chat.projectPath ? 'Проект' : 'Папка'}>
          {folder ? <span title={folder}>{shortPath(folder)}</span> : <span className="ses-hint">временная папка чата</span>}
        </Row>
        {s.mcp?.length ? (
          <div className="ses-mcp">
            <span className="ses-label">MCP-серверы</span>
            <ul>
              {s.mcp.map((m) => {
                const st = mcpStatus(m.status);
                return (
                  <li key={m.name}>
                    <span className={`ses-dot is-${st.tone}`} />
                    <span className="ses-mcp-name">{m.name}</span>
                    <span className="ses-hint">{st.label}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <Row label="MCP-серверы">
            <span className="ses-hint">{s.answers ? 'нет' : 'станут известны после ответа'}</span>
          </Row>
        )}
        <Row label="Создан">{when(chat.createdAt)}</Row>
        <Row label="Обновлён">{when(chat.updatedAt)}</Row>
      </section>
    </div>
  );
}
