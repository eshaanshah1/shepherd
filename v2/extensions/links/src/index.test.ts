import { describe, expect, it } from 'vitest';
import {
  extensionId,
  manualClock,
  nullLogger,
  PointRegistry,
  type ExecErr,
  type ExecOk,
  type ExecOptions,
  type ExtensionContext,
  type Shepherd,
} from '@shepherd/sdk';
import type { PastedLinkProvider } from '@shepherd/ext-tasks/manifest';
import { activate } from './index.ts';
import { PASTED_LINK_POINT_ID } from './manifest.ts';
import { LINK_PATTERNS } from './parse.ts';

/**
 * The extension through `activate`, with `tasks` played by a real
 * `PointRegistry` — because the claim worth testing is that a provider lands in
 * the seam `tasks` actually defines and answers the shape it actually expects. A
 * hand-rolled point would agree with whatever this file happened to do.
 */

const NOTHING: ExecErr = { ok: false, code: 127, stdout: '', stderr: 'no such file' };

interface Harness {
  /** The single provider, as `tasks` would see it. Throws if none registered. */
  provider(): PastedLinkProvider;
  registered(): number;
  readonly warnings: string[];
  dispose(): void;
}

function harness(
  opts: {
    withPoint?: boolean;
    exec?: (cmd: readonly string[], opts: ExecOptions) => ExecOk | ExecErr;
    secret?: string;
  } = {},
): Harness {
  const process_ = {
    exec: (cmd: readonly string[], execOpts: ExecOptions) =>
      Promise.resolve(opts.exec?.(cmd, execOpts) ?? NOTHING),
    gitRead: () => Promise.resolve(NOTHING),
    gitWrite: () => Promise.resolve(NOTHING),
  };

  const registry = new PointRegistry({ logger: nullLogger });
  const point =
    opts.withPoint === false
      ? undefined
      : registry.define<PastedLinkProvider>(PASTED_LINK_POINT_ID, {
          order: 'registration',
          owner: 'shepherd.tasks',
        });

  const warnings: string[] = [];
  const ctx: ExtensionContext = {
    id: extensionId('shepherd.links'),
    source: 'builtin',
    subscriptions: [],
    storage: {
      get: () => undefined,
      set: () => {},
      delete: () => {},
      keys: () => [],
    },
    dataDir: '/data',
    homeDir: '/Users/ada',
    userName: 'ada',
    secrets: {
      get: () => Promise.resolve(opts.secret),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    log: { ...nullLogger.child('extension'), warn: (line: string) => void warnings.push(line) },
    clock: manualClock(1),
    permissions: ['process.exec', 'network', 'secrets'],
    isDev: false,
  };

  const api = {
    version: '1.0.0',
    proposed: { points: registry, process: process_ },
  } as unknown as Shepherd;

  activate(ctx, api);

  return {
    provider: () => {
      const found = point?.all()[0];
      if (found === undefined) throw new Error('nothing registered into the point');
      return found;
    },
    registered: () => point?.all().length ?? 0,
    warnings,
    dispose: () => {
      for (const sub of ctx.subscriptions) sub.dispose();
      registry.dispose();
    },
  };
}

const live = (): AbortSignal => new AbortController().signal;
const answered = (summary: string): ExecOk => ({
  ok: true,
  stdout: JSON.stringify({ fields: { summary } }),
  stderr: '',
});

describe('activate', () => {
  it('lands exactly one provider in tasks.pastedLink', () => {
    const h = harness();
    expect(h.registered()).toBe(1);
    h.dispose();
  });

  it('offers both vendors’ patterns', () => {
    const h = harness();
    expect(h.provider().patterns).toEqual(LINK_PATTERNS);
    h.dispose();
  });

  /**
   * D15: a degraded path reports itself. Without the point there is no seam to
   * register into and pasting a link silently keeps working as plain text —
   * which is a reasonable outcome and an unreasonable thing to be silent about.
   */
  it('warns, and registers nothing, when nothing defines the point', () => {
    const h = harness({ withPoint: false });
    expect(h.registered()).toBe(0);
    expect(h.warnings.some((line) => line.includes(PASTED_LINK_POINT_ID))).toBe(true);
    h.dispose();
  });
});

describe('what it claims', () => {
  it('labels a slack permalink from the url alone, with no call made', async () => {
    const h = harness();
    expect(
      await h
        .provider()
        .resolve('https://x.slack.com/archives/C08ABCDEF/p1724500000123456', live()),
    ).toEqual({ vendor: 'slack', label: 'Slack thread', resolved: false });
    h.dispose();
  });

  it('labels a jira issue with what acli said', async () => {
    const h = harness({ exec: () => answered('Retry loop drops the last event') });
    expect(await h.provider().resolve('https://x.atlassian.net/browse/SHEP-412', live())).toEqual({
      vendor: 'jira',
      label: 'SHEP-412 Retry loop drops the last event',
      resolved: true,
    });
    h.dispose();
  });

  it('falls back to the bare key when nothing answered', async () => {
    const h = harness();
    expect(await h.provider().resolve('https://x.atlassian.net/browse/SHEP-412', live())).toEqual({
      vendor: 'jira',
      label: 'SHEP-412',
      resolved: false,
    });
    h.dispose();
  });

  it('asks the site the url named, not one it was configured with', async () => {
    // Two Atlassian sites need no second configuration: the URL says which.
    const seen: string[] = [];
    const h = harness({
      exec: (cmd) => {
        seen.push(cmd.join(' '));
        return answered('x');
      },
    });
    await h.provider().resolve('https://other.atlassian.net/browse/AB-2', live());
    expect(seen[0]).toContain('AB-2');
    h.dispose();
  });

  it('claims nothing it cannot read, so the composer never has to un-draw a pill', async () => {
    const h = harness();
    for (const url of [
      'https://x.atlassian.net/wiki/spaces/ENG',
      'https://x.atlassian.net/browse/notakey',
      'https://example.com/anything',
    ]) {
      expect(await h.provider().resolve(url, live()), url).toBeNull();
    }
    h.dispose();
  });

  it('answers with the fallback rather than throwing when the deadline has fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ exec: () => answered('too late') });
    expect(
      await h.provider().resolve('https://x.atlassian.net/browse/A-1', controller.signal),
    ).toEqual({ vendor: 'jira', label: 'A-1', resolved: false });
    h.dispose();
  });
});
