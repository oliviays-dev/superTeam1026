import type {
  Agent,
  AgentEpisode,
  HandoffCard,
  MemoryClaim,
  MemoryReviewQueueItem,
  MemorySourceRef,
  ProjectMember,
  Task,
} from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Bot,
  Check,
  CircleAlert,
  Inbox,
  Link2,
  LoaderCircle,
  LockKeyhole,
  PackageCheck,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  ApiRequestError,
  confirmHandoff,
  createHandoff,
  listAgentEpisodes,
  listHandoffs,
  listMemoryReviews,
  listProjectMembers,
  reviewMemoryClaims,
} from "./api.js";

type OpenTask = (taskId: string, projectId: string) => void;
type OpenMeeting = (meetingId: string, projectId: string) => void;

function claimVersionMap(
  items: readonly MemoryReviewQueueItem[],
): Record<string, number> {
  return Object.fromEntries(
    items.map((item) => [item.claim.id, item.claim.version]),
  );
}

function isConflict(error: Error | null): boolean {
  return (
    error instanceof ApiRequestError && error.code === "memory_review_conflict"
  );
}

function sourceMeetingId(refs: readonly MemorySourceRef[]): string | undefined {
  return refs.find((ref) => ref.kind === "meeting")?.id;
}

function SourceLinks({
  refs,
  projectId,
  onOpenTask,
  onOpenMeeting,
}: {
  readonly refs: readonly MemorySourceRef[];
  readonly projectId: string;
  readonly onOpenTask: OpenTask;
  readonly onOpenMeeting: OpenMeeting;
}) {
  const meetingId = sourceMeetingId(refs);
  const tasks = refs.filter((ref) => ref.kind === "task");
  const claims = refs.filter((ref) => ref.kind === "memory-claim");
  const actions = refs.filter((ref) => ref.kind === "action-item");
  const unavailable = refs.filter((ref) => !ref.available);
  if (
    meetingId === undefined &&
    tasks.length === 0 &&
    claims.length === 0 &&
    actions.length === 0
  ) {
    return null;
  }
  return (
    <div className="memory-source-links" aria-label="来源引用">
      <span>
        <Link2 size={11} />
        来源
      </span>
      {meetingId !== undefined && (
        <button
          type="button"
          onClick={() => onOpenMeeting(meetingId, projectId)}
        >
          会议纪要
          <ArrowRight size={11} />
        </button>
      )}
      {actions.map((ref) => (
        <span className="memory-source-note" key={ref.id}>
          行动项 · {ref.label}
        </span>
      ))}
      {tasks.map((ref) => (
        <button
          type="button"
          key={ref.id}
          onClick={() => onOpenTask(ref.id, projectId)}
        >
          关联任务
          <ArrowRight size={11} />
        </button>
      ))}
      {claims.map((ref) => (
        <span className="memory-source-note" key={ref.id}>
          Memory Claim
        </span>
      ))}
      {unavailable.length > 0 && (
        <span className="memory-source-unavailable">
          <CircleAlert size={11} />
          {unavailable.length} 个来源不可用
        </span>
      )}
    </div>
  );
}

