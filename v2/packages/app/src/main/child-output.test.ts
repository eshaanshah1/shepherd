import { describe, expect, it } from 'vitest';
import { createLogger, type LogRecord } from '@shepherd/sdk';
import { forwardChildOutput, lineReader } from './child-output.ts';

const clock = { now: () => 0, setTimeout: () => ({ dispose: () => {} }) };

function recorder(): { records: LogRecord[]; log: ReturnType<ReturnType<typeof createLogger>['child']> } {
  const records: LogRecord[] = [];
  const logger = createLogger({ clock, level: 'debug', sink: (_line, record) => records.push(record) });
  return { records, log: logger.child('extension') };
}

/** A readable stream, reduced to the one event this reads. */
function stream(): NodeJS.ReadableStream & { push(chunk: string): void } {
  let listener: ((chunk: Buffer | string) => void) | undefined;
  return {
    on: (_event: string, fn: (chunk: Buffer | string) => void) => {
      listener = fn;
      return undefined;
    },
    push: (chunk: string) => listener?.(chunk),
  } as unknown as NodeJS.ReadableStream & { push(chunk: string): void };
}

describe('lineReader', () => {
  it('holds a partial line until the rest of it arrives', () => {
    const lines: string[] = [];
    const read = lineReader((line) => lines.push(line));

    read('[ext-host] the host closed the fra');
    expect(lines).toEqual([]);

    read('me channel\n');
    expect(lines).toEqual(['[ext-host] the host closed the frame channel']);
  });

  it('splits a chunk carrying several lines, and drops the blank ones', () => {
    const lines: string[] = [];
    const read = lineReader((line) => lines.push(line));

    read('first\n\nsecond\n');

    expect(lines).toEqual(['first', 'second']);
  });

  it('reads a Buffer as utf8', () => {
    const lines: string[] = [];
    const read = lineReader((line) => lines.push(line));

    read(Buffer.from('from a pipe\n', 'utf8'));

    expect(lines).toEqual(['from a pipe']);
  });
});

describe('forwardChildOutput', () => {
  it('logs stderr at warn and stdout at info — the child chose the stream', () => {
    const { records, log } = recorder();
    const stdout = stream();
    const stderr = stream();
    forwardChildOutput({ stdout, stderr }, log, 'the extension host');

    stdout.push('extension host accepted: protocol 1\n');
    stderr.push('[ext-host] no parentPort\n');

    expect(records).toEqual([
      { ts: 0, level: 'info', category: 'extension', message: 'extension host accepted: protocol 1' },
      { ts: 0, level: 'warn', category: 'extension', message: '[ext-host] no parentPort' },
    ]);
  });

  it('says so when a stream it was told to read is not there', () => {
    const { records, log } = recorder();

    forwardChildOutput({ stdout: null, stderr: null }, log, 'the extension host');

    expect(records.map((record) => record.message)).toEqual([
      'the extension host has no stdout to read',
      'the extension host has no stderr to read',
    ]);
  });
});
