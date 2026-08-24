import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

/**
 * Rewrite `./x.ts` → `./x.js` in the emitted files.
 *
 * This codebase writes explicit extensions in its imports (`from
 * './palette.ts'`), which is what `nodenext` resolution wants from TypeScript
 * source. esbuild with `bundle: false` is a transpiler and leaves an import
 * specifier exactly as written, so the emitted JS asks for a `.ts` file that is
 * not there and the app dies with ERR_MODULE_NOT_FOUND naming
 * `dist/palette.ts`. Measured — this is the second failure of this shape, and
 * the first (types under node_modules) is what the file above is about.
 *
 * A post-pass over the output rather than an esbuild plugin: `bundle: false`
 * does not run resolution at all, so there is no hook to attach to.
 */
async function rewriteExtensions(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await rewriteExtensions(full);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    const source = await readFile(full, 'utf8');
    /**
     * Any quoted RELATIVE specifier ending in `.ts`/`.tsx`, wherever it appears.
     *
     * Matching on the QUOTES rather than on the keyword before them, because
     * the first version anchored on `from"` and missed every multi-line import
     * — esbuild wraps a long named-import list, so the specifier lands on its
     * own line and `from` is nowhere near it. That left `./pane.ts` in
     * `@shepherd/core` and the next build could not resolve it.
     *
     * A bare `@shepherd/core` is untouched: it names a package and resolves
     * through that package's own exports map, which already points at `.js`.
     */
    const rewritten = source.replace(
      /(['"])(\.[^'"]*?)\.tsx?\1/g,
      (_match, quote, path) => `${quote}${path}.js${quote}`,
    );
    if (rewritten !== source) await writeFile(full, rewritten);
  }
}

/**
 * Make the workspace packages loadable by a packaged app.
 *
 * Every `@shepherd/*` package points its `exports` at TypeScript **source**.
 * That is right for development — Vite transforms those files on the way past,
 * and it is what lets `packages/*` be typechecked and lint-bounded as real
 * packages rather than as build output. It is impossible once packaged: Node
 * refuses to strip types under `node_modules`, so the app dies on launch with
 *
 *   ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
 *   … app.asar/node_modules/@shepherd/design-tokens/src/index.ts
 *
 * and nothing before launch says so, because `pnpm dev` never takes this path.
 *
 * **Why a beforePack hook and not a bundler setting.** The obvious answer is to
 * inline these packages into the main bundle, and four ways of asking for that
 * did nothing: electron-vite already sets `ssr.noExternal = true` itself,
 * `resolve.noExternal` is ignored on this build, a rollup `external` predicate
 * is merged with electron-vite's own and loses, and a `resolveId` plugin under
 * `main.plugins` is never called (probed: zero invocations). The imports are
 * emitted either way. So the honest layer is the one that decides what lands in
 * app.asar — this hook — rather than a fifth attempt at a config key.
 *
 * What it does, per package: compile every export subpath to ESM with esbuild
 * (bundling nothing — each package keeps importing its siblings by name, so one
 * copy of each ships and the graph is unchanged), write a package.json whose
 * `exports` name the emitted `.js`, and stage the result. electron-builder then
 * copies the staged directory in place of the linked source.
 *
 * Deliberately NOT compiled: `.d.ts`. Types are a build-time concern and a
 * packaged app never reads them; emitting them would double the work and ship a
 * megabyte of declarations to no reader.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

/** Where the compiled copies are staged. Removed and rebuilt on every pack. */
const STAGE = join(root, 'packages/app/.workspace-dist');

/**
 * Every workspace package the app can reach at runtime.
 *
 * Listed rather than globbed: a package that appears here ships, and that is a
 * decision worth being explicit about — `@shepherd/ui` is in because an
 * extension's `ui/` half imports it, and a future package that only tests
 * something must not be swept in by a wildcard.
 *
 * A list is only as good as the check on it, and this one was wrong twice at
 * once: `worktree-hook` and `remote` were both imported by the main bundle and
 * both absent here, which the app reported as
 * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING at launch and nothing before
 * launch reported at all. `assertEveryImportStaged` below closes that gap.
 */
const PACKAGES = [
  'packages/sdk',
  'packages/core',
  'packages/design-tokens',
  'packages/platform/darwin',
  'packages/ui',
  'packages/remote',
  'extensions/diagnostics',
  'extensions/scratch',
  'extensions/agents-core',
  'extensions/claude-code',
  'extensions/tasks',
  'extensions/shell',
  'extensions/worktree-hook',
  'extensions/github',
  'extensions/transcripts',
];

/** `./src/index.ts` → `./dist/index.js`, and the entry that produces it. */
function outputFor(entry) {
  const withoutSrc = entry.replace(/^\.\/src\//, '').replace(/^\.\//, '');
  return `./dist/${withoutSrc.replace(/\.tsx?$/, '.js')}`;
}

/**
 * Rewrite one package's `exports` map, collecting the entries to compile.
 *
 * Handles both shapes in this repo: `"./x": "./src/x.css"` (a string) and
 * `"./x": { types, default }` (conditions). A non-TypeScript target — the CSS
 * one — is copied rather than compiled and keeps its path, since a stylesheet
 * is already what it needs to be.
 */
function rewriteExports(exportsMap, entries, assets) {
  const out = {};
  for (const [subpath, value] of Object.entries(exportsMap)) {
    if (typeof value === 'string') {
      if (value.endsWith('.ts') || value.endsWith('.tsx')) {
        entries.add(value);
        out[subpath] = outputFor(value);
      } else {
        assets.add(value);
        out[subpath] = value;
      }
      continue;
    }
    const target = value.default ?? value.types;
    if (typeof target !== 'string') continue;
    if (target.endsWith('.ts') || target.endsWith('.tsx')) {
      entries.add(target);
      // `types` is dropped: a packaged app has no typechecker, and pointing at
      // a `.d.ts` we did not emit would be a promise the directory cannot keep.
      out[subpath] = { default: outputFor(target) };
    } else {
      assets.add(target);
      out[subpath] = { default: target };
    }
  }
  return out;
}

/** Every `.ts`/`.tsx` under a directory, excluding tests. */
async function collectSources(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectSources(full)));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    found.push(full);
  }
  return found;
}

