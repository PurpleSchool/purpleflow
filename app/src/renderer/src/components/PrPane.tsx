import { useEffect, useMemo, useState } from 'react';
import { CircleCheck, CircleX, ExternalLink, FileCode2, GitMerge, GitPullRequest, MessageSquare, RotateCw, ShieldAlert, Wrench } from 'lucide-react';
import type { PrComment, PrDetails, PrFollowupItem, PrStatus, RunFile } from '@purpleflow/core';
import { Button, TextArea } from './ui';
import { Markdown } from './Markdown';
import { when } from '../lib/format';

const cleanErr = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/** Обновили PR на вкладке — статус в строке прогона подхватывает его без отдельного запроса. */
const refreshed = new Set<(runId: string, st: PrStatus) => void>();
export function onPrRefreshed(runId: string, fn: (st: PrStatus) => void): () => void {
  const h = (id: string, st: PrStatus) => id === runId && fn(st);
  refreshed.add(h);
  return () => refreshed.delete(h);
}

const noun = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'замечание' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'замечания' : 'замечаний');

const REVIEW_STATE: Record<string, string> = { APPROVED: 'одобрил', CHANGES_REQUESTED: 'просит изменения', COMMENTED: 'прокомментировал', DISMISSED: 'отозвано' };

/**
 * Вкладка «Pull Request»: PR прогона, замечания ревьюеров и упавшие проверки CI.
 * Данные — по кнопке «Обновить» (и при открытии вкладки), без фонового опроса.
 */
