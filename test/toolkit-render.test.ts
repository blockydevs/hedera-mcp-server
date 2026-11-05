import { describe, it, expect } from 'vitest';
import { renderToolResult } from '../src/signing/toolkit.js';
import { WALLET_DELIVERY } from '../src/signing/wallet-strategy.js';

/**
 * `Tool.execute` is declared `=> Promise<any>` and `BaseTool.execute` converts every thrown
 * error into a plain result envelope rather than rethrowing, so this function is the only place
 * that can tell a refusal from a success. Treating an unrecognised shape as success would mean
 * handing the model a transaction that never passed the guards.
 */

const approval = {
  requestId: 'req-1',
  status: 'awaiting_approval',
  summary: 'Transfer — 0.0.2002 receives 5 ℏ',
  walletVerifiable: true,
  hint: 'Delivered to the wallet.',
};

describe('renderToolResult', () => {
  it('emits the approval envelope and NEVER the transaction bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const out = renderToolResult({ bytes, status: 'SUCCESS', kind: WALLET_DELIVERY, approval });

    expect(out.isError).toBeUndefined();
    const text = out.content[0].text;
    // toEqual proves there are no extra keys; the explicit check names the one that matters.
    expect(JSON.parse(text)).toEqual(approval);
    expect(text).not.toContain('bytes');
  });

  it('surfaces a refusal as an MCP error, not a successful result', () => {
    const out = renderToolResult({
      bytes: new Uint8Array(),
      status: 'ERROR',
      kind: WALLET_DELIVERY,
      approvalRefused: 'Transaction debits 0.0.9999, which is not the paired account 0.0.1001.',
    });

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/debits 0\.0\.9999/);
  });

  it("surfaces the kit's own error envelope as an MCP error", () => {
    const out = renderToolResult({
      raw: { status: 'ERROR', error: 'boom' },
      humanMessage: 'Failed to execute Associate Token: boom',
    });

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/Failed to execute/);
  });

  it('passes a query tool result through unchanged', () => {
    const queryResult = { raw: { status: 'SUCCESS', balance: 42 }, humanMessage: 'Balance is 42' };
    const out = renderToolResult(queryResult);

    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0].text)).toEqual(queryResult);
  });

  it('passes a plain string result through', () => {
    expect(renderToolResult('done').content[0].text).toBe('done');
  });

  // The brand is what makes this safe. Discriminating on "has an approval-ish field" would let
  // any shape carrying those keys be rendered as a delivered approval; only results the
  // strategy actually produced carry `kind`.
  it('does not treat an unbranded look-alike as a delivered approval', () => {
    const forged = { bytes: new Uint8Array([9]), status: 'SUCCESS', approval };
    const out = renderToolResult(forged);

    // Rendered as an ordinary tool result, not as our approval envelope.
    expect(JSON.parse(out.content[0].text)).toEqual(JSON.parse(JSON.stringify(forged)));
  });
});