async function stagePackage(relDir) {
  const dir = join(root, relDir);
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const entries = new Set();
  const assets = new Set();
  const exportsMap = rewriteExports(manifest.exports ?? {}, entries, assets);

  const staged = join(STAGE, manifest.name);
  await mkdir(staged, { recursive: true });

  if (entries.size > 0) {
    /**
     * Every source file, not just the export entries.
     *
     * `bundle: false` is a transpiler: it emits exactly the files it is given
     * and follows no imports. Handing it the entries alone therefore emitted
     * `index.js` importing `./palette.js` that nothing had produced — an
     * internal module is not an entry, and the app died naming it. So the
     * entry list is the package's whole `src` tree, minus tests, which a
     * shipped app never runs and which would drag `vitest` in with them.
     */
    const sources = await collectSources(join(dir, 'src'));
    await build({
      entryPoints: sources,
      outdir: join(staged, 'dist'),
      outbase: join(dir, 'src'),
      format: 'esm',
      platform: 'node',
      target: 'node22',
      // **Nothing is bundled.** Each package keeps importing its siblings by
      // name, so `@shepherd/core` still resolves to the one staged copy rather
      // than being inlined into three of them — the dependency graph the
      // boundaries file describes survives into the shipped app.
      bundle: false,
      sourcemap: false,
      logLevel: 'warning',
    });
  }

  if (entries.size > 0) await rewriteExtensions(join(staged, 'dist'));

  for (const asset of assets) {
    const from = join(dir, asset);
    if (!existsSync(from)) continue;
    const to = join(staged, asset);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to);
  }

  // The `ui` package's stylesheet imports its per-component CSS by relative
  // path, so the whole directory has to travel, not just the entry file.
  const cssDir = join(dir, 'src');
  if (assets.size > 0 && existsSync(cssDir)) {
    for (const name of await readdir(cssDir)) {
      if (!name.endsWith('.css')) continue;
      await cp(join(cssDir, name), join(staged, 'src', name));
    }
  }

  await writeFile(
    join(staged, 'package.json'),
    `${JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        type: 'module',
        // `main` as well as `exports`: Electron's own loader reads it, and a
        // package with neither is one Node cannot resolve at all.
        ...(exportsMap['.'] === undefined
          ? {}
          : { main: typeof exportsMap['.'] === 'string' ? exportsMap['.'] : exportsMap['.'].default }),
        exports: exportsMap,
        // Kept: `tasks` reads its own `shepherd` key, and a manifest that
        // arrived without it would fail validation at activation.
        ...(manifest.shepherd === undefined ? {} : { shepherd: manifest.shepherd }),
        ...(manifest.dependencies === undefined ? {} : { dependencies: manifest.dependencies }),
      },
      null,
      2,
    )}\n`,
  );

  return { name: manifest.name, entries: entries.size, assets: assets.size };
}

/**
 * Put the pnpm links back.
 *
 * Registered as an `exit` handler rather than left to the `pnpm package`
 * script, because a failed or interrupted pack must not leave the workspace
 * broken: the compiled copies resolve for the app and NOT for the test suite,
 * whose first symptom is `Cannot find package '@radix-ui/react-slot' imported
 * from …/@shepherd/ui/dist/button.js` in three renderer files that nobody
 * touched. Measured, one commit too late.
 *
 * `execFileSync` at exit, because the process is on its way out and there is
 * no await left to give.
 */
