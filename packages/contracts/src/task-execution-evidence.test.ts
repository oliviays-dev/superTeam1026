import { describe, expect, it } from "vitest";
import {
  executionDecisionSchema,
  submitTaskAcceptanceEvidenceInputSchema,
  taskAcceptanceItemSchema,
  taskExecutionAnomalySchema,
} from "./index.js";

describe("M1a execution evidence contracts", () => {
  it("keeps layered execution decisions non-cacheable", () => {
    const parsed = executionDecisionSchema.parse({
      projectId: "00000000-0000-4000-8000-000000000001",
      principalId: "local-admin",
      authorization: {
        allowed: true,
        permission: "write",
        grantIds: [],
        reasons: [],
      },
      dispatchEligibility: {
        allowed: false,
        policyRevision: 0,
        reasons: [
          {
            code: "runtime_unavailable",
            message: "Runtime changed",
            source: "dispatch.runtime",
          },
        ],
      },
      decidedAt: "2026-11-13T00:00:00.000Z",
      cacheable: false,
    });
    expect(parsed.authorization.allowed).toBe(true);
    expect(parsed.dispatchEligibility.allowed).toBe(false);
    expect(parsed.cacheable).toBe(false);
  });

  it("requires typed evidence and stable acceptance revisions", () => {
    expect(() =>
      submitTaskAcceptanceEvidenceInputSchema.parse({
        runId: "00000000-0000-4000-8000-000000000003",
        items: [
          {
            acceptanceItemId: "00000000-0000-4000-8000-000000000004",
            acceptanceItemRevision: 1,
            evidenceRefs: [
              {
                kind: "artifact",
                refId: "00000000-0000-4000-8000-000000000005",
                digest: "not-a-digest",
              },
            ],
          },
        ],
      }),
    ).toThrow();
    expect(
      taskAcceptanceItemSchema.parse({
        id: "00000000-0000-4000-8000-000000000004",
        taskId: "00000000-0000-4000-8000-000000000002",
        position: 0,
        requirement: "Evidence is complete",
        required: true,
        revision: 1,
        contentDigest: "a".repeat(64),
        deprecatedAt: null,
      }).required,
    ).toBe(true);
  });

  it("models anomaly lifecycle without an abnormal TaskStatus", () => {
    const anomaly = taskExecutionAnomalySchema.parse({
      id: "00000000-0000-4000-8000-000000000006",
      taskId: "00000000-0000-4000-8000-000000000002",
      code: "missing_acceptance",
      message: "One required item is missing",
      runId: "00000000-0000-4000-8000-000000000003",
      runAttempt: 1,
      eventId: null,
      status: "active",
      occurrence: 1,
      detectedAt: "2026-11-13T00:00:00.000Z",
      clearedAt: null,
      clearedReason: null,
      revision: 1,
    });
    expect(anomaly.status).toBe("active");
  });
});
