import { describe, expect, it } from "vitest";
import {
  normalizeRuntimeUsage,
  summarizeRuntimeUsage,
  type RuntimeUsageReceipt,
} from "./runtime-economics.js";

function receipt(
  overrides: Partial<RuntimeUsageReceipt> = {},
): RuntimeUsageReceipt {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    runId: "00000000-0000-4000-8000-000000000002",
    runAttempt: 1,
    jobId: null,
    jobAttempt: 1,
    workspaceId: "workspace-fixture",
    projectId: null,
    contextType: "task",
    contextId: "00000000-0000-4000-8000-000000000003",
    runtimeId: "builtin:fake",
    runtimeRevision: 1,
    provider: "fake",
    model: null,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cachedInputTokens: null,
    reasoningTokens: null,
    costAmount: null,
    costCurrency: null,
    source: "unavailable",
    unknownFields: [
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "costAmount",
      "costCurrency",
    ],
    durationMs: 500,
    payloadDigest: "a".repeat(64),
    recordedAt: "2026-10-27T00:00:00.000Z",
    ...overrides,
  };
}

describe("runtime economics contracts", () => {
  it("preserves unknown provider usage instead of inventing zeroes", () => {
    expect(normalizeRuntimeUsage(undefined)).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costAmount: null,
      costCurrency: null,
      source: "unavailable",
      unknownFields: expect.arrayContaining([
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "costAmount",
        "costCurrency",
      ]),
    });
  });

  it("derives only total tokens and keeps cost unknown when unreported", () => {
    expect(
      normalizeRuntimeUsage({
        inputTokens: 120,
        outputTokens: 30,
      }),
    ).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      costAmount: null,
      source: "mixed",
      unknownFields: expect.arrayContaining(["costAmount", "costCurrency"]),
    });
  });

  it("keeps unconvertible cost unknown when no currency is reported", () => {
    expect(
      normalizeRuntimeUsage({
        inputTokens: 50,
        outputTokens: 10,
        costAmount: 0.5,
      }),
    ).toMatchObject({
      totalTokens: 60,
      costAmount: null,
      costCurrency: null,
      unknownFields: expect.arrayContaining(["costAmount", "costCurrency"]),
    });
  });

  it("sums known receipts and reports unknown sample coverage separately", () => {
    const summary = summarizeRuntimeUsage([
      receipt({
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        costAmount: 0.03,
        costCurrency: "USD",
        source: "runtime-reported",
        unknownFields: [],
      }),
      receipt({
        runAttempt: 2,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
      }),
    ]);
    expect(summary).toMatchObject({
      sampleCount: 2,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      costAmount: 0.03,
      costCurrencies: ["USD"],
      unknownSampleCount: 1,
    });
  });
});
