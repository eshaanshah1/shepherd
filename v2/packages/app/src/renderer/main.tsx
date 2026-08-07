import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ShepherdBridge } from '../shared/index.ts';
import { App, placeholderSnapshot } from './app.tsx';
import { PaneSessionRegistry } from './pane-sessions.ts';
import { defaultSessionSpec, smokeSessionSpec } from './session-spec.ts';
import { installSmokeHook } from './smoke-hook.ts';
import { applyThemeVariables } from './theme.ts';
import { createXtermTerminal } from './xterm-terminal.ts';
import './styles.css';

/**
 * The composition root: the only file that knows the bridge is a global, that a
 * terminal is xterm, and that `?smoke=1` means the terminal smoke is driving.
 *
 * Everything below it takes what it needs as a parameter, which is why the
 * lifecycle claims can be tested with a spy registry and a fake terminal in
 * jsdom, where xterm cannot measure a character cell.
 */

const host = document.getElementById('root');
if (host === null) throw new Error('renderer: #root is missing from index.html');

const params = new URLSearchParams(globalThis.location.search);
const isSmoke = params.get('smoke') === '1';

const bridge = (globalThis as { shepherd?: ShepherdBridge }).shepherd ?? null;

const terminals =
  bridge === null
    ? null
    : new PaneSessionRegistry({
        session: bridge.session,
        createTerminal: () => createXtermTerminal('dark'),
        spec: isSmoke ? smokeSessionSpec : defaultSessionSpec,
        onError: (error, context) => {
          // Rule carried from v1: every branch that ends in "and then nothing
          // happens" says why. A pane that silently never starts is the exact
          // failure that costs a day.
          console.error(`[shepherd] ${context}:`, error);
        },
      });

const smoke = isSmoke ? installSmokeHook(terminals) : null;

// Tokens before the first paint: a stylesheet that reads `--sh-ink-deep` before
// anything sets it renders the app on transparent, which on macOS is white.
applyThemeVariables(document.documentElement, 'dark');

createRoot(host).render(
  <StrictMode>
    <App
      terminals={terminals}
      layout={bridge?.layout ?? null}
      commands={bridge?.commands ?? null}
      // With no bridge there is no main process to project a tree, so the page
      // draws one placeholder pane rather than nothing at all — which is what
      // `pnpm --filter @shepherd/app dev`-without-electron shows you.
      {...(bridge === null ? { initialSnapshot: placeholderSnapshot() } : {})}
      {...(smoke === null ? {} : { onSnapshot: smoke.onSnapshot })}
    />
  </StrictMode>,
);
