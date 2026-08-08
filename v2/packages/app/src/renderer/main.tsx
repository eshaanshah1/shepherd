import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ShepherdBridge } from '../shared/index.ts';
import { App, placeholderSnapshots } from './app.tsx';
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

/**
 * `react-grab` — dev-only, and named in the sketch (§6) as one of the two
 * reasons the renderer is React at all.
 *
 * It turns an element on screen into its component source, which is exactly the
 * loop v1 lived without: P6's empty dock cost a screenshot, a log line and a
 * guess before the log said `ctx.clock.setInterval is not a function`. An agent
 * that can ask "what component is this" answers that in one step.
 *
 * **Excluded from production**, and by a build-time constant rather than a
 * runtime check: `import.meta.env.DEV` is statically false in the production
 * bundle, so the dynamic import below is dropped entirely rather than shipped
 * and skipped. Dev/prod isolation applies to tooling too (§6).
 *
 * Failure to load is a LOG, never a throw. A missing devtool must not be able to
 * stop the app from starting — that would make the tooling load-bearing, which
 * is precisely what it is not.
 */
declare global {
  /**
   * Vite's build-time flag, declared here rather than by adding `vite/client` to
   * the package's `types`. Main, preload and renderer compile as ONE project
   * (see the tsconfig's own note), so that would put Vite's globals in the main
   * process — which does not have them — to type one line in the renderer.
   */
  interface ImportMeta {
    readonly env?: { readonly DEV?: boolean };
  }
}

if (import.meta.env?.DEV === true) {
  void import('react-grab').catch((error: unknown) => {
    console.warn('[shepherd] react-grab did not load; continuing without it:', error);
  });
}

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
      agents={bridge?.agents ?? null}
      views={bridge?.views ?? null}
      // With no bridge there is no main process to project a tree, so the page
      // draws one placeholder pane rather than nothing at all — which is what
      // `pnpm --filter @shepherd/app dev`-without-electron shows you.
      {...(bridge === null ? { initialSnapshot: placeholderSnapshots() } : {})}
      {...(smoke === null ? {} : { onSnapshot: smoke.onSnapshot })}
    />
  </StrictMode>,
);
