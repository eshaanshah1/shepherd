// One attention channel, aggregated (core-design §4.5).
//
//   viewing.ts   — ADR 0020's single "is the user looking at this pane" predicate,
//                  for THIS window.
//   viewers.ts   — the same predicate aggregated over every client (ADR 0052):
//                  the SET of principals viewing a session. Not a second answer
//                  — the same one, with the client named.
//   routing.ts   — the PURE banner/chime/push/badge decision, ported from v1's
//                  NotificationRoutingPolicy. `viewing` is threaded in, never
//                  re-derived.
//   store.ts     — set/clear/get, the dock-badge count, the folder dot, the ⌘⇧A
//                  ring, and `decide()` which composes the two above so the
//                  viewing value is computed exactly once.
//   commands.ts  — `attention.set` / `attention.clear`, both behind the
//                  `attention` permission.
export { ViewingResolver, type Presence } from './viewing.ts';
export { ViewerRegistry } from './viewers.ts';
export { route, wantsAttention, type RoutingDecision, type RoutingInput } from './routing.ts';
export {
  AttentionStore,
  ATTENTION_TOPIC,
  attentionTarget,
  type AttentionChanged,
  type AttentionStoreOptions,
  type AttentionTarget,
  type DecideOptions,
} from './store.ts';
export {
  ATTENTION_COMMANDS,
  registerAttentionCommands,
  type AttentionCommandsOptions,
} from './commands.ts';
