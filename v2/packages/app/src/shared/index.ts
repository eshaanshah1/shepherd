export {
  COALESCE,
  EMIT,
  INVOKE,
  emitChannels,
  invokeChannels,
  type Channel,
  type EmitChannel,
  type InvokeChannel,
  type IpcError,
  type IpcResult,
  type LayoutSnapshot,
  type LayoutSnapshots,
  type SessionCreateRequest,
  type SessionDataMessage,
  type SessionDescriptor,
  type SessionExitMessage,
  type SessionResizeMessage,
  type ViewportRect,
  type ControlFrameMessage,
} from './channels.ts';

export {
  BRIDGE_SURFACE,
  FORBIDDEN_GLOBALS,
  type BridgeNamespace,
  type CommandsApi,
  type LayoutApi,
  type SessionApi,
  type ShepherdBridge,
  type WindowApi,
} from './bridge.ts';

// `menu-commands.ts` is deliberately absent: it imports @shepherd/core/layout as
// a value, and this barrel is what the sandboxed preload pulls in.
export { COMMANDS, commandIds, SETTINGS_VISIBILITY_COMMAND, type CommandID } from './commands.ts';
export { CONTROL_COMMANDS, CONTROL_TOPICS } from './control.ts';

export { OutputCoalescer, type CoalescerOptions } from './coalescer.ts';

export type { AgentIndicatorDTO } from './channels.ts';
export type { AgentsApi, ViewContributionDTO, ViewsApi } from './bridge.ts';
export type { SettingsApi, SettingsPageDTO, SettingsSnapshotDTO } from './bridge.ts';
export { THEME_KEY, type ThemeSetting } from './settings-keys.ts';
export { memberOf, qualify, unqualify } from './view-types.ts';
export { HOME_ROOT_ID } from './home-root.ts';
