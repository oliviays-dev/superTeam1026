import { describe, expect, it } from "vitest";
import {
  MCP_PROJECT_SOURCE_FLAG,
  MCP_PROJECT_SOURCE_READ_PROTOCOL,
  businessChainSourceRefSchema,
  projectSourceMcpReadIntentSchema,
  projectSourceMcpToolDataSchema,
} from "./index.js";

describe("M13d project source contracts", () => {
  it("keeps the MCP read flag off by name and requires a read-only binding", () => {
    expect(MCP_PROJECT_SOURCE_FLAG).toBe("project.source.mcp");
    expect(() =>
      businessChainSourceRefSchema.parse({
        refKey: "erp:order:42",
        sourceKind: "mcp",
        sourceSystem: "erp",
        objectType: "order",
        objectId: "42",
        path: "amount",
        required: true,
      }),
    ).toThrow(/provider/);
    expect(
      businessChainSourceRefSchema.parse({
        refKey: "erp:order:42",
        sourceKind: "mcp",
        sourceSystem: "erp",
        objectType: "order",
        objectId: "42",
        path: "amount",
        required: true,
        providerId: "00000000-0000-4000-8000-000000000001",
        providerVersionId: "00000000-0000-4000-8000-000000000002",
        providerRevision: 1,
        toolKey: "a".repeat(64),
        readOnly: true,
      }),
    ).toMatchObject({ readOnly: true });
  });

  it("accepts only the structured read protocol and bound intent", () => {
    expect(
      projectSourceMcpToolDataSchema.parse({
        protocol: MCP_PROJECT_SOURCE_READ_PROTOCOL,
        sourceRevision: "v1",
        observedAt: new Date().toISOString(),
        effectiveAt: null,
        freshUntil: new Date(Date.now() + 30_000).toISOString(),
        payload: { amount: 42 },
        alerts: [],
      }),
    ).toMatchObject({ payload: { amount: 42 } });
    expect(() =>
      projectSourceMcpToolDataSchema.parse({
        protocol: "raw-response",
        observedAt: new Date().toISOString(),
        payload: {},
      }),
    ).toThrow();
    expect(() =>
      projectSourceMcpReadIntentSchema.parse({
        projectId: "00000000-0000-4000-8000-000000000001",
        refKey: "erp:order:42",
        runId: "00000000-0000-4000-8000-000000000002",
        runAttempt: 1,
        gateId: "00000000-0000-4000-8000-000000000003",
        requestId: "00000000-0000-4000-8000-000000000004",
        idempotencyKey: "idempotent-source-read",
        toolKey: "a".repeat(64),
      }),
    ).toThrow();
  });
});
