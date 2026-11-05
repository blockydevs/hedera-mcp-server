import { describe, it, expect } from 'vitest';
import { AgentMode } from '@hashgraph/hedera-agent-kit';
import { parseArgs } from '../src/options.js';

/**
 * The non-custodial guarantee rests on the kit running in RETURN_BYTES mode. Its strategy
 * dispatch treats ONLY the exact string `returnBytes` as the no-signing path and falls through
 * to the executing strategy for anything else — undefined included — so both the default and
 * the validation have to be fail-safe here rather than merely conventional.
 */
describe('--agent-mode is pinned to RETURN_BYTES', () => {
  it('defaults to RETURN_BYTES when the flag is omitted', () => {
    // Leaving mode undefined would make the kit resolve to the EXECUTING strategy — the
    // opposite of what this server is allowed to do.
    expect(parseArgs([]).context?.mode).toBe(AgentMode.RETURN_BYTES);
  });

  it('accepts an explicit returnBytes', () => {
    expect(parseArgs(['--agent-mode=returnBytes']).context?.mode).toBe(AgentMode.RETURN_BYTES);
  });

  it('refuses autonomous, which the upstream enum would otherwise admit', () => {
    // `autonomous` IS a valid AgentMode, so validating against Object.values(AgentMode)
    // would accept exactly the server-side-signing mode the check exists to refuse.
    expect(() => parseArgs(['--agent-mode=autonomous'])).toThrow(/non-custodial/);
  });

  it('refuses kit 4.1.0 execute-capable modes, so the accepted set cannot widen upstream', () => {
    expect(() => parseArgs(['--agent-mode=customExecuteTx'])).toThrow(/non-custodial/);
    expect(() => parseArgs(['--agent-mode=customReturnBytes'])).toThrow(/non-custodial/);
  });

  it('still refuses a value that is not a mode at all', () => {
    expect(() => parseArgs(['--agent-mode=execute'])).toThrow(/Invalid agent-mode/);
  });

  it('does not let an unrelated flag disturb the mode', () => {
    expect(parseArgs(['--ledger-id=mainnet']).context?.mode).toBe(AgentMode.RETURN_BYTES);
  });
});
