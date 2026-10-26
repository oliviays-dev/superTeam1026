import { describe, expect, it } from "vitest";
import {
  createChildTraceContext,
  createRootTraceContext,
  formatTraceparent,
  parseTraceparent,
} from "./trace.js";

describe("W3C trace context", () => {
  it("round-trips a valid traceparent and creates child spans", () => {
    const root = createRootTraceContext();
    const parsed = parseTraceparent(formatTraceparent(root));
    expect(parsed).toEqual(root);
    const child = createChildTraceContext(root);
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentSpanId).toBe(root.spanId);
    expect(child.spanId).not.toBe(root.spanId);
  });

  it("rejects malformed, all-zero, and forged trace context", () => {
    expect(parseTraceparent("forged")).toBeUndefined();
    expect(
      parseTraceparent(
        "00-00000000000000000000000000000000-1111111111111111-01",
      ),
    ).toBeUndefined();
    expect(
      parseTraceparent(
        "00-11111111111111111111111111111111-0000000000000000-01",
      ),
    ).toBeUndefined();
    expect(
      parseTraceparent(
        "ff-11111111111111111111111111111111-1111111111111111-01",
      ),
    ).toBeUndefined();
  });
});
