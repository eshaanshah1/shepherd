/**
 * The extension-point primitive now lives in `@shepherd/sdk` (`points.ts`), and
 * this file is the re-export that keeps core's public surface unchanged.
 *
 * It moved because a point hands back a live object holding provider
 * *functions*, which cannot cross a message port — so the registry has to run in
 * the process the extensions run in, which is the extension host's utility
 * process. `boundaries.js` denies `@shepherd/core` there (a core import in that
 * process would be a second, empty kernel), and the primitive is pure and had no
 * consumer inside core, so the SDK is where it belongs — which is also where
 * core-design §4.7 put it in the first place.
 */
export { PointRegistry, DuplicatePointError, type PointRegistryOptions } from '@shepherd/sdk';
