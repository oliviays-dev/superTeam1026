import type {
  Agent,
  Meeting,
  MeetingDetail,
  Project,
  WorkflowDefinition,
  WorkflowInstance,
} from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  MessageSquare,
  Plus,
  Workflow,
} from "lucide-react";
import { useState } from "react";
import {
  advanceWorkflow,
  closeMeeting,
  createMeeting,
  createWorkflow,
  getMeeting,
  getWorkbench,
  listMeetings,
  listMemory,
  listWorkflows,
  postMeetingMessage,
  startWorkflow,
} from "./api.js";

interface ProjectViewProps {
  readonly projects: Project[];
  readonly agents: Agent[];
  readonly projectId: string;
  readonly onProjectChange: (projectId: string) => void;
}

export function WorkbenchView({
  projects,
  projectId,
  onProjectChange,
}: ProjectViewProps) {
  const selectedProjectId = projectId || projects[0]?.id || "";
  const summaryQuery = useQuery({
    queryKey: ["workbench-summary"],
    queryFn: getWorkbench,
    refetchInterval: 5_000,
  });
  const memoryQuery = useQuery({
    queryKey: ["memory", selectedProjectId],
    queryFn: () => listMemory(selectedProjectId),
    enabled: selectedProjectId !== "",
  });
  const summary = summaryQuery.data;
  const metrics = [
    ["项目", summary?.projects],
    ["执行中任务", summary?.activeTasks],
    ["待验收", summary?.reviewTasks],
    ["运行中 Run", summary?.activeRuns],
    ["项目记忆", summary?.memoryTopics],
    ["活跃流程", summary?.workflows],
    ["未结束会议", summary?.meetings],
  ] as const;

  return (
    <main className="page-shell">
      <header className="page-heading">
        <div>
          <span className="eyebrow">Overview</span>
          <h1>工作台</h1>
        </div>
        <select
          aria-label="工作台项目"
          value={selectedProjectId}
          onChange={(event) => onProjectChange(event.target.value)}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </header>
      <section className="metrics-grid">
        {metrics.map(([label, value]) => (
          <div className="metric" key={label}>
            <span>{label}</span>
            <strong>{value ?? "-"}</strong>
          </div>
        ))}
      </section>
      <section className="page-panel">
        <div className="section-title">
          <BookOpen size={16} />
          <h2>项目记忆</h2>
        </div>
        <div className="memory-list">
          {memoryQuery.data?.map((topic) => (
            <article className="memory-item" key={topic.id}>
              <div>
                <strong>{topic.title}</strong>
                <span>v{topic.currentTruth?.version ?? "-"}</span>
              </div>
              <p>{topic.currentTruth?.content ?? "尚未发布结论"}</p>
              <small>{formatDateTime(topic.updatedAt)}</small>
            </article>
          ))}
          {memoryQuery.data?.length === 0 && (
            <div className="empty-state compact">
              任务验收通过后会写入项目记忆
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

export function WorkflowsView({
  projects,
  projectId,
  onProjectChange,
}: ProjectViewProps) {
  const queryClient = useQueryClient();
  const selectedProjectId = projectId || projects[0]?.id || "";
  const [name, setName] = useState("");
  const [steps, setSteps] = useState("");
  const [instance, setInstance] = useState<WorkflowInstance | null>(null);
  const workflowsQuery = useQuery({
    queryKey: ["workflows", selectedProjectId],
    queryFn: () => listWorkflows(selectedProjectId),
    enabled: selectedProjectId !== "",
  });
  const createMutation = useMutation({
    mutationFn: () =>
      createWorkflow({
        projectId: selectedProjectId,
        name,
        description: "",
        stepNames: steps
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
      }),
    onSuccess: () => {
      setName("");
      setSteps("");
      void queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
  });
  const startMutation = useMutation({
    mutationFn: (workflow: WorkflowDefinition) =>
      startWorkflow(
        workflow.id,
        `${workflow.name} · ${new Date().toLocaleString("zh-CN")}`,
      ),
    onSuccess: setInstance,
  });
  const advanceMutation = useMutation({
    mutationFn: (workflowInstance: WorkflowInstance) =>
      advanceWorkflow(workflowInstance.id),
    onSuccess: (result) => {
      setInstance(result);
      void queryClient.invalidateQueries({ queryKey: ["workbench-summary"] });
    },
  });

  return (
    <main className="page-shell">
      <header className="page-heading">
        <div>
          <span className="eyebrow">Process</span>
          <h1>工作流</h1>
        </div>
        <select
          aria-label="工作流项目"
          value={selectedProjectId}
          onChange={(event) => {
            onProjectChange(event.target.value);
            setInstance(null);
          }}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </header>
      <div className="two-column-page">
        <section className="page-panel">
          <div className="section-title">
            <Plus size={16} />
            <h2>创建工作流</h2>
          </div>
          <form
            className="stack-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                name.trim() !== "" &&
                steps
                  .split("\n")
                  .map((item) => item.trim())
                  .filter(Boolean).length > 0
              ) {
                createMutation.mutate();
              }
            }}
          >
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="工作流名称"
            />
            <textarea
              value={steps}
              onChange={(event) => setSteps(event.target.value)}
              placeholder={"步骤，每行一个\n需求确认\n方案分析\n人工验收"}
              rows={5}
            />
            <button className="primary-button" type="submit">
              <Plus size={15} />
              创建
            </button>
          </form>
          <div className="definition-list">
            {workflowsQuery.data?.map((workflow) => (
              <button
                className="definition-row"
                key={workflow.id}
                onClick={() => startMutation.mutate(workflow)}
              >
                <div>
                  <strong>{workflow.name}</strong>
                  <span>{workflow.steps.length} 个步骤</span>
                </div>
                <ArrowRight size={15} />
              </button>
            ))}
          </div>
        </section>
        <section className="page-panel">
          <div className="section-title">
            <Workflow size={16} />
            <h2>运行实例</h2>
          </div>
          {instance === null ? (
            <div className="empty-state compact">选择工作流开始运行</div>
          ) : (
            <div className="workflow-instance">
              <div className="instance-head">
                <div>
                  <strong>{instance.title}</strong>
                  <span>
                    {instance.status === "completed" ? "已完成" : "运行中"}
                  </span>
                </div>
                {instance.status === "active" && (
                  <button
                    className="primary-button"
                    onClick={() => advanceMutation.mutate(instance)}
                  >
                    <CheckCircle2 size={15} />
                    完成当前步骤
                  </button>
                )}
              </div>
              <ol className="workflow-steps">
                {instance.steps.map((step, index) => (
                  <li
                    className={`workflow-step step-${step.status}`}
                    key={step.stepId}
                  >
                    <span>{index + 1}</span>
                    <div>
                      <strong>{step.name}</strong>
                      <small>
                        {step.kind === "agent" ? "Agent 步骤" : "人工步骤"}
                      </small>
                    </div>
                    <em>{step.status}</em>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

export function MeetingsView({
  projects,
  agents,
  projectId,
  onProjectChange,
}: ProjectViewProps) {
  const queryClient = useQueryClient();
  const selectedProjectId = projectId || projects[0]?.id || "";
  const [meetingId, setMeetingId] = useState("");
  const [title, setTitle] = useState("");
  const [agenda, setAgenda] = useState("");
  const [agentId, setAgentId] = useState("");
  const [message, setMessage] = useState("");
  const meetingsQuery = useQuery({
    queryKey: ["meetings", selectedProjectId],
    queryFn: () => listMeetings(selectedProjectId),
    enabled: selectedProjectId !== "",
  });
  const detailQuery = useQuery({
    queryKey: ["meeting", meetingId],
    queryFn: () => getMeeting(meetingId),
    enabled: meetingId !== "",
    refetchInterval: 2_000,
  });
  const createMutation = useMutation({
    mutationFn: () =>
      createMeeting({
        projectId: selectedProjectId,
        title,
        agenda,
        agentIds: agentId === "" ? [] : [agentId],
      }),
    onSuccess: (meeting) => {
      setTitle("");
      setAgenda("");
      setMeetingId(meeting.id);
      void queryClient.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
  const messageMutation = useMutation({
    mutationFn: () => postMeetingMessage(meetingId, message),
    onSuccess: () => {
      setMessage("");
      void queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
    },
  });
  const closeMutation = useMutation({
    mutationFn: () =>
      closeMeeting(meetingId, "会议由本地用户结束，纪要等待补充。"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["meeting", meetingId] });
      void queryClient.invalidateQueries({ queryKey: ["meetings"] });
    },
  });
  const detail: MeetingDetail | undefined = detailQuery.data;

  return (
    <main className="page-shell">
      <header className="page-heading">
        <div>
          <span className="eyebrow">Communication</span>
          <h1>会议</h1>
        </div>
        <select
          aria-label="会议项目"
          value={selectedProjectId}
          onChange={(event) => {
            onProjectChange(event.target.value);
            setMeetingId("");
          }}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </header>
      <div className="meeting-layout">
        <section className="page-panel meeting-list-panel">
          <div className="section-title">
            <MessageSquare size={16} />
            <h2>会议列表</h2>
          </div>
          <form
            className="stack-form compact-stack"
            onSubmit={(event) => {
              event.preventDefault();
              if (title.trim() !== "") createMutation.mutate();
            }}
          >
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="会议主题"
            />
            <textarea
              value={agenda}
              onChange={(event) => setAgenda(event.target.value)}
              placeholder="会议议程"
              rows={2}
            />
            <select
              aria-label="邀请 AI 伙伴"
              value={agentId}
              onChange={(event) => setAgentId(event.target.value)}
            >
              <option value="">仅本地用户</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <button className="primary-button" type="submit">
              <Plus size={15} />
              新建会议
            </button>
          </form>
          <div className="meeting-list">
            {meetingsQuery.data?.map((meeting: Meeting) => (
              <button
                key={meeting.id}
                className={`meeting-row ${meeting.id === meetingId ? "active" : ""}`}
                onClick={() => setMeetingId(meeting.id)}
              >
                <div>
                  <strong>{meeting.title}</strong>
                  <span>{meeting.status === "open" ? "进行中" : "已结束"}</span>
                </div>
                <small>{formatDateTime(meeting.updatedAt)}</small>
              </button>
            ))}
          </div>
        </section>
        <section className="page-panel meeting-room">
          {detail === undefined ? (
            <div className="empty-state compact">选择或创建会议</div>
          ) : (
            <>
              <div className="instance-head">
                <div>
                  <strong>{detail.meeting.title}</strong>
                  <span>{detail.meeting.agenda || "无议程"}</span>
                </div>
                {detail.meeting.status === "open" && (
                  <button
                    className="secondary-button"
                    onClick={() => closeMutation.mutate()}
                  >
                    结束会议
                  </button>
                )}
              </div>
              <div className="participant-row">
                {detail.meeting.participants.map((participant) => (
                  <span key={`${participant.kind}-${participant.id}`}>
                    {participant.name}
                  </span>
                ))}
              </div>
              <div className="message-stream">
                {detail.messages.map((item) => (
                  <article
                    className={`meeting-message message-${item.authorType}`}
                    key={item.id}
                  >
                    <div>
                      <strong>{item.authorName}</strong>
                      <time>{formatDateTime(item.createdAt)}</time>
                    </div>
                    <p>{item.content}</p>
                  </article>
                ))}
                {detail.messages.length === 0 && (
                  <div className="empty-state compact">会议尚未产生消息</div>
                )}
              </div>
              {detail.meeting.status === "open" && (
                <form
                  className="message-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (message.trim() !== "") messageMutation.mutate();
                  }}
                >
                  <textarea
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="发送会议消息"
                    rows={2}
                  />
                  <button className="primary-button" type="submit">
                    发送
                  </button>
                </form>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
