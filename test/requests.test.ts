import { describe, it, expect } from 'vitest';
import {
  SigningRequestRegistry,
  isUserRejection,
  toMirrorTransactionId,
  type ConfirmResult,
} from '../src/signing/requests.js';
import { SessionGoneError, type WalletApprover } from '../src/wallet/approver.js';

/** A stand-in wallet whose approval outcome the test controls. */
function fakeApprover(behaviour: (topic: string) => Promise<{ transactionId: string }>) {
  return { signAndExecute: (topic: string) => behaviour(topic) } as unknown as WalletApprover;
}

const SUBMIT = {
  accountId: '0.0.1001',
  topic: 'topic-a',
  transactionBase64: 'AAAA',
  summary: 'Transfer — 0.0.3003 receives 5 ℏ',
  walletVerifiable: true,
};

/** Lets the background approval promise settle before asserting. */
const settle = () => new Promise(resolve => setImmediate(resolve));

describe('SigningRequestRegistry', () => {
  // The whole point of the async surface: the tool call returns before the human acts.
  it('returns immediately with awaiting_approval instead of blocking on the wallet', () => {
    const registry = new SigningRequestRegistry(
      fakeApprover(() => new Promise(() => {})), // never settles
      60_000,
    );
    const request = registry.submit(SUBMIT);
    expect(request.status).toBe('awaiting_approval');
    expect(request.requestId).toBeTruthy();
  });

  it('records the transaction id once the wallet has signed and broadcast', async () => {
    const registry = new SigningRequestRegistry(
      fakeApprover(async () => ({ transactionId: '0.0.1001@123.456' })),
      60_000,
    );
    const { requestId } = registry.submit(SUBMIT);
    await settle();
    const request = registry.get(requestId);
    expect(request?.status).toBe('executed');
    expect(request?.transactionId).toBe('0.0.1001@123.456');
  });

  it('reports a user decline as rejected', async () => {
    const registry = new SigningRequestRegistry(
      fakeApprover(async () => { throw new Error('User rejected the request'); }),
      60_000,
    );
    const { requestId } = registry.submit(SUBMIT);
    await settle();
    expect(registry.get(requestId)?.status).toBe('rejected');
  });

  it('reports a dead wallet session as needs_reauth, not a generic failure', async () => {
    const registry = new SigningRequestRegistry(
      fakeApprover(async () => { throw new SessionGoneError(); }),
      60_000,
    );
    const { requestId } = registry.submit(SUBMIT);
    await settle();
    expect(registry.get(requestId)?.status).toBe('needs_reauth');
  });

  it('expires a request whose TTL lapses while still awaiting approval', () => {
    const registry = new SigningRequestRegistry(fakeApprover(() => new Promise(() => {})), 1_000);
    const { requestId } = registry.submit(SUBMIT);
    expect(registry.get(requestId, Date.now() + 1_001)?.status).toBe('expired');
  });

  it('does not overwrite a terminal status when TTL later lapses', async () => {
    const registry = new SigningRequestRegistry(
      fakeApprover(async () => ({ transactionId: '0.0.1001@1' })),
      1_000,
    );
    const { requestId } = registry.submit(SUBMIT);
    await settle();
    expect(registry.get(requestId, Date.now() + 10_000)?.status).toBe('executed');
  });

  it('marks live requests needs_reauth when their wallet session ends', () => {
    const registry = new SigningRequestRegistry(fakeApprover(() => new Promise(() => {})), 60_000);
    const { requestId } = registry.submit(SUBMIT);
    registry.markSessionGone('topic-a');
    expect(registry.get(requestId)?.status).toBe('needs_reauth');
  });

  it('leaves requests on other sessions untouched when one session ends', () => {
    const registry = new SigningRequestRegistry(fakeApprover(() => new Promise(() => {})), 60_000);
    const mine = registry.submit(SUBMIT);
    registry.markSessionGone('someone-elses-topic');
    expect(registry.get(mine.requestId)?.status).toBe('awaiting_approval');
  });

  it('counts only live requests per account — the basis for future approval quotas', () => {
    const registry = new SigningRequestRegistry(fakeApprover(() => new Promise(() => {})), 60_000);
    registry.submit(SUBMIT);
    registry.submit(SUBMIT);
    registry.submit({ ...SUBMIT, accountId: '0.0.9999', topic: 'topic-b' });
    expect(registry.countAwaiting('0.0.1001')).toBe(2);
    expect(registry.countAwaiting('0.0.9999')).toBe(1);
  });

  it('prunes settled requests but keeps live ones', async () => {
    const registry = new SigningRequestRegistry(
      fakeApprover(async () => ({ transactionId: '0.0.1001@1' })),
      1_000,
    );
    registry.submit(SUBMIT);
    await settle();
    registry.prune(Date.now() + 10_000);
    expect(registry.size).toBe(0);
  });

  it('returns undefined for an unknown requestId', () => {
    const registry = new SigningRequestRegistry(fakeApprover(() => new Promise(() => {})), 60_000);
    expect(registry.get('nope')).toBeUndefined();
  });
});

