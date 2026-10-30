import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@xterm/xterm/css/xterm.css';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App';
import { StoreProvider } from './lib/store';

// До переименования ключи окна в localStorage начинались с psflow. — переносим один раз.
try {
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('psflow.')) continue;
    const next = 'purpleflow.' + key.slice('psflow.'.length);
    if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key)!);
    localStorage.removeItem(key);
  }
} catch {
  /* хранилище недоступно — настройки окна просто начнутся с нуля */
}

// Нативное стекло окна: CSS убирает непрозрачный фон и кладёт тонировку поверх обоев.
document.documentElement.dataset.material = window.purpleflow.material;
window.purpleflow.onMaterial((m) => (document.documentElement.dataset.material = m));

createRoot(document.getElementById('root')!).render(
  <StoreProvider>
    <App />
  </StoreProvider>,
);
