// The extension lifecycle, as a pure model (core-design §4.7, sketch §7b/§7c).
//
//   manifest.ts     — semantic validation on top of `manifestSchema`, reporting
//                     EVERY error, each naming the extension and the bad value.
//   permissions.ts  — review-at-install / grant-once: the pure `permissionDiff`
//                     that decides whether an update re-prompts, and the store
//                     over `KV` that produces the `GrantSet` `authorize` reads.
//   points.ts       — the extension-point primitive, so an extension can be a
//                     platform too. Ships with tests and NO artificial consumer;
//                     its first real one is `agents-core` in M2.
//   registry.ts     — who is installed, what state, when to activate, and the
//                     dependency/permission checks that run before an injected
//                     `activator` is called.
//
// There is no process, no IPC and no electron in here on purpose: the utility-
// process host is a later phase, and everything above can be decided and tested
// without one.
export { parseManifest, isExtensionIdShape, isVersion, isVersionRange, type ManifestError } from './manifest.ts';
export {
  permissionDiff,
  PermissionStore,
  type PermissionDiff,
  type ReviewOutcome,
} from './permissions.ts';
export { PointRegistry, DuplicatePointError, type PointRegistryOptions } from './points.ts';
export {
  ExtensionRegistry,
  shouldActivate,
  type ActivationTrigger,
  type Activator,
  type ExtensionRecord,
  type ExtensionRegistryOptions,
  type ExtensionState,
} from './registry.ts';
