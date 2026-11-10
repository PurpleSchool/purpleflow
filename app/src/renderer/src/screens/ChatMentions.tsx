// «@» и «/» в поле ввода чата: список файлов проекта или скиллов над полем, выбор стрелками и Enter.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { FileText, Sparkles } from 'lucide-react';
import type { ChatSkill } from '@purpleflow/core';
import { bridge } from '../lib/api';
import { applyMention, rankFiles, rankSkills, tokenAt } from '../lib/mentions';

interface Item {
  value: string;
  label: string;
  hint?: string;
  badge?: string;
}

const split = (p: string) => {
  const i = p.lastIndexOf('/');
  return i < 0 ? { name: p, dir: '' } : { name: p.slice(i + 1), dir: p.slice(0, i) };
};

/**
 * Подсказки упоминаний. onKeyDown возвращает true, если клавишу забрал список (стрелки, Enter, Tab, Escape);
 * onInput — при вводе текста, onCaret — при перемещении курсора.
 */
export function useMentions(o: {
  text: string;
  setText: (t: string) => void;
  input: RefObject<HTMLTextAreaElement | null>;
  projectPath?: string;
}): {
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onInput: () => void;
  onCaret: () => void;
  menu: ReactNode;
} {
  const { text, setText, input, projectPath } = o;
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Escape закрывает список, пока человек не продолжит печатать или не перейдёт к другому слову.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [files, setFiles] = useState<{ path: string; list: string[] } | null>(null);
  const [skills, setSkills] = useState<ChatSkill[] | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number | null>(null);

  const raw = tokenAt(text, caret);
  const token = raw && raw.start !== dismissed ? raw : null;
  const wantFiles = token?.kind === 'file' && Boolean(projectPath);

  useEffect(() => {
    let alive = true;
    setSkills(null);
    bridge.core
      .listChatSkills(projectPath)
      .then((s) => alive && setSkills(s))
      .catch(() => alive && setSkills([]));
    return () => {
      alive = false;
    };
  }, [projectPath]);

  // Файлы — лениво, при первом «@» в этом проекте.
  useEffect(() => {
    if (!wantFiles || !projectPath || files?.path === projectPath) return;
    let alive = true;
    bridge.core
      .listChatFiles(projectPath)
      .then((list) => alive && setFiles({ path: projectPath, list }))
      .catch(() => alive && setFiles({ path: projectPath, list: [] }));
    return () => {
      alive = false;
    };
  }, [wantFiles, projectPath, files?.path]);

  useEffect(() => setActive(0), [token?.kind, token?.query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  let items: Item[] = [];
  let empty: string | null = null;
  if (token?.kind === 'file') {
    if (!projectPath) empty = token.query ? null : 'Файлы можно упоминать в чате с проектом';
    else if (files?.path !== projectPath) empty = 'Загружаю файлы проекта…';
    else {
      items = rankFiles(files.list, token.query).map((f) => {
        const { name, dir } = split(f);
        return { value: f, label: name, hint: dir };
      });
      if (!items.length && !token.query) empty = 'В проекте нет файлов';
    }
  } else if (token?.kind === 'skill') {
    if (!skills) empty = token.query ? null : 'Загружаю скиллы…';
    else {
      items = rankSkills(skills, token.query).map((s) => ({
        value: s.name,
        label: `/${s.name}`,
        hint: s.description,
        badge: s.source === 'project' ? 'проект' : undefined,
      }));
      if (!items.length && !token.query) empty = 'Скиллов нет. Добавьте их в .claude/skills проекта или в ~/.claude/skills';
    }
  }

  const onCaret = () => {
    const el = input.current;
    if (!el) return;
    setCaret(el.selectionStart ?? 0);
    const t = tokenAt(el.value, el.selectionStart ?? 0);
    if (!t || t.start !== dismissed) setDismissed(null);
  };

  /** Ввод текста снова открывает закрытый список. */
  const onInput = () => {
    setDismissed(null);
    setCaret(input.current?.selectionStart ?? 0);
  };

  const pick = (value: string) => {
    if (!token) return;
    const r = applyMention(text, token, value);
    pendingCaret.current = r.caret;
    setText(r.text);
    setCaret(r.caret);
  };

  // Курсор — сразу после того, как новый текст попал в поле: до следующего нажатия клавиши.
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at == null) return;
    pendingCaret.current = null;
    input.current?.focus();
    input.current?.setSelectionRange(at, at);
  }, [text, input]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!token || e.nativeEvent.isComposing) return false;
    if (e.key === 'Escape' && (items.length || empty)) {
      e.preventDefault();
      setDismissed(token.start);
      return true;
    }
    if (!items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a + d + items.length) % items.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      pick(items[Math.min(active, items.length - 1)].value);
      return true;
    }
    return false;
  };

  const menu =
    token && (items.length || empty) ? (
      <div className="chat-mention" role="listbox" aria-label={token.kind === 'file' ? 'Файлы проекта' : 'Скиллы'} ref={list}>
        {empty && !items.length ? <div className="chat-mention-empty">{empty}</div> : null}
        {items.map((it, i) => (
          <button
            key={it.value}
            type="button"
            role="option"
            data-i={i}
            aria-selected={i === active}
            className={`chat-mention-opt ${i === active ? 'is-active' : ''}`}
            onMouseEnter={() => setActive(i)}
            // Фокус остаётся в поле ввода.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(it.value)}
          >
            {token.kind === 'file' ? <FileText size={14} /> : <Sparkles size={14} />}
            <span className="chat-mention-label">{it.label}</span>
            {it.hint && <span className="chat-mention-hint">{it.hint}</span>}
            {it.badge && <span className="chat-mention-badge">{it.badge}</span>}
          </button>
        ))}
      </div>
    ) : null;

  return { onKeyDown, onInput, onCaret, menu };
}
