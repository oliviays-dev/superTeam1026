import type {
  Agent,
  MeetingDetail,
  MeetingDelegate,
  ProjectMember,
} from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Bot,
  Check,
  FileUp,
  History,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
  ShieldCheck,
  UserRoundCog,
} from "lucide-react";
import { useState } from "react";
import {
  archiveMeeting,
  archiveMeetingFile,
  archiveMeetingPrivateBriefing,
  confirmMeetingMinutes,
  createMeetingDelegate,
  createMeetingPrivateBriefing,
  createMeetingTask,
  generateMeetingMinutes,
  getMeetingMinutes,
  handoffMeetingFacilitator,
  listMeetingDelegates,
  listMeetingFacilitatorHandoffs,
  listMeetingFiles,
  listMeetingMinutesConfirmations,
  listMeetingPrivateBriefings,
  listMeetingTasks,
  restoreMeeting,
  revokeMeetingDelegate,
  uploadMeetingFile,
} from "./api.js";

export function MeetingCollaborationPanel({
  meeting,
  members,
  agents,
  canWrite,
  canApprove,
}: {
  readonly meeting: MeetingDetail;
  readonly members: ProjectMember[];
  readonly agents: Agent[];
  readonly canWrite: boolean;
  readonly canApprove: boolean;
}) {
  const queryClient = useQueryClient();
  const meetingId = meeting.meeting.id;
  const collaboration = meeting.collaboration;
  const activeMembers = members.filter(
    (member) => member.status === "active" && member.principalId !== null,
  );
  const agentMembers = activeMembers.filter(
    (member) =>
      member.kind === "agent" &&
      agents.some(
        (agent) => agent.id === member.actorId && agent.status === "active",
      ),
  );
  const [facilitatorPrincipalId, setFacilitatorPrincipalId] = useState("");
  const [handoffReason, setHandoffReason] = useState("");
  const [delegatePrincipalId, setDelegatePrincipalId] = useState("");
  const [delegateAgentId, setDelegateAgentId] = useState("");
  const [delegateKind, setDelegateKind] =
    useState<MeetingDelegate["representativeKind"]>("human");
  const [delegateReason, setDelegateReason] = useState("");
  const [briefingAudienceId, setBriefingAudienceId] = useState("");
  const [briefingContent, setBriefingContent] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskAgentId, setTaskAgentId] = useState("");
  const [minutesNote, setMinutesNote] = useState("");
  const [minutesRevision, setMinutesRevision] = useState<number | null>(null);
  const [archiveReason, setArchiveReason] = useState("");

  const delegatesQuery = useQuery({
    queryKey: ["meeting-collaboration-delegates", meetingId],
    queryFn: () => listMeetingDelegates(meetingId),
  });
  const briefingsQuery = useQuery({
    queryKey: ["meeting-collaboration-briefings", meetingId],
    queryFn: () => listMeetingPrivateBriefings(meetingId, true),
  });
  const filesQuery = useQuery({
    queryKey: ["meeting-collaboration-files", meetingId],
    queryFn: () => listMeetingFiles(meetingId, true),
  });
  const tasksQuery = useQuery({
    queryKey: ["meeting-collaboration-tasks", meetingId],
    queryFn: () => listMeetingTasks(meetingId),
  });
  const confirmationsQuery = useQuery({
    queryKey: ["meeting-collaboration-confirmations", meetingId],
    queryFn: () => listMeetingMinutesConfirmations(meetingId),
  });
  const handoffsQuery = useQuery({
    queryKey: ["meeting-collaboration-handoffs", meetingId],
    queryFn: () => listMeetingFacilitatorHandoffs(meetingId),
  });
  const minutesQuery = useQuery({
    queryKey: ["meeting-minutes", meetingId],
    queryFn: () => getMeetingMinutes(meetingId),
  });

  const refreshCollaboration = () => {
    for (const key of [
      "meeting",
      "meetings",
      "meeting-collaboration-delegates",
      "meeting-collaboration-briefings",
      "meeting-collaboration-files",
      "meeting-collaboration-tasks",
      "meeting-collaboration-confirmations",
      "meeting-collaboration-handoffs",
      "meeting-minutes",
    ]) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };

  const handoffMutation = useMutation({
    mutationFn: () =>
      handoffMeetingFacilitator(meetingId, {
        expectedRevision: collaboration?.revision ?? 1,
        facilitatorPrincipalId,
        reason: handoffReason,
      }),
    onSuccess: () => {
      setFacilitatorPrincipalId("");
      setHandoffReason("");
      refreshCollaboration();
    },
  });
  const delegateMutation = useMutation({
    mutationFn: () =>
      createMeetingDelegate(meetingId, {
        representativeKind: delegateKind,
        ...(delegateKind === "agent"
          ? { agentId: delegateAgentId }
          : { representativePrincipalId: delegatePrincipalId }),
        allowedActions: ["speak", "read_private"],
        reason: delegateReason,
      }),
    onSuccess: () => {
      setDelegatePrincipalId("");
      setDelegateAgentId("");
      setDelegateReason("");
      refreshCollaboration();
    },
  });
  const revokeMutation = useMutation({
    mutationFn: (delegateId: string) =>
      revokeMeetingDelegate(
        meetingId,
        delegateId,
        "Revoked from meeting panel",
      ),
    onSuccess: refreshCollaboration,
  });
  const briefingMutation = useMutation({
    mutationFn: () =>
      createMeetingPrivateBriefing(meetingId, {
        ...(briefingAudienceId === ""
          ? {}
          : { audiencePrincipalId: briefingAudienceId }),
        content: briefingContent,
      }),
    onSuccess: () => {
      setBriefingContent("");
      refreshCollaboration();
    },
  });
  const archiveBriefingMutation = useMutation({
    mutationFn: ({
      id,
      revision,
    }: {
      readonly id: string;
      readonly revision: number;
    }) => archiveMeetingPrivateBriefing(meetingId, id, revision),
    onSuccess: refreshCollaboration,
  });
  const fileArchiveMutation = useMutation({
    mutationFn: ({
      id,
      archived,
    }: {
      readonly id: string;
      readonly archived: boolean;
    }) => archiveMeetingFile(meetingId, id, archived),
    onSuccess: refreshCollaboration,
  });
  const fileUploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const buffer = await file.arrayBuffer();
      let binary = "";
      for (const byte of new Uint8Array(buffer)) {
        binary += String.fromCharCode(byte);
      }
      return uploadMeetingFile(meetingId, {
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        contentBase64: btoa(binary),
      });
    },
    onSuccess: refreshCollaboration,
  });
  const taskMutation = useMutation({
    mutationFn: () =>
      createMeetingTask(meetingId, {
        title: taskTitle,
        description: "",
        assigneeAgentId: taskAgentId,
        priority: "medium",
        sourceType: "manual",
        sourceMessageIds: [],
        idempotencyKey: `web:${meetingId}:${Date.now()}`,
        dispatch: false,
      }),
    onSuccess: () => {
      setTaskTitle("");
      refreshCollaboration();
    },
  });
  const generateMinutesMutation = useMutation({
    mutationFn: () =>
      generateMeetingMinutes(
        meetingId,
        minutesRevision ?? minutesQuery.data?.draft.revision ?? 0,
      ),
    onSuccess: (draft) => {
      setMinutesRevision(draft.revision);
      refreshCollaboration();
    },
  });
  const confirmMinutesMutation = useMutation({
    mutationFn: () =>
      confirmMeetingMinutes(meetingId, {
        expectedRevision:
          minutesRevision ?? minutesQuery.data?.draft.revision ?? 0,
        note: minutesNote,
      }),
    onSuccess: (result) => {
      setMinutesRevision(result.minutes.draft.revision);
      setMinutesNote("");
      refreshCollaboration();
    },
  });
  const lifecycleMutation = useMutation({
    mutationFn: () =>
      collaboration?.lifecycleStatus === "archived"
        ? restoreMeeting(meetingId, collaboration.revision)
        : archiveMeeting(meetingId, {
            expectedRevision: collaboration?.revision ?? 1,
            reason:
              archiveReason || "Meeting archived from collaboration panel",
          }),
    onSuccess: refreshCollaboration,
  });

  const activeDelegates =
    delegatesQuery.data?.filter((delegate) => delegate.status === "active") ??
    [];
  const latestConfirmation = confirmationsQuery.data?.[0];
  const mutationError =
    handoffMutation.error ??
    delegateMutation.error ??
    briefingMutation.error ??
    fileUploadMutation.error ??
    taskMutation.error ??
    generateMinutesMutation.error ??
    confirmMinutesMutation.error ??
    lifecycleMutation.error;

  return (
    <div
      className="meeting-collaboration-panel"
      data-testid="meeting-collaboration"
    >
      <div className="meeting-collaboration-grid">
        <section className="meeting-collaboration-card">
          <header>
            <ShieldCheck size={16} />
            <div>
              <strong>主持人</strong>
              <small>
                {collaboration?.facilitator.displayName ?? "未初始化"} · 修订{" "}
                {collaboration?.revision ?? "-"}
              </small>
            </div>
            <span
              className={`pm-pill ${
                collaboration?.lifecycleStatus === "archived"
                  ? "warn"
                  : "progress"
              }`}
            >
              {collaboration?.lifecycleStatus === "archived"
                ? "已归档"
                : "协作中"}
            </span>
          </header>
          {canWrite && (
            <div className="meeting-collaboration-form">
              <select
                aria-label="新主持人"
                value={facilitatorPrincipalId}
                onChange={(event) =>
                  setFacilitatorPrincipalId(event.target.value)
                }
              >
                <option value="">选择新的主持人</option>
                {activeMembers
                  .filter((member) => member.kind === "human")
                  .map((member) => (
                    <option key={member.id} value={member.principalId ?? ""}>
                      {member.name}
                    </option>
                  ))}
              </select>
              <input
                aria-label="转交原因"
                placeholder="转交原因"
                value={handoffReason}
                onChange={(event) => setHandoffReason(event.target.value)}
              />
              <button
                type="button"
                className="pm-btn"
                disabled={
                  handoffMutation.isPending ||
                  facilitatorPrincipalId === "" ||
                  handoffReason.trim() === ""
                }
                onClick={() => handoffMutation.mutate()}
              >
                <UserRoundCog size={14} />
                安全转交
              </button>
            </div>
          )}
          <div className="meeting-collaboration-list compact">
            {handoffsQuery.data?.slice(0, 3).map((handoff) => (
              <div key={handoff.id}>
                <span>{handoff.toPrincipalId}</span>
                <small>{formatDateTime(handoff.createdAt)}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="meeting-collaboration-card">
          <header>
            <Bot size={16} />
            <div>
              <strong>参会代表</strong>
              <small>{activeDelegates.length} 个有效委托</small>
            </div>
          </header>
          {canWrite && (
            <div className="meeting-collaboration-form">
              <select
                aria-label="代表类型"
                value={delegateKind}
                onChange={(event) =>
                  setDelegateKind(
                    event.target.value as MeetingDelegate["representativeKind"],
                  )
                }
              >
                <option value="human">人类代表</option>
                <option value="agent">AI 代表</option>
              </select>
              {delegateKind === "agent" ? (
                <select
                  aria-label="AI 代表"
                  value={delegateAgentId}
                  onChange={(event) => setDelegateAgentId(event.target.value)}
                >
                  <option value="">选择 AI 代表</option>
                  {agentMembers.map((member) => (
                    <option key={member.id} value={member.actorId}>
                      {member.name}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  aria-label="人类代表"
                  value={delegatePrincipalId}
                  onChange={(event) =>
                    setDelegatePrincipalId(event.target.value)
                  }
                >
                  <option value="">选择人类代表</option>
                  {activeMembers
                    .filter((member) => member.kind === "human")
                    .map((member) => (
                      <option key={member.id} value={member.principalId ?? ""}>
                        {member.name}
                      </option>
                    ))}
                </select>
              )}
              <input
                aria-label="委托原因"
                placeholder="委托边界与原因"
                value={delegateReason}
                onChange={(event) => setDelegateReason(event.target.value)}
              />
              <button
                type="button"
                className="pm-btn"
                disabled={
                  delegateMutation.isPending ||
                  delegateReason.trim() === "" ||
                  (delegateKind === "agent"
                    ? delegateAgentId === ""
                    : delegatePrincipalId === "")
                }
                onClick={() => delegateMutation.mutate()}
              >
                <Bot size={14} />
                授权代表
              </button>
            </div>
          )}
          <div className="meeting-collaboration-list">
            {activeDelegates.map((delegate) => (
              <div key={delegate.id}>
                <div>
                  <strong>{delegate.representativeName}</strong>
                  <small>
                    {delegate.representativeKind === "agent" ? "AI" : "人类"} ·
                    可发言 / 读取私密嘱咐
                  </small>
                </div>
                {canWrite && (
                  <button
                    type="button"
                    className="pm-icon-btn"
                    aria-label="撤销委托"
                    onClick={() => revokeMutation.mutate(delegate.id)}
                  >
                    <RotateCcw size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="meeting-collaboration-card">
          <header>
            <LockKeyhole size={16} />
            <div>
              <strong>私密嘱咐</strong>
              <small>私密内容</small>
            </div>
          </header>
          {canWrite && (
            <div className="meeting-collaboration-form">
              <select
                aria-label="嘱咐对象"
                value={briefingAudienceId}
                onChange={(event) => setBriefingAudienceId(event.target.value)}
              >
                <option value="">仅自己</option>
                {activeMembers.map((member) => (
                  <option key={member.id} value={member.principalId ?? ""}>
                    {member.name}
                  </option>
                ))}
              </select>
              <textarea
                aria-label="私密嘱咐"
                placeholder="输入私密嘱咐"
                value={briefingContent}
                onChange={(event) => setBriefingContent(event.target.value)}
              />
              <button
                type="button"
                className="pm-btn"
                disabled={
                  briefingMutation.isPending || briefingContent.trim() === ""
                }
                onClick={() => briefingMutation.mutate()}
              >
                <LockKeyhole size={14} />
                保存嘱咐
              </button>
            </div>
          )}
          <div className="meeting-collaboration-list">
            {briefingsQuery.data?.map((briefing) => (
              <div key={briefing.id}>
                <div>
                  <strong>{briefing.content}</strong>
                  <small>
                    {briefing.status === "active" ? "有效" : "已归档"} ·{" "}
                    {formatDateTime(briefing.updatedAt)}
                  </small>
                </div>
                {canWrite && briefing.status === "active" && (
                  <button
                    type="button"
                    className="pm-icon-btn"
                    aria-label="归档嘱咐"
                    onClick={() =>
                      archiveBriefingMutation.mutate({
                        id: briefing.id,
                        revision: briefing.revision,
                      })
                    }
                  >
                    <Archive size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="meeting-collaboration-card">
          <header>
            <FileUp size={16} />
            <div>
              <strong>会议文件</strong>
              <small>{filesQuery.data?.length ?? 0} 个受控文件</small>
            </div>
          </header>
          {canWrite && collaboration?.lifecycleStatus === "active" && (
            <label className="pm-btn meeting-file-picker">
              <FileUp size={14} />
              上传文件
              <input
                type="file"
                aria-label="上传会议文件"
                disabled={fileUploadMutation.isPending}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) fileUploadMutation.mutate(file);
                  event.target.value = "";
                }}
              />
            </label>
          )}
          <div className="meeting-collaboration-list">
            {filesQuery.data?.map((file) => (
              <div key={file.id}>
                <div>
                  <strong>{file.name}</strong>
                  <small>
                    {Math.ceil(file.size / 1024)} KB · {file.status}
                  </small>
                </div>
                {canWrite && (
                  <button
                    type="button"
                    className="pm-icon-btn"
                    aria-label={
                      file.status === "active" ? "归档文件" : "恢复文件"
                    }
                    onClick={() =>
                      fileArchiveMutation.mutate({
                        id: file.id,
                        archived: file.status !== "active",
                      })
                    }
                  >
                    {file.status === "active" ? (
                      <Archive size={14} />
                    ) : (
                      <RotateCcw size={14} />
                    )}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="meeting-collaboration-card">
          <header>
            <Check size={16} />
            <div>
              <strong>纪要生成与确认</strong>
              <small>
                {latestConfirmation === undefined
                  ? "尚未确认"
                  : `${latestConfirmation.confirmedBy} 已确认`}
              </small>
            </div>
          </header>
          <div className="meeting-collaboration-actions">
            {canWrite && (
              <button
                type="button"
                className="pm-btn"
                disabled={generateMinutesMutation.isPending}
                onClick={() => generateMinutesMutation.mutate()}
              >
                <History size={14} />
                从消息生成草稿
              </button>
            )}
          </div>
          {canApprove && (
            <div className="meeting-collaboration-form">
              <input
                aria-label="确认说明"
                placeholder="确认说明"
                value={minutesNote}
                onChange={(event) => setMinutesNote(event.target.value)}
              />
              <button
                type="button"
                className="pm-btn"
                disabled={
                  confirmMinutesMutation.isPending ||
                  generateMinutesMutation.isPending ||
                  minutesQuery.data === undefined
                }
                onClick={() => confirmMinutesMutation.mutate()}
              >
                <Check size={14} />
                确认并发布纪要
              </button>
            </div>
          )}
        </section>

        <section className="meeting-collaboration-card">
          <header>
            <History size={16} />
            <div>
              <strong>会议任务</strong>
              <small>{tasksQuery.data?.length ?? 0} 个任务关联</small>
            </div>
          </header>
          {canWrite && collaboration?.lifecycleStatus === "active" && (
            <div className="meeting-collaboration-form">
              <input
                aria-label="会议任务标题"
                placeholder="任务标题"
                value={taskTitle}
                onChange={(event) => setTaskTitle(event.target.value)}
              />
              <select
                aria-label="会议任务执行 AI"
                value={taskAgentId}
                onChange={(event) => setTaskAgentId(event.target.value)}
              >
                <option value="">选择执行 AI</option>
                {agentMembers.map((member) => (
                  <option key={member.id} value={member.actorId}>
                    {member.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="pm-btn"
                disabled={
                  taskMutation.isPending ||
                  taskTitle.trim() === "" ||
                  taskAgentId === ""
                }
                onClick={() => taskMutation.mutate()}
              >
                <Check size={14} />
                创建任务
              </button>
            </div>
          )}
          <div className="meeting-collaboration-list">
            {tasksQuery.data?.map((task) => (
              <div key={task.id}>
                <div>
                  <strong>{task.title}</strong>
                  <small>
                    {task.taskStatus} · {task.sourceType}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <footer className="meeting-collaboration-footer">
        {collaboration?.lifecycleStatus === "active" && canWrite && (
          <input
            aria-label="归档原因"
            placeholder="归档原因"
            value={archiveReason}
            onChange={(event) => setArchiveReason(event.target.value)}
          />
        )}
        {canWrite && (
          <button
            type="button"
            className="pm-btn"
            disabled={lifecycleMutation.isPending}
            onClick={() => lifecycleMutation.mutate()}
          >
            {collaboration?.lifecycleStatus === "archived" ? (
              <RotateCcw size={14} />
            ) : (
              <Archive size={14} />
            )}
            {collaboration?.lifecycleStatus === "archived"
              ? "恢复会议"
              : "归档会议"}
          </button>
        )}
        {mutationError !== null && (
          <span className="pm-inline-error">{mutationError.message}</span>
        )}
        {lifecycleMutation.isPending && (
          <LoaderCircle className="spin" size={15} />
        )}
      </footer>
    </div>
  );
}
