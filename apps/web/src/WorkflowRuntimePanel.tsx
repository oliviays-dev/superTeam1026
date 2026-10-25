import type {
  ProjectMember,
  WorkflowAuditEvent,
  WorkflowAuditKind,
  WorkflowInstance,
  WorkflowInstanceDetail,
  WorkflowRuntimeNode,
} from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Check,
  CircleAlert,
  Forward,
  GitBranch,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  UserRoundPlus,
  X,
} from "lucide-react";
import { useState } from "react";
import { listWorkflowAudit } from "./api.js";

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
  readonly members: readonly ProjectMember[];
  readonly onTransfer: (
    node: WorkflowRuntimeNode,
    targetActorId: string,
    note: string,
  ) => void;
  readonly onCosign: (
    node: WorkflowRuntimeNode,
    approverId: string,
    note: string,
  ) => void;
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
  "instance.reconciled": "状态同步",
  "node.started": "节点开始",
  "node.completed": "节点完成",
  "node.rejected": "节点拒绝",
  "node.skipped": "节点跳过",
  "node.blocked": "节点阻塞",
  "node.failed": "节点失败",
  "node.timed_out": "节点超时",
  "node.retried": "节点重试",
  "node.retry_scheduled": "计划重试",
  "node.recovered": "自动恢复",
  "branch.selected": "选择分支",
  "branch.skipped": "跳过分支",
  "approval.requested": "发起审批",
  "approval.decided": "审批结论",
  "approval.transferred": "审批转交",
  "approval.cosigned": "审批加签",
  "run.interrupted": "Run 中断",
  "subworkflow.started": "启动子流程",
  "subworkflow.completed": "子流程完成",
  "subworkflow.failed": "子流程失败",
};

function WorkflowAuditBrowser({
  projectId,
  instanceId,
}: {
  readonly projectId: string;
  readonly instanceId: string;
}) {
  const [nodeId, setNodeId] = useState("");
  const [kind, setKind] = useState<WorkflowAuditKind | "">("");
  const [query, setQuery] = useState("");
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [page, setPage] = useState(1);
  const auditQuery = useQuery({
    queryKey: [
      "workflow-audit",
      projectId,
      instanceId,
      nodeId,
      kind,
      query,
      failuresOnly,
      page,
    ],
    queryFn: () =>
      listWorkflowAudit({
        projectId,
        instanceId,
        ...(nodeId.trim() === "" ? {} : { nodeId: nodeId.trim() }),
        ...(kind === "" ? {} : { kind }),
        ...(query.trim() === "" ? {} : { query: query.trim() }),
        failuresOnly,
        page,
        pageSize: 20,
      }),
    refetchInterval: 3_000,
  });
  const audit = auditQuery.data;
  const resetPage = () => setPage(1);

  return (
    <section className="workflow-audit-browser">
      <div className="pm-section-head">
        <div>
          <h3>运行审计</h3>
          <p>{audit?.total ?? 0} 条不可变事件</p>
        </div>
        <CircleAlert size={15} />
      </div>
      <div className="workflow-audit-filters">
        <input
          aria-label="审计节点"
          value={nodeId}
          onChange={(event) => {
            setNodeId(event.target.value);
            resetPage();
          }}
          placeholder="节点 ID"
        />
        <select
          aria-label="审计事件类型"
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as WorkflowAuditKind | "");
            resetPage();
          }}
        >
          <option value="">全部动作</option>
          {(Object.keys(auditLabels) as WorkflowAuditKind[]).map((item) => (
            <option key={item} value={item}>
              {auditLabels[item]}
            </option>
          ))}
        </select>
        <label className="workflow-audit-search">
          <Search size={12} />
          <input
            aria-label="审计关键词"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              resetPage();
            }}
            placeholder="摘要或失败原因"
          />
        </label>
        <label className="workflow-audit-failure-toggle">
          <input
            type="checkbox"
            checked={failuresOnly}
            onChange={(event) => {
              setFailuresOnly(event.target.checked);
              resetPage();
            }}
          />
          仅失败
        </label>
      </div>
      <div className="workflow-audit-list">
        {audit?.items.map((event) => (
          <div key={event.id}>
            <span>{event.seq}</span>
            <div>
              <strong>{auditLabels[event.kind] ?? event.kind}</strong>
              <small>{event.summary}</small>
              <small>
                {event.nodeId ?? "实例"} · {event.actorId}
              </small>
            </div>
            <time>{formatDateTime(event.createdAt)}</time>
          </div>
        ))}
        {audit?.items.length === 0 && (
          <div className="pm-empty compact">没有匹配的审计事件</div>
        )}
        {auditQuery.isLoading && (
          <div className="pm-empty compact">正在加载审计事件</div>
        )}
      </div>
      {auditQuery.error !== null && (
        <div className="pm-error">{auditQuery.error.message}</div>
      )}
      <div className="workflow-audit-pagination">
        <button
          className="pm-icon-btn"
          type="button"
          title="上一页"
          disabled={page <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          <ChevronLeft size={13} />
        </button>
        <span>
          {page} / {Math.max(1, Math.ceil((audit?.total ?? 0) / 20))}
        </span>
        <button
          className="pm-icon-btn"
          type="button"
          title="下一页"
          disabled={audit?.hasMore !== true}
          onClick={() => setPage((current) => current + 1)}
        >
          <ChevronRight size={13} />
        </button>
      </div>
    </section>
  );
}

