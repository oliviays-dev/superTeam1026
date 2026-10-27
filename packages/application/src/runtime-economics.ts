import { createHash } from "node:crypto";
import type {
  ExecutionHistoryItem,
  RunDurationBreakdown,
  RunEconomicsReconciliation,
  RunExecutionEconomics,
  RunPhase,
  RunPhaseSegment,
  RuntimeEconomicsBucket,
  RuntimeUsageReceipt,
  RuntimeUsageSummary,
  WorkspaceRuntimeEconomics,
} from "@pluginmax/contracts";
import { summarizeRuntimeUsage } from "@pluginmax/contracts";
import type { RuntimeRunSource } from "@pluginmax/database";

const phaseDurations = [
  "queued",
  "claimed",
  "waiting_approval",
  "running",
  "needs_input",
  "retry_wait",
  "recovery",
  "settlement",
  "terminal",
] as const satisfies readonly RunPhase[];

type TimelineSource = RunPhaseSegment["source"];

interface TimelineTransition {
  readonly at: number;
  readonly phase: RunPhase;
  readonly source: TimelineSource;
  readonly sourceId: string | null;
}

const phasePriority: Record<RunPhase, number> = {
  queued: 0,
  needs_input: 1,
  recovery: 2,
  retry_wait: 3,
  waiting_approval: 4,
  claimed: 5,
  running: 6,
  settlement: 7,
  terminal: 8,
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function time(value: Date | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function emptyDurations(): RunDurationBreakdown {
  return {
    observedTotalMs: 0,
    queuedMs: 0,
    claimedMs: 0,
    waitingApprovalMs: 0,
    runningMs: 0,
    needsInputMs: 0,
    retryWaitMs: 0,
    recoveryMs: 0,
    settlementMs: 0,
    unclassifiedMs: 0,
  };
}

function durationKey(phase: RunPhase): keyof RunDurationBreakdown {
  switch (phase) {
    case "queued":
      return "queuedMs";
    case "claimed":
      return "claimedMs";
    case "waiting_approval":
      return "waitingApprovalMs";
    case "running":
      return "runningMs";
    case "needs_input":
      return "needsInputMs";
    case "retry_wait":
      return "retryWaitMs";
    case "recovery":
      return "recoveryMs";
    case "settlement":
    case "terminal":
      return "settlementMs";
  }
}

export function buildRunTimeline(
  source: RuntimeRunSource,
  now = new Date(),
): {
  readonly segments: RunPhaseSegment[];
  readonly durations: RunDurationBreakdown;
} {
  const createdAt = time(source.run.createdAt);
  if (createdAt === undefined) {
    return { segments: [], durations: emptyDurations() };
  }
  const endedAt = time(source.run.endedAt) ?? now.getTime();
  const finalAt = Math.max(createdAt, endedAt);
  const transitions: TimelineTransition[] = [];
  const add = (
    value: Date | string | null | undefined,
    phase: RunPhase,
    sourceName: TimelineSource,
    sourceId: string | null,
  ) => {
    const parsed = time(value);
    if (parsed === undefined || parsed < createdAt || parsed > finalAt) return;
    transitions.push({ at: parsed, phase, source: sourceName, sourceId });
  };

  for (const gate of source.gates) {
    add(gate.requested_at, "waiting_approval", "execution-gate", gate.gate_id);
    if (gate.decided_at !== null) {
      add(gate.decided_at, "queued", "execution-gate", gate.gate_id);
    }
  }
  for (const attempt of source.jobAttempts) {
    add(attempt.started_at, "claimed", "job-attempt", attempt.id);
  }
  for (const event of source.runEvents) {
    if (event.type === "run.started") {
      add(event.created_at, "running", "run-event", event.id);
    } else if (
      event.type === "run.interrupted" ||
      event.type === "runtime.effect_cancelled"
    ) {
      add(event.created_at, "recovery", "run-event", event.id);
    } else if (event.type === "job.retry_scheduled") {
      add(event.created_at, "retry_wait", "run-event", event.id);
    } else if (
      event.type === "run.recovered" ||
      event.type === "job.manually_recovered"
    ) {
      add(event.created_at, "queued", "run-event", event.id);
    } else if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      add(event.created_at, "terminal", "run-event", event.id);
    }
  }
  for (const event of source.taskEvents) {
    const from = event.data?.from;
    const to = event.data?.to;
    if (event.kind === "input" && to === "needs_input") {
      add(event.created_at, "needs_input", "task-event", event.id);
    } else if (
      event.kind === "input" &&
      from === "needs_input" &&
      to === "queued"
    ) {
      add(event.created_at, "queued", "task-event", event.id);
    }
  }
  for (const effect of source.runtimeEffects) {
    add(effect.started_at, "running", "runtime-effect", effect.id);
    if (effect.completed_at !== null) {
      add(effect.completed_at, "settlement", "runtime-effect", effect.id);
    }
  }
  add(source.run.startedAt, "running", "run", source.run.id);
  add(source.run.endedAt, "terminal", "run", source.run.id);

  transitions.sort(
    (left, right) =>
      left.at - right.at ||
      phasePriority[left.phase] - phasePriority[right.phase],
  );
  const segments: RunPhaseSegment[] = [];
  const durations = emptyDurations();
  let phase: RunPhase = "queued";
  let sourceName: TimelineSource = "run";
  let sourceId: string | null = source.run.id;
  let cursor = createdAt;
  let index = 0;
  while (index < transitions.length) {
    const at = transitions[index]!.at;
    if (at > cursor) {
      const durationMs = Math.max(0, at - cursor);
      segments.push({
        phase,
        startAt: new Date(cursor).toISOString(),
        endAt: new Date(at).toISOString(),
        durationMs,
        source: sourceName,
        sourceId,
      });
      const key = durationKey(phase);
      durations[key] += durationMs;
    }
    while (index < transitions.length && transitions[index]!.at === at) {
      const transition = transitions[index]!;
      phase = transition.phase;
      sourceName = transition.source;
      sourceId = transition.sourceId;
      index += 1;
    }
    cursor = at;
  }
  if (finalAt > cursor) {
    const durationMs = finalAt - cursor;
    segments.push({
      phase,
      startAt: new Date(cursor).toISOString(),
      endAt: new Date(finalAt).toISOString(),
      durationMs,
      source: sourceName,
      sourceId,
    });
    durations[durationKey(phase)] += durationMs;
  }
  durations.observedTotalMs = Math.max(0, finalAt - createdAt);
  const classified = phaseDurations.reduce(
    (total, item) => total + durations[durationKey(item)],
    0,
  );
  durations.unclassifiedMs = Math.max(
    0,
    durations.observedTotalMs - classified,
  );
  return { segments, durations };
}

export function reconcileRunEconomics(
  source: RuntimeRunSource,
  now = new Date(),
): RunEconomicsReconciliation {
  const terminal = new Set([
    "completed",
    "failed",
    "cancelled",
    "timeout",
    "interrupted",
  ]);
  const issues: RunEconomicsReconciliation["issues"][number][] = [];
  const add = (
    code: RunEconomicsReconciliation["issues"][number]["code"],
    severity: "info" | "warning" | "error",
    sourceName: RunEconomicsReconciliation["issues"][number]["source"],
    message: string,
  ) => issues.push({ code, severity, source: sourceName, message });
  if (terminal.has(source.run.status) && source.run.endedAt === null) {
    add(
      "run_not_settled",
      "error",
      "run",
      "Terminal Run is missing its settlement timestamp",
    );
  }
  const hasTerminalEvent = source.runEvents.some((event) =>
    ["run.completed", "run.failed", "run.cancelled"].includes(event.type),
  );
  if (terminal.has(source.run.status) && !hasTerminalEvent) {
    add(
      "run_event_terminal_missing",
      "warning",
      "run-event",
      "Terminal Run has no matching Run Event",
    );
  }
  if (
    source.run.status === "completed" &&
    source.runtimeEffects.every((effect) => effect.status !== "completed")
  ) {
    add(
      "runtime_effect_missing",
      "warning",
      "runtime-effect",
      "Completed Run has no completed Runtime Effect",
    );
  }
  if (terminal.has(source.run.status) && source.jobAttempts.length === 0) {
    add(
      "job_attempt_missing",
      "warning",
      "job-attempt",
      "Terminal Run has no Job Attempt history",
    );
  }
  if (terminal.has(source.run.status) && source.receipts.length === 0) {
    add(
      "usage_receipt_missing",
      "warning",
      "usage",
      "Historical Run has no normalized usage receipt",
    );
  }
  if (
    source.receipts.length > 0 &&
    !source.outbox.some((message) => message.topic === "runtime.usage.recorded")
  ) {
    add(
      "usage_outbox_missing",
      "warning",
      "outbox",
      "Usage receipt is missing its durable Outbox projection",
    );
  }
  if (
    source.receipts.length !==
    new Set(source.receipts.map((receipt) => receipt.runAttempt)).size
  ) {
    add(
      "duplicate_usage_receipt",
      "error",
      "usage",
      "Run has duplicate usage receipts for the same attempt",
    );
  }
  const chronological = [
    source.run.createdAt,
    ...source.jobAttempts.map((attempt) => attempt.started_at),
    source.run.startedAt,
    source.run.endedAt,
  ]
    .filter((value): value is string | Date => value !== null)
    .map((value) => time(value))
    .filter((value): value is number => value !== undefined);
  if (
    chronological.some(
      (value, index) => index > 0 && value < chronological[index - 1]!,
    )
  ) {
    add(
      "timeline_out_of_order",
      "error",
      "timeline",
      "Run, Job Attempt and settlement timestamps are not monotonic",
    );
  }
  const hasError = issues.some((issue) => issue.severity === "error");
  const hasIncomplete = issues.some(
    (issue) => issue.code === "run_not_settled",
  );
  return {
    status: hasError
      ? "inconsistent"
      : hasIncomplete
        ? "incomplete"
        : issues.length > 0
          ? "unknown"
          : "reconciled",
    checkedAt: now.toISOString(),
    issues,
    sourceCounts: {
      taskEvents: source.taskEvents.length,
      runEvents: source.runEvents.length,
      jobAttempts: source.jobAttempts.length,
      runtimeEffects: source.runtimeEffects.length,
      outboxMessages: source.outbox.length,
      usageReceipts: source.receipts.length,
    },
  };
}

export function executionEconomics(
  source: RuntimeRunSource,
  now = new Date(),
): RunExecutionEconomics {
  const timeline = buildRunTimeline(source, now);
  const firstAttempt = source.jobAttempts[0];
  return {
    schemaVersion: 1,
    runId: source.run.id,
    workspaceId: source.run.workspaceId,
    projectId: source.run.projectId,
    taskId: source.run.taskId,
    contextType: source.run.contextType,
    contextId: source.run.contextId,
    status: source.run.status,
    runtimeId: source.run.runtimeId,
    runtimeRevision: source.run.runtimeRevision,
    provider: source.run.provider,
    model: source.run.model,
    createdAt: source.run.createdAt,
    startedAt: source.run.startedAt,
    endedAt: source.run.endedAt,
    usage: summarizeRuntimeUsage(source.receipts),
    receipts: [...source.receipts],
    durations: timeline.durations,
    segments: timeline.segments,
    claim:
      firstAttempt === undefined
        ? null
        : {
            jobId: firstAttempt.job_id,
            attempt: firstAttempt.attempt,
            workerId: firstAttempt.worker_id,
            startedAt: firstAttempt.started_at.toISOString(),
            claimLatencyMs: Math.max(
              0,
              firstAttempt.started_at.getTime() -
                new Date(source.run.createdAt).getTime(),
            ),
          },
    reconciliation: reconcileRunEconomics(source, now),
  };
}

export function executionHistoryItem(
  source: RuntimeRunSource,
  now = new Date(),
): ExecutionHistoryItem {
  const economics = executionEconomics(source, now);
  return {
    runId: economics.runId,
    workspaceId: economics.workspaceId,
    projectId: economics.projectId,
    taskId: economics.taskId,
    contextType: economics.contextType,
    contextId: economics.contextId,
    status: economics.status,
    runtimeId: economics.runtimeId,
    provider: economics.provider,
    model: economics.model,
    createdAt: economics.createdAt,
    endedAt: economics.endedAt,
    usage: economics.usage,
    durations: economics.durations,
    reconciliationStatus: economics.reconciliation.status,
  };
}

function sumDurations(
  items: readonly RunDurationBreakdown[],
): RunDurationBreakdown {
  return items.reduce<RunDurationBreakdown>(
    (total, item) => ({
      observedTotalMs: total.observedTotalMs + item.observedTotalMs,
      queuedMs: total.queuedMs + item.queuedMs,
      claimedMs: total.claimedMs + item.claimedMs,
      waitingApprovalMs: total.waitingApprovalMs + item.waitingApprovalMs,
      runningMs: total.runningMs + item.runningMs,
      needsInputMs: total.needsInputMs + item.needsInputMs,
      retryWaitMs: total.retryWaitMs + item.retryWaitMs,
      recoveryMs: total.recoveryMs + item.recoveryMs,
      settlementMs: total.settlementMs + item.settlementMs,
      unclassifiedMs: total.unclassifiedMs + item.unclassifiedMs,
    }),
    emptyDurations(),
  );
}

function mergeUsage(
  receipts: readonly RuntimeUsageReceipt[],
): RuntimeUsageSummary {
  return summarizeRuntimeUsage(receipts);
}

export function workspaceEconomics(
  workspaceId: string,
  sources: readonly RuntimeRunSource[],
  options: {
    readonly from?: string | undefined;
    readonly to?: string | undefined;
    readonly now?: Date | undefined;
  } = {},
): WorkspaceRuntimeEconomics {
  const now = options.now ?? new Date();
  const items = sources.map((source) => executionEconomics(source, now));
  const byRuntime = new Map<
    string,
    {
      provider: string | null;
      model: string | null;
      runIds: Set<string>;
      receipts: RuntimeUsageReceipt[];
      durations: RunDurationBreakdown[];
    }
  >();
  for (const source of sources) {
    const item = executionEconomics(source, now);
    const key = source.run.runtimeId ?? "unknown";
    const bucket = byRuntime.get(key) ?? {
      provider: source.run.provider,
      model: source.run.model,
      runIds: new Set<string>(),
      receipts: [],
      durations: [],
    };
    bucket.runIds.add(source.run.id);
    bucket.receipts.push(...source.receipts);
    bucket.durations.push(item.durations);
    byRuntime.set(key, bucket);
  }
  const runtimes: RuntimeEconomicsBucket[] = [...byRuntime.entries()]
    .map(([runtimeId, bucket]) => ({
      runtimeId,
      provider: bucket.provider,
      model: bucket.model,
      runCount: bucket.runIds.size,
      usage: mergeUsage(bucket.receipts),
      durations: sumDurations(bucket.durations),
    }))
    .sort((left, right) => right.runCount - left.runCount);
  return {
    workspaceId,
    generatedAt: now.toISOString(),
    from: options.from ?? null,
    to: options.to ?? null,
    runCount: items.length,
    usage: mergeUsage(sources.flatMap((source) => source.receipts)),
    durations: sumDurations(items.map((item) => item.durations)),
    runtimes,
  };
}

export function executionHistoryFingerprint(input: {
  readonly workspaceId: string;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly runtimeId?: string | undefined;
  readonly contextType?: string | undefined;
  readonly status?: string | undefined;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: input.workspaceId,
        from: input.from ?? null,
        to: input.to ?? null,
        runtimeId: input.runtimeId ?? null,
        contextType: input.contextType ?? null,
        status: input.status ?? null,
      }),
    )
    .digest("hex");
}

interface ExecutionHistoryCursorPayload {
  readonly workspaceId: string;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly id: string;
}

export function encodeExecutionHistoryCursor(
  payload: ExecutionHistoryCursorPayload,
): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeExecutionHistoryCursor(
  cursor: string,
): ExecutionHistoryCursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("execution_history_cursor_conflict");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as ExecutionHistoryCursorPayload).workspaceId !== "string" ||
    typeof (parsed as ExecutionHistoryCursorPayload).fingerprint !== "string" ||
    typeof (parsed as ExecutionHistoryCursorPayload).createdAt !== "string" ||
    typeof (parsed as ExecutionHistoryCursorPayload).id !== "string" ||
    !Number.isFinite(
      Date.parse((parsed as ExecutionHistoryCursorPayload).createdAt),
    )
  ) {
    throw new Error("execution_history_cursor_conflict");
  }
  return parsed as ExecutionHistoryCursorPayload;
}

export { iso as runtimeEconomicsIso };
