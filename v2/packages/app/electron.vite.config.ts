import { defineConfig } from 'electron-vite';

/**
 * electron-vite's defaults already name every path this app uses
 * (`src/main/index.ts`, `src/preload/index.ts`, `src/renderer/index.html`), so
 * the config is the four things that are NOT default:
 *
 *   - **No `externalizeDepsPlugin`.** The templates ship it, and here it would
 *     be wrong: it externalizes everything in `dependencies`, which includes
 *     the workspace packages — and those resolve to TypeScript *sources*, which
 *     Electron cannot load. They must be bundled. `node-pty` is the one thing
 *     that genuinely has to stay external (a native .node cannot be bundled).
 *   - **JSX with no plugin.** `@vitejs/plugin-react`'s current major peers on
 *     vite 8 and electron-vite 5 peers on vite ≤7, so the plugin is out until
 *     that clears. Vite's own esbuild transform reads `jsx: react-jsx` from
 *     tsconfig, so the only thing missing is Fast Refresh: a save reloads the
 *     page instead of patching it. In M0 the renderer holds no state worth
 *     preserving across a reload.
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
    renderer: {},
  };
});
