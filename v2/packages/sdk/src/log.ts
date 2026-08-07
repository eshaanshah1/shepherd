import type { Clock } from './clock.ts';

/**
 * The logger, and the rule it exists to enforce:
 *
 *   **Every branch that ends in "and then nothing happens" logs why.**
 *
 * That sentence is the whole design. v1's predecessor was a bare string printer,
 * and the cost showed up as a LAN-pairing failure that took a session to find
 * because no line said *when* "no tailnet address" happened relative to the
 * phone connecting. So: millisecond stamps, a category, a level that can be
 * raised without a restart, and no dependencies — test targets compile this file
 * too, and a logger that drags configuration in behind it stops being usable
 * from the places that need it most.
 *
 * The sink is injected. Nothing here knows about a file, a console, or
 * `os_log`: `packages/sdk` has no OS APIs by lint, and the one caller that wants
 * a rotating file (`packages/app`) is also the one that may open one.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Categories are a closed set on purpose: `grep -c ' ingress '` only works if
 * the writer could not have invented `Ingress` or `ingres`. Extensions get
 * `extension` and are distinguished by their id in the message.
 */
export const LOG_CATEGORIES = [
  'app',
  'session',
  'command',
  'event',
  'ingress',
  'storage',
  'layout',
  'attention',
  'extension',
] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

export interface LogRecord {
  readonly ts: number;
  readonly level: LogLevel;
  readonly category: LogCategory;
  readonly message: string;
}

export interface Logger {
  debug(category: LogCategory, message: string): void;
  info(category: LogCategory, message: string): void;
  warn(category: LogCategory, message: string): void;
  error(category: LogCategory, message: string): void;
  /** A logger whose category is already chosen — what `ctx.log` hands out. */
  child(category: LogCategory): CategoryLogger;
  /** Raise or lower the bar live. Config reload calls this; nothing restarts. */
  setLevel(level: LogLevel): void;
  readonly level: LogLevel;
}

/** The same four verbs with the category bound. */
export interface CategoryLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type LogSink = (line: string, record: LogRecord) => void;

export interface LoggerOptions {
  readonly clock: Clock;
  readonly level: LogLevel;
  readonly sink: LogSink;
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** True when `level` is at or above the configured bar. */
export function passes(configured: LogLevel, level: LogLevel): boolean {
  return RANK[level] >= RANK[configured];
}

export function parseLogLevel(raw: string | undefined): LogLevel | undefined {
  const name = raw?.trim().toLowerCase();
  return LOG_LEVELS.find((level) => level === name);
}

/**
 * `MM-dd HH:mm:ss.mmm LEVEL category message`, local time — the format v1
 * settled on, kept so two months of habits still read.
 *
 * The message is flattened to one physical line. A stack trace or a git stderr
 * pasted verbatim would otherwise turn one event into forty unattributed lines
 * and break every `grep` over the file.
 */
export function formatLine(record: LogRecord): string {
  const at = new Date(record.ts);
  const stamp =
    `${pad(at.getMonth() + 1, 2)}-${pad(at.getDate(), 2)} ` +
    `${pad(at.getHours(), 2)}:${pad(at.getMinutes(), 2)}:${pad(at.getSeconds(), 2)}.${pad(at.getMilliseconds(), 3)}`;
  const level = record.level.toUpperCase().padEnd(5, ' ');
  return `${stamp} ${level} ${record.category} ${flatten(record.message)}`;
}

export function createLogger(options: LoggerOptions): Logger {
  const { clock, sink } = options;
  let level = options.level;

  const write = (recordLevel: LogLevel, category: LogCategory, message: string): void => {
    if (!passes(level, recordLevel)) return;
    const record: LogRecord = { ts: clock.now(), level: recordLevel, category, message };
    try {
      sink(formatLine(record), record);
    } catch {
      // A logger that throws turns "log why nothing happened" into a second
      // failure on the path that was already failing. There is nowhere left to
      // report a broken sink to, so this is the one empty catch in the SDK.
    }
  };

  const logger: Logger = {
    debug: (category, message) => write('debug', category, message),
    info: (category, message) => write('info', category, message),
    warn: (category, message) => write('warn', category, message),
    error: (category, message) => write('error', category, message),
    child: (category) => ({
      // Reads `level` through `write` at call time, so a later `setLevel`
      // reaches loggers that were handed out before it.
      debug: (message) => write('debug', category, message),
      info: (message) => write('info', category, message),
      warn: (message) => write('warn', category, message),
      error: (message) => write('error', category, message),
    }),
    setLevel: (next) => {
      level = next;
    },
    get level() {
      return level;
    },
  };
  return logger;
}

/** A logger that discards everything — for tests and for a headless tool. */
export const nullLogger: Logger = createLogger({
  clock: { now: () => 0, setTimeout: () => ({ dispose: () => {} }) },
  level: 'error',
  sink: () => {},
});

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function flatten(message: string): string {
  return message.replace(/\r?\n/g, '\\n');
}
