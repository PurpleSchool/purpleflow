import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { useStore } from './lib/store';
import { NewTaskScreen } from './screens/NewTask';
import { ProjectScreen, ProjectsScreen } from './screens/Projects';
import { RunScreen } from './screens/Run';
import { SettingsScreen } from './screens/Settings';
import { WelcomeScreen } from './screens/Welcome';
import { ChatScreen } from './screens/Chat';

const SIDEBAR_KEY = 'psflow.sidebarCollapsed';

export function App() {
  const { state } = useStore();
  const v = state.view;
  const viewKey = v.name === 'chat' ? `chat:${v.chatId ?? 'new'}` : v.name === 'run' ? `run:${v.runId}` : v.name === 'project' ? `project:${v.path}` : v.name === 'new' ? `new:${v.project ?? ''}` : v.name;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => setCollapsed((c) => {
    try {
      localStorage.setItem(SIDEBAR_KEY, c ? '0' : '1');
    } catch { /* без памяти о панели */ }
    return !c;
  });
  const { go } = useStore();
  // Звук внимания (прогон ждёт решения, готов или упал) и переход к прогону по клику на уведомление.
  useEffect(() => {
    const offChime = window.psflow.onChime(chime);
    const offGo = window.psflow.onGo((runId) => go({ name: 'run', runId }));
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
  if (v.name === 'welcome') {
    return (
      <div className={`app app-onboard os-${window.psflow.platform}`}>
        <WelcomeScreen />
      </div>
    );
  }

  return (
    <div className={`app os-${window.psflow.platform} ${collapsed ? 'is-collapsed' : ''}`}>
      <Sidebar collapsed={collapsed} onToggle={toggle} />
      <main className="main">
        {/* Полоса сверху вместо заголовка окна: за неё окно перетаскивается. */}
        <div className="main-drag drag" aria-hidden />
        <div className="screen-enter" key={viewKey}>
          {v.name === 'new' && <NewTaskScreen key={v.draft ? `draft-${v.draft.task.length}` : 'new'} initialProject={v.project} draft={v.draft} />}
          {v.name === 'projects' && <ProjectsScreen />}
          {v.name === 'project' && <ProjectScreen path={v.path} initialTab={v.tab} />}
          {v.name === 'run' && <RunScreen runId={v.runId} />}
          {v.name === 'settings' && <SettingsScreen />}
          {v.name === 'chat' && <ChatScreen chatId={v.chatId} initialProject={v.project} />}
        </div>
      </main>
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
  } catch { /* без звука */ }
}
