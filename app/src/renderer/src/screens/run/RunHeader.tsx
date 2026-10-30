import { useEffect, useState } from 'react';
import { Clock3, GitPullRequest, Trash2, ArrowRight, FileText, GitMerge, Hand, ShieldAlert, X, TriangleAlert } from 'lucide-react';
import type { PrStatus, RunFile, StageId } from '@purpleflow/core';
import { useNow } from '../../components/Timeline';
import { isGate } from '../../lib/bars';
import { agentTime, ms } from '../../lib/clock';
import { onPrRefreshed } from '../../components/PrPane';
import { Select } from '../../components/Dropdown';
import { Button } from '../../components/ui';
import { tokens, usageTotal, when } from '../../lib/format';
import { Lightbox } from './views/VisualView';
import { bridge, cleanErr } from '../../lib/api';

/** Удаление прогона с подтверждением: worktree и данные приложения, ветка — по выбору. */
export function DeleteRun({ run, runId }: { run: RunFile; runId: string }) {
  const [open, setOpen] = useState(false);
  const [withBranch, setWithBranch] = useState(Boolean(run.merged) || run.status === 'cancelled');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await bridge.core.dispatch({ type: 'run.delete', runId, deleteBranch: withBranch });
    } catch (e) {
      setError(cleanErr(e));
      setBusy(false);
    }
  };
  return (
    <div className="delete-run">
      <Button tone="quiet" icon={<Trash2 size={16} />} title="Удалить прогон" onClick={() => setOpen(!open)} />
      {open && (
        <>
          <div className="pop-backdrop" onClick={() => !busy && setOpen(false)} />
          <div className="pop delete-pop" role="dialog" aria-label="Удалить прогон">
            <strong>Удалить прогон?</strong>
            <p>
              {run.status === 'running'
                ? 'Прогон ещё идёт — он будет остановлен. '
                : run.status === 'waiting'
                  ? 'Прогон ждёт вашего решения — он будет закрыт без него. '
                  : ''}
              {run.workspace === 'branch'
                ? 'Удалятся лог, скриншоты и запись в истории. Файлы проекта не трогаем.'
                : 'Удалятся рабочая копия прогона (worktree), лог, скриншоты и запись в истории. Ваш проект не изменится.'}
            </p>
            <label className="check">
              <input type="checkbox" checked={withBranch} onChange={(e) => setWithBranch(e.target.checked)} />
              <span>
                Удалить и ветку <code>{run.branch}</code>
                {run.merged ? ' (уже влита)' : run.commit ? ' — в ней коммит с результатом' : ''}
              </span>
            </label>
            {error && <p className="pop-error">{error}</p>}
            <div className="pop-actions">
              <Button tone="quiet" disabled={busy} onClick={() => setOpen(false)}>
                Отмена
              </Button>
              <Button tone="danger" icon={<Trash2 size={14} />} busy={busy} onClick={() => void remove()}>
                Удалить
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function Banner({ run }: { run: RunFile }) {
  if (run.status === 'finished') return null;
  if (run.status === 'queued') {
    return (
      <div className="banner b-quiet">
        <Clock3 size={18} />
        <div>
          <strong>В очереди</strong>
          <p>
            Начнётся сам, когда освободится место — лимит одновременных прогонов задаётся в «Настройки → Модели». «Запустить сейчас» — без
            очереди.
          </p>
        </div>
      </div>
    );
  }
  if (run.status === 'cancelled')
    return (
      <div className="banner b-quiet">
        <X size={18} />
        <div>
          <strong>Прогон отменён</strong>
        </div>
      </div>
    );
  if (run.status === 'stopped' && run.message) {
    const failed = run.attempts.some((a) => a.status === 'failed' && a.error === run.message);
    return (
      <div className={`banner ${failed ? 'b-coral' : 'b-amber'}`}>
        {failed ? <ShieldAlert size={18} /> : <Hand size={18} />}
        <div>
          <strong>{failed ? 'Стадия остановлена из-за ошибки' : 'Прогон остановлен'}</strong>
          <p>{run.message}</p>
        </div>
      </div>
    );
  }
  if (run.status === 'waiting' && run.next === 'limit') {
    return (
      <div className="banner b-amber">
        <Hand size={18} />
        <div>
          <strong>Нужно ваше решение</strong>
          <p>{run.message}</p>
        </div>
      </div>
    );
  }
  return null;
}

export const AGENT_STAGES: StageId[] = ['clarify', 'plan', 'implement', 'review', 'visual'];

/**
 * Агент работает дольше обычного: прогон его не обрывает (останавливает только молчание или потолок ×4) —
 * решать человеку, ждать или остановить.
 */
export function LongRunBanner({ run, limitMin }: { run: RunFile; limitMin: number }) {
  const now = useNow(run);
  if (run.status !== 'running') return null;
  const a = [...run.attempts].reverse().find((x) => x.status === 'running' && AGENT_STAGES.includes(x.stage));
  if (!a) return null;
  const min = Math.floor((now - Date.parse(a.startedAt)) / 60_000);
  if (min < limitMin) return null;
  return (
    <div className="banner b-amber">
      <Clock3 size={18} />
      <div>
        <strong>
          {STAGE_TITLES_RU[a.stage] ?? 'Агент'} идёт уже {min} мин — дольше обычного
        </strong>
        <p>
          Агент не завис: его останавливают, только если он молчит {limitMin} мин, или через {limitMin * 4} мин. Посмотрите «Лог» — если он
          ходит по кругу, нажмите «Стоп» и дайте подсказку при продолжении; иначе можно подождать.
        </p>
      </div>
    </div>
  );
}

export const STAGE_TITLES_RU: Partial<Record<StageId, string>> = {
  clarify: 'Уточнение',
  plan: 'План',
  implement: 'Реализация',
  review: 'Ревью',
  visual: 'Визуальная проверка',
};

/** Готовый прогон: влить ветку purpleflow/<id> в выбранную ветку — прямо в строке статуса. */
export function MergeControl({ run, runId }: { run: RunFile; runId: string }) {
  const [branches, setBranches] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState<'merge' | 'pr' | 'prMerge' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prWhy, setPrWhy] = useState<string | null | undefined>(undefined);
  const [pr, setPr] = useState<PrStatus | null>(null);

  useEffect(() => {
    if (run.merged || run.pr) return;
    void bridge.core
      .listBranches(runId)
      .then((b) => {
        setBranches(b.branches);
        setTarget((t) => t || b.suggested || b.current || b.branches[0] || '');
      })
      .catch((e) => setError(cleanErr(e)));
    void bridge.core
      .prReady(runId)
      .then(setPrWhy)
      .catch(() => setPrWhy('Не удалось проверить GitHub CLI'));
  }, [runId, run.merged, run.pr]);

  // Открытый PR: статус проверок CI — при открытии прогона и после обновления на вкладке «Pull Request», без фонового опроса.
  useEffect(() => {
    if (!run.pr?.url) return;
    let alive = true;
    const load = () =>
      void bridge.core
        .getPrStatus(runId)
        .then((x) => alive && setPr(x))
        .catch((e) => alive && setError(cleanErr(e)));
    load();
    const off = onPrRefreshed(runId, (st) => alive && setPr(st));
    return () => {
      alive = false;
      off();
    };
  }, [runId, run.pr?.url]);

  const act = async (kind: 'merge' | 'pr' | 'prMerge') => {
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'merge') await bridge.core.dispatch({ type: 'run.merge', runId, target });
      else if (kind === 'pr') await bridge.core.dispatch({ type: 'run.pr', runId, base: target });
      else {
        await bridge.core.dispatch({ type: 'run.prMerge', runId });
        setPr(await bridge.core.getPrStatus(runId));
      }
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(null);
    }
  };

  if (run.pr) {
    const c = pr?.checks;
    const ciState = !pr ? 'loading' : !c?.total ? 'none' : c.failed ? 'failed' : c.pending ? 'pending' : 'ok';
    const ciText = !pr
      ? '…'
      : !c?.total
        ? 'без проверок CI'
        : c.failed
          ? `проверки: ${c.failed} упало`
          : c.pending
            ? `проверки идут ${c.passed}/${c.total}`
            : `проверки ✓ ${c.passed}/${c.total}`;
    const merged = pr?.state === 'MERGED' || Boolean(run.merged);
    return (
      <span className="merge-inline">
        <a className={`chip pr-chip ci-${ciState}`} href={run.pr.url} target="_blank" rel="noreferrer" title="Открыть PR на GitHub">
          <GitPullRequest size={12} /> PR #{run.pr.number} → {run.pr.base}
          {!merged && <span className="pr-ci">· {ciText}</span>}
        </a>
        {merged ? (
          <span className="chip merged">
            <GitMerge size={12} /> PR влит
          </span>
        ) : pr?.state === 'CLOSED' ? (
          <span className="chip">PR закрыт</span>
        ) : (
          <Button
            tone="approve"
            className="merge-btn"
            icon={<GitMerge size={14} />}
            busy={busy === 'prMerge'}
            disabled={!pr || pr.conflicts || ciState === 'failed' || ciState === 'pending'}
            title={
              pr?.conflicts
                ? 'Конфликт с базовой веткой — разрешите на GitHub'
                : ciState === 'failed'
                  ? 'Проверки CI упали'
                  : ciState === 'pending'
                    ? 'Ждём проверки CI'
                    : pr?.blocked
                      ? 'GitHub может потребовать ревью или обязательные проверки'
                      : 'gh pr merge --merge'
            }
            onClick={() => void act('prMerge')}
          >
            Влить PR
          </Button>
        )}
        {error && (
          <span className="merge-error" title={error}>
            {error}
          </span>
        )}
      </span>
    );
  }

  if (run.merged) {
    return (
      <span className="chip merged" title={`Коммит слияния ${run.merged.commit} · ${when(run.merged.at)}`}>
        <GitMerge size={12} /> влито в {run.merged.into} · <span className="mono">{run.merged.commit.slice(0, 7)}</span>
      </span>
    );
  }
  return (
    <span className="merge-inline">
      <ArrowRight size={14} className="muted" />
      <span className="muted merge-into">в</span>
      <Select<string>
        className="merge-target"
        mono
        title="Ветка, в которую влить результат или открыть PR"
        ariaLabel="Ветка, в которую влить"
        value={target}
        minWidth={220}
        disabled={busy !== null || !branches.length}
        placeholder="ветки не найдены"
        onChange={setTarget}
        options={branches.map((b) => ({ value: b, label: b }))}
      />
      <Button
        tone="ghost"
        className="merge-btn"
        icon={<GitPullRequest size={14} />}
        busy={busy === 'pr'}
        disabled={!target || prWhy !== null || busy !== null}
        title={prWhy ?? 'Отправить ветку на GitHub и открыть Pull Request с описанием из прогона'}
        onClick={() => void act('pr')}
      >
        Создать PR
      </Button>
      <Button
        tone="approve"
        className="merge-btn"
        icon={<GitMerge size={14} />}
        busy={busy === 'merge'}
        disabled={!target || busy !== null}
        onClick={() => void act('merge')}
        title="Влить локально, без GitHub"
      >
        Влить
      </Button>
      {error && (
        <span className="merge-error" title={error}>
          {error}
        </span>
      )}
    </span>
  );
}

