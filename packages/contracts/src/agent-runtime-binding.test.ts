import { describe, expect, it } from "vitest";
import {
  agentRuntimeBindingSchema,
  agentRuntimePreflightInputSchema,
  runtimePreflightErrorCodeSchema,
  runtimePreflightRemediation,
  removeAgentRuntimeBindingInputSchema,
  setAgentRuntimeBindingInputSchema,
} from "./agent-runtime-binding.js";

describe("agent runtime binding contracts", () => {
  const binding = {
    id: "00000000-0000-4000-8000-000000000010",
    agentId: "00000000-0000-4000-8000-000000000001",
    runtimeId: "00000000-0000-4000-8000-000000000020",
    executionMode: "external",
    status: "active",
    revision: 1,
    boundBy: "runtime-owner",
    disabledBy: null,
    disabledReason: null,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
    disabledAt: null,
  } as const;

  it("defines binding revision and idempotent command inputs", () => {
    expect(agentRuntimeBindingSchema.parse(binding)).toEqual(binding);
    expect(
      setAgentRuntimeBindingInputSchema.parse({
        runtimeId: binding.runtimeId,
        expectedRevision: 0,
      }),
    ).toEqual({
      runtimeId: binding.runtimeId,
      expectedRevision: 0,
    });
    expect(() =>
      removeAgentRuntimeBindingInputSchema.parse({ expectedRevision: 0 }),
    ).toThrow();
  });

  it("normalizes preflight requirements for the application safety check", () => {
    expect(
      agentRuntimePreflightInputSchema.parse({
        expectedRevision: 1,
        workspaceId: "project/safe-workspace",
        requiredCapabilities: ["structuredPlan", "structuredPlan"],
      }),
    ).toMatchObject({
      workspaceId: "project/safe-workspace",
      requiredCapabilities: ["structuredPlan"],
    });
    expect(
      agentRuntimePreflightInputSchema.parse({
        expectedRevision: 1,
        workspaceId: "../outside",
      }).workspaceId,
    ).toBe("../outside");
    expect(
      runtimePreflightErrorCodeSchema.parse("runtime_binding_missing"),
    ).toBe("runtime_binding_missing");
  });

  it("provides actionable remediation for every stable preflight code", () => {
    for (const code of runtimePreflightErrorCodeSchema.options) {
      expect(runtimePreflightRemediation(code).length).toBeGreaterThan(10);
    }
  });
});
