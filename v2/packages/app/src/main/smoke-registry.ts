import type { BrowserWindow } from 'electron';
import type { SessionHost } from '@shepherd/core';
import { die, say } from './smoke-support.ts';
import type { M1SmokeOptions } from './smoke-m1.ts';

/**
 * `--shepherd-smoke=<name>` → the smoke to run.
 *
 * A table rather than an `if` chain in `index.ts` so an unknown name FAILS
 * rather than starting a normal app that a runner then waits on until timeout,
 * reporting a hang where the real fault was a typo in a package.json script.
 */
export async function runSmoke(
  name: string,
  win: BrowserWindow,
  host: SessionHost,
  /**
   * The kernel handles a smoke may need. Passed rather than imported so this
   * table stays the only thing that knows which smoke wants what — and so a
   * smoke cannot reach a second copy of anything.
   */
  kernel: M1SmokeOptions,
): Promise<void> {
  say(`running '${name}'`);
  switch (name) {
    case 'terminal': {
      const { runTerminalSmoke } = await import('./smoke-terminal.ts');
      return runTerminalSmoke(win, host);
    }
    case 'm0': {
      const { runM0Smoke } = await import('./smoke-m0.ts');
      return runM0Smoke(win, host);
    }
    case 'm1': {
      const { runM1Smoke } = await import('./smoke-m1.ts');
      return runM1Smoke(win, host, kernel);
    }
    default:
      return die(`unknown smoke '${name}'`);
  }
}