/** Файлы задачи: изображения — миниатюрами (клик — крупно), остальные — карточками (клик — открыть в системном приложении). */
export function Attachments({ runId, files }: { runId: string; files: string[] }) {
  const [urls, setUrls] = useState<(string | null)[]>([]);
  const [big, setBig] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void Promise.all(files.map((_, i) => bridge.core.getAttachment(runId, i))).then((u) => alive && setUrls(u));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- файлы задачи только добавляются: хватает их числа
  }, [runId, files.length]);
  return (
    <>
      <div className="desc-images">
        {files.map((f, i) =>
          urls[i] ? (
            <button key={i} className="imgdrop-thumb" onClick={() => setBig(urls[i])} title="Открыть">
              <img src={urls[i]!} alt={`Изображение ${i + 1}`} />
            </button>
          ) : (
            <button key={i} className="file-chip" onClick={() => void bridge.openPath(f)} title={f}>
              <FileText size={16} />
              <span className="file-chip-text">
                <strong>{f.split(/[\\/]/).pop()!.replace(/^\d+-/, '')}</strong>
                <small>открыть</small>
              </span>
            </button>
          ),
        )}
      </div>
      {big && <Lightbox src={big} onClose={() => setBig(null)} />}
    </>
  );
}

/** Цифры прогона строкой в шапке. */
export function MetricsInline({ run }: { run: RunFile }) {
  const now = useNow(run);
  const runs = run.attempts.filter((a) => !isGate(a.stage)).length;
  const total = usageTotal(run.totals);
  return (
    <dl className="metrics-inline">
      <div title="Сколько работали агенты и проверки — без ожидания вашего решения и пауз">
        <dt>Время агентов</dt>
        <dd>
          <Num animate={false} text={ms(agentTime(run, now))} />
        </dd>
      </div>
      <div>
        <dt>Запусков стадий</dt>
        <dd>
          <Num text={String(runs)} />
        </dd>
      </div>
      <div title={`вход ${run.totals.input}, выход ${run.totals.output}, кэш ${run.totals.cacheRead + run.totals.cacheWrite}`}>
        <dt>Токены</dt>
        <dd>
          <Num text={total ? tokens(total) : '—'} />
        </dd>
      </div>
      <div>
        <dt>Попытки</dt>
        <dd>
          <Num text={`${run.implAttemptsUsed}`} />
          <small>/ {run.implAttemptsLimit}</small>
        </dd>
      </div>
    </dl>
  );
}

