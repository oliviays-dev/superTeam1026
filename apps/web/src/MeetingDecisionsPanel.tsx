import type {
  Agent,
  MeetingActionItem,
  MeetingDetail,
  MeetingMinutesVersion,
  ProjectMember,
} from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Check,
  ChevronRight,
  Clock3,
  FileCheck2,
  History,
  Link2,
  ListChecks,
  LoaderCircle,
  RefreshCw,
  Send,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  convertMeetingActionItem,
  createMeetingActionItem,
  getMeetingMinutes,
  getMeetingTraceability,
  listMeetingActionItems,
  publishMeetingMinutes,
  saveMeetingMinutesDraft,
  updateMeetingActionItem,
} from "./api.js";

type MeetingDecisionTab = "minutes" | "actions" | "trace";

const priorityLabel: Record<MeetingActionItem["priority"], string> = {
  low: "低",
  medium: "中",
  high: "高",
  urgent: "紧急",
};

const actionStatusLabel: Record<MeetingActionItem["status"], string> = {
  open: "待处理",
  in_progress: "进行中",
  done: "已完成",
  cancelled: "已取消",
};

const actionStatusTone: Record<MeetingActionItem["status"], string> = {
  open: "neutral",
  in_progress: "progress",
  done: "done",
  cancelled: "warn",
};

