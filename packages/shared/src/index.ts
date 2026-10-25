import { isAbsolute, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

export const COLLAB_API_PREFIX = "/api/collab";
export const COLLAB_TOKEN_HEADER = "authorization";

export interface HeaderLike {
  get(name: string): string | null;
}

export function sameOrigin(
  origin: string | null | undefined,
  host: string | null | undefined,
): boolean {
  if (
    origin === null ||
    origin === undefined ||
    origin === "" ||
    host === null ||
    host === undefined ||
    host === ""
  )
    return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function bearerToken(headers: HeaderLike): string | undefined {
  const value = headers.get(COLLAB_TOKEN_HEADER);
  if (value === null || !value.startsWith("Bearer ")) return undefined;
  const token = value.slice("Bearer ".length).trim();
  return token === "" ? undefined : token;
}

export function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (normalizedRoot === normalizedCandidate) return true;
  return normalizedCandidate.startsWith(
    normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep,
  );
}

export function resolveWithin(root: string, untrustedPath: string): string {
  if (untrustedPath.includes("\0"))
    throw new Error("path contains a null byte");
  const absolute = isAbsolute(untrustedPath)
    ? untrustedPath
    : resolve(root, untrustedPath);
  const normalized = resolve(absolute);
  if (!isWithin(root, normalized))
    throw new Error(`path escapes root: ${untrustedPath}`);
  return normalized;
}

export function sendJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes = 1024 * 1024,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += buffer.byteLength;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new Error("request body is required");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
