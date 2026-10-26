import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock3,
  ShieldCheck,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import type {
  AgentRuntimeBindingDetail,
  AgentRuntimePreflightResult,
  ExternalRuntime,
  ExternalRuntimeCapabilityName,
  ExternalRuntimeCapabilitySnapshot,
  PlatformRunEvent,
  Run,
} from "@pluginmax/contracts";
import { externalRuntimeCapabilityNames } from "@pluginmax/contracts";
import { formatDateTime, shortId } from "@pluginmax/ui";

export const runtimeCapabilityLabels: Readonly<
  Record<ExternalRuntimeCapabilityName, string>
> = {
  search: "搜索",
  network: "网络",
  fileRead: "读取文件",
  fileWrite: "写入文件",
  shell: "命令",
  browser: "浏览器",
  mcp: "MCP",
  sessionResume: "会话恢复",
  structuredPlan: "结构化计划",
  structuredToolEvents: "工具事件",
  structuredSubagent: "子 Agent",
};

export interface RuntimeAvailability {
  readonly tone: "available" | "pending" | "blocked";
  readonly label: string;
  readonly reason: string;
}

export function runtimeAvailability(
  runtime: ExternalRuntime,
  capability?: ExternalRuntimeCapabilitySnapshot,
): RuntimeAvailability {
  if (runtime.status === "archived") {
    return {
      tone: "blocked",
      label: "不可派发",
      reason: "Runtime 已归档。恢复后必须重新 Probe 并启用。",
    };
  }
  const probe = runtime.lastProbe;
  if (probe === null) {
    return {
      tone: "blocked",
      label: "等待 Probe",
      reason:
        runtime.status === "disabled"
          ? "Runtime 已停用且当前 revision 尚无 Probe 结果。"
          : "当前 revision 尚无 Probe 结果，启用和派发都会被拒绝。",
    };
  }
  if (probe.status === "requested" || probe.status === "running") {
    return {
      tone: "pending",
      label: "Probe 进行中",
      reason: "等待当前 revision 的 Probe 完成，再尝试绑定或派发。",
    };
  }
  if (probe.status === "failed") {
    return {
      tone: "blocked",
      label: "Probe 失败",
      reason: "检查命令、登录态与执行环境后重新 Probe；当前不可绑定或派发。",
    };
  }
  if (runtime.status === "disabled") {
    return {
      tone: "blocked",
      label: "不可派发",
      reason: "Runtime 已停用。完成当前 revision 的 Probe 后启用。",
    };
  }
  if (capability === undefined) {
    return {
      tone: "pending",
      label: "能力快照加载中",
      reason: "成功 Probe 应生成不可变 Capability 快照。",
    };
  }
  return {
    tone: "available",
    label: "可参与 Preflight",
    reason: "Runtime 已启用且当前 revision 的 Probe 与 Capability 快照匹配。",
  };
}

export function bindingUnavailableReason(
  detail: AgentRuntimeBindingDetail,
): string | null {
  if (detail.binding === null) {
    return "尚未创建外部 Runtime Binding；Agent.runtime_kind 不能作为绑定证明。";
  }
  if (detail.runtime === null) {
    return "绑定的 Runtime 已不存在，需要重新绑定可用 Runtime。";
  }
  if (detail.binding.status === "disabled") {
    if (detail.runtime.status === "archived") {
      return "Runtime 已归档，Binding 已停用，新派发已阻止。";
    }
    if (detail.runtime.status === "disabled") {
      return "Runtime 已停用，Binding 已停用，新派发已阻止。";
    }
    return detail.binding.disabledReason ?? "Binding 已停用，需要重新绑定。";
  }
  if (detail.runtime.status === "archived") {
    return "Runtime 已归档，新派发已阻止。";
  }
  if (detail.runtime.status === "disabled") {
    return "Runtime 已停用，新派发已阻止。";
  }
  const probe = detail.runtime.lastProbe;
  if (probe === null) return "当前 Runtime revision 尚无 Probe 结果。";
  if (probe.status === "requested" || probe.status === "running") {
    return "当前 Runtime revision 的 Probe 仍在进行。";
  }
  if (probe.status === "failed") return "当前 Runtime revision 的 Probe 失败。";
  return null;
}

export function RuntimeAvailabilityNotice({
  runtime,
  capability,
}: {
  readonly runtime: ExternalRuntime;
  readonly capability?: ExternalRuntimeCapabilitySnapshot;
}) {
  const availability = runtimeAvailability(runtime, capability);
  const Icon =
    availability.tone === "available"
      ? ShieldCheck
      : availability.tone === "pending"
        ? Clock3
        : AlertTriangle;
  return (
    <div
      className={`runtime-availability ${availability.tone}`}
      role="status"
      aria-label="运行时可用性"
    >
      <Icon size={15} />
      <div>
        <strong>{availability.label}</strong>
        <span>{availability.reason}</span>
      </div>
      <code>
        Probe r{runtime.lastProbe?.runtimeRevision ?? "-"}
        {capability === undefined
          ? ""
          : ` · Cap r${capability.runtimeRevision}`}
      </code>
    </div>
  );
}

