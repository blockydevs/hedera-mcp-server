import { describe, it, expect } from 'vitest';
import { originAllowed } from '../src/web/connect.js';

const SELF = 'https://mcp.example.com';

describe('originAllowed', () => {
  it('accepts a matching Origin header', () => {
    expect(originAllowed({ origin: 'https://mcp.example.com' }, SELF)).toBe(true);
  });

  it('rejects a different Origin', () => {
    expect(originAllowed({ origin: 'https://evil.example.com' }, SELF)).toBe(false);
  });

  it('falls back to Referer when Origin is absent', () => {
    expect(originAllowed({ referer: 'https://mcp.example.com/connect?ceremony=x' }, SELF)).toBe(true);
  });

  it('rejects a cross-site Referer', () => {
    expect(originAllowed({ referer: 'https://evil.example.com/attack' }, SELF)).toBe(false);
  });

  // A cross-site form POST can be crafted with no Origin/Referer; treat absence as untrusted.
  it('rejects a request with neither header', () => {
    expect(originAllowed({}, SELF)).toBe(false);
  });

  it('does not throw on a malformed Referer', () => {
    expect(originAllowed({ referer: 'not a url' }, SELF)).toBe(false);
  });

  it('rejects rather than throwing when the expected URL is unset', () => {
    expect(originAllowed({ origin: 'https://mcp.example.com' }, '')).toBe(false);
  });
});