describe('isUserRejection', () => {
  it.each([
    'User rejected the request',
    'Request declined by user',
    'user denied transaction',
  ])('recognises %s', message => {
    expect(isUserRejection(new Error(message))).toBe(true);
  });

  it('does not mistake a transport failure for a decline', () => {
    expect(isUserRejection(new Error('relay socket closed'))).toBe(false);
  });
});

describe('mirror-node confirmation', () => {
  const approver = (txId = '0.0.1001@1.2') =>
    fakeApprover(async () => ({ transactionId: txId }));
  const confirm = (result: ConfirmResult | (() => Promise<ConfirmResult>)) =>
    typeof result === 'function' ? result : async () => result;
  // callTimeoutMs is required — generous here so the cap never fires during these tests.
  const opts = { attempts: 3, delayMs: 0, callTimeoutMs: 10_000 };

  // The core guarantee: the wallet's word alone must not produce `executed`.
  it('reports executed only after the mirror node confirms success', async () => {
    const registry = new SigningRequestRegistry(approver(), 60_000, confirm('success'), opts);
    const { requestId } = registry.submit(SUBMIT);
    await settle();
    const request = registry.get(requestId);
    expect(request?.status).toBe('executed');
    expect(request?.transactionId).toBe('0.0.1001@1.2');
  });

  it('reports failed (not executed) when the transaction failed on-chain', async () => {
    const registry = new SigningRequestRegistry(approver(), 60_000, confirm('failed'), opts);
    const { requestId } = registry.submit(SUBMIT);
    await settle();
    const request = registry.get(requestId);
    expect(request?.status).toBe('failed');
    // The id is still recorded, so the agent can point the user at HashScan.
    expect(request?.transactionId).toBe('0.0.1001@1.2');
  });

  it('reports expired when the transaction never appears on the mirror node', async () => {
    const registry = new SigningRequestRegistry(approver(), 60_000, confirm('not_found'), opts);
    const { requestId } = registry.submit(SUBMIT);
    await settle();
    expect(registry.get(requestId)?.status).toBe('expired');
  });

  it('treats a mirror-node error as not-yet-found, not a success', async () => {
    const registry = new SigningRequestRegistry(
      approver(),
      60_000,
      confirm(async () => { throw new Error('mirror 404'); }),
      opts,
    );
    const { requestId } = registry.submit(SUBMIT);
    await settle();
    expect(registry.get(requestId)?.status).toBe('expired');
  });

  it('sits in confirming while the mirror node has not yet answered', async () => {
    const registry = new SigningRequestRegistry(
      approver(),
      60_000,
      confirm(() => new Promise<ConfirmResult>(() => {})), // never resolves
      opts,
    );
    const { requestId } = registry.submit(SUBMIT);
    await settle();
    const request = registry.get(requestId);
    expect(request?.status).toBe('confirming');
    expect(request?.transactionId).toBe('0.0.1001@1.2');
  });

  it('retries a lagging mirror node before settling', async () => {
    let calls = 0;
    const registry = new SigningRequestRegistry(
      approver(),
      60_000,
      confirm(async () => (++calls < 3 ? 'not_found' : 'success')),
      opts,
    );
    const { requestId } = registry.submit(SUBMIT);
    await settle();
    expect(calls).toBe(3);
    expect(registry.get(requestId)?.status).toBe('executed');
  });
});

describe('toMirrorTransactionId', () => {
  it('converts the SDK @/. form to the mirror REST -/- form', () => {
    expect(toMirrorTransactionId('0.0.1001@1784663084.300120841')).toBe(
      '0.0.1001-1784663084-300120841',
    );
  });

  it('keeps the account dots intact', () => {
    expect(toMirrorTransactionId('0.0.42@1.2')).toBe('0.0.42-1-2');
  });

  it('passes through an id that is already in mirror form', () => {
    expect(toMirrorTransactionId('0.0.42-1-2')).toBe('0.0.42-1-2');
  });
});

