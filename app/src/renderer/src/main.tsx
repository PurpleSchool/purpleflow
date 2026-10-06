import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@xterm/xterm/css/xterm.css';
import './styles/tokens.css';
import './styles/app.css';
import { App } from './App';
import { StoreProvider } from './lib/store';

createRoot(document.getElementById('root')!).render(
  <StoreProvider>
    <App />
  </StoreProvider>,
);
