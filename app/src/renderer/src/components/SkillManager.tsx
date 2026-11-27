// Управление скиллами проекта: список по агентам с удалением и окно поиска по каталогу skills.sh с установкой.
import { Check, ChevronRight, Copy, Download, LoaderCircle, Search, TriangleAlert, X } from 'lucide-react';
import { ConfirmDelete, OpenSkill } from './RowActions';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentKind, ChatSkill, SkillHit } from '@purpleflow/core';
import { bridge, cleanErr } from '../lib/api';
import { useStore } from '../lib/store';
import { useDialogClose } from '../lib/useDialogClose';
import { Select } from './Dropdown';
import { PillTabs } from './PillTabs';
import { Button } from './ui';

/** Подзаголовки вкладки: скиллы проекта и ваши — из ~/.claude, ~/.agents… */
const SOURCE_TITLE: Record<ChatSkill['source'], string> = { project: 'Проект', user: 'Ваши — для всех проектов' };

/** Удалить скилл: что не убрал `skills` CLI (положен руками), окно отправляет в корзину системы. */
export async function removeSkill(projectPath: string | undefined, s: ChatSkill): Promise<ChatSkill[]> {
  const r = await bridge.core.removeSkill({ projectPath, name: s.name, source: s.source });
  if (r.leftovers.length) await bridge.trashSkill(r.leftovers);
  return r.leftovers.length ? bridge.core.listChatSkills(projectPath) : r.skills;
}

/**
 * Скиллы по агентам: у каждого включённого агента — те, что он найдёт сам. Один скилл бывает у нескольких агентов —
 * удаление убирает его у всех. Скиллы плагинов claude удаляются в самом claude, поэтому без кнопки.
 */
