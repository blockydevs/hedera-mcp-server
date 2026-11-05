import type { Response } from 'express';

/** Extracts a JSON-RPC request id, preserving a legitimate `0` (never mapping it to null). */
export function rpcId(body: unknown): string | number | null {
  const id = (body as { id?: string | number } | undefined)?.id;
  return id ?? null;
}

/** Sends a JSON-RPC 2.0 error response with a consistent shape. */
export function rpcError(res: Response, status: number, code: number, message: string, id: string | number | null): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id });
}