export function RuntimeBindingSummary({
  detail,
  runtimeKind,
}: {
  readonly detail: AgentRuntimeBindingDetail;
  readonly runtimeKind: string;
}) {
  const binding = detail.binding;
  const runtime = detail.runtime;
  const state = binding === null ? "unbound" : binding.status;
  return (
    <div className="runtime-binding-summary" aria-label="外部 Runtime 绑定">
      <div className="runtime-binding-summary-head">
        <div>
          <span className={`runtime-binding-state ${state}`}>
            {state === "active"
              ? "Active"
              : state === "disabled"
                ? "Disabled"
                : "未绑定"}
          </span>
          <strong>{runtime?.name ?? "没有外部 Runtime"}</strong>
        </div>
        <code>Agent.runtime_kind={runtimeKind}</code>
      </div>
      {binding === null ? (
        <p className="runtime-binding-reason">
          尚未创建外部 Binding。runtime_kind 只描述 Agent 定义，不代表已有可用
          Runtime。
        </p>
      ) : (
        <>
          <div className="runtime-binding-facts">
            <div>
              <span>Binding revision</span>
              <strong>r{binding.revision}</strong>
            </div>
            <div>
              <span>Runtime revision</span>
              <strong>{runtime === null ? "-" : `r${runtime.revision}`}</strong>
            </div>
            <div>
              <span>模型</span>
              <strong>{runtime?.defaultModel ?? "未设置默认模型"}</strong>
            </div>
            <div>
              <span>Sandbox</span>
              <strong>{runtime?.sandboxMode ?? "-"}</strong>
            </div>
            <div>
              <span>Network</span>
              <strong>{runtime?.networkMode ?? "-"}</strong>
            </div>
            <div>
              <span>Runtime 状态</span>
              <strong>{runtime?.status ?? "missing"}</strong>
            </div>
          </div>
          {(() => {
            const reason = bindingUnavailableReason(detail);
            return reason === null ? (
              <p className="runtime-binding-ready">
                <CheckCircle2 size={13} />
                Binding 可用于当前 revision 的 Preflight。
              </p>
            ) : (
              <p className="runtime-binding-reason">
                <AlertTriangle size={13} />
                {reason}
              </p>
            );
          })()}
        </>
      )}
    </div>
  );
}

export function PreflightFeedback({
  result,
  failure,
}: {
  readonly result: AgentRuntimePreflightResult | null;
  readonly failure: {
    readonly code: string;
    readonly message: string;
    readonly remediation: string;
  } | null;
}) {
  if (failure !== null) {
    return (
      <div
        className="runtime-preflight-feedback failed"
        role="alert"
        aria-label="Preflight 结果"
      >
        <AlertTriangle size={15} />
        <div>
          <strong>{failure.code}</strong>
          <p>{failure.message}</p>
          <span>{failure.remediation}</span>
        </div>
      </div>
    );
  }
  if (result === null) return null;
  return (
    <div
      className="runtime-preflight-feedback passed"
      role="status"
      aria-label="Preflight 结果"
    >
      <CheckCircle2 size={15} />
      <div>
        <strong>Preflight 通过</strong>
        <p>
          Binding r{result.bindingRevision} · Runtime r{result.runtimeRevision}{" "}
          · {result.envelopePreview.launch.model ?? "无模型参数"}
        </p>
        <span>
          {result.envelopePreview.resolved.sandbox} ·{" "}
          {result.envelopePreview.resolved.networkAccess} ·{" "}
          {formatDateTime(result.checkedAt)}
        </span>
        {result.warnings.map((warning) => (
          <span key={warning}>{warning}</span>
        ))}
      </div>
    </div>
  );
}

function protocolNote(protocol: string): string {
  return protocol === "plain-text"
    ? "final-only：仅展示最终输出，不生成计划、工具或步骤事件。"
    : "structured：展示归一化的 progress 与 tool 事件；reasoning 正文不展示。";
}