export function SkillGroups({
  skills,
  projectPath,
  onChange,
}: {
  skills: ChatSkill[];
  projectPath?: string;
  onChange: (skills: ChatSkill[]) => void;
}) {
  const { state } = useStore();
  const enabled = state.settings?.enabledAgents ?? ['claude', 'codex'];
  const [error, setError] = useState<string | null>(null);
  const groups: { agent: AgentKind | null; items: ChatSkill[] }[] = enabled
    .map((agent) => ({ agent, items: skills.filter((s) => s.agents?.includes(agent)) }))
    .filter((g) => g.items.length);
  // Скиллы, которые не найдёт ни один включённый агент (например, только для выключенного): вызываются через «/» в чате.
  const orphan = skills.filter((s) => !s.agents?.some((a) => enabled.includes(a)));
  if (orphan.length) groups.push({ agent: null, items: orphan });

  const key = (a: AgentKind | null) => a ?? 'other';
  const [tab, setTab] = useState<string>(() => key(groups[0]?.agent ?? null));
  const current = groups.find((g) => key(g.agent) === tab) ?? groups[0];
  // Свои скиллы проекта — раскрыты; ваши (из ~/.claude, ~/.agents…) обычно длинный список — свёрнуты, если есть проектные.
  const hasProject = skills.some((s) => s.source === 'project');
  const [open, setOpen] = useState<Record<ChatSkill['source'], boolean>>({ project: true, user: !hasProject });

  return (
    <div className="skill-groups">
      {groups.length > 1 && (
        <PillTabs<string>
          className="tabs skill-tabs"
          value={current ? key(current.agent) : null}
          onChange={setTab}
          items={groups.map((g) => ({
            id: key(g.agent),
            label: g.agent ?? 'Только через «/»',
            extra: <span className="tab-badge">{g.items.length}</span>,
          }))}
        />
      )}
      {error && <p className="inline-error">{error}</p>}
      {current && (
        <div className="skill-sources tab-enter" key={key(current.agent)}>
          {(['project', 'user'] as const).map((src) => {
            const items = current.items.filter((s) => s.source === src).sort((a, b) => a.name.localeCompare(b.name));
            if (!items.length) return null;
            const isOpen = open[src];
            return (
              <section key={src} className={`skill-source ${isOpen ? 'is-open' : ''}`}>
                <h4 className="skill-source-head">
                  <button type="button" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [src]: !o[src] }))}>
                    <ChevronRight size={14} className="skill-source-chevron" />
                    {SOURCE_TITLE[src]} <span className="muted">{items.length}</span>
                  </button>
                </h4>
                {isOpen && (
                  <ul className="skill-list">
                    {items.map((s) => (
                      <SkillRow
                        key={`${s.source}:${s.name}`}
                        s={s}
                        others={(s.agents ?? []).filter((a) => a !== current.agent && enabled.includes(a))}
                        copyTo={enabled.filter((a) => !s.agents?.includes(a))}
                        onCopy={async (to) => {
                          setError(null);
                          try {
                            onChange(await bridge.core.copySkill({ projectPath, name: s.name, source: s.source, to }));
                          } catch (e) {
                            setError(cleanErr(e));
                          }
                        }}
                        onRemove={async () => {
                          setError(null);
                          try {
                            onChange(await removeSkill(projectPath, s));
                          } catch (e) {
                            setError(cleanErr(e));
                          }
                        }}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SkillRow({
  s,
  others,
  copyTo,
  onCopy,
  onRemove,
}: {
  s: ChatSkill;
  others: AgentKind[];
  /** Включённые агенты, которые этот скилл сами не найдут: ему можно скопировать. */
  copyTo: AgentKind[];
  onCopy: (to: AgentKind) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [copying, setCopying] = useState<'pick' | AgentKind | null>(null);
  const canCopy = s.kind === 'skill' && !s.plugin && copyTo.length > 0;
  const copy = async (to: AgentKind) => {
    setCopying(to);
    await onCopy(to);
    setCopying(null);
  };
  return (
    <li title={s.path}>
      <div className="skill-head">
        <code className="skill-name">
          {s.kind === 'command' ? '/' : ''}
          {s.name}
        </code>
        {s.plugin && <span className="tag">плагин {s.plugin}</span>}
        {s.kind === 'command' && <span className="tag">команда</span>}
        {s.untracked && (
          <span className="tag is-wait" title="Скилл не в git: прогон в отдельной рабочей копии его не увидит. Закоммитьте его.">
            <TriangleAlert size={11} /> не в git
          </span>
        )}
        <span className="grow" />
        {canCopy &&
          (copying === 'pick' ? (
            <span className="skill-copy-to" role="group" aria-label={`Скопировать ${s.name}`}>
              {copyTo.map((a) => (
                <button key={a} type="button" className="skill-del is-copy" onClick={() => void copy(a)}>
                  <Copy size={13} /> в {a}
                </button>
              ))}
              <button type="button" className="skill-del" aria-label="Отмена" onClick={() => setCopying(null)}>
                <X size={13} />
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="skill-del"
              aria-label={`Скопировать ${s.name} другому агенту`}
              title="Скопировать другому агенту"
              disabled={copying !== null}
              onClick={() => setCopying('pick')}
            >
              {copying ? <LoaderCircle size={14} className="spin" /> : <Copy size={14} />}
            </button>
          ))}
        <OpenSkill s={s} />
        {!s.plugin && (
          <ConfirmDelete
            name={s.name}
            ask={s.source === 'user' ? 'Удалить во всех проектах?' : 'Удалить из проекта?'}
            title={others.length ? `Скилл удалится и у ${others.join(', ')}` : undefined}
            onConfirm={onRemove}
          />
        )}
      </div>
      {s.description && <p className="skill-desc">{s.description}</p>}
    </li>
  );
}

const installsText = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.0', '')} млн` : n >= 1000 ? `${Math.round(n / 1000)} тыс.` : String(n);

/** Окно «Добавить скиллы»: поиск по каталогу skills.sh и установка через `npx skills` для включённых агентов. */
export function SkillSearchDialog({
  projectPath,
  installed,
  onClose: closeNow,
  onInstalled,
}: {
  projectPath?: string;
  installed: ChatSkill[];
  onClose: () => void;
  onInstalled: (skills: ChatSkill[]) => void;
}) {
  const { closing, close } = useDialogClose(closeNow);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SkillHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<'project' | 'user'>(projectPath ? 'project' : 'user');
  const { state } = useStore();
  const enabled = state.settings?.enabledAgents ?? ['claude', 'codex'];
  const [agents, setAgents] = useState<AgentKind[]>(enabled);
  const toggle = (a: AgentKind) => setAgents((l) => (l.includes(a) ? l.filter((x) => x !== a) : [...l, a]));
  const input = useRef<HTMLInputElement>(null);
  const has = new Set(installed.map((s) => s.name));

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return setHits(null);
    let live = true;
    setSearching(true);
    const t = window.setTimeout(() => {
      bridge.core
        .searchSkills(q)
        .then((r) => live && (setHits(r), setError(null)))
        .catch((e) => live && setError(cleanErr(e)))
        .finally(() => live && setSearching(false));
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query]);

  const install = async (h: SkillHit) => {
    setBusy(h.id);
    setError(null);
    try {
      const skills = await bridge.core.installSkill({
        projectPath: scope === 'project' ? projectPath : undefined,
        source: h.source,
        skill: h.skill,
        agents,
      });
      setDone((d) => [...d, h.id]);
      onInstalled(skills);
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <div className={`qs-scrim ${closing ? 'is-closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="qs skill-search" role="dialog" aria-modal aria-labelledby="skill-search-title">
        <header className="qs-head">
          <div>
            <h2 id="skill-search-title">Добавить скиллы</h2>
            <p>Каталог skills.sh. Скилл ставится через npx skills для выбранных агентов.</p>
          </div>
          <button className="qs-close" aria-label="Закрыть" onClick={() => close()}>
            <X size={16} />
          </button>
        </header>
        <div className="skill-search-bar">
          <Search size={15} />
          <input
            ref={input}
            value={query}
            placeholder="Например: react native, testing, figma"
            aria-label="Поиск скиллов"
            onChange={(e) => setQuery(e.target.value)}
          />
          {searching && <LoaderCircle size={15} className="spin" />}
        </div>
        <div className="skill-search-opts">
          <span className="skill-search-agents" role="group" aria-label="Для агентов">
            <span className="muted">Для агентов</span>
            {enabled.map((a) => (
              <button
                key={a}
                type="button"
                className={`skill-agent-chip ${agents.includes(a) ? 'is-on' : ''}`}
                aria-pressed={agents.includes(a)}
                onClick={() => toggle(a)}
              >
                {agents.includes(a) && <Check size={12} />}
                {a}
              </button>
            ))}
          </span>
          {projectPath && (
            <Select<'project' | 'user'>
              ariaLabel="Куда ставить"
              value={scope}
              minWidth={260}
              onChange={setScope}
              options={[
                { value: 'project', label: 'В этот проект', hint: 'Папки скиллов в проекте — закоммитьте их, чтобы видели прогоны' },
                { value: 'user', label: 'Для всех проектов', hint: 'В ваши папки агентов (~/.claude, ~/.agents…)' },
              ]}
            />
          )}
        </div>
        {error && <p className="inline-error skill-search-error">{error}</p>}
        <ul className="skill-search-list" aria-label="Найденные скиллы">
          {hits?.map((h) => {
            const isDone = done.includes(h.id) || has.has(h.skill);
            return (
              <li key={h.id}>
                <div className="skill-search-text">
                  <code className="skill-name">{h.name}</code>
                  <span className="muted">
                    {h.source} · {installsText(h.installs)} установок
                  </span>
                </div>
                {isDone ? (
                  <span className="skill-search-done">
                    <Check size={14} /> Установлен
                  </span>
                ) : (
                  <Button
                    tone="ghost"
                    icon={<Download size={14} />}
                    busy={busy === h.id}
                    disabled={Boolean(busy) || !agents.length}
                    onClick={() => void install(h)}
                  >
                    Установить
                  </Button>
                )}
              </li>
            );
          })}
          {hits && !hits.length && <li className="muted skill-search-empty">Ничего не нашлось — попробуйте другие слова.</li>}
          {!hits && <li className="muted skill-search-empty">Введите, что нужно агентам: технологию, задачу или сервис.</li>}
        </ul>
        <footer className="qs-foot">
          <span className="grow" />
          <Button tone="primary" onClick={() => close()}>
            Готово
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
