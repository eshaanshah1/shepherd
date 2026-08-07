import { describe, expect, it } from 'vitest';
import { manualClock } from './clock.ts';
import { createLogger, formatLine, LOG_LEVELS, parseLogLevel, passes } from './log.ts';

describe('formatLine', () => {
  it('stamps milliseconds, zero-padded', () => {
    // The ms field is the whole point: these lines get correlated against other
    // logs and against packet captures, and v1's untimestamped predecessor cost
    // a whole session on one pairing failure because nothing said *when*.
    // Seconds and ms are the timezone-invariant part — a half-hour offset zone
    // shifts the minute field, so the test pins what it can pin.
    const line = formatLine({
      ts: Date.UTC(2026, 7, 7, 14, 3, 9, 42),
      level: 'info',
      category: 'command',
      message: 'invoked layout.split',
    });
    expect(line).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:09\.042 INFO {2}command invoked layout\.split$/);
  });

  it('pads the level so categories line up in a column', () => {
    const at = (level: 'debug' | 'info' | 'warn' | 'error') =>
      formatLine({ ts: 0, level, category: 'app', message: 'x' }).split(' ').slice(2).join(' ');
    expect(at('debug')).toBe('DEBUG app x');
    expect(at('info')).toBe('INFO  app x');
    expect(at('warn')).toBe('WARN  app x');
    expect(at('error')).toBe('ERROR app x');
  });

  it('keeps a multi-line message on one line so a log stays greppable', () => {
    const line = formatLine({ ts: 0, level: 'error', category: 'ingress', message: 'bad body:\nline two' });
    expect(line).not.toContain('\n');
    expect(line).toContain('bad body:\\nline two');
  });
});

describe('passes', () => {
  it('admits its own level and everything above it', () => {
    expect(LOG_LEVELS).toEqual(['debug', 'info', 'warn', 'error']);
    expect(passes('info', 'debug')).toBe(false);
    expect(passes('info', 'info')).toBe(true);
    expect(passes('info', 'error')).toBe(true);
    expect(passes('error', 'warn')).toBe(false);
    expect(passes('debug', 'debug')).toBe(true);
  });
});

describe('parseLogLevel', () => {
  it('accepts the four names, case-insensitively, and nothing else', () => {
    expect(parseLogLevel('DEBUG')).toBe('debug');
    expect(parseLogLevel(' warn ')).toBe('warn');
    expect(parseLogLevel('verbose')).toBeUndefined();
    expect(parseLogLevel(undefined)).toBeUndefined();
  });
});

describe('createLogger', () => {
  it('writes through the sink, at or above the level', () => {
    const lines: string[] = [];
    const log = createLogger({ clock: manualClock(0), level: 'info', sink: (line) => lines.push(line) });

    log.debug('app', 'not this one');
    log.info('app', 'this one');
    log.error('session', 'and this one');

    expect(lines.map((l) => l.split(' ').slice(2).join(' '))).toEqual([
      'INFO  app this one',
      'ERROR session and this one',
    ]);
  });

  it('reads the clock at write time, not at construction', () => {
    const clock = manualClock(0);
    const lines: string[] = [];
    const log = createLogger({ clock, level: 'debug', sink: (line) => lines.push(line) });

    log.info('app', 'first');
    clock.advance(5_000);
    log.info('app', 'second');

    expect(lines[0]).not.toBe(lines[1]);
  });

  it('setLevel changes what passes, live', () => {
    // ⌘⇧R re-reads the config in v1 precisely so debug can be turned on WITHOUT
    // restarting and losing the state you are trying to explain.
    const lines: string[] = [];
    const log = createLogger({ clock: manualClock(0), level: 'warn', sink: (line) => lines.push(line) });

    log.info('app', 'dropped');
    log.setLevel('debug');
    log.info('app', 'kept');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('kept');
  });

  it('a throwing sink does not take the caller down', () => {
    // A logger that can throw turns "log why nothing happened" into a second
    // failure on the path that was already failing.
    const log = createLogger({
      clock: manualClock(0),
      level: 'debug',
      sink: () => {
        throw new Error('disk full');
      },
    });
    expect(() => log.error('app', 'the original problem')).not.toThrow();
  });

  it('child() fixes the category and inherits the level, live', () => {
    const lines: string[] = [];
    const log = createLogger({ clock: manualClock(0), level: 'debug', sink: (line) => lines.push(line) });
    const ingress = log.child('ingress');

    ingress.info('accepted 1 envelope');
    log.setLevel('error');
    ingress.info('dropped');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('INFO  ingress accepted 1 envelope');
  });
});