export function PrPane({ run, runId, onStarted }: { run: RunFile; runId: string; onStarted: () => void }) {
  const [d, setD] = useState<PrDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'followup' | 'update' | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  /** Замечания, уже отработанные в прошлых кругах. */
  const handled = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of run.prRounds ?? []) for (const i of r.items) m.set(i.id, r.round);
    return m;
  }, [run.prRounds]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const x = await window.purpleflow.core.getPrDetails(runId);
      setD(x);
      if (x) {
        refreshed.forEach((fn) => fn(runId, x.status));
        // По умолчанию отмечены новые: открытые обсуждения, ревью с просьбой изменений, общие комментарии и упавший CI.
        setPicked(new Set(x.comments.filter((c) => !handled.has(c.id) && !c.resolved && !(c.kind === 'review' && c.state === 'APPROVED')).map((c) => c.id)));
      }
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [runId]);

  if (!run.pr) return null;
  const inRound = run.status !== 'finished';
  const merged = d?.status.state === 'MERGED' || Boolean(run.merged);
  const closed = d?.status.state === 'CLOSED';
  const all = d?.comments ?? [];
  const resolved = all.filter((c) => c.resolved);
  const visible = showResolved ? all : all.filter((c) => !c.resolved);
  const groups: { title: string; kind: PrComment['kind'] }[] = [
    { title: 'Проверки CI', kind: 'check' },
    { title: 'Обсуждения в коде', kind: 'thread' },
    { title: 'Ревью', kind: 'review' },
    { title: 'Комментарии', kind: 'comment' },
  ];
  const toggle = (id: string) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const start = async () => {
    const items: PrFollowupItem[] = all.filter((c) => picked.has(c.id)).map((c) => ({
      id: c.id, kind: c.kind, author: c.author, path: c.path, line: c.line, url: c.url,
      // В обсуждении важны и ответы: ревьюер мог уточнить, что именно хочет.
      body: c.replies?.length ? `${c.body}\n${c.replies.map((r) => `  ↳ @${r.author}: ${r.body}`).join('\n')}` : c.body,
    }));
    setBusy('followup');
    setError(null);
    try {
      await window.purpleflow.core.dispatch({ type: 'run.prFollowup', runId, items, note: note.trim() || undefined });
      setNote('');
      onStarted();
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(null);
    }
  };

  const update = async () => {
    setBusy('update');
    setError(null);
    try {
      await window.purpleflow.core.dispatch({ type: 'run.updateBranch', runId });
      onStarted();
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(null);
    }
  };

  const st = d?.status;
  const ci = st?.checks;
  return (
    <div className="scroll">
      <div className="prpane">
        <section className="panel pr-head">
          <div className="pr-title">
            <span className="kdoc-icon"><GitPullRequest size={16} /></span>
            <div>
              <a href={run.pr.url} target="_blank" rel="noreferrer" className="pr-link">
                <strong>{d?.title ?? run.title}</strong> <span className="muted">#{run.pr.number}</span> <ExternalLink size={13} />
              </a>
              <div className="pr-meta">
                <span className={`tag ${merged ? 'is-ok' : closed ? 'is-bad' : ''}`}>{merged ? 'Влит' : closed ? 'Закрыт' : st?.draft ? 'Черновик' : 'Открыт'}</span>
                <span className="mono">{run.branch} → {run.pr.base}</span>
                {ci && (
                  <span className={`pr-ci-state ${ci.failed ? 'is-bad' : ci.pending ? 'is-wait' : ci.total ? 'is-ok' : ''}`}>
                    {!ci.total ? 'без проверок CI' : ci.failed ? `CI: упало ${ci.failed} из ${ci.total}` : ci.pending ? `CI: идут ${ci.passed}/${ci.total}` : `CI: ✓ ${ci.passed}/${ci.total}`}
                  </span>
                )}
                {st?.review && <span className="muted">{st.review === 'APPROVED' ? 'одобрен' : st.review === 'CHANGES_REQUESTED' ? 'просят изменения' : st.review === 'REVIEW_REQUIRED' ? 'ждёт ревью' : st.review}</span>}
                {st?.conflicts ? <span className="tag is-bad">конфликт с {run.pr.base}</span> : st?.behind && <span className="tag is-wait">отстаёт от {run.pr.base}</span>}
              </div>
            </div>
          </div>
          <div className="pr-refresh">
            {d && <span className="muted">обновлено {when(d.fetchedAt)}</span>}
            <Button tone="ghost" icon={<RotateCw size={14} className={loading ? 'spin' : ''} />} disabled={loading} onClick={() => void load()}>Обновить</Button>
          </div>
        </section>

        {(run.prRounds?.length ?? 0) > 0 && (
          <p className="pr-rounds muted">
            Кругов доработки: {run.prRounds!.length}.{' '}
            {run.prRounds!.map((r) => `круг ${r.round} — ${r.kind === 'update' ? `обновление из ${run.pr!.base}${r.conflicts?.length ? `, конфликтов: ${r.conflicts.length}` : ''}` : `${r.items.length} ${noun(r.items.length)}`}${r.commit ? `, ${r.commit.slice(0, 7)}` : inRound && r === run.prRounds!.at(-1) ? ', идёт' : ''}`).join('; ')}
          </p>
        )}

        {error && <p className="inline-error">{error}</p>}
        {!d && loading && <div className="center pr-loading"><span className="spinner big" /></div>}

        {d && !all.length && (
          <section className="panel knowledge-empty-card">
            <span className="browser-empty-icon"><MessageSquare size={22} /></span>
            <strong>Замечаний пока нет</strong>
            <p>Когда ревьюеры оставят комментарии или упадёт CI, нажмите «Обновить» — они появятся здесь.</p>
          </section>
        )}

        {groups.map((g) => {
          const list = visible.filter((c) => c.kind === g.kind);
          if (!list.length) return null;
          return (
            <section key={g.kind} className="pr-group">
              <h4>{g.title} <span className="muted">{list.length}</span></h4>
              {list.map((c) => (
                <label key={c.id} className={`pr-item ${picked.has(c.id) ? 'is-picked' : ''} ${c.resolved ? 'is-resolved' : ''}`}>
                  <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} disabled={inRound || merged} />
                  <div className="pr-item-body">
                    <div className="pr-item-head">
                      {c.kind === 'check' ? <CircleX size={14} className="err" /> : c.kind === 'thread' ? <FileCode2 size={14} /> : c.kind === 'review' ? (c.state === 'APPROVED' ? <CircleCheck size={14} className="ok" /> : <ShieldAlert size={14} />) : <MessageSquare size={14} />}
                      {c.kind === 'check' ? <strong>{c.body}</strong> : <strong>@{c.author}</strong>}
                      {c.kind === 'review' && c.state && <span className="muted">{REVIEW_STATE[c.state] ?? c.state}</span>}
                      {c.path && <span className="mono pr-loc">{c.path}{c.line ? `:${c.line}` : ''}</span>}
                      {c.resolved && <span className="tag">решено</span>}
                      {c.outdated && !c.resolved && <span className="tag">код изменился</span>}
                      {handled.has(c.id) && <span className="tag is-ok">отработано в круге {handled.get(c.id)}</span>}
                      <span className="grow" />
                      {c.kind !== 'check' && <time className="muted">{when(c.at)}</time>}
                      {c.url && <a className="pr-open" href={c.url} target="_blank" rel="noreferrer" title="Открыть на GitHub" onClick={(e) => e.stopPropagation()}><ExternalLink size={13} /></a>}
                    </div>
                    {c.kind === 'check' ? (
                      <p className="muted pr-check-hint">Исполнитель получит хвост лога упавшего job{c.url?.includes('/actions/') ? '' : ' (если это GitHub Actions)'}.</p>
                    ) : (
                      <Markdown source={c.body} className="pr-md" />
                    )}
                    {c.replies?.map((r, i) => (
                      <div key={i} className="pr-reply">
                        <strong>@{r.author}</strong>
                        <Markdown source={r.body} className="pr-md" />
                      </div>
                    ))}
                  </div>
                </label>
              ))}
            </section>
          );
        })}
        {resolved.length > 0 && (
          <button className="link pr-show-resolved" onClick={() => setShowResolved(!showResolved)}>
            {showResolved ? 'Скрыть решённые обсуждения' : `Показать решённые обсуждения (${resolved.length})`}
          </button>
        )}

        {d && !merged && !closed && (
          <section className="panel pr-action">
            {inRound ? (
              <p className="muted">{run.prRounds?.at(-1)?.kind === 'update' ? `Идёт обновление ветки из ${run.pr.base} — круг ${run.prRound}.` : `Идёт доработка по PR — круг ${run.prRound}.`} Следите за ним на таймлайне; после проверок{run.mergeOnly ? '' : ' и приёмки'} изменения уйдут в ветку PR.</p>
            ) : (
              <>
                <TextArea rows={2} placeholder="Ваш комментарий к доработке (необязательно) — например, с каким замечанием не согласны" value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="pr-action-row">
                  <span className="muted">Новый круг в этом прогоне: реализация → проверки → ревью → приёмка → коммит и push в ветку PR. Отвечать в обсуждениях — на GitHub.</span>
                  <Button
                    tone={st?.behind || st?.conflicts ? 'ghost' : 'quiet'}
                    icon={<GitMerge size={14} />}
                    busy={busy === 'update'}
                    disabled={busy !== null}
                    title={`Влить свежую ${run.pr.base} в ветку PR: без конфликтов — проверки и push, с конфликтами — их разрешит исполнитель, затем проверки и приёмка`}
                    onClick={() => void update()}
                  >
                    Обновить ветку{st?.conflicts ? ' и разрешить конфликты' : ''}
                  </Button>
                  <Button tone="primary" icon={<Wrench size={14} />} busy={busy === 'followup'} disabled={busy !== null || (!picked.size && !note.trim())} onClick={() => void start()}>
                    Отработать{picked.size ? ` (${picked.size})` : ''}
                  </Button>
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
