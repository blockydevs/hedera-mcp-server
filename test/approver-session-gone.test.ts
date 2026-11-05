import { describe, it, expect } from 'vitest';
import { WalletApprover } from '../src/wallet/approver.js';

// Exercises the private emit/replay buffer without a real WalletConnect client: a
// session_delete that arrives before onSessionGone() is attached must not be lost.
describe('WalletApprover session-gone buffering', () => {
  const approver = () => new WalletApprover(0 as any, {} as any) as any;

  it('replays a pre-subscription event to a late listener', () => {
    const a = approver();
    a.emitSessionGone('topic-early'); // fires before any listener
    const seen: string[] = [];
    a.onSessionGone((t: string) => seen.push(t));
    expect(seen).toEqual(['topic-early']);
  });

  it('delivers live events once a listener exists', () => {
    const a = approver();
    const seen: string[] = [];
    a.onSessionGone((t: string) => seen.push(t));
    a.emitSessionGone('topic-live');
    expect(seen).toEqual(['topic-live']);
  });

  it('does not double-deliver a buffered event to a second listener', () => {
    const a = approver();
    a.emitSessionGone('topic-x');
    const first: string[] = [];
    const second: string[] = [];
    a.onSessionGone((t: string) => first.push(t));  // drains the buffer
    a.onSessionGone((t: string) => second.push(t)); // buffer already empty
    expect(first).toEqual(['topic-x']);
    expect(second).toEqual([]);
  });
});
