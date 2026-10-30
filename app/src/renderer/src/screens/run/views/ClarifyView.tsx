// Уточнение до плана: вопросы планировщика и ответы человека.
import type { RunFile } from '@purpleflow/core';
import { useState } from 'react';
import { Button, Input } from '../../../components/ui';
import { bridge, cleanErr } from '../../../lib/api';

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
