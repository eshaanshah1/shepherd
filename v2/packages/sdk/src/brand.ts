declare const brand: unique symbol;

/**
 * A nominal string type. `Brand<string, 'SessionID'>` is assignable to `string`
 * but a bare `string` is not assignable to it — which is what stops a pane id
 * from being handed to a session lookup, the correlation bug v1 kept re-finding.
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };
