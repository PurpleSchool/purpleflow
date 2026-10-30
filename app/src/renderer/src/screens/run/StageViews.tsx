import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleCheck, RotateCcw, Sparkles } from 'lucide-react';
import type { ReviewItem, LineComment, RunFile, StageAttempt, StageId } from '@purpleflow/core';
import { PillTabs } from '../../components/PillTabs';
import { LiveLog, cut, finalMessage, type LogSlice } from '../../components/Terminal';
import { Markdown } from '../../components/Markdown';
import { CommentableMarkdown } from '../../components/CommentableMarkdown';
import { OriginTag, PickBox } from '../../components/DiffReview';
import { Button, Empty, Input } from '../../components/ui';
import type { ChangeDocs } from '../../../../shared/ipc';
import { originSummary, stripAnsi, unstableText } from './util';
import { bridge, cleanErr } from '../../lib/api';

/** Вопросы планировщика до плана: варианты ответа кнопками или свой текст. */
export function ClarifyView({ run, runId, waiting, onDone }: { run: RunFile; runId: string; waiting: boolean; onDone: () => void }) {
  const qs = run.clarify?.questions ?? [];
  const given = run.clarify?.answers ?? [];
  const [answers, setAnswers] = useState<string[]>(() => qs.map((q) => given.find((a) => a.q === q.q)?.a ?? ''));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await bridge.core.dispatch({ type: 'gate.answer', runId, answers: qs.map((q, i) => ({ q: q.q, a: answers[i] ?? '' })) });
      onDone();
    } catch (e) {
      setError(cleanErr(e));
      setBusy(false);
    }
  };
  const filled = answers.filter((a) => a.trim()).length;
  return (
    <div className="scroll">
      <div className="clarify">
        {!waiting && (
          <p className="muted">
            {run.clarify?.skipped
              ? 'Продолжили без ответов — планировщик решал сам.'
              : given.length
                ? `Ответы отправлены: ${given.length} из ${qs.length}.`
                : 'На вопросы не ответили.'}
          </p>
        )}
        {qs.map((q, i) => (
          <section key={i} className="clarify-q">
            <strong>
              <span className="clarify-n">{i + 1}</span>
              {q.q}
            </strong>
            {q.why && <p className="muted">{q.why}</p>}
            {q.options?.length ? (
              <div className="clarify-options">
                {q.options.map((o) => (
                  <button
                    key={o}
                    className={`clarify-opt ${answers[i] === o ? 'is-on' : ''}`}
                    disabled={!waiting}
                    onClick={() => setAnswers(answers.map((a, j) => (j === i ? (a === o ? '' : o) : a)))}
                  >
                    <i aria-hidden />
                    <span>{o}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <Input
              placeholder={q.options?.length ? 'или свой ответ' : 'Ваш ответ'}
              value={q.options?.includes(answers[i]) ? '' : answers[i]}
              disabled={!waiting}
              onChange={(e) => setAnswers(answers.map((a, j) => (j === i ? e.target.value : a)))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && filled) void send();
              }}
            />
          </section>
        ))}
        {waiting && (
          <div className="clarify-actions">
            {error && <span className="actionbar-error">{error}</span>}
            <span className="muted">Пустые вопросы планировщик решит сам</span>
            <Button tone="primary" busy={busy} disabled={!filled} onClick={() => void send()}>
              Ответить и продолжить
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Баг: доказательство воспроизведения. Рефакторинг: зелёный эталон до начала. */
export function ReproView({ run, kind }: { run: RunFile; kind: 'bug' | 'baseline' }) {
  if (kind === 'baseline' && run.mode !== 'refactor') return <BaseChecksView run={run} />;
  const r = run.repro;
  if (!r) return <Empty icon={<Sparkles />} title={kind === 'bug' ? 'Баг ещё не воспроизведён' : 'Базовые проверки ещё не запускались'} />;
  const ok = kind === 'bug' ? !r.passed : r.passed;
  const failedCheck = r.checks?.find((c) => !c.passed);
  return (
    <div className={`repro ${ok ? 'is-ok' : 'is-bad'}`}>
      <strong>
        {kind === 'bug'
          ? ok
            ? 'Баг воспроизведён: проверки красные на текущем коде'
            : 'Тест не воспроизвёл баг — проверки зелёные'
          : ok
            ? 'Проверки зелёные до рефакторинга — эталон зафиксирован'
            : 'Проверки красные ещё до рефакторинга'}
      </strong>
      {(failedCheck ?? r.checks?.[0]) && (
        <pre className="output">
          {stripAnsi((failedCheck ?? r.checks![0]).output)
            .split('\n')
            .slice(-18)
            .join('\n')}
        </pre>
      )}
    </div>
  );
}

/** Обычная задача: проверки на коде до правок, снятые в фоне. Красные до задачи не блокируют — агенту нельзя добавлять ошибок. */
function BaseChecksView({ run }: { run: RunFile }) {
  const checks = run.baseChecks;
  if (!checks?.length) return <Empty icon={<Sparkles />} title="Проверки до правок ещё идут" />;
  const red = checks.find((c) => !c.passed);
  return (
    <div className={`repro ${red ? 'is-bad' : 'is-ok'}`}>
      <strong>
        {red ? 'Красные ещё до задачи — от агента потребуется не добавлять новых ошибок' : 'Проверки зелёные до правок — эталон снят'}
      </strong>
      <ul className="base-checks">
        {checks.map((c) => (
          <li key={`${c.kind}:${c.command}`} className={c.passed ? 'is-ok' : 'is-bad'}>
            <span>{c.kind === 'lint' ? 'Линтер' : c.command === run.focusTestCommand ? 'Тесты задачи' : 'Тесты'}</span>
            <code>{c.command}</code>
          </li>
        ))}
      </ul>
      {run.focusTestCommand && (
        <p className="base-checks-note">
          Тесты задачи выбрал планировщик (раздел «Checks» плана): они идут на каждой попытке, полный набор <code>{run.testCommand}</code> —
          один раз перед приёмкой.
        </p>
      )}
      {red && <pre className="output">{stripAnsi(red.output).split('\n').slice(-18).join('\n')}</pre>}
    </div>
  );
}

/** Визуальная проверка: вердикт и галерея скриншотов. */
export function VisualView({ run, runId, idx, attempt }: { run: RunFile; runId: string; idx: number; attempt?: StageAttempt }) {
  const running = attempt?.status === 'running';
  // Результат — только у завершённой попытки; у упавшей (сбой агента) или идущей — сразу лог.
  const v = running || (attempt && attempt.status === 'failed' && !run.visuals?.[idx]) ? undefined : run.visuals?.[idx];
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [big, setBig] = useState<number | null>(null);
  const [tab, setTab] = useState<'result' | 'server' | 'log'>(v ? 'result' : 'log');
  useEffect(() => {
    let alive = true;
    if (!v) return;
    void Promise.all(v.shots.map(async (s) => [s.file, await bridge.core.getVisualShot(runId, s.file)] as const)).then((pairs) => {
      // Удалённый очисткой хранилища скриншот — пустая строка: показываем заглушку, а не вечный спиннер.
      if (alive) setUrls(Object.fromEntries(pairs.map(([f, u]) => [f, u ?? ''])));
    });
    return () => {
      alive = false;
    };
  }, [runId, v]);
  const slice: LogSlice | null = attempt
    ? { title: 'Визуальная проверка', attempt: attempt.attempt, stage: 'visual', live: running }
    : null;
  // Повторить можно последнюю проверку, пока прогон ждёт решения или остановлен (например, после правки команды запуска).
  const canRerun = !running && idx === (run.visuals?.length ?? 0) - 1 && (run.status === 'waiting' || run.status === 'stopped');
  const [rerunning, setRerunning] = useState(false);
  const [rerunErr, setRerunErr] = useState<string | null>(null);
  const rerun = async () => {
    setRerunning(true);
    setRerunErr(null);
    try {
      await bridge.core.dispatch({ type: 'run.rerunVisual', runId });
    } catch (e) {
      setRerunErr(cleanErr(e));
    } finally {
      setRerunning(false);
    }
  };
  if (!v && !slice)
    return (
      <Empty icon={<Sparkles />} title="Визуальной проверки ещё не было">
        Приложение запустится после ревью.
      </Empty>
    );
  const items = v
    ? [...v.blocking.map((x) => ({ ...x, kind: 'blocking' as const })), ...v.notes.map((x) => ({ ...x, kind: 'note' as const }))]
    : [];
  const shown = v ? tab : 'log';
  const shotUrls = v ? v.shots.map((s) => urls[s.file]).filter(Boolean) : [];
  return (
    <div className="agent-out">
      {v && (
        <div className="agent-out-tabs">
          <PillTabs<'result' | 'server' | 'log'>
            className="tabs small"
            value={shown}
            onChange={setTab}
            items={[
              { id: 'result', label: 'Результат' },
              ...(v.serverOutput ? [{ id: 'server' as const, label: 'Вывод сервера' }] : []),
              { id: 'log', label: 'Лог' },
            ]}
          />
        </div>
      )}
      {shown === 'log' && slice ? (
        <div className="pane-log">
          <LiveLog runId={runId} slice={slice} />
        </div>
      ) : shown === 'server' && v?.serverOutput ? (
        <div className="agent-result scroll tab-enter">
          <ServerOutput command={v.command} output={v.serverOutput} />
        </div>
      ) : v ? (
        <div className="agent-result scroll tab-enter">
          <div className="review">
            {v.unverified ? (
              <div className="verdict is-warn">
                <span className="verdict-mark">!</span>
                <div>
                  <strong>
                    {/^Нестабильное окружение:/i.test(v.unverified) ? 'Окружение вело себя нестабильно' : 'Проверить не удалось'}
                  </strong>
                  <p>{v.unverified.replace(/^Нестабильное окружение:\s*/i, '')}</p>
                  <p className="muted">
                    {/^Нестабильное окружение:/i.test(v.unverified)
                      ? 'Интерфейс не реагировал даже после перезагрузки, а ошибок в коде задачи не видно — похоже на сбой dev-сервера или браузера. Задача не вернулась исполнителю: проверьте сами во вкладке «Браузер» или перезапустите проверку.'
                      : 'Это не ошибка реализации — задача не вернулась исполнителю. Проверьте сами во вкладке «Браузер»; тестовый вход и подготовку данных можно описать в «Инструкции для проверки» в настройках проекта.'}
                  </p>
                </div>
              </div>
            ) : null}
            {v.unverified && v.serverOutput && /error|Missing script|EADDRINUSE|ECONNREFUSED/i.test(v.serverOutput) && (
              <button className="link server-link" onClick={() => setTab('server')}>
                В выводе сервера есть ошибки — открыть
              </button>
            )}
            {canRerun && (
              <div className="visual-rerun">
                <Button tone="ghost" icon={<RotateCcw size={14} />} busy={rerunning} onClick={() => void rerun()}>
                  Проверить ещё раз
                </Button>
                <span className="muted">Команда запуска и адрес — из настроек проекта: если вы их поправили, проверка возьмёт новые.</span>
                {rerunErr && <span className="actionbar-error">{rerunErr}</span>}
              </div>
            )}
            {!v.unverified && (
              <div className={`verdict ${v.blocking.length ? 'is-bad' : 'is-ok'}`}>
                <span className="verdict-mark">{v.blocking.length ? v.blocking.length : <CircleCheck size={22} />}</span>
                <div>
                  <strong>{v.blocking.length ? `Видимых проблем: ${v.blocking.length}` : 'В браузере всё выглядит верно'}</strong>
                  <p>
                    {v.url} · скриншотов: {v.shots.length} · заметок: {v.notes.length}
                  </p>
                </div>
              </div>
            )}
            <div className="shots">
              {v.shots.map((s) => (
                <figure key={s.file} className="shot">
                  <button onClick={() => urls[s.file] && setBig(shotUrls.indexOf(urls[s.file]))}>
                    {urls[s.file] ? (
                      <img src={urls[s.file]} alt={s.caption} />
                    ) : urls[s.file] === '' ? (
                      <span className="muted shot-gone">Скриншот удалён</span>
                    ) : (
                      <span className="spinner" />
                    )}
                  </button>
                  <figcaption>{s.caption}</figcaption>
                </figure>
              ))}
            </div>
            {items.length > 0 && (
              <ul className="review-list">
                {items.map((x, i) => (
                  <li key={i} className={`note n-${x.kind}`}>
                    {x.file && <span className="note-loc">{x.file}</span>}
                    <p>{x.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
      {big !== null && shotUrls[big] && (
        <Lightbox
          src={shotUrls[big]}
          caption={v?.shots.find((s) => urls[s.file] === shotUrls[big])?.caption}
          onClose={() => setBig(null)}
          onPrev={big > 0 ? () => setBig(big - 1) : undefined}
          onNext={big < shotUrls.length - 1 ? () => setBig(big + 1) : undefined}
        />
      )}
    </div>
  );
}

/** Просмотр изображения на всё окно (через портал — не зависит от прокрутки и анимаций панели). ←/→ — соседние, Esc — закрыть. */
export function Lightbox({
  src,
  caption,
  onClose,
  onPrev,
  onNext,
}: {
  src: string;
  caption?: string;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') onPrev?.();
      else if (e.key === 'ArrowRight') onNext?.();
      else return;
      // Esc и стрелки не должны дойти до экрана прогона (там они закрывают детали и листают стадии).
      e.stopImmediatePropagation();
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, onPrev, onNext]);
  return createPortal(
    <div className="lightbox" onClick={onClose} role="dialog" aria-label="Изображение">
      <img src={src} alt={caption ?? ''} onClick={(e) => e.stopPropagation()} />
      {caption && <p className="lightbox-caption">{caption}</p>}
      {onPrev && (
        <button
          className="lightbox-nav is-prev"
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          aria-label="Предыдущий"
        >
          ‹
        </button>
      )}
      {onNext && (
        <button
          className="lightbox-nav is-next"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          aria-label="Следующий"
        >
          ›
        </button>
      )}
    </div>,
    document.body,
  );
}

export function PlanView({
  docs,
  run,
  comments,
  onComments,
  editable,
}: {
  docs: ChangeDocs | null;
  run: RunFile;
  comments: LineComment[];
  onComments: (c: LineComment[]) => void;
  editable: boolean;
}) {
  const [specOpen, setSpecOpen] = useState<string | null>(null);
  // Путь от корня рабочей копии — так планировщик сразу найдёт файл.
  const at = (f: string) => `openspec/changes/${run.changeId}/${f}`;
  const doc = (f: string, source: string, className?: string) => (
    <CommentableMarkdown
      file={at(f)}
      source={source}
      comments={comments}
      onComments={onComments}
      editable={editable}
      className={className}
    />
  );
  if (!docs)
    return (
      <div className="center">
        <span className="spinner big" />
      </div>
    );
  if (!docs.proposal && !docs.tasks) {
    return (
      <Empty icon={<Sparkles />} title="План ещё пишется">
        Планировщик создаёт изменение <code>{run.changeId}</code>. Ход работы — в логе этой попытки ниже, когда она закончится, здесь
        появятся файлы.
      </Empty>
    );
  }
  const done = (docs.tasks.match(/- \[x\]/gi) ?? []).length;
  const all = (docs.tasks.match(/- \[[ x]\]/gi) ?? []).length;
  return (
    <div className="scroll">
      <div className="plan">
        <article className="doc bezel">
          <header className="doc-head">
            <span>proposal.md</span>
            <span className="mono muted">{run.changeId}</span>
          </header>
          {doc('proposal.md', docs.proposal)}
        </article>
        <article className="doc bezel">
          <header className="doc-head">
            <span>tasks.md</span>
            {all > 0 && (
              <span className="progress" title={`${done} из ${all}`}>
                <i style={{ width: `${(done / all) * 100}%` }} />
                <b>
                  {done}/{all}
                </b>
              </span>
            )}
          </header>
          {doc('tasks.md', docs.tasks, 'tasks')}
        </article>
        {docs.design && (
          <article className="doc bezel">
            <header className="doc-head">
              <span>design.md</span>
            </header>
            {doc('design.md', docs.design)}
          </article>
        )}
        {docs.specs.length > 0 && (
          <article className="doc bezel">
            <header className="doc-head">
              <span>Дельты спецификаций</span>
              <span className="muted">{docs.specs.length}</span>
            </header>
            {docs.specs.map((s) => (
              <div key={s.path} className="spec">
                <button
                  className="spec-toggle"
                  onClick={() => setSpecOpen(specOpen === s.path ? null : s.path)}
                  aria-expanded={specOpen === s.path}
                >
                  <span className="mono">{s.path}</span>
                  <span className="muted">{specOpen === s.path ? 'свернуть' : 'показать'}</span>
                </button>
                {(specOpen === s.path || comments.some((c) => c.file === at(s.path))) && doc(s.path, s.content, 'spec-md')}
              </div>
            ))}
          </article>
        )}
      </div>
    </div>
  );
}

export const IN_PROGRESS: Partial<Record<StageId, { title: string; text: string }>> = {
  plan: { title: 'Планировщик пишет план', text: 'Документы изменения появятся, когда он закончит.' },
  tests: { title: 'Проверки идут', text: 'Линтер и тесты запущены — результат появится, когда они завершатся.' },
  review: { title: 'Идёт ревью', text: 'Ревьюер читает изменения — замечания появятся, когда он закончит.' },
};

export function InProgress({ stage, attempt }: { stage: StageId; attempt: StageAttempt }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.round((now - Date.parse(attempt.startedAt)) / 1000));
  const c = IN_PROGRESS[stage] ?? { title: 'Выполняется', text: 'Результат появится, когда стадия завершится.' };
  return (
    <div className="in-progress">
      <span className="spinner big" />
      <h3>
        {c.title} · попытка #{attempt.attempt}
      </h3>
      <p>{c.text}</p>
      <small>{sec < 60 ? `${sec} с` : `${Math.floor(sec / 60)} мин ${String(sec % 60).padStart(2, '0')} с`}</small>
    </div>
  );
}

export function TestsView({ run, idx }: { run: RunFile; idx: number }) {
  const t = run.tests[idx];
  if (!t) return <Empty icon={<Sparkles />} title="Проверки ещё не запускались" />;
  const checks = t.checks?.length
    ? t.checks
    : t.command
      ? [
          {
            kind: 'test' as const,
            command: t.command,
            passed: t.passed,
            exitCode: t.exitCode,
            durationMs: t.durationMs,
            output: t.output,
            timedOut: t.timedOut,
          },
        ]
      : [];
  return (
    <div className="scroll">
      <div className="tests">
        {!checks.length && <p className="muted">{t.output}</p>}
        {checks.map((c, i) => (
          <section key={i} className="check-block">
            <div className={`tests-head ${c.unstable ? 'is-old' : c.passed ? 'is-ok' : c.preexisting ? 'is-old' : 'is-bad'}`}>
              <strong>
                {c.kind === 'lint' ? 'Линтер' : 'Тесты'} ·{' '}
                {c.unstable ? 'нестабильные' : c.passed ? 'ok' : c.preexisting ? 'красные и до задачи' : 'красные'}
              </strong>
              <span className="mono">{c.command}</span>
              <span className="muted">
                код {c.exitCode ?? '—'} · {(c.durationMs / 1000).toFixed(1)} с{c.timedOut ? ' · таймаут' : ''}
              </span>
            </div>
            {c.preexisting && (
              <p className="check-old">
                Проверка была красной ещё до правок агента, новых ошибок не появилось ({c.preexisting.before ?? '?'} →{' '}
                {c.preexisting.after ?? '?'}). Не блокирует — старые ошибки лучше чинить отдельной задачей.
              </p>
            )}
            {c.unstable && <p className="check-old">{unstableText(c.unstable)}</p>}
            <pre className="output">{stripAnsi(c.output) || 'нет вывода'}</pre>
          </section>
        ))}
      </div>
    </div>
  );
}

/** Вывод команды запуска: строки с ошибками подсвечены, частые причины — подсказкой. */
export function ServerOutput({ command, output }: { command?: string; output: string }) {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-30);
  const bad = (l: string) => /error|ERR!|Missing script|not found|EADDRINUSE|ECONNREFUSED|Cannot find|failed/i.test(l);
  const missing = output.match(/Missing script: "([^"]+)"/);
  const inUse = /EADDRINUSE|address already in use|Another next dev server/i.test(output);
  return (
    <section className="server-out">
      <header>
        <strong>Вывод команды запуска</strong>
        {command && <code>{command}</code>}
      </header>
      {missing && (
        <p className="server-hint">
          В одном из package.json нет скрипта «{missing[1]}» — исправьте «Запуск приложения» в командах проекта (например, у NestJS это
          обычно <code>start:dev</code>).
        </p>
      )}
      {inUse && (
        <p className="server-hint">
          Порт или каталог уже заняты другим запущенным сервером — остановите его или смените порт в команде запуска.
        </p>
      )}
      <pre className="output">
        {lines.map((l, i) => (
          <span key={i} className={bad(l) ? 'is-err' : undefined}>
            {l}
            {'\n'}
          </span>
        ))}
      </pre>
    </section>
  );
}

export function ReviewView({
  run,
  idx,
  picked,
  onPicked,
}: {
  run: RunFile;
  idx: number;
  picked?: ReviewItem[];
  onPicked?: (items: ReviewItem[]) => void;
}) {
  const r = run.reviews[idx];
  const items = useMemo(
    () =>
      r ? [...r.blocking.map((x) => ({ ...x, kind: 'blocking' as const })), ...r.notes.map((x) => ({ ...x, kind: 'note' as const }))] : [],
    [r],
  );
  if (!r) return <Empty icon={<Sparkles />} title="Ревью ещё не было" />;
  return (
    <div className="scroll">
      <div className="review">
        <div className={`verdict bezel ${r.blocking.length ? 'is-bad' : 'is-ok'}`}>
          <span className="verdict-mark">{r.blocking.length ? r.blocking.length : <CircleCheck size={22} />}</span>
          <div>
            <strong>{r.blocking.length ? `Блокирующих замечаний: ${r.blocking.length}` : 'Блокирующих замечаний нет'}</strong>
            <p>
              {r.blocking.length
                ? run.next === 'limit' && idx === run.reviews.length - 1
                  ? 'Попытки реализации исчерпаны — решение за вами: ещё попытка или дальше как есть.'
                  : 'Задача вернулась исполнителю с этими замечаниями.'
                : 'Изменение передано вам на приёмку.'}{' '}
              Заметок: {r.notes.length}.{originSummary(r.blocking)}
            </p>
          </div>
          <span className="muted mono">
            {run.agents.reviewer} · {run.models.reviewer || 'по умолчанию'}
          </span>
        </div>
        <ul className="review-list">
          {items.map((x, i) => (
            <li key={i} className={`note n-${x.kind}`}>
              {x.file && (
                <span className="note-loc">
                  {x.file}
                  {x.line ? `:${x.line}` : ''}
                </span>
              )}
              <OriginTag origin={x.origin} />
              <p>{x.message}</p>
              {picked && onPicked && <PickBox item={x} picked={picked} onPicked={onPicked} />}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Стадия агента: итоговый ответ в Markdown отдельно от служебного лога. */
export function AgentOutput({ runId, slice, attempt }: { runId: string; slice: LogSlice; attempt: StageAttempt }) {
  const running = attempt.status === 'running';
  const [fromLog, setFromLog] = useState<string | null>(null);
  const [tab, setTab] = useState<'result' | 'log'>(running ? 'log' : 'result');
  useEffect(() => {
    if (running || attempt.output) return;
    let alive = true;
    void bridge.core.getLog(runId).then((full) => alive && setFromLog(finalMessage(cut(full, slice))));
    return () => {
      alive = false;
    };
  }, [runId, slice.title, slice.attempt, running, attempt.output]);
  useEffect(() => {
    if (!running) setTab('result');
  }, [running]);
  const result = attempt.output ?? fromLog;
  const hasResult = !running && Boolean(result);
  const shown = hasResult ? tab : 'log';
  return (
    <div className="agent-out">
      {hasResult && (
        <div className="agent-out-tabs">
          <PillTabs<'result' | 'log'>
            className="tabs small"
            value={shown}
            onChange={setTab}
            items={[
              { id: 'result', label: 'Результат' },
              { id: 'log', label: 'Лог' },
            ]}
          />
        </div>
      )}
      {shown === 'result' && result ? (
        <div className="agent-result scroll tab-enter">
          <Markdown source={result} />
        </div>
      ) : (
        <div className="pane-log">
          <LiveLog runId={runId} slice={slice} />
        </div>
      )}
    </div>
  );
}
