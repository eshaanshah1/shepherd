import type { BrowserWindow } from 'electron';
import type { SessionHost } from '@shepherd/core';
import { die, say } from './smoke-support.ts';
import type { M1SmokeOptions } from './smoke-m1.ts';
import type { M2SmokeOptions } from './smoke-m2.ts';
import type { M3SmokeOptions } from './smoke-m3.ts';

/**
 * Every handle any smoke may want.
 *
 * One bag rather than a union, because `index.ts` builds it once and this table
 * is the only thing that knows which smoke needs what — a smoke that reached for
 * something absent would otherwise fail as a `TypeError` three frames deep
 * instead of as a named refusal here.
 */
export type SmokeKernel = M1SmokeOptions &
  Partial<Omit<M2SmokeOptions, keyof M1SmokeOptions>> &
  Partial<Omit<M3SmokeOptions, keyof M1SmokeOptions>>;

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
  kernel: SmokeKernel,
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
    case 'm2': {
      const { runM2Smoke } = await import('./smoke-m2.ts');
      const { isM2Options } = await import('./smoke-m2.ts');
      if (!isM2Options(kernel)) return die('the m2 smoke needs the layout and agent handles');
      return runM2Smoke(win, host, kernel);
    }
    case 'm3': {
      const { isM3Options, runM3Smoke } = await import('./smoke-m3.ts');
      if (!isM3Options(kernel)) return die('the m3 smoke needs the alerts handle');
      return runM3Smoke(win, kernel);
    }

    default:
      return die(`unknown smoke '${name}'`);
  }
}
