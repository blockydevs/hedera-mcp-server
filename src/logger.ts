/**
 * Structured logger — dependency-free (keeps the audit surface small).
 *
 * Emits one JSON object per line to stdout (info/debug) or stderr (warn/error), with a
 * timestamp, level, message, and arbitrary structured fields. This is machine-parseable by a
 * log aggregator (Datadog/CloudWatch/Loki).
 *
 * `LOG_LEVEL` gates verbosity (debug < info < warn < error; default info). `LOG_PRETTY=true`
 * switches to human-readable emoji lines for local dev.
 *
 * Correlation: `logger.child({ reqId, sessionId, accountId, requestId })` returns a logger
 * that stamps those fields on every line, so a single request is traceable across the async
 * hops (inbound → wallet delivery → broadcast → mirror confirm) by its ids.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const EMOJI: Record<LogLevel, string> = { debug: '🔍', info: '✅', warn: '⚠️', error: '❌' };

/** `LOG_LEVEL=silent` suppresses all output (used by the test suite). */
function threshold(): number {
  const configured = (process.env.LOG_LEVEL || 'info').toLowerCase();
  if (configured === 'silent') return Infinity;
  return LEVEL_ORDER[configured as LogLevel] ?? LEVEL_ORDER.info;
}
const pretty = (): boolean => process.env.LOG_PRETTY === 'true';

export class Logger {
  constructor(private readonly base: LogFields = {}) {}

  /** Returns a logger that stamps `fields` (e.g. correlation ids) on every subsequent line. */
  child(fields: LogFields): Logger {
    return new Logger({ ...this.base, ...fields });
  }

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < threshold()) return;
    const record = { ts: new Date().toISOString(), level, msg, ...this.base, ...fields };
    // new Date() is fine here — logging is a runtime side effect, not replayed.
    const line = pretty()
      ? `${EMOJI[level]} ${msg}${fieldsSuffix({ ...this.base, ...fields })}`
      : JSON.stringify(record);
    if (level === 'warn' || level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  debug(msg: string, fields?: LogFields): void { this.emit('debug', msg, fields); }
  info(msg: string, fields?: LogFields): void { this.emit('info', msg, fields); }
  warn(msg: string, fields?: LogFields): void { this.emit('warn', msg, fields); }
  error(msg: string, fields?: LogFields): void { this.emit('error', msg, fields); }
}

function fieldsSuffix(fields: LogFields): string {
  const entries = Object.entries(fields);
  return entries.length ? ' ' + entries.map(([k, v]) => `${k}=${String(v)}`).join(' ') : '';
}

/** The process-wide root logger. */
export const logger = new Logger();
