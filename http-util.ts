// Shared HTTP helpers for the forge's surfaces: JSON answers (always with a request id),
// body reading, and the bearer-token gate.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const VIEWER = { login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid', id: 1000 };
export const STRANGER = { login: 'olgabauer', id: 1002 };

let requestSeq = 0;

export function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(text);
}

export function sendEmpty(res: ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId(), ...extra });
  res.end();
}

export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false; error: string } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid JSON' };
  }
}

/** The bearer token the suite presents; null when the env did not set one (local runs). */
export function shopToken(): string | null {
  const t = process.env.MAKEFUN_SHOP_TOKEN;
  return t && t.length > 0 ? t : null;
}

/** True when the request carries the shop token. With no token configured, any Bearer passes. */
export function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const expected = shopToken();
  if (expected === null) return true;
  return h === `Bearer ${expected}`;
}

export function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

export function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}
