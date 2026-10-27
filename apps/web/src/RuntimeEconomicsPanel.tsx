import type {
  RunDurationBreakdown,
  RunExecutionEconomics,
  RuntimeUsageSummary,
  WorkspaceRuntimeEconomics,
} from "@pluginmax/contracts";
import { formatDateTime, shortId } from "@pluginmax/ui";
import { useQuery } from "@tanstack/react-query";
import { Coins, Gauge, Timer, TriangleAlert } from "lucide-react";
import { getRunEconomics, getWorkspaceRuntimeEconomics } from "./api.js";

function tokenValue(summary: RuntimeUsageSummary): string {
  return summary.unknownFields.includes("totalTokens") &&
    summary.sampleCount > 0
    ? summary.totalTokens > 0
      ? `${summary.totalTokens.toLocaleString()} + unknown`
      : "unknown"
    : summary.totalTokens.toLocaleString();
}

function costValue(summary: RuntimeUsageSummary): string {
  if (summary.costCurrencies.length === 0) return "unknown";
  if (summary.costCurrencies.length > 1) {
    return `${summary.costAmount.toLocaleString()} (${summary.costCurrencies.join(
      ", ",
    )})`;
  }
  return `${summary.costAmount.toLocaleString()} ${summary.costCurrencies[0]}`;
}

function durationLabel(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

const phaseLabels: ReadonlyArray<{
  key: keyof RunDurationBreakdown;
  label: string;
}> = [
  { key: "queuedMs", label: "排队" },
  { key: "claimedMs", label: "Claim" },
  { key: "waitingApprovalMs", label: "等待审批" },
  { key: "runningMs", label: "运行" },
  { key: "needsInputMs", label: "等待输入" },
  { key: "retryWaitMs", label: "重试等待" },
  { key: "recoveryMs", label: "恢复" },
  { key: "settlementMs", label: "结算" },
];

function PhaseGrid({ durations }: { durations: RunDurationBreakdown }) {
  return (
    <div className="runtime-economics-phases">
      {phaseLabels.map((phase) => (
        <div key={phase.key}>
          <span>{phase.label}</span>
          <strong>{durationLabel(durations[phase.key])}</strong>
        </div>
      ))}
    </div>
  );
}

export function WorkspaceRuntimeEconomicsPanel({
  workspaceId,
}: {
  workspaceId: string;
}) {
  const query = useQuery({
    queryKey: ["workspace-runtime-economics", workspaceId],
    queryFn: () => getWorkspaceRuntimeEconomics(workspaceId),
    enabled: workspaceId !== "",
  });
  const economics = query.data;
  if (workspaceId === "") {
    return null;
  }
  return (
    <section
      className="pm-panel runtime-economics-panel"
      aria-label="Runtime 经济与可见性"
    >
      <div className="pm-section-head">
        <div>
          <h3>执行经济</h3>
          <span>最近 100 个可读 Run 的已归一化统计</span>
        </div>
        <span>{economics?.runCount ?? 0} runs</span>
      </div>
      {query.isError ? (
        <div className="pm-error">
          <TriangleAlert size={14} />
          无法读取 Workspace 统计
        </div>
      ) : economics === undefined ? (
        <div className="pm-empty">加载经济统计...</div>
      ) : (
        <WorkspaceEconomicsSummary economics={economics} />
      )}
    </section>
  );
}

function WorkspaceEconomicsSummary({
  economics,
}: {
  economics: WorkspaceRuntimeEconomics;
}) {
  return (
    <>
      <div className="runtime-economics-kpis">
        <div>
          <Gauge size={15} />
          <span>Token</span>
          <strong>{tokenValue(economics.usage)}</strong>
          <small>{economics.usage.unknownSampleCount} 个样本含 unknown</small>
        </div>
        <div>
          <Coins size={15} />
          <span>成本</span>
          <strong>{costValue(economics.usage)}</strong>
          <small>不根据 Provider 名称推算价格</small>
        </div>
        <div>
          <Timer size={15} />
          <span>观测总时长</span>
          <strong>{durationLabel(economics.durations.observedTotalMs)}</strong>
          <small>{formatDateTime(economics.generatedAt)}</small>
        </div>
      </div>
      <PhaseGrid durations={economics.durations} />
      <div className="runtime-economics-breakdown">
        {economics.runtimes.slice(0, 8).map((runtime) => (
          <div key={runtime.runtimeId}>
            <span title={runtime.runtimeId}>
              {runtime.runtimeId.startsWith("builtin:")
                ? runtime.runtimeId
                : shortId(runtime.runtimeId)}
            </span>
            <strong>{runtime.runCount} runs</strong>
            <small>
              {tokenValue(runtime.usage)} tokens · {costValue(runtime.usage)}
            </small>
          </div>
        ))}
        {economics.runtimes.length === 0 && (
          <div className="pm-empty">当前 Workspace 尚无执行样本</div>
        )}
      </div>
    </>
  );
}

export function RunEconomicsPanel({ runId }: { runId: string }) {
  const query = useQuery({
    queryKey: ["run-economics", runId],
    queryFn: () => getRunEconomics(runId),
  });
  const economics = query.data;
  return (
    <section
      className="run-section runtime-economics-run"
      aria-label="Run 经济统计"
    >
      <div className="section-title">
        <Gauge size={15} />
        <h3>执行经济与结算</h3>
        {economics !== undefined && (
          <span
            className={`pm-pill reconciliation-${economics.reconciliation.status}`}
          >
            {economics.reconciliation.status}
          </span>
        )}
      </div>
      {query.isError ? (
        <div className="pm-error">
          <TriangleAlert size={14} />
          无法读取 Run 经济统计
        </div>
      ) : economics === undefined ? (
        <div className="pm-empty">加载 Run 统计...</div>
      ) : (
        <RunEconomicsSummary economics={economics} />
      )}
    </section>
  );
}

function RunEconomicsSummary({
  economics,
}: {
  economics: RunExecutionEconomics;
}) {
  return (
    <>
      <div className="runtime-economics-kpis compact">
        <div>
          <span>总 Token</span>
          <strong>{tokenValue(economics.usage)}</strong>
          <small>{economics.usage.sampleCount} 个 usage receipt</small>
        </div>
        <div>
          <span>成本</span>
          <strong>{costValue(economics.usage)}</strong>
          <small>{economics.provider ?? "unknown provider"}</small>
        </div>
        <div>
          <span>模型</span>
          <strong>{economics.model ?? "unknown"}</strong>
          <small>{economics.runtimeId ?? "runtime unknown"}</small>
        </div>
        <div>
          <span>Claim 延迟</span>
          <strong>
            {economics.claim === null
              ? "unknown"
              : durationLabel(economics.claim.claimLatencyMs)}
          </strong>
          <small>{economics.claim?.workerId ?? "尚未 Claim"}</small>
        </div>
      </div>
      <PhaseGrid durations={economics.durations} />
      {economics.reconciliation.issues.length > 0 && (
        <div className="runtime-economics-issues">
          {economics.reconciliation.issues.map((issue) => (
            <div key={`${issue.code}-${issue.message}`}>
              <TriangleAlert size={13} />
              <span>{issue.message}</span>
              <small>{issue.source}</small>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
