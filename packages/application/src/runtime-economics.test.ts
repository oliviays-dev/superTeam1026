import { describe, expect, it } from "vitest";
import type { RuntimeRunSource } from "@pluginmax/database";
import {
  buildRunTimeline,
  decodeExecutionHistoryCursor,
  encodeExecutionHistoryCursor,
  executionHistoryFingerprint,
  reconcileRunEconomics,
} from "./runtime-economics.js";

const base = Date.parse("2026-10-27T00:00:00.000Z");
const at = (seconds: number): Date => new Date(base + seconds * 1_000);

function source(overrides: Partial<RuntimeRunSource> = {}): RuntimeRunSource {
  return {
    run: {
      id: "00000000-0000-4000-8000-000000000001",
      workspaceId: "workspace-fixture",
      projectId: "00000000-0000-4000-8000-000000000002",
      taskId: "00000000-0000-4000-8000-000000000003",
      meetingTurnId: null,
      directChatTurnId: null,
      agentId: "00000000-0000-4000-8000-000000000004",
      agentRuntimeKind: "fake",
      status: "completed",
      contextType: "task",
      contextId: "00000000-0000-4000-8000-000000000003",
      runtimeId: "builtin:fake",
      runtimeRevision: 1,
      provider: "fake",
      model: null,
      createdAt: at(0).toISOString(),
      startedAt: at(7).toISOString(),
      endedAt: at(10).toISOString(),
    },
    jobAttempts: [
      {
        id: "00000000-0000-4000-8000-000000000005",
        job_id: "00000000-0000-4000-8000-000000000006",
        attempt: 1,
        worker_id: "worker-1",
        status: "completed",
        started_at: at(6),
        ended_at: at(9),
      },
    ],
    runEvents: [
      {
        id: "00000000-0000-4000-8000-000000000007",
        type: "run.started",
        created_at: at(7),
      },
      {
        id: "00000000-0000-4000-8000-000000000008",
        type: "run.completed",
        created_at: at(10),
      },
    ],
    taskEvents: [],
    gates: [
      {
        gate_id: "00000000-0000-4000-8000-000000000009",
        status: "approved",
        requested_at: at(2),
        decided_at: at(5),
      },
    ],
    runtimeEffects: [
      {
        id: "00000000-0000-4000-8000-000000000010",
        status: "completed",
        started_at: at(7),
        completed_at: at(9),
      },
    ],
    outbox: [
      {
        id: "00000000-0000-4000-8000-000000000011",
        topic: "runtime.usage.recorded",
        status: "pending",
        created_at: at(10),
      },
    ],
    receipts: [],
    ...overrides,
  };
}

describe("runtime economics timeline", () => {
  it("separates queue, Claim, blocking Gate, running and settlement time", () => {
    const timeline = buildRunTimeline(source(), at(20));
    expect(timeline.durations).toMatchObject({
      observedTotalMs: 10_000,
      queuedMs: 3_000,
      waitingApprovalMs: 3_000,
      claimedMs: 1_000,
      runningMs: 2_000,
      settlementMs: 1_000,
      unclassifiedMs: 0,
    });
    expect(timeline.segments.map((segment) => segment.phase)).toEqual([
      "queued",
      "waiting_approval",
      "queued",
      "claimed",
      "running",
      "settlement",
    ]);
  });

  it("accounts for needsInput, retry and recovery windows", () => {
    const timeline = buildRunTimeline(
      source({
        run: {
          ...source().run,
          endedAt: at(18).toISOString(),
        },
        gates: [],
        taskEvents: [
          {
            id: "needs-input",
            kind: "input",
            data: { from: "queued", to: "needs_input" },
            created_at: at(1),
          },
          {
            id: "input-provided",
            kind: "input",
            data: { from: "needs_input", to: "queued" },
            created_at: at(3),
          },
        ],
        runEvents: [
          {
            id: "retry",
            type: "job.retry_scheduled",
            created_at: at(8),
          },
          {
            id: "recovery",
            type: "run.interrupted",
            created_at: at(11),
          },
          {
            id: "completed",
            type: "run.completed",
            created_at: at(18),
          },
        ],
        jobAttempts: [
          {
            ...source().jobAttempts[0]!,
            started_at: at(6),
            ended_at: at(8),
          },
        ],
        runtimeEffects: [],
      }),
      at(20),
    );
    expect(timeline.durations.needsInputMs).toBe(2_000);
    expect(timeline.durations.retryWaitMs).toBe(3_000);
    expect(timeline.durations.recoveryMs).toBe(7_000);
    expect(timeline.durations.observedTotalMs).toBe(18_000);
  });
});

describe("runtime economics reconciliation", () => {
  it("fails closed on missing usage and exposes projection mismatches", () => {
    const result = reconcileRunEconomics(
      source({ receipts: [], outbox: [] }),
      at(20),
    );
    expect(result.status).toBe("unknown");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "usage_receipt_missing" }),
      ]),
    );
    const missingOutbox = reconcileRunEconomics(
      source({
        receipts: [
          {
            id: "00000000-0000-4000-8000-000000000020",
            runId: source().run.id,
            runAttempt: 1,
            jobId: null,
            jobAttempt: 1,
            workspaceId: source().run.workspaceId,
            projectId: source().run.projectId,
            contextType: "task",
            contextId: source().run.contextId,
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
            unknownFields: ["totalTokens"],
            durationMs: 1_000,
            payloadDigest: "a".repeat(64),
            recordedAt: at(10).toISOString(),
          },
        ],
        outbox: [],
      }),
      at(20),
    );
    expect(missingOutbox.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "usage_outbox_missing" }),
      ]),
    );
  });

  it("binds Cursor payloads to workspace and query fingerprint", () => {
    const fingerprint = executionHistoryFingerprint({
      workspaceId: "workspace-a",
      status: "completed",
    });
    const cursor = encodeExecutionHistoryCursor({
      workspaceId: "workspace-a",
      fingerprint,
      createdAt: at(0).toISOString(),
      id: "00000000-0000-4000-8000-000000000001",
    });
    expect(decodeExecutionHistoryCursor(cursor)).toMatchObject({
      workspaceId: "workspace-a",
      fingerprint,
    });
    expect(() => decodeExecutionHistoryCursor("not-a-cursor")).toThrow(
      "execution_history_cursor_conflict",
    );
  });
});
