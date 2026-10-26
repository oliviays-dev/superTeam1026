import type {
  Project,
  ProjectReportDetail,
  WorkbenchSourceRef,
} from "@pluginmax/contracts";
import { formatDateTime } from "@pluginmax/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarDays,
  ChevronRight,
  FileClock,
  LoaderCircle,
  RefreshCw,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  generateProjectReport,
  getProjectReport,
  listProjectReports,
  markProjectReportRead,
} from "./api.js";

interface ProjectReportsPanelProps {
  readonly project: Project;
  readonly canGenerate?: boolean | undefined;
  readonly initialReportId?: string;
  readonly onOpenSource: (
    source: WorkbenchSourceRef,
    reportId?: string,
  ) => void;
}

const sectionMeta = {
  conclusion: "今日结论",
  progress: "关键进展",
  risk: "风险与待确认",
  "next-step": "下一步",
} as const;

function reportDateToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function ProjectReportsPanel({
  project,
  canGenerate: capabilityCanGenerate,
  initialReportId,
  onOpenSource,
}: ProjectReportsPanelProps) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [reportDate, setReportDate] = useState(reportDateToday);
  const [selectedId, setSelectedId] = useState(initialReportId ?? "");
  const reportsQuery = useQuery({
    queryKey: ["project-reports", project.id, query],
    queryFn: () => listProjectReports(project.id, { query }),
  });
  const reports = reportsQuery.data ?? [];
  const selected =
    reports.find((report) => report.id === selectedId) ?? reports[0];
  const detailQuery = useQuery({
    queryKey: ["project-report", project.id, selected?.id],
    queryFn: () => getProjectReport(project.id, selected!.id),
    enabled: selected !== undefined,
  });
  const generateMutation = useMutation({
    mutationFn: () => generateProjectReport(project.id, reportDate),
    onSuccess: (result) => {
      setSelectedId(result.report.id);
      void queryClient.invalidateQueries({
        queryKey: ["project-reports", project.id],
      });
      void queryClient.invalidateQueries({ queryKey: ["workbench-dashboard"] });
    },
  });
  const readMutation = useMutation({
    mutationFn: (reportId: string) =>
      markProjectReportRead(project.id, reportId, true),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["project-reports", project.id],
      });
    },
  });

  useEffect(() => {
    if (initialReportId !== undefined && initialReportId !== "") {
      setSelectedId(initialReportId);
    }
  }, [initialReportId, project.id]);

  useEffect(() => {
    if (selected !== undefined && !selected.read && !readMutation.isPending) {
      readMutation.mutate(selected.id);
    }
  }, [selected?.id, selected?.read]);

  const loading = reportsQuery.isLoading || detailQuery.isLoading;
  const error = reportsQuery.error ?? detailQuery.error;
  const canGenerate =
    capabilityCanGenerate ??
    reports[0]?.canGenerate ??
    project.status === "active";
  const readOnly = reports[0]?.readOnly ?? project.status === "archived";
  const grouped = useMemo(() => {
    const detail: ProjectReportDetail | undefined = detailQuery.data;
    return {
      conclusion: detail?.snapshot.items.filter(
        (item) => item.section === "conclusion",
      ),
      progress: detail?.snapshot.items.filter(
        (item) => item.section === "progress",
      ),
      risk: detail?.snapshot.items.filter((item) => item.section === "risk"),
      "next-step": detail?.snapshot.items.filter(
        (item) => item.section === "next-step",
      ),
    };
  }, [detailQuery.data]);

  return (
    <section className="project-reports-panel">
      <header className="project-reports-toolbar">
        <div>
          <strong>项目日报</strong>
          <span>
            {reports.length} 个版本 · {readOnly ? "只读" : "可刷新"}
          </span>
        </div>
        <div className="project-reports-actions">
          <label className="pm-search report-search">
            <Search size={14} />
            <input
              aria-label="搜索项目日报"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索日报内容"
            />
          </label>
          <label className="report-date-control">
            <CalendarDays size={14} />
            <input
              aria-label="日报日期"
              type="date"
              value={reportDate}
              onChange={(event) => setReportDate(event.target.value)}
            />
          </label>
          <button
            className="pm-icon-btn"
            type="button"
            title="刷新项目日报"
            aria-label="刷新项目日报"
            disabled={!canGenerate || readOnly || generateMutation.isPending}
            onClick={() => generateMutation.mutate()}
          >
            <RefreshCw
              size={14}
              className={generateMutation.isPending ? "spin" : undefined}
            />
          </button>
        </div>
      </header>

      {readOnly && (
        <div className="pm-readonly-notice">
          项目已归档。日报历史保持只读，不可生成新版本。
        </div>
      )}
      {(error !== null || generateMutation.error !== null) && (
        <div className="pm-error">
          {errorMessage(
            generateMutation.error ?? error,
            "项目日报加载失败，请重试。",
          )}
        </div>
      )}
      {loading && reports.length === 0 && (
        <div className="pm-loading">
          <LoaderCircle className="spin" size={16} />
          正在加载项目日报
        </div>
      )}
      {!loading && reports.length === 0 && (
        <div className="project-report-empty">
          <FileClock size={22} />
          <strong>当前项目还没有日报</strong>
          <span>
            {canGenerate && !readOnly
              ? "选择日期后点击刷新，生成第一份项目日报。"
              : "项目归档前没有生成过日报。"}
          </span>
        </div>
      )}

      {reports.length > 0 && (
        <div className="project-report-grid">
          <div className="project-report-list" role="list">
            {reports.map((report) => (
              <button
                className={`project-report-row ${
                  report.id === selected?.id ? "active" : ""
                }`}
                type="button"
                role="listitem"
                key={report.id}
                onClick={() => setSelectedId(report.id)}
              >
                <span className="project-report-date">
                  <strong>{report.reportDate}</strong>
                  <small>
                    v{report.version}
                    {report.latest ? " · 最新" : " · 历史"}
                  </small>
                </span>
                <span className="project-report-state">
                  {!report.read && <i aria-label="未读" />}
                  <ChevronRight size={13} />
                </span>
              </button>
            ))}
          </div>

          <article className="project-report-detail" aria-live="polite">
            {detailQuery.isLoading && selected !== undefined && (
              <div className="pm-loading">
                <LoaderCircle className="spin" size={16} />
                正在加载日报详情
              </div>
            )}
            {detailQuery.data !== undefined && (
              <>
                <header className="project-report-detail-head">
                  <div>
                    <h3>
                      {detailQuery.data.projectName} ·{" "}
                      {detailQuery.data.reportDate}
                    </h3>
                    <p>
                      v{detailQuery.data.version} · 生成于{" "}
                      {formatDateTime(detailQuery.data.generatedAt)}
                    </p>
                  </div>
                  <span
                    className={`pm-pill ${
                      detailQuery.data.latest ? "done" : "neutral"
                    }`}
                  >
                    {detailQuery.data.latest ? "当前版本" : "历史版本"}
                  </span>
                </header>

                <div className="project-report-counts">
                  <span>任务 {detailQuery.data.snapshot.counts.tasks}</span>
                  <span>Run {detailQuery.data.snapshot.counts.runs}</span>
                  <span>Review {detailQuery.data.snapshot.counts.reviews}</span>
                  <span>
                    工作流 {detailQuery.data.snapshot.counts.workflows}
                  </span>
                  <span>会议 {detailQuery.data.snapshot.counts.meetings}</span>
                  <span>Memory {detailQuery.data.snapshot.counts.memory}</span>
                </div>

                <div className="project-report-sections">
                  {(
                    Object.keys(sectionMeta) as Array<keyof typeof sectionMeta>
                  ).map((section) => {
                    const items = grouped[section] ?? [];
                    return (
                      <section
                        className={`project-report-section section-${section}`}
                        key={section}
                      >
                        <h4>{sectionMeta[section]}</h4>
                        {items.length === 0 ? (
                          <p className="report-section-empty">
                            本版无新增事项。
                          </p>
                        ) : (
                          items.map((item) => (
                            <article
                              className="project-report-item"
                              key={item.id}
                            >
                              <p>{item.text}</p>
                              {item.sourceRefs.length > 0 && (
                                <div className="report-sources">
                                  {item.sourceRefs.map((source) => (
                                    <button
                                      className="source-link"
                                      type="button"
                                      key={`${source.kind}:${source.id}`}
                                      disabled={
                                        !source.available ||
                                        source.route === "report" ||
                                        source.route === "supply-exception" ||
                                        source.route === "supplier-risk"
                                      }
                                      title={
                                        source.available
                                          ? `打开${source.label}`
                                          : "来源已删除"
                                      }
                                      onClick={() =>
                                        onOpenSource(
                                          source,
                                          detailQuery.data.id,
                                        )
                                      }
                                    >
                                      {source.label || source.kind}
                                      {!source.available && " · 已删除"}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </article>
                          ))
                        )}
                      </section>
                    );
                  })}
                </div>
              </>
            )}
          </article>
        </div>
      )}
    </section>
  );
}
