/** MCP tool-result envelopes, shared by the wallet tools and the write-tool wrapper. */

/**
 * One declared shape for every result these helpers produce, with `isError` optional.
 *
 * Without this, `mcpText` and `mcpError` infer two structurally different types, and any caller
 * that can return either ends up with a union whose `isError` is unreachable — so a test (or a
 * caller) cannot ask "was this an error?" without a cast. Since `isError` is the only signal
 * that a wallet delivery was REFUSED rather than accepted, it has to be legible on the type.
 */
// A `type` alias, not an `interface`: the MCP SDK's CallToolResult carries an index signature,
// and only type aliases get the implicit index signature needed to stay assignable to it.
export type McpResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

export function mcpText(text: string): McpResult {
  return { content: [{ type: 'text', text }] };
}

export function mcpJson(value: unknown): McpResult {
  return mcpText(JSON.stringify(value, null, 2));
}

export function mcpError(message: string): McpResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