export function MemoryReviewQueuePanel({
  projectId,
  canManage,
  onOpenTask,
  onOpenMeeting,
}: {
  readonly projectId: string;
  readonly canManage: boolean;
  readonly onOpenTask: OpenTask;
  readonly onOpenMeeting: OpenMeeting;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [reason, setReason] = useState("");
  const queueQuery = useQuery({
    queryKey: ["memory-reviews", projectId],
    queryFn: () => listMemoryReviews(projectId),
    refetchInterval: 5_000,
  });
  useEffect(() => {
    if (queueQuery.data === undefined) return;
    const allowed = claimVersionMap(queueQuery.data.items);
    setSelected((current) =>
      Object.fromEntries(
        Object.entries(current).filter(
          ([claimId, version]) => allowed[claimId] === version,
        ),
      ),
    );
  }, [queueQuery.data]);
  const reviewMutation = useMutation({
    mutationFn: (decision: "accept" | "reject") =>
      reviewMemoryClaims(projectId, {
        decision,
        reason,
        items: Object.entries(selected).map(([claimId, expectedVersion]) => ({
          claimId,
          expectedVersion,
        })),
      }),
    onSuccess: () => {
      setSelected({});
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["memory", projectId] });
      void queryClient.invalidateQueries({
        queryKey: ["memory-reviews", projectId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["meeting-traceability"],
      });
    },
  });
  const items = queueQuery.data?.items ?? [];
  const selectedCount = Object.keys(selected).length;
  const conflict = isConflict(reviewMutation.error);

  return (
    <section className="memory-review-panel">
      <header className="memory-closure-head">
        <div>
          <strong>Memory Review 队列</strong>
          <small>自动摄入的会议 Claim 在确认前不会进入 Current Truth。</small>
        </div>
        <button
          className="pm-icon-btn"
          type="button"
          title="刷新 Review 队列"
          onClick={() => void queueQuery.refetch()}
        >
          <RefreshCw
            className={queueQuery.isFetching ? "spin" : undefined}
            size={14}
          />
        </button>
      </header>
      {!canManage && (
        <div className="memory-readonly">
          <LockKeyhole size={13} />
          当前账号可查看 Review 队列，只有项目负责人可以接受或拒绝。
        </div>
      )}
      {queueQuery.isLoading && (
        <div className="pm-empty compact">加载 Review 队列…</div>
      )}
      {queueQuery.error !== null && (
        <div className="pm-error">
          {queueQuery.error.message}
          <button type="button" onClick={() => void queueQuery.refetch()}>
            重试
          </button>
        </div>
      )}
      {!queueQuery.isLoading &&
        queueQuery.error === null &&
        items.length === 0 && (
          <div className="pm-empty memory-review-empty">
            <Inbox size={24} />
            <strong>Review 队列为空</strong>
            <span>发布会议纪要后，生成的 Claim 会出现在这里等待确认。</span>
          </div>
        )}
      {items.length > 0 && (
        <>
          <div className="memory-review-list">
            {items.map((item) => {
              const checked = selected[item.claim.id] !== undefined;
              return (
                <article className="memory-review-item" key={item.claim.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!canManage || reviewMutation.isPending}
                      onChange={(event) => {
                        setSelected((current) => {
                          if (!event.target.checked) {
                            const next = { ...current };
                            delete next[item.claim.id];
                            return next;
                          }
                          return {
                            ...current,
                            [item.claim.id]: item.claim.version,
                          };
                        });
                      }}
                    />
                    <span>
                      <b>{item.topicTitle}</b>
                      {item.claim.content}
                    </span>
                  </label>
                  <div className="memory-review-meta">
                    <span className="pm-pill neutral">待确认</span>
                    <small>
                      Claim v{item.claim.version} ·{" "}
                      {formatDateTime(item.claim.createdAt)}
                    </small>
                  </div>
                  <SourceLinks
                    refs={item.claim.sourceRefs}
                    projectId={projectId}
                    onOpenTask={onOpenTask}
                    onOpenMeeting={onOpenMeeting}
                  />
                </article>
              );
            })}
          </div>
          {canManage && (
            <div className="memory-review-actions">
              <input
                aria-label="Review 说明"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="拒绝时必须填写原因"
              />
              <span>{selectedCount} 项已选</span>
              <button
                className="pm-btn secondary"
                type="button"
                disabled={
                  selectedCount === 0 ||
                  reviewMutation.isPending ||
                  (reviewMutation.variables === "reject" &&
                    reason.trim() === "")
                }
                onClick={() => reviewMutation.mutate("reject")}
              >
                {reviewMutation.isPending &&
                reviewMutation.variables === "reject" ? (
                  <LoaderCircle className="spin" size={13} />
                ) : (
                  <X size={13} />
                )}
                拒绝
              </button>
              <button
                className="pm-btn primary"
                type="button"
                disabled={selectedCount === 0 || reviewMutation.isPending}
                onClick={() => reviewMutation.mutate("accept")}
              >
                {reviewMutation.isPending &&
                reviewMutation.variables === "accept" ? (
                  <LoaderCircle className="spin" size={13} />
                ) : (
                  <Check size={13} />
                )}
                接受并更新 Truth
              </button>
            </div>
          )}
        </>
      )}
      {reviewMutation.error !== null && (
        <div className="pm-error">
          {conflict
            ? "Review 状态已变化，已阻止覆盖。"
            : reviewMutation.error.message}
          <button
            type="button"
            onClick={() => {
              setSelected({});
              reviewMutation.reset();
              void queueQuery.refetch();
            }}
          >
            载入最新队列
          </button>
        </div>
      )}
    </section>
  );
}

