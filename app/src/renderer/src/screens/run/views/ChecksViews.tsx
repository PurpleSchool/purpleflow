// Проверки: воспроизведение бага, проверки на базовом коммите, тесты и вывод сервера.
import type { RunFile } from '@purpleflow/core';
import { Sparkles } from 'lucide-react';
import { Empty } from '../../../components/ui';
import { stripAnsi, unstableText } from '../util';

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
