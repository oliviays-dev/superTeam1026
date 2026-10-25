import type { Artifact, PlatformRunEvent } from "@pluginmax/contracts";
import { formatDateTime, shortId } from "@pluginmax/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleStop,
  Download,
  FileText,
  LoaderCircle,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  artifactDownloadUrl,
  cancelRun,
  getRunContext,
  getRunDetail,
  getRunEvents,
  listArtifacts,
  subscribeToRun,
} from "./api.js";

const terminalStatuses = new Set([
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "interrupted",
]);

const statusLabels: Record<string, string> = {
  queued: "排队中",
  running: "执行中",
  waiting_approval: "待审批",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  timeout: "超时",
  interrupted: "已中断",
};

export function RunView({ runId }: { runId: string }) {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<PlatformRunEvent[]>([]);
  const [liveOutput, setLiveOutput] = useState("");
  const [streamState, setStreamState] = useState<
    "connecting" | "live" | "closed"
  >("connecting");
  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: () => getRunDetail(runId),
  });
  const contextQuery = useQuery({
    queryKey: ["run-context", runId],
    queryFn: () => getRunContext(runId),
    retry: false,
  });
  const artifactsQuery = useQuery({
    queryKey: ["run-artifacts", runId],
    queryFn: () => listArtifacts(runId),
    enabled: runQuery.data?.run.status === "completed",
  });
  const run = runQuery.data?.run;

  useEffect(() => {
    let disposed = false;
    let source: EventSource | undefined;
    setEvents([]);
    setLiveOutput("");
    setStreamState("connecting");

    void getRunEvents(runId).then((page) => {
      if (disposed) return;
      const lastEvent = page.items.at(-1)?.seq ?? 0;
      const lastDelta = page.deltas.at(-1)?.seq ?? 0;
      setEvents(page.items);
      setLiveOutput(page.deltas.map((delta) => delta.text).join(""));
      source = subscribeToRun(runId, lastEvent, lastDelta);
      setStreamState("live");

      source.addEventListener("run.event", (message) => {
        const event = JSON.parse(
          (message as MessageEvent<string>).data,
        ) as PlatformRunEvent;
        setEvents((current) =>
          current.some((item) => item.id === event.id)
            ? current
            : [...current, event],
        );
        if (terminalStatuses.has(event.type.replace("run.", ""))) {
          void queryClient.invalidateQueries({ queryKey: ["run", runId] });
          void queryClient.invalidateQueries({
            queryKey: ["run-artifacts", runId],
          });
          void queryClient.invalidateQueries({ queryKey: ["tasks"] });
          void queryClient.invalidateQueries({ queryKey: ["task-runs"] });
        }
      });
      source.addEventListener("run.delta", (message) => {
        const delta = JSON.parse((message as MessageEvent<string>).data) as {
          text: string;
        };
        setLiveOutput((current) => current + delta.text);
      });
      source.addEventListener("error", () => {
        if (!disposed) setStreamState("connecting");
      });
    });

    return () => {
      disposed = true;
      source?.close();
      setStreamState("closed");
    };
  }, [queryClient, runId]);

  const plan = useMemo(
    () =>
      events.filter((event) => event.type === "plan.snapshot").at(-1)?.data
        ?.steps as string[] | undefined,
    [events],
  );
  const artifacts: Artifact[] = artifactsQuery.data ?? [];

  if (run === undefined) {
    return (
      <div className="empty-state">
        {runQuery.isError ? (
          <RefreshCw size={22} />
        ) : (
          <LoaderCircle className="spin" size={22} />
        )}
        <span>{runQuery.isError ? "无法加载 Run" : "加载 Run..."}</span>
      </div>
    );
  }

  const hasDetailedProgress =
    run.observability.planVisibility !== "opaque" ||
    run.observability.toolEventCompleteness !== "none";

  return (
    <div className="run-view">
      <header className="run-header">
        <div>
          <div className="run-kicker">
            RUN {shortId(run.id)}
            <span className={`status-pill status-${run.status}`}>
              {statusLabels[run.status] ?? run.status}
            </span>
            <span className={`live-dot live-${streamState}`} />
          </div>
          <h2>{run.inputSnapshot.taskTitle}</h2>
        </div>
        {!terminalStatuses.has(run.status) && (
          <button
            className="pm-btn secondary"
            type="button"
            onClick={() => void cancelRun(run.id)}
          >
            <CircleStop size={14} />
            取消
          </button>
        )}
      </header>

      <section className="run-section">
        <div className="section-title">
          <Bot size={15} />
          <h3>输入快照</h3>
        </div>
        <div className="input-grid">
          <div>
            <span>AI 伙伴</span>
            <strong>{run.inputSnapshot.agentName}</strong>
          </div>
          <div>
            <span>Runtime</span>
            <strong>{run.inputSnapshot.runtimeKind}</strong>
          </div>
          <div>
            <span>创建时间</span>
            <strong>{formatDateTime(run.createdAt)}</strong>
          </div>
        </div>
        <p className="run-description">{run.inputSnapshot.taskDescription}</p>
        {run.inputSnapshot.acceptance.length > 0 && (
          <div className="acceptance-summary">
            <span>验收标准</span>
            <ul>
              {run.inputSnapshot.acceptance.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {contextQuery.data !== undefined && (
          <div className="context-sources">
            <span>ContextPack 来源</span>
            <div>
              {contextQuery.data.pack.sources.map((source) => (
                <span
                  className="context-chip"
                  key={`${source.type}-${source.id}`}
                >
                  {source.label}
                </span>
              ))}
            </div>
          </div>
        )}
      </section>

      <section className="run-section">
        <div className="section-title">
          <Activity size={15} />
          <h3>执行进展</h3>
        </div>
        {!hasDetailedProgress && (
          <p className="runtime-capability-note">
            当前 Runtime 只提供有限进度，最终状态仍以 Run 事件为准。
          </p>
        )}
        {plan !== undefined && plan.length > 0 && (
          <ol className="plan-list">
            {plan.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
        <div className="event-timeline">
          {events
            .filter(
              (event) =>
                event.type !== "run.queued" && event.type !== "plan.snapshot",
            )
            .map((event) => (
              <div className="timeline-row" key={event.id}>
                <span className={`event-icon event-${event.type}`}>
                  {event.type.startsWith("tool.") ? (
                    <Wrench size={13} />
                  ) : event.type === "run.completed" ? (
                    <CheckCircle2 size={13} />
                  ) : (
                    <Activity size={13} />
                  )}
                </span>
                <div>
                  <div className="timeline-meta">
                    <span>{event.type}</span>
                    <time>{formatDateTime(event.createdAt)}</time>
                  </div>
                  <p>{event.summary}</p>
                </div>
              </div>
            ))}
          {events.length === 0 && (
            <div className="muted-row">等待 Agent 事件...</div>
          )}
        </div>
      </section>

      <section className="run-section output-section">
        <div className="section-title">
          <FileText size={15} />
          <h3>输出</h3>
        </div>
        <pre className="output-block">
          {run.output ?? liveOutput ?? ""}
          {!run.output && !terminalStatuses.has(run.status) && (
            <span className="stream-caret" />
          )}
        </pre>
        {artifacts.length > 0 ? (
          <div className="artifact-list">
            {artifacts.map((artifact) => (
              <a
                href={artifactDownloadUrl(artifact.id)}
                key={artifact.id}
                download
              >
                <FileText size={14} />
                <span>{artifact.name}</span>
                <Download size={13} />
              </a>
            ))}
          </div>
        ) : (
          events.some((event) => event.type === "artifact.created") && (
            <button
              className="pm-btn secondary"
              onClick={() => void artifactsQuery.refetch()}
            >
              <RefreshCw size={13} />
              加载交付物
            </button>
          )
        )}
      </section>
    </div>
  );
}