export function HandoffPanel({
  projectId,
  canManage,
  tasks,
  memory,
  onOpenTask,
  onOpenMeeting,
}: {
  readonly projectId: string;
  readonly canManage: boolean;
  readonly tasks: readonly Task[];
  readonly memory: readonly {
    readonly title: string;
    readonly claims: readonly MemoryClaim[];
  }[];
  readonly onOpenTask: OpenTask;
  readonly onOpenMeeting: OpenMeeting;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [taskId, setTaskId] = useState("");
  const [claimId, setClaimId] = useState("");
  const handoffsQuery = useQuery({
    queryKey: ["handoffs", projectId],
    queryFn: () => listHandoffs(projectId),
  });
  const allClaims = memory.flatMap((topic) =>
    topic.claims.map((claim) => ({ claim, topicTitle: topic.title })),
  );
  const createMutation = useMutation({
    mutationFn: () =>
      createHandoff(projectId, {
        title,
        summary,
        sourceRefs: [
          ...(taskId === ""
            ? []
            : [
                {
                  kind: "task" as const,
                  id: taskId,
                  projectId,
                  label:
                    tasks.find((task) => task.id === taskId)?.title ??
                    "关联任务",
                },
              ]),
          ...(claimId === ""
            ? []
            : [
                {
                  kind: "memory-claim" as const,
                  id: claimId,
                  projectId,
                  label:
                    allClaims.find((item) => item.claim.id === claimId)?.claim
                      .content ?? "Memory Claim",
                },
              ]),
        ],
      }),
    onSuccess: () => {
      setTitle("");
      setSummary("");
      setTaskId("");
      setClaimId("");
      void queryClient.invalidateQueries({ queryKey: ["handoffs", projectId] });
    },
  });
  const confirmMutation = useMutation({
    mutationFn: (handoff: HandoffCard) =>
      confirmHandoff(projectId, handoff.id, {
        expectedVersion: handoff.version,
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["handoffs", projectId] }),
  });
  const handoffs = handoffsQuery.data ?? [];

  return (
    <section className="handoff-panel">
      <header className="memory-closure-head">
        <div>
          <strong>Handoff 交接卡</strong>
          <small>草稿可修订，确认后内容、来源和版本保持不可变。</small>
        </div>
        <PackageCheck size={16} />
      </header>
      {canManage ? (
        <form
          className="handoff-create"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim() !== "" && summary.trim() !== "") {
              createMutation.mutate();
            }
          }}
        >
          <input
            aria-label="交接标题"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="交接标题"
          />
          <textarea
            aria-label="交接摘要"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
            placeholder="当前状态、下一步和需要接收方注意的风险"
            rows={3}
          />
          <div className="handoff-source-form">
            <select
              aria-label="关联任务"
              value={taskId}
              onChange={(event) => setTaskId(event.target.value)}
            >
              <option value="">不关联任务</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
            <select
              aria-label="关联 Memory Claim"
              value={claimId}
              onChange={(event) => setClaimId(event.target.value)}
            >
              <option value="">不关联 Memory</option>
              {allClaims.map(({ claim, topicTitle }) => (
                <option key={claim.id} value={claim.id}>
                  {topicTitle} · {claim.content.slice(0, 48)}
                </option>
              ))}
            </select>
            <button
              className="pm-btn primary"
              type="submit"
              disabled={
                createMutation.isPending ||
                title.trim() === "" ||
                summary.trim() === ""
              }
            >
              <Plus size={13} />
              新建草稿
            </button>
          </div>
          {createMutation.error !== null && (
            <div className="pm-error">{createMutation.error.message}</div>
          )}
        </form>
      ) : (
        <div className="memory-readonly">
          <LockKeyhole size={13} />
          当前账号可查看交接记录，只有项目负责人可以创建或确认。
        </div>
      )}
      {handoffsQuery.isLoading && (
        <div className="pm-empty compact">加载交接卡…</div>
      )}
      {handoffsQuery.error !== null && (
        <div className="pm-error">
          {handoffsQuery.error.message}
          <button type="button" onClick={() => void handoffsQuery.refetch()}>
            重试
          </button>
        </div>
      )}
      {!handoffsQuery.isLoading && handoffs.length === 0 && (
        <div className="pm-empty compact">
          当前项目还没有交接卡。创建草稿并确认后，接收方可以回到原始任务和
          Memory。
        </div>
      )}
      <div className="handoff-list">
        {handoffs.map((handoff) => (
          <article
            className={`handoff-card handoff-${handoff.status}`}
            key={handoff.id}
          >
            <header>
              <div>
                <span
                  className={`pm-pill ${handoff.status === "confirmed" ? "done" : "neutral"}`}
                >
                  {handoff.status === "confirmed" ? "已确认" : "草稿"}
                </span>
                <strong>{handoff.title}</strong>
              </div>
              <small>
                v{handoff.version} · {formatDateTime(handoff.updatedAt)}
              </small>
            </header>
            <p>{handoff.summary}</p>
            <SourceLinks
              refs={handoff.sourceRefs}
              projectId={projectId}
              onOpenTask={onOpenTask}
              onOpenMeeting={onOpenMeeting}
            />
            {handoff.status === "draft" && canManage && (
              <footer>
                <button
                  className="pm-btn secondary"
                  type="button"
                  disabled={confirmMutation.isPending}
                  onClick={() => confirmMutation.mutate(handoff)}
                >
                  {confirmMutation.isPending &&
                  confirmMutation.variables?.id === handoff.id ? (
                    <LoaderCircle className="spin" size={13} />
                  ) : (
                    <Check size={13} />
                  )}
                  确认交接
                </button>
              </footer>
            )}
            {handoff.status === "confirmed" && (
              <footer className="handoff-confirmed">
                <Check size={12} />
                {handoff.confirmedBy} 于{" "}
                {formatDateTime(handoff.confirmedAt ?? handoff.updatedAt)} 确认
                {handoff.confirmations.length > 0 &&
                  ` · ${handoff.confirmations.length} 条不可变确认记录`}
              </footer>
            )}
          </article>
        ))}
      </div>
      {confirmMutation.error !== null && (
        <div className="pm-error">{confirmMutation.error.message}</div>
      )}
    </section>
  );
}

