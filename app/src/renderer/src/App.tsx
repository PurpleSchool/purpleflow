import { useEffect, useState } from 'react';
import { applyTheme } from './lib/theme';
import { Sidebar } from './components/Sidebar';
import { WhatsNewHost } from './components/WhatsNew';
import { useActions, useStore } from './lib/store';
import { NewTaskScreen } from './screens/NewTask';
import { ProjectScreen } from './screens/projects/ProjectScreen';
import { ProjectsScreen } from './screens/projects/ProjectsScreen';
import { HomeScreen } from './screens/Home';
import { RunScreen } from './screens/Run';
import { SettingsScreen } from './screens/settings/SettingsScreen';
import { WelcomeScreen } from './screens/Welcome';
import { ChatScreen } from './screens/Chat';
import { FirstProjectScreen } from './screens/FirstProject';
import { bridge } from './lib/api';
import { ChatWebHost } from './components/ChatWebHost';
import { dropChat, getAllChatWebIds, isRunOwner } from './lib/chatWeb';
import { dropChatTerminals, getAllTermChatIds } from './lib/terminals';

const SIDEBAR_KEY = 'purpleflow.sidebarCollapsed';

export function App() {
  const { state } = useStore();
  const v = state.view;
  // Чат удалили — закрываем вкладки его браузера.
  useEffect(() => {
    const ids = new Set(state.chats.map((c) => c.id));
    for (const id of getAllChatWebIds()) if (!isRunOwner(id) && !ids.has(id)) dropChat(id);
    for (const id of getAllTermChatIds()) if (!ids.has(id)) dropChatTerminals(id);
  }, [state.chats]);
  const viewKey =
    v.name === 'chat'
      ? // Новый чат из разных проектов — разные экраны: иначе проект первого так и останется выбранным.
        `chat:${v.chatId ?? `new:${v.project ?? ''}`}`
      : v.name === 'run'
        ? `run:${v.runId}`
        : v.name === 'project'
          ? `project:${v.path}`
          : v.name === 'new'
            ? `new:${v.project ?? ''}`
            : v.name;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(SIDEBAR_KEY, c ? '0' : '1');
      } catch {
        /* без памяти о панели */
      }
      return !c;
    });
  const { go } = useActions();
  // Тема фона меняется в настройках — окно перекрашивается сразу.
  const theme = state.settings?.windowTheme;
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);
  // Звук внимания (прогон ждёт решения, готов или упал) и переход к прогону по клику на уведомление.
  useEffect(() => {
    const offChime = bridge.onChime(chime);
    const offGo = bridge.onGo((runId) => go({ name: 'run', runId }));
    return () => {
      offChime();
      offGo();
    };
  }, [go]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Экран входа при первом запуске — на всё окно, без боковой панели.
  // Онбординг первого проекта — так же на всё окно: при первом запуске это главный шаг.
  if (v.name === 'welcome' || v.name === 'start') {
    return (
      <div className={`app app-onboard os-${bridge.platform}`}>{v.name === 'welcome' ? <WelcomeScreen /> : <FirstProjectScreen />}</div>
    );
  }

  return (
    <div className={`app os-${bridge.platform} ${collapsed ? 'is-collapsed' : ''}`}>
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      {/* Вкладки браузера чатов: живут здесь, панель «Браузер» только показывает их на своём месте. */}
      <ChatWebHost />
      <main className="main">
        {/* Полоса сверху вместо заголовка окна: за неё окно перетаскивается. */}
        <div className="main-drag drag" aria-hidden />
        <div className="screen-enter" key={viewKey}>
          {v.name === 'new' && (
            <NewTaskScreen
              key={v.draft ? `draft-${v.draft.task.length}` : v.review ? `review-${JSON.stringify(v.review)}` : 'new'}
              initialProject={v.project ?? v.draft?.projectPath}
              draft={v.draft}
              review={v.review}
            />
          )}
          {v.name === 'home' && <HomeScreen />}
          {v.name === 'projects' && <ProjectsScreen />}
          {v.name === 'addProject' && <FirstProjectScreen mode="add" />}
          {v.name === 'project' && <ProjectScreen path={v.path} initialTab={v.tab} />}
          {v.name === 'run' && <RunScreen runId={v.runId} />}
          {v.name === 'settings' && <SettingsScreen />}
          {v.name === 'chat' && <ChatScreen chatId={v.chatId} initialProject={v.project} initialText={v.text} />}
        </div>
      </main>
      <WhatsNewHost />
    </div>
  );
}

/** Короткий мягкий двухтоновый сигнал без звуковых файлов. */
function chime() {
  try {
    const ctx = new AudioContext();
    const now = ctx.currentTime;
    for (const [i, f] of [880, 1318.5].entries()) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = now + i * 0.14;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.55);
    }
    setTimeout(() => void ctx.close(), 1200);
  } catch {
    /* без звука */
  }
}