export function MeetingDecisionsPanel({
  meeting,
  members,
  agents,
  onOpenTask,
}: {
  readonly meeting: MeetingDetail;
  readonly members: ProjectMember[];
  readonly agents: Agent[];
  readonly onOpenTask: (taskId: string, projectId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<MeetingDecisionTab>("minutes");
  const [content, setContent] = useState("");
  const [decisions, setDecisions] = useState("");
  const [sourceMessageIds, setSourceMessageIds] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  const [actionTitle, setActionTitle] = useState("");
  const [actionDescription, setActionDescription] = useState("");
  const [ownerActorId, setOwnerActorId] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [priority, setPriority] =
    useState<MeetingActionItem["priority"]>("medium");
  const [dedupeKey, setDedupeKey] = useState("");
  const meetingId = meeting.meeting.id;
  const projectId = meeting.meeting.projectId;
  const activeMembers = members.filter((member) => member.status === "active");
  const activeAgentMembers = activeMembers.filter(
    (member) =>
      member.kind === "agent" &&
      agents.some(
        (agent) => agent.id === member.actorId && agent.status === "active",
      ),
  );
  const minutesQuery = useQuery({
    queryKey: ["meeting-minutes", meetingId],
    queryFn: () => getMeetingMinutes(meetingId),
  });
  const actionItemsQuery = useQuery({
    queryKey: ["meeting-action-items", meetingId],
    queryFn: () => listMeetingActionItems(meetingId),
    refetchInterval: 4_000,
  });
  const traceQuery = useQuery({
    queryKey: ["meeting-traceability", meetingId],
    queryFn: () => getMeetingTraceability(meetingId),
    enabled: tab === "trace",
    refetchInterval: tab === "trace" ? 4_000 : false,
  });
  const latestVersion = minutesQuery.data?.versions[0];

  useEffect(() => {
    const draft = minutesQuery.data?.draft;
    if (draft === undefined) return;
    setContent(draft.content);
    setDecisions(draft.decisions.join("\n"));
    setSourceMessageIds(draft.sourceMessageIds);
    setRevision(draft.revision);
  }, [minutesQuery.data?.draft.updatedAt, minutesQuery.data?.draft.revision]);

  useEffect(() => {
    if (ownerActorId !== "" || activeMembers.length === 0) return;
    const owner =
      activeMembers.find((member) => member.owner) ?? activeMembers[0];
    if (owner === undefined) return;
    setOwnerActorId(owner.actorId);
  }, [activeMembers, ownerActorId]);

  const saveDraftMutation = useMutation({
    mutationFn: () =>
      saveMeetingMinutesDraft(meetingId, {
        content,
        decisions: decisions
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
        sourceMessageIds,
        expectedRevision: revision,
      }),
    onSuccess: (draft) => {
      setRevision(draft.revision);
      void queryClient.invalidateQueries({
        queryKey: ["meeting-minutes", meetingId],
      });
    },
  });
  const publishMutation = useMutation({
    mutationFn: () => publishMeetingMinutes(meetingId, revision),
    onSuccess: (result) => {
      setRevision(result.minutes.draft.revision);
      setContent(result.minutes.draft.content);
      setDecisions(result.minutes.draft.decisions.join("\n"));
      void queryClient.invalidateQueries({
        queryKey: ["meeting-minutes", meetingId],
      });
      void queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
      void queryClient.invalidateQueries({ queryKey: ["meetings"] });
      void queryClient.invalidateQueries({
        queryKey: ["meeting-traceability", meetingId],
      });
    },
  });
  const createActionMutation = useMutation({
    mutationFn: () =>
      createMeetingActionItem(meetingId, {
        title: actionTitle,
        description: actionDescription,
        ownerActorId,
        priority,
        sourceType: latestVersion === undefined ? "manual" : "minutes_version",
        sourceMessageIds: latestVersion?.sourceMessageIds ?? [],
        ...(latestVersion === undefined
          ? {}
          : {
              sourceVersionId: latestVersion.id,
            }),
        ...(dueAt === "" ? {} : { dueAt: new Date(dueAt).toISOString() }),
        ...(dedupeKey.trim() === "" ? {} : { dedupeKey: dedupeKey.trim() }),
      }),
    onSuccess: () => {
      setActionTitle("");
      setActionDescription("");
      setDueAt("");
      setDedupeKey("");
      void queryClient.invalidateQueries({
        queryKey: ["meeting-action-items", meetingId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["meeting-traceability", meetingId],
      });
    },
  });

  return (
    <section className="meeting-decisions-panel">
      <div
        className="meeting-decision-tabs"
        role="tablist"
        aria-label="会议结论"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "minutes"}
          className={tab === "minutes" ? "active" : undefined}
          onClick={() => setTab("minutes")}
        >
          <FileCheck2 size={13} />
          纪要
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "actions"}
          className={tab === "actions" ? "active" : undefined}
          onClick={() => setTab("actions")}
        >
          <ListChecks size={13} />
          行动项
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "trace"}
          className={tab === "trace" ? "active" : undefined}
          onClick={() => setTab("trace")}
        >
          <Link2 size={13} />
          闭环
        </button>
      </div>

      {tab === "minutes" && (
        <div className="meeting-minutes-workbench">
          <div className="meeting-minutes-editor">
            <div className="meeting-decision-section-head">
              <div>
                <strong>纪要草稿</strong>
                <small>修订 {revision}</small>
              </div>
              {latestVersion !== undefined && (
                <span className="pm-pill done">
                  已发布 v{latestVersion.version}
                </span>
              )}
            </div>
            <textarea
              aria-label="会议纪要内容"
              rows={7}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="记录结论、范围和待办背景"
            />
            <textarea
              aria-label="会议决策"
              rows={3}
              value={decisions}
              onChange={(event) => setDecisions(event.target.value)}
              placeholder="每行一条已确认决策"
            />
            <details className="meeting-source-picker">
              <summary>来源消息 · 已选 {sourceMessageIds.length} 条</summary>
              <div>
                {meeting.messages.map((message) => (
                  <label key={message.id}>
                    <input
                      type="checkbox"
                      checked={sourceMessageIds.includes(message.id)}
                      onChange={(event) =>
                        setSourceMessageIds((current) =>
                          event.target.checked
                            ? [...current, message.id]
                            : current.filter((id) => id !== message.id),
                        )
                      }
                    />
                    <span>
                      <b>{message.authorName}</b>
                      {message.content}
                    </span>
                  </label>
                ))}
                {meeting.messages.length === 0 && <em>会议暂无来源消息</em>}
              </div>
            </details>
            <div className="meeting-decision-actions">
              <button
                className="pm-btn secondary"
                type="button"
                disabled={saveDraftMutation.isPending}
                onClick={() => saveDraftMutation.mutate()}
              >
                {saveDraftMutation.isPending ? (
                  <LoaderCircle className="spin" size={13} />
                ) : (
                  <Check size={13} />
                )}
                保存草稿
              </button>
              <button
                className="pm-btn primary"
                type="button"
                disabled={publishMutation.isPending || content.trim() === ""}
                onClick={() => publishMutation.mutate()}
              >
                <Send size={13} />
                发布纪要
              </button>
            </div>
            {saveDraftMutation.error !== null && (
              <div className="pm-error">
                {saveDraftMutation.error.message}
                <button
                  type="button"
                  onClick={() => {
                    void minutesQuery.refetch();
                    saveDraftMutation.reset();
                  }}
                >
                  载入最新修订
                </button>
              </div>
            )}
            {publishMutation.error !== null && (
              <div className="pm-error">{publishMutation.error.message}</div>
            )}
          </div>

          <aside className="meeting-version-history">
            <header>
              <History size={13} />
              <strong>发布历史</strong>
              <span>{minutesQuery.data?.versions.length ?? 0}</span>
            </header>
            {minutesQuery.data?.versions.map((version) => (
              <VersionRow
                version={version}
                key={version.id}
                onRevise={() => {
                  setContent(version.content);
                  setDecisions(version.decisions.join("\n"));
                  setSourceMessageIds(version.sourceMessageIds);
                }}
              />
            ))}
            {minutesQuery.data?.versions.length === 0 && (
              <div className="pm-empty compact">尚未发布纪要版本</div>
            )}
          </aside>
        </div>
      )}

      {tab === "actions" && (
        <div className="meeting-actions-workbench">
          <form
            className="meeting-action-create"
            onSubmit={(event) => {
              event.preventDefault();
              if (actionTitle.trim() !== "" && ownerActorId !== "") {
                createActionMutation.mutate();
              }
            }}
          >
            <div className="meeting-decision-section-head">
              <div>
                <strong>新增行动项</strong>
                <small>
                  {latestVersion === undefined
                    ? "尚无已发布纪要"
                    : `来源 v${latestVersion.version}`}
                </small>
              </div>
            </div>
            <input
              aria-label="行动项标题"
              value={actionTitle}
              onChange={(event) => setActionTitle(event.target.value)}
              placeholder="明确、可验收的动作"
            />
            <textarea
              aria-label="行动项说明"
              rows={2}
              value={actionDescription}
              onChange={(event) => setActionDescription(event.target.value)}
              placeholder="补充范围、约束和完成标准"
            />
            <div className="meeting-action-grid">
              <label>
                负责人
                <select
                  aria-label="行动项负责人"
                  value={ownerActorId}
                  onChange={(event) => setOwnerActorId(event.target.value)}
                >
                  {activeMembers.map((member) => (
                    <option value={member.actorId} key={member.id}>
                      {member.kind === "agent" ? "AI · " : ""}
                      {member.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                截止时间
                <input
                  aria-label="行动项截止时间"
                  type="datetime-local"
                  value={dueAt}
                  onChange={(event) => setDueAt(event.target.value)}
                />
              </label>
              <label>
                优先级
                <select
                  aria-label="行动项优先级"
                  value={priority}
                  onChange={(event) =>
                    setPriority(
                      event.target.value as MeetingActionItem["priority"],
                    )
                  }
                >
                  {Object.entries(priorityLabel).map(([value, label]) => (
                    <option value={value} key={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                去重键
                <input
                  aria-label="行动项去重键"
                  value={dedupeKey}
                  onChange={(event) => setDedupeKey(event.target.value)}
                  placeholder="自动生成"
                />
              </label>
            </div>
            <button
              className="pm-btn primary"
              type="submit"
              disabled={
                createActionMutation.isPending ||
                actionTitle.trim() === "" ||
                ownerActorId === ""
              }
            >
              <ListChecks size={13} />
              添加行动项
            </button>
            {createActionMutation.error !== null && (
              <div className="pm-error">
                {createActionMutation.error.message}
              </div>
            )}
          </form>

          <div className="meeting-action-list">
            {actionItemsQuery.data?.map((item) => (
              <ActionItemCard
                key={item.id}
                meetingId={meetingId}
                projectId={projectId}
                item={item}
                agentMembers={activeAgentMembers}
                onOpenTask={onOpenTask}
              />
            ))}
            {actionItemsQuery.data?.length === 0 && (
              <div className="pm-empty meeting-action-empty">
                <ListChecks size={24} />
                <strong>暂无行动项</strong>
                <span>发布纪要后，把决策拆成有负责人和截止时间的行动项。</span>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "trace" && (
        <div className="meeting-trace-workbench">
          <div className="meeting-decision-section-head">
            <div>
              <strong>决策闭环</strong>
              <small>会议 → 行动项 → 任务 → Run → Review → Memory</small>
            </div>
            <button
              className="pm-icon-btn"
              type="button"
              title="刷新闭环"
              onClick={() => void traceQuery.refetch()}
            >
              <RefreshCw
                className={traceQuery.isFetching ? "spin" : undefined}
                size={14}
              />
            </button>
          </div>
          {traceQuery.data?.actionItems.map((item) => (
            <article className="meeting-trace-chain" key={item.id}>
              <header>
                <span className={`pm-pill ${actionStatusTone[item.status]}`}>
                  {actionStatusLabel[item.status]}
                </span>
                <strong>{item.title}</strong>
                <small>{item.ownerName}</small>
              </header>
              <div className="meeting-trace-flow">
                <TraceNode
                  label="来源"
                  value={
                    item.sourceVersionId === null
                      ? "会议消息 / 手工"
                      : "已发布纪要"
                  }
                />
                <ChevronRight size={14} />
                <TraceNode
                  label="任务"
                  value={
                    item.taskId === null
                      ? "未转换"
                      : `${item.taskStatus ?? "unknown"}`
                  }
                />
                <ChevronRight size={14} />
                <TraceNode
                  label="Run"
                  value={
                    item.runs.length === 0
                      ? "未运行"
                      : (item.runs.at(-1)?.status ?? "unknown")
                  }
                />
                <ChevronRight size={14} />
                <TraceNode
                  label="Review"
                  value={
                    item.reviews.length === 0
                      ? "待验收"
                      : item.reviews.at(-1)?.decision === "approve"
                        ? "通过"
                        : "退回"
                  }
                />
                <ChevronRight size={14} />
                <TraceNode
                  label="Memory"
                  value={
                    item.memories.length === 0
                      ? "未写入"
                      : `${item.memories.length} 条`
                  }
                />
              </div>
              <footer>
                <span>
                  <Clock3 size={12} />
                  更新 {formatDateTime(item.updatedAt)}
                </span>
                {item.taskId !== null && (
                  <button
                    className="pm-btn secondary"
                    type="button"
                    onClick={() => onOpenTask(item.taskId!, item.projectId)}
                  >
                    打开任务
                    <ArrowRight size={12} />
                  </button>
                )}
              </footer>
            </article>
          ))}
          {traceQuery.data?.actionItems.length === 0 && (
            <div className="pm-empty meeting-action-empty">
              <Link2 size={24} />
              <strong>暂无闭环记录</strong>
              <span>
                行动项转换为任务后，这里会汇总 Run、Review 和 Memory。
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function VersionRow({
  version,
  onRevise,
}: {
  readonly version: MeetingMinutesVersion;
  readonly onRevise: () => void;
}) {
  return (
    <div className="meeting-version-row">
      <span>v{version.version}</span>
      <div>
        <strong>{formatDateTime(version.publishedAt)}</strong>
        <small>{version.sourceMessageIds.length} 条来源消息</small>
      </div>
      <button type="button" onClick={onRevise}>
        修订
      </button>
    </div>
  );
}

function ActionItemCard({
  meetingId,
  projectId,
  item,
  agentMembers,
  onOpenTask,
}: {
  readonly meetingId: string;
  readonly projectId: string;
  readonly item: MeetingActionItem;
  readonly agentMembers: ProjectMember[];
  readonly onOpenTask: (taskId: string, projectId: string) => void;
}) {
  const queryClient = useQueryClient();
  const defaultAssignee =
    item.ownerKind === "agent"
      ? item.ownerActorId
      : (agentMembers[0]?.actorId ?? "");
  const [assigneeAgentId, setAssigneeAgentId] = useState(defaultAssignee);
  const [dispatch, setDispatch] = useState(true);
  const [convertedTaskId, setConvertedTaskId] = useState(item.taskId ?? "");
  const convertMutation = useMutation({
    mutationFn: () =>
      convertMeetingActionItem(meetingId, item.id, {
        assigneeAgentId,
        dispatch,
      }),
    onSuccess: (result) => {
      setConvertedTaskId(result.task.id);
      void queryClient.invalidateQueries({
        queryKey: ["meeting-action-items", meetingId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["meeting-traceability", meetingId],
      });
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const cancelMutation = useMutation({
    mutationFn: () => updateMeetingActionItem(meetingId, item.id, "cancelled"),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["meeting-action-items", meetingId],
      });
    },
  });

  return (
    <article className="meeting-action-card">
      <header>
        <div>
          <span className={`pm-pill ${actionStatusTone[item.status]}`}>
            {actionStatusLabel[item.status]}
          </span>
          <span className={`pm-pill priority-${item.priority}`}>
            {priorityLabel[item.priority]}
          </span>
        </div>
        <small>{formatDateTime(item.createdAt)}</small>
      </header>
      <strong>{item.title}</strong>
      {item.description !== "" && <p>{item.description}</p>}
      <div className="meeting-action-meta">
        <span>负责人 · {item.ownerName}</span>
        <span>
          截止 · {item.dueAt === null ? "未设置" : formatDateTime(item.dueAt)}
        </span>
        <span>来源 · {item.sourceType}</span>
        <span>去重 · {item.dedupeKey}</span>
      </div>
      {convertedTaskId !== "" ? (
        <button
          className="pm-btn secondary"
          type="button"
          onClick={() => onOpenTask(convertedTaskId, projectId)}
        >
          打开关联任务
          <ArrowRight size={12} />
        </button>
      ) : (
        <div className="meeting-action-convert">
          <select
            aria-label={`为${item.title}选择执行 AI`}
            value={assigneeAgentId}
            onChange={(event) => setAssigneeAgentId(event.target.value)}
          >
            {agentMembers.map((member) => (
              <option value={member.actorId} key={member.id}>
                {member.name}
              </option>
            ))}
          </select>
          <label>
            <input
              type="checkbox"
              checked={dispatch}
              onChange={(event) => setDispatch(event.target.checked)}
            />
            立即派发
          </label>
          <button
            className="pm-btn primary"
            type="button"
            disabled={
              convertMutation.isPending ||
              assigneeAgentId === "" ||
              item.status === "cancelled"
            }
            onClick={() => convertMutation.mutate()}
          >
            {convertMutation.isPending ? (
              <LoaderCircle className="spin" size={13} />
            ) : (
              <ArrowRight size={13} />
            )}
            转为任务
          </button>
          {item.status === "open" && (
            <button
              className="pm-icon-btn"
              type="button"
              title="取消行动项"
              disabled={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
            >
              <X size={13} />
            </button>
          )}
        </div>
      )}
      {agentMembers.length === 0 && convertedTaskId === "" && (
        <div className="pm-hint">
          项目暂无活跃 AI 成员，添加项目成员后才能转换任务。
        </div>
      )}
      {convertMutation.error !== null && (
        <div className="pm-error">{convertMutation.error.message}</div>
      )}
    </article>
  );
}

function TraceNode({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}) {
  return (
    <span className="meeting-trace-node">
      <small>{label}</small>
      <b>{value}</b>
    </span>
  );
}