export function RunExternalRuntimePanel({
  run,
  events,
}: {
  readonly run: Run;
  readonly events: readonly PlatformRunEvent[];
}) {
  const snapshot = run.executionSnapshot;
  const external =
    snapshot !== null ||
    run.externalRuntimeId !== null ||
    run.externalRuntimeProtocol !== null;
  if (!external) return null;

  const runtime = snapshot?.runtime;
  const model = snapshot?.model ?? snapshot?.envelope.launch.model ?? "未记录";
  const provider = runtime?.provider ?? "未记录";
  const observedProvider = run.externalRuntimeProvider;
  const protocol = runtime?.protocol ?? run.externalRuntimeProtocol ?? "未知";
  const runtimeRevision =
    run.externalRuntimeRevision ?? runtime?.revision ?? "未记录";
  const bindingRevision = snapshot?.binding.revision ?? "未记录";
  const capability = snapshot?.capability.capabilities;
  const diagnostics = events
    .filter((event) => event.type === "warning" || event.type === "error")
    .slice(-3);
  const spawnState =
    run.externalStartedAt === null
      ? "尚未记录 spawn"
      : `已 spawn · ${formatDateTime(run.externalStartedAt)}`;

  return (
    <section
      className="run-section external-run-panel"
      aria-label="外部 Runtime 执行"
    >
      <div className="section-title">
        <SquareTerminal size={15} />
        <h3>外部 Runtime 执行</h3>
        <code>{snapshot === null ? "snapshot missing" : "snapshot r1"}</code>
      </div>
      <div className={`runtime-protocol-note ${protocol}`}>
        {protocolNote(protocol)}
      </div>
      <div className="external-run-facts">
        <div>
          <span>Runtime</span>
          <strong>{snapshot?.runtime.name ?? "历史投影"}</strong>
          <small>{shortId(run.externalRuntimeId ?? "missing")}</small>
        </div>
        <div>
          <span>Provider</span>
          <strong>{provider}</strong>
          <small>
            {observedProvider === null
              ? "未记录观测值"
              : `观测 ${observedProvider}`}
          </small>
        </div>
        <div>
          <span>Protocol</span>
          <strong>{protocol}</strong>
          <small>{run.externalRuntimeVersion ?? "版本未记录"}</small>
        </div>
        <div>
          <span>Revision</span>
          <strong>Runtime r{runtimeRevision}</strong>
          <small>Binding r{bindingRevision}</small>
        </div>
        <div>
          <span>模型</span>
          <strong>{model}</strong>
          <small>{snapshot?.reasoningEffort ?? "reasoning 未记录"}</small>
        </div>
        <div>
          <span>Sandbox / Network</span>
          <strong>{snapshot?.runtime.sandboxMode ?? "未记录"}</strong>
          <small>{snapshot?.runtime.networkMode ?? "未记录"}</small>
        </div>
        <div>
          <span>Session</span>
          <strong title={run.externalSessionId ?? undefined}>
            {run.externalSessionId ?? "未建立"}
          </strong>
          <small>仅作诊断，不自动 resume</small>
        </div>
        <div>
          <span>Spawn</span>
          <strong>{spawnState}</strong>
          <small>
            {run.startedAt === null
              ? "Run 尚未开始"
              : `Run ${formatDateTime(run.startedAt)}`}
          </small>
        </div>
      </div>
      <div className="run-capability-panel">
        <div className="pm-section-head">
          <h3>Capability</h3>
          <span>
            {capability === undefined
              ? "历史 Run 无快照"
              : `${externalRuntimeCapabilityNames.filter((name) => capability[name] === "supported").length}/${externalRuntimeCapabilityNames.length} supported`}
          </span>
        </div>
        {capability === undefined ? (
          <p className="runtime-capability-note">
            该历史 Run 未保存 Capability 快照。
          </p>
        ) : (
          <div className="run-capability-grid" aria-label="Run Capability">
            {externalRuntimeCapabilityNames.map((name) => (
              <span className={capability[name]} key={name}>
                {runtimeCapabilityLabels[name]} ·{" "}
                {capability[name] === "supported"
                  ? "支持"
                  : capability[name] === "unsupported"
                    ? "不支持"
                    : "未知"}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="run-diagnostics" aria-label="Run 诊断">
        <div className="pm-section-head">
          <h3>诊断</h3>
          <span>受限摘要</span>
        </div>
        {run.error !== null && (
          <p className="run-diagnostic-error">{run.error}</p>
        )}
        {diagnostics.map((event) => (
          <p className={`run-diagnostic-${event.type}`} key={event.id}>
            <strong>{event.type}</strong>
            <span>{event.summary}</span>
          </p>
        ))}
        {run.error === null && diagnostics.length === 0 && (
          <p className="runtime-capability-note">未记录阻塞诊断或 warning。</p>
        )}
      </div>
    </section>
  );
}

export function RuntimeProgressHeading({
  protocol,
}: {
  readonly protocol: string;
}) {
  return (
    <div className="section-title">
      {protocol === "plain-text" ? (
        <CircleDashed size={15} />
      ) : (
        <Activity size={15} />
      )}
      <h3>执行进展</h3>
      {protocol === "plain-text" && <code>final-only</code>}
    </div>
  );
}

export function RunEventBadge({ type }: { readonly type: string }) {
  const Icon = type.startsWith("tool.")
    ? Wrench
    : type === "run.completed"
      ? CheckCircle2
      : Activity;
  return (
    <span className={`event-icon event-${type}`}>
      <Icon size={13} />
    </span>
  );
}