describe('broadcast beats a client-side timeout (no double spend)', () => {
  // A real broadcast that resolves AFTER the request TTL-expired must still be recorded,
  // not silently dropped (which would tell the agent to retry → two transfers land).
  it('records a broadcast that arrives after the request already expired', async () => {
    let fire: (() => void) | undefined;
    const approver = fakeApprover(
      () => new Promise<{ transactionId: string }>(resolve => { fire = () => resolve({ transactionId: '0.0.1001@9.9' }); }),
    );
    const registry = new SigningRequestRegistry(
      approver, 1_000, async () => 'success', { attempts: 2, delayMs: 0, callTimeoutMs: 0 },
    );
    const { requestId } = registry.submit(SUBMIT);

    // TTL lapses before the user approves — a poll flips it to expired.
    expect(registry.get(requestId, Date.now() + 2_000)?.status).toBe('expired');

    // The wallet then broadcasts (late, but real).
    fire!();
    await settle();
    await settle();

    // The broadcast is honoured and mirror-confirmed, not stranded on the stale `expired`.
    const request = registry.get(requestId);
    expect(request?.status).toBe('executed');
    expect(request?.transactionId).toBe('0.0.1001@9.9');
  });

  it('also recovers a broadcast that raced a session_delete (needs_reauth)', async () => {
    let fire: (() => void) | undefined;
    const approver = fakeApprover(
      () => new Promise<{ transactionId: string }>(resolve => { fire = () => resolve({ transactionId: '0.0.1001@8.8' }); }),
    );
    const registry = new SigningRequestRegistry(
      approver, 60_000, async () => 'success', { attempts: 2, delayMs: 0, callTimeoutMs: 0 },
    );
    const { requestId } = registry.submit(SUBMIT);
    registry.markSessionGone('topic-a'); // session dropped mid-flight
    expect(registry.get(requestId)?.status).toBe('needs_reauth');

    fire!();
    await settle();
    await settle();
    expect(registry.get(requestId)?.status).toBe('executed');
  });
});

describe('confirm timeout (M5)', () => {
  it('does not strand a request in confirming when the mirror call hangs', async () => {
    const registry = new SigningRequestRegistry(
      fakeApprover(async () => ({ transactionId: '0.0.1001@1.2' })),
      60_000,
      () => new Promise<ConfirmResult>(() => {}), // hangs, never resolves
      { attempts: 2, delayMs: 0, callTimeoutMs: 15 },
    );
    const { requestId } = registry.submit(SUBMIT);
    await new Promise(resolve => setTimeout(resolve, 120)); // let the per-call timeouts fire
    expect(registry.get(requestId)?.status).toBe('expired');
  });
});

describe('waitForResolution (long-poll)', () => {
  it('resolves as soon as the request reaches a terminal state', async () => {
    let fire: (() => void) | undefined;
    const approver = fakeApprover(
      () => new Promise<{ transactionId: string }>(resolve => { fire = () => resolve({ transactionId: '0.0.1@1' }); }),
    );
    const registry = new SigningRequestRegistry(approver, 60_000); // no confirm fn → executes on wallet word
    const { requestId } = registry.submit(SUBMIT);

    const waiter = registry.waitForResolution(requestId, 5_000);
    // Approve "in the wallet" shortly after — the waiter should resolve to executed, not time out.
    setTimeout(() => fire!(), 50);
    const start = Date.now();
    const result = await waiter;
    expect(result?.status).toBe('executed');
    expect(Date.now() - start).toBeLessThan(2_000); // returned on approval, not at the 5s cap
  });

  it('returns the still-pending state if the user does not act before the timeout', async () => {
    const registry = new SigningRequestRegistry(fakeApprover(() => new Promise(() => {})), 60_000);
    const { requestId } = registry.submit(SUBMIT);
    const result = await registry.waitForResolution(requestId, 300);
    expect(result?.status).toBe('awaiting_approval');
  });

  it('returns immediately for an already-terminal request', async () => {
    const registry = new SigningRequestRegistry(fakeApprover(async () => ({ transactionId: '0.0.1@2' })), 60_000);
    const { requestId } = registry.submit(SUBMIT);
    await settle();
    const start = Date.now();
    const result = await registry.waitForResolution(requestId, 5_000);
    expect(result?.status).toBe('executed');
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('returns undefined for an unknown requestId', async () => {
    const registry = new SigningRequestRegistry(fakeApprover(() => new Promise(() => {})), 60_000);
    expect(await registry.waitForResolution('nope', 300)).toBeUndefined();
  });
});
