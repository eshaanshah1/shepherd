import { describe, expect, it, vi } from 'vitest';
import type { ExecErr, ExecOk, ExecOptions } from '@shepherd/sdk';
import { ACLI_CANDIDATES, resolveJira } from './jira.ts';

const ok = (stdout: string): ExecOk => ({ ok: true, stdout, stderr: '' });
const err = (code = 127): ExecErr => ({ ok: false, code, stdout: '', stderr: 'no such file' });

const answered = (summary: string): string => JSON.stringify({ fields: { summary } });

const source = (
  over: {
    exec?: (cmd: readonly string[], opts: ExecOptions) => Promise<ExecOk | ExecErr>;
    secret?: string | undefined;
    fetch?: typeof globalThis.fetch;
  } = {},
) => {
  const exec = vi.fn(over.exec ?? (async () => err()));
  const get = vi.fn(async () => over.secret);
  const fetched = vi.fn(over.fetch ?? (async () => new Response('{}', { status: 401 })));
  return {
    process: { exec },
    secrets: { get },
    fetch: fetched as unknown as typeof globalThis.fetch,
    homeDir: '/Users/ada',
    userName: 'ada',
    site: 'x.atlassian.net',
  };
};

const live = (): AbortSignal => new AbortController().signal;

describe('resolveJira', () => {
  it('takes the summary acli gives it, and asks nothing else', async () => {
    const src = source({ exec: async () => ok(answered('Retry loop drops the last event')) });
    expect(await resolveJira('SHEP-412', src, live())).toBe('Retry loop drops the last event');
    expect(src.fetch).not.toHaveBeenCalled();
    // The keychain is not even opened when the CLI answered. On a Mac that is a
    // prompt that never appears.
    expect(src.secrets.get).not.toHaveBeenCalled();
  });

  it('asks acli for the one field it needs, and for json', async () => {
    const src = source({ exec: async () => ok(answered('x')) });
    await resolveJira('SHEP-412', src, live());
    const [cmd] = src.process.exec.mock.calls[0] ?? [];
    expect(cmd).toEqual([
      ACLI_CANDIDATES[0],
      'jira',
      'workitem',
      'view',
      'SHEP-412',
      '--fields',
      'summary',
      '--json',
    ]);
  });

  /**
   * A GUI app inherits a minimal `PATH`, so `acli` is not on it — the same trap
   * `github/src/token.ts` measured for `gh`. The bare name comes last and is the
   * one that normally answers, since the app harvests the login shell's `PATH` at
   * startup (ADR 0045).
   */
  it('probes the places a GUI app cannot see before falling back to the bare name', async () => {
    const exec = vi.fn(async (cmd: readonly string[]) =>
      cmd[0] === '/usr/local/bin/acli' ? ok(answered('found on the second try')) : err(),
    );
    const src = source({ exec });
    expect(await resolveJira('A-1', src, live())).toBe('found on the second try');
    expect(exec.mock.calls.map(([cmd]) => cmd[0])).toEqual([
      '/opt/homebrew/bin/acli',
      '/usr/local/bin/acli',
    ]);
    expect(ACLI_CANDIDATES.at(-1)).toBe('acli');
  });

  /**
   * `exec` REPLACES the child's environment rather than merging it, and a vendor
   * CLI handed only `HOME` reports itself as logged out — measured, and the
   * reason `ctx.userName` exists at all.
   */
  it('hands the child HOME and USER, and names no PATH', async () => {
    const src = source({ exec: async () => ok(answered('x')) });
    await resolveJira('A-1', src, live());
    const [, opts] = src.process.exec.mock.calls[0] ?? [];
    expect(opts?.env).toEqual({ HOME: '/Users/ada', USER: 'ada' });
    // Naming one would replace the app's harvested PATH with a fixed list.
    expect(Object.keys(opts?.env ?? {})).not.toContain('PATH');
    expect(opts?.timeoutMs).toBeGreaterThan(0);
  });

  it('falls to the rest api when acli cannot answer and a token is stored', async () => {
    const fetched = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ fields: { summary: 'from rest' } }), { status: 200 }),
    );
    const src = source({ secret: 'ada@example.com:tok', fetch: fetched as never });
    expect(await resolveJira('A-1', src, live())).toBe('from rest');
    const [url, init] = fetched.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://x.atlassian.net/rest/api/3/issue/A-1?fields=summary');
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      Authorization: `Basic ${btoa('ada@example.com:tok')}`,
    });
  });

  it('splits the pair on its FIRST colon, because a token may contain one', async () => {
    const fetched = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response(answered('x'), { status: 200 }),
    );
    const src = source({ secret: 'ada@example.com:to:ken', fetch: fetched as never });
    await resolveJira('A-1', src, live());
    const [, init] = fetched.mock.calls[0] ?? [];
    expect((init as RequestInit | undefined)?.headers).toMatchObject({
      Authorization: `Basic ${btoa('ada@example.com:to:ken')}`,
    });
  });

  it('gives up when there is no token to fall back on', async () => {
    const src = source();
    expect(await resolveJira('A-1', src, live())).toBeNull();
    expect(src.fetch).not.toHaveBeenCalled();
  });

  it('gives up on a secret that is not a pair, rather than sending half of one', async () => {
    const src = source({ secret: 'justatoken' });
    expect(await resolveJira('A-1', src, live())).toBeNull();
    expect(src.fetch).not.toHaveBeenCalled();
  });

  it('gives up quietly when the token is rejected', async () => {
    const src = source({ secret: 'ada@example.com:tok' });
    expect(await resolveJira('A-1', src, live())).toBeNull();
  });

  /**
   * `secrets.get` THROWS for a denial — a manifest missing the permission, which
   * no retry fixes. This caller cannot act on that, and every reason there is no
   * token has the same answer. Measured in `github`: a rejection from here once
   * escaped as an unhandled promise and took the extension host with it.
   */
  it('survives a keychain that throws', async () => {
    const src = source();
    src.secrets.get = vi.fn(async () => {
      throw new Error('denied');
    }) as never;
    expect(await resolveJira('A-1', src, live())).toBeNull();
  });

  it('gives up on output whose shape it does not recognise, rather than throwing', async () => {
    // `acli --json` is not a contract, and it already warns that it is outdated
    // on every invocation on the machine this was written for.
    for (const stdout of ['not json at all', '{}', '{"fields":{}}', '{"fields":{"summary":42}}']) {
      const src = source({ exec: async () => ok(stdout) });
      expect(await resolveJira('A-1', src, live()), stdout).toBeNull();
    }
  });

  it('survives an exec that throws instead of reporting a failure', async () => {
    const src = source({
      exec: async () => {
        throw new Error('spawn failed');
      },
    });
    expect(await resolveJira('A-1', src, live())).toBeNull();
  });

  it('does nothing at all once the deadline has fired', async () => {
    const controller = new AbortController();
    controller.abort();
    const src = source({ exec: async () => ok(answered('too late')) });
    expect(await resolveJira('A-1', src, controller.signal)).toBeNull();
    expect(src.process.exec).not.toHaveBeenCalled();
  });

  it('stops probing candidates once the deadline fires mid-chain', async () => {
    const controller = new AbortController();
    const exec = vi.fn(async () => {
      controller.abort();
      return err();
    });
    const src = source({ exec });
    expect(await resolveJira('A-1', src, controller.signal)).toBeNull();
    // One probe ran and aborted; the remaining candidates are not tried.
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
