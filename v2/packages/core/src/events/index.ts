// The event half of the kernel. `EventBus.emit` takes an explicit `Caller` where
// the SDK's `EventAPI.emit` does not: the extension host binds each extension's
// own identity as it hands the API out, so an extension cannot emit as somebody
// else.
export { EventBus, type EventBusOptions } from './bus.ts';