export function AgentEpisodePanel({
  projectId,
  agents,
  onOpenTask,
  onOpenMeeting,
}: {
  readonly projectId: string;
  readonly agents: readonly Agent[];
  readonly onOpenTask: OpenTask;
  readonly onOpenMeeting: OpenMeeting;
}) {
  const membersQuery = useQuery({
    queryKey: ["project-members", projectId],
    queryFn: () => listProjectMembers(projectId),
  });
  const members = (membersQuery.data ?? []).filter(
    (member): member is ProjectMember =>
      member.kind === "agent" && member.status === "active",
  );
  const [agentId, setAgentId] = useState("");
  const availableAgentId =
    members.some((member) => member.actorId === agentId) && agentId !== ""
      ? agentId
      : (members[0]?.actorId ?? "");
  const episodesQuery = useQuery({
    queryKey: ["agent-episodes", projectId, availableAgentId],
    queryFn: () => listAgentEpisodes(projectId, availableAgentId),
    enabled: availableAgentId !== "",
  });
  const agent = agents.find((candidate) => candidate.id === availableAgentId);
  const episodes = episodesQuery.data ?? [];

  return (
    <section className="agent-episode-panel">
      <header className="memory-closure-head">
        <div>
          <strong>Agent Episode</strong>
          <small>
            Episode 按项目和 Agent 隔离，私有记录只对目标 Agent 可见。
          </small>
        </div>
        <select
          aria-label="Episode Agent"
          value={availableAgentId}
          onChange={(event) => setAgentId(event.target.value)}
        >
          {members.map((member) => (
            <option key={member.id} value={member.actorId}>
              {member.name}
            </option>
          ))}
        </select>
      </header>
      {members.length === 0 && (
        <div className="pm-empty compact">当前项目还没有活跃 AI 伙伴成员。</div>
      )}
      {members.length > 0 && episodesQuery.isLoading && (
        <div className="pm-empty compact">加载 Agent Episode…</div>
      )}
      {episodesQuery.error !== null && (
        <div className="pm-error">{episodesQuery.error.message}</div>
      )}
      {members.length > 0 &&
        !episodesQuery.isLoading &&
        episodesQuery.error === null &&
        episodes.length === 0 && (
          <div className="pm-empty memory-episode-empty">
            <Bot size={24} />
            <strong>{agent?.name ?? "该 AI 伙伴"} 还没有可见 Episode</strong>
            <span>
              私有 Episode 仅由目标 Agent 读取；项目可见 Episode 会在这里展示。
            </span>
          </div>
        )}
      <div className="episode-list">
        {episodes.map((episode: AgentEpisode) => (
          <article className="episode-item" key={episode.id}>
            <header>
              <span className={`pm-pill ${episode.visibility}`}>
                {episode.visibility === "private" ? "私有" : "项目可见"}
              </span>
              <strong>{episode.summary}</strong>
              <small>{formatDateTime(episode.createdAt)}</small>
            </header>
            {episode.content !== "" && <p>{episode.content}</p>}
            <SourceLinks
              refs={episode.sourceRefs}
              projectId={projectId}
              onOpenTask={onOpenTask}
              onOpenMeeting={onOpenMeeting}
            />
          </article>
        ))}
      </div>
    </section>
  );
}
