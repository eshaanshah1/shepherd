import { defineConfig } from 'electron-vite';

/**
 * electron-vite's defaults already name every path this app uses
 * (`src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`), so
 * the config is mostly the two things that are NOT default:
 *
 *   - **No `externalizeDepsPlugin`.** The templates ship it, and here it would
 *     be wrong: it externalizes everything in `dependencies`, which includes
 *     the workspace packages — and those resolve to TypeScript *sources*, which
 *     Electron cannot load. They must be bundled. `node-pty` is the one thing
 *     that genuinely has to stay external (a native .node cannot be bundled);
 *     it is listed even though main does not import it yet, because the day it
 *     does is not the day to rediscover this.
 *   - **JSX with no plugin.** `@vitejs/plugin-react`'s current major peers on
 *     vite 8 and electron-vite 5 peers on vite ≤7, so the plugin is out until
 *     that clears. Vite's own esbuild transform reads `jsx: react-jsx` from
 *     tsconfig, so the only thing missing is Fast Refresh: a save reloads the
 *     page instead of patching it. In M0 the renderer holds no state worth
 *     preserving across a reload.
 */
export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ['node-pty'],
      },
    },
  },
  preload: {},
  renderer: {},
});
