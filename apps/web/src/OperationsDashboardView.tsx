import { formatDateTime } from "@pluginmax/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  Archive,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  HeartPulse,
  Layers3,
  RefreshCw,
  RotateCcw,
  Server,
  ServerOff,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  cleanupIdempotencyReceipts,
  getOperationsSnapshot,
  getReadiness,
  recoverDeadLetterJob,
  sweepApprovalSla,
} from "./api.js";

function percentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function heartbeatAge(value: string): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 1_000),
  );
  return seconds < 60 ? `${seconds}s 前` : `${Math.floor(seconds / 60)}m 前`;
}

export function OperationsDashboardView() {
  const queryClient = useQueryClient();
  const operations = useQuery({
    queryKey: ["operations"],
    queryFn: getOperationsSnapshot,
    refetchInterval: 5_000,
  });
  const readiness = useQuery({
    queryKey: ["readiness"],
    queryFn: getReadiness,
    refetchInterval: 5_000,
    retry: false,
  });
  const recover = useMutation({
    mutationFn: (jobId: string) =>
      recoverDeadLetterJob(jobId, "operator recovered from operations view"),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["operations"] }),
  });
  const cleanup = useMutation({
    mutationFn: () =>
      cleanupIdempotencyReceipts({
        olderThanSeconds: 604_800,
        batchSize: 500,
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["operations"] }),
  });
  const sweep = useMutation({
    mutationFn: () => sweepApprovalSla(100),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["operations"] }),
  });
  const data = operations.data;
  const metrics = data?.metrics;
  const ready = readiness.data?.ok === true;
  const metricItems = [
    {
      label: "在线 Worker",
      value: metrics?.activeWorkers ?? "-",
      detail: `${metrics?.totalWorkerConcurrency ?? 0} 个并发槽`,
      icon: Server,
      tone: "healthy",
    },
    {
      label: "活跃 Job",
      value: metrics?.activeJobs ?? "-",
      detail: "正在持有有效租约",
      icon: Activity,
      tone: "progress",
    },
    {
      label: "队列深度",
      value: metrics?.queueDepth ?? "-",
      detail: `P95 等待 ${(metrics?.queueWaitP95Seconds ?? 0).toFixed(2)}s`,
      icon: Layers3,
      tone: "neutral",
    },
    {
      label: "租约抖动",
      value: `${(metrics?.leaseJitterP95Seconds ?? 0).toFixed(2)}s`,
      detail: "24h P95 续租偏差",
      icon: Activity,
      tone:
        metrics !== undefined && metrics.leaseJitterP95Seconds >= 2
          ? "warning"
          : "healthy",
    },
    {
      label: "死信",
      value: metrics?.deadLetterCount ?? "-",
      detail: "需要人工处理",
      icon: AlertTriangle,
      tone:
        metrics !== undefined && metrics.deadLetterCount > 0
          ? "danger"
          : "healthy",
    },
    {
      label: "Job 失败率",
      value: metrics === undefined ? "-" : percentage(metrics.jobFailureRate),
      detail: `24h 完成 ${metrics?.completedJobs24h ?? 0} / 失败 ${metrics?.failedJobs24h ?? 0}`,
      icon: XCircle,
      tone:
        metrics !== undefined && metrics.jobFailureRate >= 0.2
          ? "danger"
          : "healthy",
    },
    {
      label: "Run 超时率",
      value: metrics === undefined ? "-" : percentage(metrics.runTimeoutRate),
      detail: `24h 超时 ${metrics?.timedOutRuns24h ?? 0}`,
      icon: Clock3,
      tone:
        metrics !== undefined && metrics.runTimeoutRate >= 0.1
          ? "warning"
          : "healthy",
    },
    {
      label: "审批积压",
      value: metrics?.approvalBacklog ?? "-",
      detail: "待处理审批人",
      icon: Database,
      tone:
        metrics !== undefined && metrics.approvalBacklog > 0
          ? "progress"
          : "healthy",
    },
    {
      label: "SLA 超时",
      value: metrics?.approvalSlaOverdue ?? "-",
      detail: `24h 过期 ${metrics?.approvalSlaExpired24h ?? 0}`,
      icon: AlertTriangle,
      tone:
        metrics !== undefined && metrics.approvalSlaOverdue > 0
          ? "danger"
          : "healthy",
    },
    {
      label: "SLA 燃尽率",
      value:
        metrics === undefined ? "-" : percentage(metrics.approvalSlaBurnRate),
      detail: "24h 已评估审批",
      icon: AlertTriangle,
      tone:
        metrics !== undefined && metrics.approvalSlaBurnRate >= 0.2
          ? "danger"
          : "healthy",
    },
    {
      label: "维护成功率",
      value:
        metrics === undefined
          ? "-"
          : percentage(metrics.maintenanceSuccessRate24h),
      detail: `${metrics?.maintenanceRuns24h ?? 0} 次 / 24h`,
      icon: CheckCircle2,
      tone:
        metrics !== undefined && metrics.maintenanceSuccessRate24h < 0.95
          ? "warning"
          : "healthy",
    },
    {
      label: "幂等归档",
      value: metrics?.archivedIdempotencyReceipts ?? "-",
      detail: `${((metrics?.archiveBytes ?? 0) / 1024).toFixed(1)} KiB`,
      icon: Archive,
      tone: "neutral",
    },
  ] as const;

  return (
    <main className="pm-page operations-page">
      <header className="pm-page-head operations-head">
        <div>
          <h1>运行运维</h1>
          <p>Worker、队列、SLA、死信与保留策略的统一运行视图。</p>
        </div>
        <div className="pm-head-actions">
          <button
            className="pm-icon-btn"
            type="button"
            title="刷新运行指标"
            onClick={() => {
              void operations.refetch();
              void readiness.refetch();
            }}
          >
            <RefreshCw
              size={14}
              className={operations.isFetching ? "spin" : undefined}
            />
          </button>
          <button
            className="pm-btn secondary"
            type="button"
            disabled={sweep.isPending}
            onClick={() => sweep.mutate()}
          >
            <Clock3 size={14} />
            执行 SLA 扫描
          </button>
          <button
            className="pm-btn secondary"
            type="button"
            disabled={cleanup.isPending}
            onClick={() => cleanup.mutate()}
          >
            <Trash2 size={14} />
            清理幂等回执
          </button>
        </div>
      </header>

      <section
        className={`operations-readiness ${ready ? "ready" : "not-ready"}`}
        aria-label="服务就绪状态"
      >
        <div className="operations-readiness-mark">
          {ready ? <HeartPulse size={18} /> : <ServerOff size={18} />}
        </div>
        <div>
          <strong>
            {readiness.isLoading
              ? "正在检查服务就绪状态"
              : ready
                ? "运行面已就绪"
                : "运行面未就绪"}
          </strong>
          <small>
            Database {readiness.data?.checks.database.status ?? "-"} · Worker{" "}
            {readiness.data?.checks.worker.status ?? "-"} · Migration{" "}
            {readiness.data?.checks.migration.status ?? "-"}
          </small>
        </div>
        <span>
          Migration v{metrics?.migrationVersion ?? "-"} / v
          {metrics?.expectedMigrationVersion ?? "-"}
        </span>
      </section>

      {operations.isError && (
        <div className="pm-error-banner">
          <AlertTriangle size={15} />
          {operations.error.message}
        </div>
      )}

      <section className="operations-metric-grid" aria-label="运行指标">
        {metricItems.map((item) => {
          const Icon = item.icon;
          return (
            <div
              className={`operations-metric metric-${item.tone}`}
              key={item.label}
            >
              <Icon size={16} />
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <small>{item.detail}</small>
            </div>
          );
        })}
      </section>

      <section className="operations-section">
        <header>
          <div>
            <h2>Worker 心跳</h2>
            <span>
              心跳 TTL {metrics?.workerHeartbeatStaleAfterSeconds ?? "-"}s
            </span>
          </div>
          <Gauge size={17} />
        </header>
        <div className="operations-table" role="table">
          <div className="operations-table-head" role="row">
            <span>Worker</span>
            <span>状态</span>
            <span>并发</span>
            <span>心跳</span>
            <span>主机 / PID</span>
          </div>
          {(data?.workers ?? []).map((worker) => (
            <div className="operations-table-row" role="row" key={worker.id}>
              <strong title={worker.id}>
                {worker.id.slice(0, 18)}
                {worker.id.length > 18 ? "..." : ""}
              </strong>
              <span className={`pm-pill status-${worker.status}`}>
                {worker.status === "running"
                  ? "运行中"
                  : worker.status === "draining"
                    ? "排空中"
                    : worker.status === "stopped"
                      ? "已停止"
                      : "启动中"}
              </span>
              <span>{worker.concurrency}</span>
              <span>{heartbeatAge(worker.heartbeatAt)}</span>
              <span>
                {worker.hostname} / {worker.pid}
              </span>
            </div>
          ))}
          {(data?.workers ?? []).length === 0 && (
            <div className="pm-empty compact">暂无 Worker 心跳</div>
          )}
        </div>
      </section>

      <section className="operations-section">
        <header>
          <div>
            <h2>死信队列</h2>
            <span>{data?.deadLetters.length ?? 0} 个可恢复 Job</span>
          </div>
          <AlertTriangle size={17} />
        </header>
        <div className="operations-table dead-letter-table" role="table">
          <div className="operations-table-head" role="row">
            <span>Job / Run</span>
            <span>尝试</span>
            <span>错误</span>
            <span>进入时间</span>
            <span>操作</span>
          </div>
          {(data?.deadLetters ?? []).map((job) => (
            <div className="operations-table-row" role="row" key={job.id}>
              <span className="operations-job-ref">
                <strong title={job.id}>{job.id.slice(0, 13)}...</strong>
                <small title={job.runId}>{job.runId.slice(0, 13)}...</small>
              </span>
              <span>
                {job.attempts} / {job.maxAttempts}
              </span>
              <span className="operations-error-copy">
                {job.lastError ?? "unknown"}
              </span>
              <span>
                {job.deadLetterAt ? formatDateTime(job.deadLetterAt) : "未记录"}
              </span>
              <button
                className="pm-btn secondary compact"
                type="button"
                title="恢复死信 Job"
                disabled={recover.isPending}
                onClick={() => recover.mutate(job.id)}
              >
                <RotateCcw size={13} />
                恢复
              </button>
            </div>
          ))}
          {(data?.deadLetters ?? []).length === 0 && (
            <div className="pm-empty compact">
              <CheckCircle2 size={14} /> 当前没有死信 Job
            </div>
          )}
        </div>
      </section>

      <section className="operations-foot-grid">
        <div className="operations-foot-panel">
          <header>
            <div>
              <h2>审批 SLA 风险</h2>
              <span>最晚到期 {metrics?.approvalSlaOverdue ?? 0} 组</span>
            </div>
            <Clock3 size={17} />
          </header>
          {(data?.approvalSlaOverdue ?? []).slice(0, 6).map((item) => (
            <div
              className="operations-risk-row"
              key={`${item.instanceId}:${item.nodeId}:${item.round}`}
            >
              <span>
                <strong>{item.nodeId}</strong>
                <small>{item.instanceId.slice(0, 18)}...</small>
              </span>
              <em>{item.pendingCount} 人待办</em>
              <time>
                {item.dueAt === null ? "-" : formatDateTime(item.dueAt)}
              </time>
            </div>
          ))}
          {(data?.approvalSlaOverdue ?? []).length === 0 && (
            <div className="pm-empty compact">当前没有 SLA 超时审批</div>
          )}
        </div>

        <div className="operations-foot-panel">
          <header>
            <div>
              <h2>维护记录</h2>
              <span>{data?.maintenanceSchedules.length ?? 0} 个持久化调度</span>
            </div>
            <Archive size={17} />
          </header>
          {(data?.maintenanceSchedules ?? []).map((schedule) => (
            <div className="operations-risk-row" key={schedule.kind}>
              <span>
                <strong>{schedule.kind}</strong>
                <small>
                  {schedule.lastStatus === "failed"
                    ? (schedule.lastError ?? "最近执行失败")
                    : `每 ${schedule.intervalSeconds}s`}
                </small>
              </span>
              <em>{schedule.consecutiveFailures} 次失败</em>
              <time>{formatDateTime(schedule.nextRunAt)}</time>
            </div>
          ))}
          {metrics?.lastMaintenance === null ||
          metrics?.lastMaintenance === undefined ? (
            <div className="pm-empty compact">暂无维护记录</div>
          ) : (
            <dl className="operations-maintenance">
              <div>
                <dt>最近任务</dt>
                <dd>{metrics.lastMaintenance.kind}</dd>
              </div>
              <div>
                <dt>处理数量</dt>
                <dd>{metrics.lastMaintenance.processedCount}</dd>
              </div>
              <div>
                <dt>归档 / 删除</dt>
                <dd>
                  {metrics.lastMaintenance.archivedCount} /{" "}
                  {metrics.lastMaintenance.deletedCount}
                </dd>
              </div>
              <div>
                <dt>完成时间</dt>
                <dd>{formatDateTime(metrics.lastMaintenance.completedAt)}</dd>
              </div>
            </dl>
          )}
          {(cleanup.isError || sweep.isError || recover.isError) && (
            <div className="operations-inline-error">
              {cleanup.error?.message ??
                sweep.error?.message ??
                recover.error?.message}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
