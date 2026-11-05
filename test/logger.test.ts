import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '../src/logger.js';

let out: string[];
let err: string[];
beforeEach(() => {
  out = []; err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s: any) => { out.push(String(s)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((s: any) => { err.push(String(s)); return true; });
  delete process.env.LOG_PRETTY;
  process.env.LOG_LEVEL = 'debug';
});
afterEach(() => vi.restoreAllMocks());

describe('structured Logger', () => {
  it('emits one JSON object per line with ts/level/msg/fields', () => {
    new Logger().info('hello', { reqId: 'r1' });
    const rec = JSON.parse(out[0]);
    expect(rec).toMatchObject({ level: 'info', msg: 'hello', reqId: 'r1' });
    expect(typeof rec.ts).toBe('string');
  });

  it('routes warn/error to stderr, info to stdout', () => {
    const l = new Logger();
    l.info('i'); l.warn('w'); l.error('e');
    expect(out).toHaveLength(1);
    expect(err).toHaveLength(2);
    expect(JSON.parse(err[0]).level).toBe('warn');
  });

  it('child() stamps correlation fields on every line', () => {
    new Logger().child({ requestId: 'req-9' }).info('transition', { to: 'executed' });
    expect(JSON.parse(out[0])).toMatchObject({ requestId: 'req-9', to: 'executed' });
  });

  it('respects LOG_LEVEL (debug suppressed at info)', () => {
    process.env.LOG_LEVEL = 'info';
    new Logger().debug('noisy');
    expect(out).toHaveLength(0);
  });

  it('LOG_PRETTY emits human lines instead of JSON', () => {
    process.env.LOG_PRETTY = 'true';
    new Logger().info('pretty', { a: 1 });
    expect(out[0]).toContain('pretty');
    expect(() => JSON.parse(out[0])).toThrow();
  });
});