function restoreLinksOnExit() {
  let done = false;
  const restore = () => {
    if (done) return;
    done = true;
    try {
      execFileSync('pnpm', ['install', '--silent'], { cwd: root, stdio: 'ignore' });
    } catch {
      process.stderr.write(
        '  ⚠ could not restore the workspace links — run `pnpm install` before the next build\n',
      );
    }
  };
  process.on('exit', restore);
  process.on('SIGINT', restore);
}

/**
 * Fail the pack if the built bundles import a workspace package this file did
 * not stage.
 *
 * The list above is hand-written on purpose, so the thing that keeps it honest
 * has to be a check rather than a convention. The bundles are the authority:
 * electron-vite leaves every `@shepherd/*` specifier external, so whatever
 * `out/main/*.js` imports is exactly what the app will ask `node_modules` for
 * at launch — and anything not staged is still TypeScript when it gets there.
 *
 * Reading the emitted JS rather than the source tree, because it is the only
 * place the real answer exists: an import that the bundler dropped does not
 * need staging, and one that arrives through a re-export does.
 */
async function assertEveryImportStaged(outDir, stagedNames) {
  if (!existsSync(outDir)) return;
  const wanted = new Set();
  for (const entry of await readdir(outDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const source = await readFile(join(outDir, entry.name), 'utf8');
    for (const [, spec] of source.matchAll(/from\s*["'](@shepherd\/[^"']+)["']/g)) {
      // `@shepherd/core/layout` is the `core` package; the subpath is its own
      // concern and its exports map already names the staged `.js`.
      const [scope, name] = spec.split('/');
      wanted.add(`${scope}/${name}`);
    }
  }
  const missing = [...wanted].filter((name) => !stagedNames.has(name));
  if (missing.length > 0) {
    throw new Error(
      `before-pack: the app imports ${missing.join(', ')} but PACKAGES does not stage ` +
        `${missing.length === 1 ? 'it' : 'them'} — the packaged app would die on launch with ` +
        'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. Add the package directory to PACKAGES.',
    );
  }
}

/**
 * electron-builder's hook. It runs after the app is built and before the files
 * are copied, which is exactly the window in which app.asar's contents can
 * still be decided.
 */
export default async function beforePack(context) {
  restoreLinksOnExit();
  await rm(STAGE, { recursive: true, force: true });
  const staged = [];
  for (const dir of PACKAGES) staged.push(await stagePackage(dir));

  /**
   * The daemon bundle ships beside main, and nothing at runtime can do without
   * it: no `out/daemon/main.js` means every session fails to start and the app
   * shows a terminal pane that prints nothing at all. It is built by a separate
   * script that `electron-vite build` (which empties `out/`) does not run, so
   * the one thing standing between a working app and a silent one is the order
   * of two commands in a package script. Check it here rather than trust it.
   */
  const daemon = join(root, 'packages/app/out/daemon/main.js');
  if (!existsSync(daemon)) {
    throw new Error(
      `before-pack: no daemon bundle at ${relative(root, daemon)} — the packaged app would start ` +
        'no sessions. Run tooling/scripts/build-daemon.mjs after `electron-vite build`.',
    );
  }

  /**
   * The icon, for the same reason: electron-builder does not fail on a missing
   * one, it substitutes Electron's default and says so in a single line of an
   * otherwise successful build. The app then ships looking like a generic
   * Electron app, which is how this was noticed — by looking at the Dock.
   */
  const icon = join(root, 'packages/app/build/icon.icns');
  if (!existsSync(icon)) {
    throw new Error(
      `before-pack: no app icon at ${relative(root, icon)} — the build would silently use ` +
        "Electron's default. Regenerate with tooling/scripts/make-icons.sh.",
    );
  }

  // Before the destructive swap below, so a missing package fails the pack with
  // the workspace still intact.
  await assertEveryImportStaged(
    join(root, 'packages/app/out/main'),
    new Set(staged.map(({ name }) => name)),
  );

  /**
   * Swap the pnpm links for the compiled copies.
   *
   * This is destructive to `packages/app/node_modules/@shepherd/*` and it has
   * to be: electron-builder follows a symlink to the source tree, which is the
   * `.ts` this file exists to keep out of app.asar. `pnpm package` runs
   * `pnpm install` afterwards to put the links back — without it the NEXT
   * renderer build resolves these compiled copies instead of source and fails
   * on a file the stage does not contain.
   */
  const appDir = join(root, 'packages/app');
  for (const { name } of staged) {
    const target = join(appDir, 'node_modules', name);
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    // A real copy, not a link: electron-builder follows a symlink to the source
    // tree, which is the `.ts` this whole file exists to keep out.
    await cp(join(STAGE, name), target, { recursive: true });
  }

  const total = staged.reduce((sum, entry) => sum + entry.entries, 0);
  process.stdout.write(
    `  • staged ${staged.length} workspace packages as JS  entries=${total} out=${relative(root, STAGE)}\n`,
  );
  return context;
}
