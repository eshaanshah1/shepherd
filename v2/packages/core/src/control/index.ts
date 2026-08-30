// The control plane, once. Commands and subscriptions, with `control.sock` and
// the app's renderer as two adapters over the same surface — because a protocol
// with exactly one in-process consumer is a protocol nobody has tested.
export {
  MAX_NUDGE_KEYS,
  SubscriptionState,
  type Delivery,
  type ControlFrame,
  type SnapshotResult,
  type SubscriptionSpec,
} from './subscription.ts';
export { TopicRegistry, type TopicDeclaration, type TopicSummary } from './topics.ts';
export { ControlSurface, type ControlSurfaceOptions, type Subscription } from './surface.ts';
