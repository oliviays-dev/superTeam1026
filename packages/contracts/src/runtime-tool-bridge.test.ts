import { describe, expect, it } from "vitest";
import {
  runtimeMcpToolRequestSchema,
  runtimeMcpToolResultSchema,
} from "./runtime-tool-bridge.js";

describe("M13c Runtime Tool Request contracts", () => {
  const request = {
    requestId: "00000000-0000-4000-8000-000000130001",
    toolKey: "a".repeat(64),
    gateId: "00000000-0000-4000-8000-000000130002",
    idempotencyKey: "runtime-tool-request-0001",
    arguments: { orderId: "order-42" },
  };

  it("accepts only the Worker-resolved Runtime intent shape", () => {
    expect(runtimeMcpToolRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      runtimeMcpToolRequestSchema.parse({
        ...request,
        runId: "00000000-0000-4000-8000-000000130003",
      }),
    ).toThrow();
    expect(() =>
      runtimeMcpToolRequestSchema.parse({
        ...request,
        envelopeId: "model-supplied-envelope",
      }),
    ).toThrow();
  });

  it("supports status-only and in-memory result delivery", () => {
    expect(
      runtimeMcpToolResultSchema.parse({
        requestId: request.requestId,
        callId: null,
        status: "succeeded",
        deduplicated: true,
        resultAvailable: false,
        errorCategory: null,
        errorCode: null,
        errorMessage: null,
      }),
    ).toMatchObject({ resultAvailable: false });
    expect(
      runtimeMcpToolResultSchema.parse({
        requestId: request.requestId,
        callId: null,
        status: "succeeded",
        deduplicated: false,
        resultAvailable: true,
        result: { content: [] },
        errorCategory: null,
        errorCode: null,
        errorMessage: null,
      }),
    ).toMatchObject({ resultAvailable: true });
  });
});
