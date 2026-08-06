import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { applyThemeVariables } from './theme.ts';
import './styles.css';

const host = document.getElementById('root');
if (host === null) throw new Error('renderer: #root is missing from index.html');

// Tokens before the first paint: a stylesheet that reads `--sh-ink-deep` before
// anything sets it renders the app on transparent, which on macOS is white.
applyThemeVariables(document.documentElement, 'dark');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
