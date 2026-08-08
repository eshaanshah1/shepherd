import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * electron-vite's defaults already name every path this app uses
 * (`src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`), so
 * the config is the five things that are NOT default:
 *
 *   - **The extension host is a fourth build target.**
 *     `utilityProcess.fork` needs built JS and electron-vite's config accepts
 *     exactly three keys — `main`, `preload`, `renderer` — so the fourth target
 *     is expressed as a second `rollupOptions.input` on the main build. Naming
 *     `input` at all takes this build out of electron-vite's lib mode, which is
 *     why the entry keys are spelled out: `index` must keep landing at
 *     `out/main/index.js`, because `package.json`'s `main` field names that path
 *     literally and Electron's app loader reads it as written. The child lands
 *     beside it at `out/main/ext-host.js`, which is what
 *     `ext-host-process.ts`'s `EXT_HOST_ENTRY` resolves against.
 *
 *   - **No `externalizeDepsPlugin`.** The templates ship it, and here it would
 *     be wrong: it externalizes everything in `dependencies`, which includes
 *     the workspace packages — and those resolve to TypeScript *sources*, which
 *     Electron cannot load. They must be bundled. `node-pty` is the one thing
 *     that genuinely has to stay external (a native .node cannot be bundled).
 *   - **Fast Refresh, on the 4.x line.** The note here used to say the plugin
 *     was out because its current major peers on vite 8 while electron-vite 5
 *     caps at 7 — true of `@vitejs/plugin-react@6`, and it made a save RELOAD
 *     the page. That is no longer a cosmetic cost: a reload rebuilds every
 *     terminal in the window, so editing a stylesheet kills the agents you were
 *     looking at. `@vitejs/plugin-react@4.7` peers on `^7.0.0`, which is where
 *     this workspace is, so Fast Refresh patches components in place and the
 *     ptys survive.
 *   - **`__SHEPHERD_IS_DEV__` substituted into the main bundle.** Which build
 *     this is decides which userData directory it owns, and therefore which
 *     single-instance lock it takes. A runtime read (`process.env`, argv,
 *     `app.isPackaged`) is a switch anybody can flip into the production
 *     directory; a textual substitution is not. `pnpm smoke:isolation` asserts
 *     both halves — the path each build prints, and that the identifier does
 *     not survive into the bundle.
 *   - **A CommonJS preload.** `sandbox: true` in `window-options.ts` means the
 *     renderer process is sandboxed, and a sandboxed preload is not an ES
 *     module — Electron loads it through a `require` shim. So this one output
 *     is `.cjs` while the package stays `"type": "module"`. The preload's whole
 *     import list is `contextBridge` + `ipcRenderer`, both of which that shim
 *     provides.
 */
export default defineConfig(({ mode }) => {
  // `electron-vite dev` runs in development; `electron-vite build` defaults to
  // production and takes `--mode development` for a dev-flavoured build.
  const isDev = mode !== 'production';

  return {
    main: {
      define: {
        __SHEPHERD_IS_DEV__: JSON.stringify(isDev),
      },
      build: {
        rollupOptions: {
          external: ['node-pty'],
          input: {
            index: 'src/main/index.ts',
            'ext-host': 'src/ext-host/index.ts',
          },
        },
      },
    },
    preload: {
      build: {
        rollupOptions: {
          output: {
            format: 'cjs',
            entryFileNames: 'index.cjs',
          },
        },
      },
    },
    renderer: {
      plugins: [react()],
    },
  };
});
