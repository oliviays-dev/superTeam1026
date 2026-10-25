import type {
  WorkflowAuditEvent,
  WorkflowInstance,
  WorkflowInstanceDetail,
  WorkflowRuntimeNode,
} from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import {
  Bot,
  Check,
  CircleAlert,
  GitBranch,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";

interface WorkflowRuntimePanelProps {
  readonly detail: WorkflowInstanceDetail;
  readonly pending: boolean;
  readonly onComplete: (node: WorkflowRuntimeNode) => void;
  readonly onDispatch: () => void;
  readonly onApproval: (
    node: WorkflowRuntimeNode,
    decision: "approve" | "reject",
  ) => void;
  readonly onRetry: (node: WorkflowRuntimeNode) => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onReconcile: () => void;
}

const instanceStatusLabels: Record<WorkflowInstance["status"], string> = {
  active: "运行中",
  waiting: "等待操作",
  blocked: "已阻塞",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const nodeStatusLabels: Record<WorkflowRuntimeNode["status"], string> = {
  waiting: "等待",
  ready: "就绪",
  running: "执行中",
  waiting_approval: "待审批",
  blocked: "阻塞",
  completed: "完成",
  rejected: "拒绝",
  skipped: "跳过",
  failed: "失败",
};

const auditLabels: Partial<Record<WorkflowAuditEvent["kind"], string>> = {
  "instance.started": "启动",
  "instance.paused": "暂停",
  "instance.resumed": "恢复",
  "instance.completed": "完成",
  "instance.blocked": "阻塞",
  "instance.failed": "失败",
  "node.started": "节点开始",
  "node.completed": "节点完成",
  "node.rejected": "节点拒绝",
  "node.skipped": "节点跳过",
  "node.blocked": "节点阻塞",
  "node.failed": "节点失败",
  "node.timed_out": "节点超时",
  "node.retried": "节点重试",
  "branch.selected": "选择分支",
  "branch.skipped": "跳过分支",
  "approval.requested": "发起审批",
  "approval.decided": "审批结论",
  "subworkflow.started": "启动子流程",
  "subworkflow.completed": "子流程完成",
  "subworkflow.failed": "子流程失败",
};

export function WorkflowRuntimePanel({
  detail,
  pending,
  onComplete,
  onDispatch,
  onApproval,
  onRetry,
  onPause,
  onResume,
  onReconcile,
}: WorkflowRuntimePanelProps) {
  const { instance, approvals, audit } = detail;
  const graph = instance.graph;
  const terminal = new Set(["completed", "failed", "cancelled", "blocked"]);

  return (
    <div className="workflow-runtime-panel">
      <div className="instance-head workflow-runtime-head">
        <div>
          <strong>{instance.title}</strong>
          <span>
            {instance.definitionKey}@v{instance.definitionVersion} ·{" "}
            {formatDateTime(instance.updatedAt)}
          </span>
        </div>
        <div className="pm-head-actions">
          <span className={`pm-pill workflow-status-${instance.status}`}>
            {instanceStatusLabels[instance.status]}
          </span>
          <button
            className="pm-icon-btn"
            type="button"
            title="同步运行状态"
            disabled={pending}
            onClick={onReconcile}
          >
            <RefreshCw size={14} className={pending ? "spin" : undefined} />
          </button>
          {(instance.status === "active" || instance.status === "waiting") && (
            <button
              className="pm-btn secondary"
              type="button"
              disabled={pending}
              onClick={onPause}
            >
              <Pause size={14} />
              暂停
            </button>
          )}
          {instance.status === "paused" && (
            <button
              className="pm-btn primary"
              type="button"
              disabled={pending}
              onClick={onResume}
            >
              <Play size={14} />
              恢复
            </button>
          )}
        </div>
      </div>

      {instance.failureReason !== null && (
        <div className="workflow-failure-reason">
          <CircleAlert size={14} />
          <span>{instance.failureReason}</span>
        </div>
      )}

      <ol className="workflow-node-list">
        {graph?.nodes.map((definition, index) => {
          const node = instance.runtime.nodes.find(
            (candidate) => candidate.nodeId === definition.id,
          );
          if (node === undefined) return null;
          return (
            <li
              className={`workflow-node node-${node.status}`}
              key={node.nodeId}
              data-node-id={node.nodeId}
            >
              <span className="workflow-node-index">
                {node.status === "completed" ? (
                  <Check size={13} />
                ) : node.status === "failed" || node.status === "blocked" ? (
                  <CircleAlert size={13} />
                ) : (
                  index + 1
                )}
              </span>
              <div className="workflow-node-copy">
                <div>
                  <strong>{definition.name}</strong>
                  <span className={`pm-pill status-${node.status}`}>
                    {nodeStatusLabels[node.status]}
                  </span>
                </div>
                <small>
                  {definition.type === "approval"
                    ? `审批 · ${definition.approvalPolicy === "all" ? "全部通过" : "任一通过"}`
                    : definition.type === "subworkflow"
                      ? `子流程 · ${definition.subworkflowKey ?? "-"}`
                      : `${definition.executor.kind}:${definition.executor.id}`}
                  {node.visits > 1 ? ` · 第 ${node.visits} 次进入` : ""}
                  {node.attempt > 0 ? ` · 第 ${node.attempt} 次执行` : ""}
                </small>
                {node.taskId !== null && (
                  <code>任务 {node.taskId.slice(0, 8)}</code>
                )}
                {node.runId !== null && (
                  <code>Run {node.runId.slice(0, 8)}</code>
                )}
                {node.childInstanceId !== null && (
                  <code>子实例 {node.childInstanceId.slice(0, 8)}</code>
                )}
                {node.error !== null && <em>{node.error}</em>}
              </div>
              <div className="workflow-node-actions">
                {node.status === "ready" &&
                  node.type !== "decision" &&
                  node.type !== "approval" &&
                  node.type !== "subworkflow" &&
                  (definition.executor.kind === "agent" ||
                    definition.executor.kind === "role") && (
                    <button
                      className="pm-btn secondary"
                      type="button"
                      disabled={pending}
                      onClick={onDispatch}
                    >
                      <Bot size={13} />
                      派发 Agent
                    </button>
                  )}
                {node.status === "ready" &&
                  node.type !== "decision" &&
                  node.type !== "approval" &&
                  node.type !== "subworkflow" &&
                  definition.executor.kind !== "agent" &&
                  definition.executor.kind !== "role" && (
                    <button
                      className="pm-btn primary"
                      type="button"
                      disabled={pending}
                      onClick={() => onComplete(node)}
                    >
                      <Check size={13} />
                      完成
                    </button>
                  )}
                {node.status === "waiting_approval" && (
                  <>
                    <button
                      className="pm-btn primary"
                      type="button"
                      disabled={pending}
                      onClick={() => onApproval(node, "approve")}
                    >
                      <ShieldCheck size={13} />
                      同意
                    </button>
                    <button
                      className="pm-btn secondary danger"
                      type="button"
                      disabled={pending}
                      onClick={() => onApproval(node, "reject")}
                    >
                      <X size={13} />
                      拒绝
                    </button>
                  </>
                )}
                {node.type === "task" &&
                  (node.status === "failed" || node.status === "blocked") && (
                    <button
                      className="pm-btn secondary"
                      type="button"
                      disabled={pending}
                      onClick={() => onRetry(node)}
                    >
                      <RotateCcw size={13} />
                      重试
                    </button>
                  )}
              </div>
            </li>
          );
        })}
      </ol>

      {graph !== null && (
        <section className="workflow-branches">
          <div className="pm-section-head">
            <div>
              <h3>分支与循环</h3>
              <p>条件求值、默认分支和循环回边由运行时确定。</p>
            </div>
            <GitBranch size={15} />
          </div>
          <div className="workflow-branch-grid">
            {graph.edges.map((edge) => {
              const runtimeEdge = instance.runtime.edges.find(
                (candidate) => candidate.edgeId === edge.id,
              );
              const selected =
                runtimeEdge?.status === "selected" ||
                runtimeEdge?.status === "looped";
              return (
                <div
                  className={`workflow-branch ${
                    selected ? "selected" : "inactive"
                  }`}
                  key={edge.id}
                >
                  <span>
                    {edge.from} → {edge.to}
                  </span>
                  <small>
                    {edge.result === undefined
                      ? (edge.condition ??
                        edge.breakCondition ??
                        (edge.default === true ? "默认分支" : "顺序"))
                      : `结果：${edge.result}`}
                    {edge.breakCondition === undefined
                      ? ""
                      : ` · break: ${edge.breakCondition}`}
                  </small>
                  <i>{runtimeEdge?.status ?? "pending"}</i>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="workflow-runtime-secondary">
        <section>
          <div className="pm-section-head">
            <div>
              <h3>审批记录</h3>
              <p>
                {approvals.filter((item) => item.status === "pending").length}{" "}
                项待处理
              </p>
            </div>
            <ShieldCheck size={15} />
          </div>
          <div className="workflow-approval-list">
            {approvals.map((approval) => (
              <div key={approval.id}>
                <span>
                  <strong>{approval.nodeId}</strong>
                  <small>
                    {approval.approverId} · 第 {approval.round} 轮
                  </small>
                </span>
                <i className={`pm-pill status-${approval.status}`}>
                  {approval.status}
                </i>
              </div>
            ))}
            {approvals.length === 0 && (
              <div className="pm-empty compact">暂无审批记录</div>
            )}
          </div>
        </section>
        <section>
          <div className="pm-section-head">
            <div>
              <h3>运行审计</h3>
              <p>{audit.length} 条不可变事件</p>
            </div>
            <CircleAlert size={15} />
          </div>
          <div className="workflow-audit-list">
            {[...audit]
              .reverse()
              .slice(0, 16)
              .map((event) => (
                <div key={event.id}>
                  <span>{event.seq}</span>
                  <div>
                    <strong>{auditLabels[event.kind] ?? event.kind}</strong>
                    <small>{event.summary}</small>
                  </div>
                  <time>{formatDateTime(event.createdAt)}</time>
                </div>
              ))}
            {audit.length === 0 && (
              <div className="pm-empty compact">暂无审计记录</div>
            )}
          </div>
        </section>
      </div>

      {terminal.has(instance.status) && instance.status !== "completed" && (
        <div className="pm-error">
          该实例已进入 {instanceStatusLabels[instance.status]}{" "}
          状态，请查看审计后重试或取消。
        </div>
      )}
    </div>
  );
}
