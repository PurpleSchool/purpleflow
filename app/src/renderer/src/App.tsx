import { AppBar } from './components/Sidebar';
import { useStore } from './lib/store';
import { HistoryScreen } from './screens/History';
import { NewTaskScreen } from './screens/NewTask';
import { RunScreen } from './screens/Run';
import { SettingsScreen } from './screens/Settings';

export function App() {
  const { state } = useStore();
  const v = state.view;
  return (
    <div className={`app os-${window.psflow.platform}`}>
      <AppBar />
      <main className="main">
        {v.name === 'new' && <NewTaskScreen />}
        {v.name === 'run' && <RunScreen runId={v.runId} />}
        {v.name === 'history' && <HistoryScreen />}
        {v.name === 'settings' && <SettingsScreen />}
      </main>
    </div>
  );
}
