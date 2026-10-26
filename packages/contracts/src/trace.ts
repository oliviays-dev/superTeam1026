import { z } from "zod";

export const traceIdPattern = /^[0-9a-f]{32}$/;
export const spanIdPattern = /^[0-9a-f]{16}$/;
export const traceIdSchema = z.string().regex(traceIdPattern);
export const spanIdSchema = z.string().regex(spanIdPattern);

export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly traceFlags: number;
}

function isNonZeroHex(value: string): boolean {
  return /^0+$/.test(value) === false;
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function newTraceId(): string {
  let traceId = randomHex(16);
  while (!isNonZeroHex(traceId)) traceId = randomHex(16);
  return traceId;
}

export function newSpanId(): string {
  let spanId = randomHex(8);
  while (!isNonZeroHex(spanId)) spanId = randomHex(8);
  return spanId;
}

export function createRootTraceContext(): TraceContext {
  return {
    traceId: newTraceId(),
    spanId: newSpanId(),
    parentSpanId: null,
    traceFlags: 1,
  };
}

export function createChildTraceContext(
  parent: Pick<TraceContext, "traceId" | "spanId" | "traceFlags">,
): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: newSpanId(),
    parentSpanId: parent.spanId,
    traceFlags: parent.traceFlags,
  };
}

export function parseTraceparent(
  value: string | null | undefined,
): TraceContext | undefined {
  if (value === null || value === undefined) return undefined;
  const parts = value.trim().toLowerCase().split("-");
  if (parts.length !== 4) return undefined;
  const [version, traceId, spanId, flags] = parts;
  if (
    version === undefined ||
    traceId === undefined ||
    spanId === undefined ||
    flags === undefined
  ) {
    return undefined;
  }
  if (
    !/^[0-9a-f]{2}$/.test(version) ||
    version === "ff" ||
    !traceIdPattern.test(traceId) ||
    !isNonZeroHex(traceId) ||
    !spanIdPattern.test(spanId) ||
    !isNonZeroHex(spanId) ||
    !/^[0-9a-f]{2}$/.test(flags)
  ) {
    return undefined;
  }
  return {
    traceId,
    spanId,
    parentSpanId: null,
    traceFlags: Number.parseInt(flags, 16),
  };
}

export function formatTraceparent(context: TraceContext): string {
  const flags = (context.traceFlags & 0xff).toString(16).padStart(2, "0");
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}
