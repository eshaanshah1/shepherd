// The two external front doors, both HTTP over a unix socket — framing, acks,
// request timeouts and body caps for free, and `curl --unix-socket` can drive
// either one by hand.
//
// Neither owns a verb: `events.sock` publishes onto the bus, `control.sock`
// forwards to the command registry. Adding a command touches neither file.
export { EventsIngress, EVENTS_ROUTE, type EventsIngressOptions } from './events-ingress.ts';
export {
  ControlIngress,
  COMMANDS_ROUTE,
  INVOKE_ROUTE,
  SUBSCRIBE_ROUTE,
  type ControlIngressOptions,
} from './control-ingress.ts';
export {
  UnixHttpServer,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type Route,
  type RouteRequest,
  type RouteResponse,
  type UnixHttpServerOptions,
} from './unix-http.ts';
export { reclaimSocketPath, type ReclaimOutcome } from './socket-path.ts';
