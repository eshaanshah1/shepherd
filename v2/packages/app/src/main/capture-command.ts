import { writeFile } from 'node:fs/promises';
import { s, type Clock, type Disposable } from '@shepherd/sdk';
import type { CommandRegistry } from '@shepherd/core';

/**
 * `window.capture` — the app photographing itself, as a command.
 *
 * `SHEPHERD_CAPTURE=… pnpm dev` (see `index.ts`) already writes one PNG, but it
 * fires once, at load, before anything has been driven. This is the same
 * `webContents.capturePage()` reachable from the control socket at any moment,
 * so a reviewer who cannot look at the screen can drive the app and then ask it
 * what it looks like:
 *
 *     shepherd raw window.capture --path /tmp/x.png
 *
 * It asks the app for its own pixels rather than shelling out to macOS
 * `screencapture -l <id>`, which needs Screen Recording permission an automated
 * session does not have — and whose failure ("could not create image from
 * window") is indistinguishable from the app never having drawn.
 *
 * **Permission: `layout`.** Not "no permission": a command with no permission
 * field is one any caller may invoke, and what comes back here is the contents
 * of the user's screen — every pane's scrollback, whatever the terminal is
 * showing. `layout` is the grant that already means "this caller may open and
 * arrange windows on your screen", so reading what is on one belongs to it
 * rather than to a new permission with one member. It stays registered in every
 * build, because the grant is the gate: a dev-only command would be one the
 * shipped app's own smokes could not use.
 */

export interface CaptureImage {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface CaptureCommandOptions {
  readonly registry: CommandRegistry;
  /**
   * The window's own pixels, or `null` when there is no window to photograph.
   *
   * Injected rather than taking a `BrowserWindow`, for two reasons that happen
   * to agree: the window does not exist when this is registered (commands are in
   * place before the sockets open, which is before `createWindow`), and a
   * closure makes every decision in this file assertable without Electron.
   */
  readonly capture: () => Promise<CaptureImage | null>;
  /** Where an unnamed capture lands. The app's own support dir. */
  readonly supportDir: string;
  readonly clock: Clock;
  /** Injected so a test asserts the path AND the bytes without touching disk. */
  readonly write?: (path: string, png: Uint8Array) => Promise<void>;
}

/**
 * Where the PNG goes: what the caller asked for, else a timestamped file.
 *
 * Timestamped rather than fixed, because the interesting use is several
 * captures across one session and a fixed name would leave only the last. The
 * stamp has its colons replaced — an ISO string is not a filename on every
 * filesystem, and a path that silently fails to be creatable is the worst of the
 * available answers.
 */
export function capturePath(input: { path?: string; supportDir: string; at: number }): string {
  if (input.path !== undefined && input.path !== '') return input.path;
  const stamp = new Date(input.at).toISOString().replace(/[:.]/g, '-');
  return `${input.supportDir}/capture-${stamp}.png`;
}

export function registerCaptureCommand(options: CaptureCommandOptions): Disposable {
  const { registry, capture, supportDir, clock } = options;
  const write = options.write ?? ((path, png) => writeFile(path, png));

  return registry.register('window.capture', {
    title: 'Capture the Window',
    permission: 'layout',
    schema: s.object({ path: s.optional(s.string()) }),
    handler: async (args) => {
      const image = await capture();
      // A throw, not a quiet no-op answering a path nothing was written to: on
      // macOS the app outlives its last window, so "there is no window" is a
      // reachable state and a caller reading `{path}` back would go looking for
      // a file that does not exist.
      if (image === null) throw new Error('there is no window to capture');

      const path = capturePath({
        ...(args.path === undefined ? {} : { path: args.path }),
        supportDir,
        at: clock.now(),
      });
      await write(path, image.png);
      return { path, width: image.width, height: image.height };
    },
  });
}