export function WorkflowRuntimePanel({
  detail,
  pending,
  onComplete,
  onDispatch,
  onApproval,
  onRetry,
  members,
  onTransfer,
  onCosign,
  onPause,
  onResume,
  onReconcile,
}: WorkflowRuntimePanelProps) {
  const { instance, approvals } = detail;
  const graph = instance.graph;
  const terminal = new Set(["completed", "failed", "cancelled", "blocked"]);
  const currentActorId = "local-admin";
  const currentMember = members.find(
    (member) =>
      member.status === "active" && member.actorId === currentActorId,
  );
  const [approvalEditor, setApprovalEditor] = useState<{
    readonly nodeId: string;
    readonly mode: "transfer" | "cosign";
    readonly targetActorId: string;
    readonly note: string;
  } | null>(null);

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
          const currentApproval = approvals.find(
            (approval) =>
              approval.nodeId === node.nodeId &&
              approval.round === node.visits &&
              approval.approverId === currentActorId &&
              approval.status === "pending",
          );
          const humanCandidates = members.filter(
            (member) =>
              member.kind === "human" &&
              member.status === "active" &&
              member.actorId !== currentActorId,
          );
          const editor =
            approvalEditor?.nodeId === node.nodeId ? approvalEditor : null;
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
                {node.status === "waiting_approval" && currentApproval && (
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
                    <button
                      className="pm-btn secondary"
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        setApprovalEditor({
                          nodeId: node.nodeId,
                          mode: "transfer",
                          targetActorId: humanCandidates[0]?.actorId ?? "",
                          note: "",
                        })
                      }
                    >
                      <Forward size={13} />
                      转交
                    </button>
                  </>
                )}
                {node.status === "waiting_approval" &&
                  (currentApproval !== undefined || currentMember?.owner) && (
                    <button
                      className="pm-btn secondary"
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        setApprovalEditor({
                          nodeId: node.nodeId,
                          mode: "cosign",
                          targetActorId: humanCandidates[0]?.actorId ?? "",
                          note: "",
                        })
                      }
                    >
                      <UserRoundPlus size={13} />
                      加签
                    </button>
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
              {editor !== null && (
                <form
                  className="workflow-approval-editor"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (editor.targetActorId === "") return;
                    if (editor.mode === "transfer") {
                      onTransfer(node, editor.targetActorId, editor.note);
                    } else {
                      onCosign(node, editor.targetActorId, editor.note);
                    }
                    setApprovalEditor(null);
                  }}
                >
                  <select
                    aria-label={
                      editor.mode === "transfer" ? "转交审批人" : "加签审批人"
                    }
                    value={editor.targetActorId}
                    onChange={(event) =>
                      setApprovalEditor({
                        ...editor,
                        targetActorId: event.target.value,
                      })
                    }
                  >
                    <option value="">选择审批人</option>
                    {humanCandidates.map((member) => (
                      <option key={member.actorId} value={member.actorId}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="审批操作备注"
                    value={editor.note}
                    onChange={(event) =>
                      setApprovalEditor({ ...editor, note: event.target.value })
                    }
                    placeholder="备注"
                  />
                  <button
                    className="pm-btn primary"
                    type="submit"
                    disabled={
                      pending ||
                      editor.targetActorId === "" ||
                      humanCandidates.length === 0
                    }
                  >
                    {editor.mode === "transfer" ? (
                      <Forward size={13} />
                    ) : (
                      <UserRoundPlus size={13} />
                    )}
                    {editor.mode === "transfer" ? "确认转交" : "确认加签"}
                  </button>
                  <button
                    className="pm-btn secondary"
                    type="button"
                    onClick={() => setApprovalEditor(null)}
                  >
                    <X size={13} />
                    取消
                  </button>
                </form>
              )}
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
                    {approval.approverId} · 第 {approval.round} 轮 ·{" "}
                    {approval.kind === "cosign" ? "加签" : "审批"}
                    {approval.delegatedFrom === null
                      ? ""
                      : ` · 来自 ${approval.delegatedFrom}`}
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
        <WorkflowAuditBrowser
          projectId={instance.projectId}
          instanceId={instance.id}
        />
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