/** Крупное число тонким начертанием, единицы — мелко и серым: «18 мин 54 с», «93 тыс.». */
export function Num({ text, animate = true }: { text: string; animate?: boolean }) {
  const parts = text.split(/(\d+(?:[.,]\d+)?|\$)/).filter(Boolean);
  return (
    <>
      {parts.map((p, i) =>
        /^[\d$]/.test(p) ? (
          <span key={animate ? `${i}:${p}` : i} className={animate ? 'num-in' : undefined}>
            {p}
          </span>
        ) : (
          <small key={i}>{p}</small>
        ),
      )}
    </>
  );
}

/** Предупреждения ядра: прогон шёл дальше, но что-то не удалось (зависимости, артефакты, автопилот). */
export function Warnings({ run }: { run: RunFile }) {
  const [hidden, setHidden] = useState(0);
  const list = (run.warnings ?? []).slice(hidden);
  if (!list.length) return null;
  return (
    <div className="banner b-quiet warnings">
      <TriangleAlert size={18} />
      <div>
        <strong>{list.length === 1 ? 'Предупреждение' : `Предупреждений: ${list.length}`}</strong>
        {list.slice(-3).map((w, i) => (
          <p key={i}>{w.text}</p>
        ))}
      </div>
      <button className="link" onClick={() => setHidden(run.warnings?.length ?? 0)}>
        Скрыть
      </button>
    </div>
  );
}
