import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_LOG_MAX_BYTES, openLogFile } from './log-file.ts';

/** The log an installed app leaves behind. */

const dir = (): string => mkdtempSync(join(tmpdir(), 'shepherd-app-log-'));

/** The record a sink is handed alongside the formatted line. */
const record = { ts: 0, level: 'info', category: 'app', message: 'ready' } as const;

describe('openLogFile', () => {
  it('appends each line it is handed, one physical line each', () => {
    const path = join(dir(), 'app.log');
    const sink = openLogFile(path);
    if (sink === undefined) throw new Error('the log did not open');

    sink('first', record);
    sink('second', record);

    expect(readFileSync(path, 'utf8')).toBe('first\nsecond\n');
  });

  it('opens a log in a directory that does not exist yet', () => {
    const path = join(dir(), 'nested', 'app.log');
    const sink = openLogFile(path);
    if (sink === undefined) throw new Error('the log did not open');

    sink('a first run', record);

    expect(readFileSync(path, 'utf8')).toBe('a first run\n');
  });

  it('keeps what a previous run wrote', () => {
    const path = join(dir(), 'app.log');
    writeFileSync(path, 'an earlier run\n');

    const sink = openLogFile(path);
    sink?.('this run', record);

    expect(readFileSync(path, 'utf8')).toBe('an earlier run\nthis run\n');
  });

  it('rolls a log past its cap aside instead of growing forever', () => {
    const path = join(dir(), 'app.log');
    writeFileSync(path, 'x'.repeat(APP_LOG_MAX_BYTES + 1));

    const sink = openLogFile(path);
    sink?.('a fresh run', record);

    expect(readFileSync(path, 'utf8')).toBe('a fresh run\n');
    expect(readFileSync(`${path}.1`, 'utf8')).toHaveLength(APP_LOG_MAX_BYTES + 1);
  });

  it('keeps ONE generation, so two rotations cannot fill a disk', () => {
    const path = join(dir(), 'app.log');
    writeFileSync(`${path}.1`, 'the run before last');
    writeFileSync(path, 'x'.repeat(APP_LOG_MAX_BYTES + 1));

    openLogFile(path);

    expect(readFileSync(`${path}.1`, 'utf8')).toHaveLength(APP_LOG_MAX_BYTES + 1);
    expect(existsSync(`${path}.2`)).toBe(false);
  });

  it('reports a log it cannot open rather than throwing', () => {
    expect(openLogFile('/dev/null/nope/app.log')).toBeUndefined();
  });
});
