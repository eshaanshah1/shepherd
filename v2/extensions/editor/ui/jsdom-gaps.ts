/**
 * The browser APIs jsdom does not have and this pane's renderers do.
 *
 * Loaded as a setup file for every test in this package. It is a no-op under
 * `node`, and under `jsdom` it fills gaps rather than faking behaviour: each
 * stub is the smallest thing that lets a component MOUNT, so a test can assert
 * about the DOM it produced. Nothing here should ever make an assertion pass —
 * if a test needs one of these to actually do something, it wants a real
 * browser, which is what the Electron preview is for.
 */

/*
 * `ResizeObserver` — `@pierre/diffs`' `CodeView` constructs one during setup, so
 * without it the component throws on mount and every Files-tab test fails with
 * a stack inside the package rather than a message about the test.
 *
 * It never fires. The viewer virtualises off measured sizes, and a callback
 * that invented one would make the rendered output depend on a number this file
 * made up.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}
