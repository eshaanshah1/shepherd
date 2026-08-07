/**
 * Which build this is — decided when the bundle is written, not when it runs.
 *
 * `__SHEPHERD_IS_DEV__` is substituted textually by electron-vite's `define`
 * (see `electron.vite.config.ts`), so `out/main/index.js` contains the literal
 * `true` or `false` and the identifier appears nowhere in it. That is the whole
 * point: a runtime read — `process.env.SHEPHERD_DEV`, an argv flag,
 * `app.isPackaged` — is a switch anybody can flip, and the thing it switches is
 * which userData directory this app owns. A dev build that can be talked into
 * the production directory shares the production single-instance lock, which is
 * exactly the collision the redirect exists to prevent.
 *
 * `pnpm smoke:isolation` builds twice and asserts both halves: the printed
 * path, and that the identifier is gone from the bundle.
 *
 * It is a `declare const` (erased by the compiler, never emitted) so nothing
 * here can accidentally provide a default. An unsubstituted build fails loudly
 * at startup with a ReferenceError rather than quietly picking a directory.
 */
declare const __SHEPHERD_IS_DEV__: boolean;

export const IS_DEV: boolean = __SHEPHERD_IS_DEV__;
