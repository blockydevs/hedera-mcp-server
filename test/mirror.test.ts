import { describe, it, expect, vi, afterEach } from 'vitest';
import { LedgerId } from '@hiero-ledger/sdk';

// Mock the agent-kit mirror service so we can drive slow/failing lookups deterministically.
const getAccount = vi.fn();
vi.mock('@hashgraph/hedera-agent-kit', () => ({
  getMirrornodeService: () => ({ getAccount }),
}));

const { fetchAccountPublicKey } = await import('../src/wallet/mirror.js');

afterEach(() => getAccount.mockReset());

describe('fetchAccountPublicKey (init-path DoS guard)', () => {
  it('returns the key on a fast success', async () => {
    getAccount.mockResolvedValue({ accountPublicKey: 'pubkey-1' });
    expect(await fetchAccountPublicKey(LedgerId.TESTNET, '0.0.5001')).toBe('pubkey-1');
  });

  it('returns undefined (does not block) when the lookup hangs past the timeout', async () => {
    getAccount.mockReturnValue(new Promise(() => {})); // never resolves
    const start = Date.now();
    const result = await fetchAccountPublicKey(LedgerId.TESTNET, '0.0.5002');
    expect(result).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(4000); // bounded by the 3s timeout, not the hang
  });

  it('returns undefined on a lookup error rather than throwing', async () => {
    getAccount.mockRejectedValue(new Error('mirror 404'));
    await expect(fetchAccountPublicKey(LedgerId.TESTNET, '0.0.5003')).resolves.toBeUndefined();
  });

  it('caches, so a repeat lookup does not hit the mirror again', async () => {
    getAccount.mockResolvedValue({ accountPublicKey: 'pubkey-4' });
    await fetchAccountPublicKey(LedgerId.TESTNET, '0.0.5004');
    await fetchAccountPublicKey(LedgerId.TESTNET, '0.0.5004');
    expect(getAccount).toHaveBeenCalledTimes(1);
  });
});
