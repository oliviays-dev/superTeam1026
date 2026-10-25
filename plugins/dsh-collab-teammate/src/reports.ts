import { randomUUID } from "node:crypto";
import {
  teammateAuditEventSchema,
  teammateWorkReportSchema,
  type TeammateAuditEvent,
  type TeammateWorkReport,
  type TeammateWorkReportAuthor,
} from "./models.js";
import type { KvTableLike } from "./service.js";

export interface WorkReportTables {
  readonly workReports: KvTableLike<TeammateWorkReport>;
  readonly auditEvents: KvTableLike<TeammateAuditEvent>;
}

export interface WorkReportQuery {
  readonly teammateId: string;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly q?: string | undefined;
}

export interface AuditEventQuery {
  readonly teammateId: string;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface AuditEventPage {
  readonly events: readonly TeammateAuditEvent[];
  readonly nextCursor?: string | undefined;
}

export interface WorkReportServiceOptions {
  readonly tables: WorkReportTables;
  readonly now?: () => Date;
}

export interface SaveWorkReportInput {
  readonly teammateId: string;
  readonly reportDate: string;
  readonly author: TeammateWorkReportAuthor;
  readonly title: string;
  readonly contentMarkdown: string;
  readonly excerpt: string;
  readonly sourceRefs?: readonly string[] | undefined;
}

export interface WriteAuditInput {
  readonly teammateId: string;
  readonly actor: {
    readonly type: "user" | "ai-teammate" | "system";
    readonly id: string;
    readonly name?: string | undefined;
  };
  readonly narrative: string;
  readonly refs?: {
    readonly taskId?: string | undefined;
    readonly workflowRunId?: string | undefined;
    readonly reportId?: string | undefined;
  };
}

function reportKey(teammateId: string, reportDate: string): string {
  return `${teammateId}:${reportDate}`;
}

/** 业务日期按服务器本地时区计算，避免 UTC 与用户所在时区跨日歧义。 */
export function localDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  const value = Number.parseInt(cursor, 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 关键词对日期、标题、摘要与正文做大小写不敏感的多词 AND 匹配。 */
export function reportMatchesKeywords(
  report: TeammateWorkReport,
  keywords: readonly string[],
): boolean {
  if (keywords.length === 0) return true;
  const haystack = [
    report.reportDate,
    report.title,
    report.excerpt,
    report.contentMarkdown,
  ]
    .join(" ")
    .toLowerCase();
  return keywords.every((keyword) => haystack.includes(keyword));
}

export function splitReportKeywords(q: string | undefined): string[] {
  return String(q ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((keyword) => keyword !== "");
}

export class WorkReportService {
  constructor(private readonly options: WorkReportServiceOptions) {}

  private timestamp(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private values<T>(table: KvTableLike<T>): T[] {
    return [...table.entries()].map(([, value]) => value);
  }

  /** 同 teammate + reportDate 只保留一份当前快照，覆盖时更新生成时间。 */
  async save(input: SaveWorkReportInput): Promise<TeammateWorkReport> {
    const key = reportKey(input.teammateId, input.reportDate);
    const existing = this.options.tables.workReports.get(key);
    const report = teammateWorkReportSchema.parse({
      id: existing?.id ?? `wr-${randomUUID()}`,
      teammateId: input.teammateId,
      reportDate: input.reportDate,
      generatedAt: this.timestamp(),
      author: input.author,
      title: input.title.trim() || `${input.reportDate} 工作日报`,
      excerpt: input.excerpt.trim().slice(0, 1_000),
      contentMarkdown: input.contentMarkdown,
      sourceRefs: [...(input.sourceRefs ?? [])],
    });
    await this.options.tables.workReports.put(key, report);
    return report;
  }

  get(teammateId: string, reportDate: string): TeammateWorkReport | undefined {
    return this.options.tables.workReports.get(reportKey(teammateId, reportDate));
  }

  query(input: WorkReportQuery): readonly TeammateWorkReport[] {
    const keywords = splitReportKeywords(input.q);
    return this.values(this.options.tables.workReports)
      .filter((report) => report.teammateId === input.teammateId)
      .filter((report) => input.from === undefined || report.reportDate >= input.from)
      .filter((report) => input.to === undefined || report.reportDate <= input.to)
      .filter((report) => reportMatchesKeywords(report, keywords))
      .sort((left, right) => right.reportDate.localeCompare(left.reportDate));
  }

  async writeAudit(input: WriteAuditInput): Promise<TeammateAuditEvent> {
    const event = teammateAuditEventSchema.parse({
      id: `aud-${randomUUID()}`,
      teammateId: input.teammateId,
      occurredAt: this.timestamp(),
      actor: input.actor,
      narrative: input.narrative,
      ...(input.refs === undefined ? {} : { refs: input.refs }),
    });
    await this.options.tables.auditEvents.put(event.id, event);
    return event;
  }

  auditEvents(input: AuditEventQuery): AuditEventPage {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 100);
    const events = this.values(this.options.tables.auditEvents)
      .filter((event) => event.teammateId === input.teammateId)
      .sort(
        (left, right) =>
          right.occurredAt.localeCompare(left.occurredAt) ||
          right.id.localeCompare(left.id),
      );
    const offset = decodeCursor(input.cursor);
    const page = events.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      events: page,
      ...(next < events.length ? { nextCursor: String(next) } : {}),
    };
  }
}
