// The command half of the kernel: the pure authorization decision and the one
// registry every transport dispatches into.
export { authorize, emptyGrants, type GrantSet, type Verdict } from './authorize.ts';
export { CommandRegistry, DuplicateCommandError, type CommandRegistryOptions } from './registry.ts';
