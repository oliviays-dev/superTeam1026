import type { OperationsSnapshot } from "@pluginmax/contracts";

function metric(
  name: string,
  help: string,
  type: "counter" | "gauge",
  samples: ReadonlyArray<{
    readonly labels?: Readonly<Record<string, string>>;
    readonly value: number;
  }>,
): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const sample of samples) {
    const labels =
      sample.labels === undefined
        ? ""
        : `{${Object.entries(sample.labels)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(
              ([key, value]) =>
                `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
            )
            .join(",")}}`;
    lines.push(`${name}${labels} ${sample.value}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderRuntimePrometheusMetrics(
  snapshot: OperationsSnapshot,
): string {
  const { metrics, maintenanceSchedules, maintenanceTrend, runtimeEffects } =
    snapshot;
  const maintenanceCounts = new Map<string, number>();
  for (const run of maintenanceTrend) {
    const key = `${run.kind}:${run.status}`;
    maintenanceCounts.set(key, (maintenanceCounts.get(key) ?? 0) + 1);
  }
  const effectCounts = new Map<string, number>();
  for (const effect of runtimeEffects) {
    const key = `${effect.operation}:${effect.status}`;
    effectCounts.set(key, (effectCounts.get(key) ?? 0) + 1);
  }
  const output = [
    metric("pluginmax_runtime_up", "Runtime metrics scrape health.", "gauge", [
      { value: 1 },
    ]),
    metric(
      "pluginmax_runtime_migration_version",
      "Applied database migration version.",
      "gauge",
      [{ value: metrics.migrationVersion }],
    ),
    metric(
      "pluginmax_runtime_migration_expected_version",
      "Expected database migration version.",
      "gauge",
      [{ value: metrics.expectedMigrationVersion }],
    ),
    metric(
      "pluginmax_runtime_workers_active",
      "Workers with a fresh heartbeat.",
      "gauge",
      [{ value: metrics.activeWorkers }],
    ),
    metric(
      "pluginmax_runtime_worker_concurrency",
      "Fresh worker concurrency slots.",
      "gauge",
      [{ value: metrics.totalWorkerConcurrency }],
    ),
    metric("pluginmax_runtime_jobs_queue_depth", "Queued jobs.", "gauge", [
      { value: metrics.queueDepth },
    ]),
    metric("pluginmax_runtime_jobs_active", "Running jobs.", "gauge", [
      { value: metrics.activeJobs },
    ]),
    metric(
      "pluginmax_runtime_jobs_dead_letter",
      "Jobs in the dead-letter state.",
      "gauge",
      [{ value: metrics.deadLetterCount }],
    ),
    metric(
      "pluginmax_runtime_job_failure_ratio",
      "Terminal job failures over 24 hours.",
      "gauge",
      [{ value: metrics.jobFailureRate }],
    ),
    metric(
      "pluginmax_runtime_queue_wait_seconds",
      "Job queue wait distribution over 24 hours.",
      "gauge",
      [
        { labels: { quantile: "0.5" }, value: metrics.queueWaitP50Seconds },
        { labels: { quantile: "0.95" }, value: metrics.queueWaitP95Seconds },
      ],
    ),
    metric(
      "pluginmax_runtime_lease_jitter_seconds",
      "Worker lease renewal jitter p95 over 24 hours.",
      "gauge",
      [
        {
          labels: { quantile: "0.95" },
          value: metrics.leaseJitterP95Seconds,
        },
      ],
    ),
    metric(
      "pluginmax_runtime_approval_backlog",
      "Pending workflow approvals.",
      "gauge",
      [{ value: metrics.approvalBacklog }],
    ),
    metric(
      "pluginmax_runtime_approval_sla_burn_rate",
      "Expired approvals relative to approvals evaluated over 24 hours.",
      "gauge",
      [{ value: metrics.approvalSlaBurnRate }],
    ),
    metric(
      "pluginmax_runtime_approval_oldest_overdue_seconds",
      "Age of the oldest overdue pending approval.",
      "gauge",
      [{ value: metrics.approvalSlaOldestOverdueSeconds }],
    ),
    metric(
      "pluginmax_runtime_maintenance_success_ratio",
      "Successful maintenance runs over 24 hours.",
      "gauge",
      [{ value: metrics.maintenanceSuccessRate24h }],
    ),
    metric(
      "pluginmax_runtime_maintenance_scheduling_lag_seconds",
      "Maintenance scheduling lag p95 over 24 hours.",
      "gauge",
      [
        {
          labels: { quantile: "0.95" },
          value: metrics.maintenanceSchedulingLagP95Seconds,
        },
      ],
    ),
    metric(
      "pluginmax_runtime_maintenance_duration_seconds",
      "Maintenance execution duration p95 over 24 hours.",
      "gauge",
      [
        {
          labels: { quantile: "0.95" },
          value: metrics.maintenanceDurationP95Seconds,
        },
      ],
    ),
    metric(
      "pluginmax_runtime_effects_active",
      "Runtime effects currently leased.",
      "gauge",
      [{ value: metrics.activeRuntimeEffects }],
    ),
    metric(
      "pluginmax_runtime_effects_stale",
      "Runtime effects whose lease has expired.",
      "gauge",
      [{ value: metrics.staleRuntimeEffects }],
    ),
    metric(
      "pluginmax_runtime_effects_cancelled_24h",
      "Runtime effects cancelled in 24 hours.",
      "gauge",
      [{ value: metrics.cancelledRuntimeEffects24h }],
    ),
    metric(
      "pluginmax_runtime_effects_replayed_total",
      "Runtime effect receipt replays.",
      "counter",
      [{ value: metrics.runtimeEffectReplays }],
    ),
    metric(
      "pluginmax_runtime_maintenance_next_run_timestamp_seconds",
      "Unix timestamp of the next scheduled maintenance run.",
      "gauge",
      maintenanceSchedules.map((schedule) => ({
        labels: { kind: schedule.kind },
        value: Date.parse(schedule.nextRunAt) / 1_000,
      })),
    ),
    metric(
      "pluginmax_runtime_maintenance_failures_consecutive",
      "Consecutive maintenance failures by kind.",
      "gauge",
      maintenanceSchedules.map((schedule) => ({
        labels: { kind: schedule.kind },
        value: schedule.consecutiveFailures,
      })),
    ),
    metric(
      "pluginmax_runtime_maintenance_last_completed_timestamp_seconds",
      "Unix timestamp of the last completed maintenance schedule.",
      "gauge",
      maintenanceSchedules.map((schedule) => ({
        labels: { kind: schedule.kind },
        value:
          schedule.lastCompletedAt === null
            ? 0
            : Date.parse(schedule.lastCompletedAt) / 1_000,
      })),
    ),
    metric(
      "pluginmax_runtime_maintenance_runs",
      "Recent maintenance runs by kind and status.",
      "gauge",
      [...maintenanceCounts].map(([key, value]) => {
        const [kind, status] = key.split(":");
        return { labels: { kind: kind!, status: status! }, value };
      }),
    ),
    metric(
      "pluginmax_runtime_effect_receipts",
      "Recent runtime effect receipts by status.",
      "gauge",
      [...effectCounts].map(([key, value]) => {
        const [operation, status] = key.split(":");
        return { labels: { operation: operation!, status: status! }, value };
      }),
    ),
  ];
  return output.join("");
}
