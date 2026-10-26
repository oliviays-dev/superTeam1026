import { createHash, randomUUID } from "node:crypto";
import type {
  CreateSupplyExceptionInput,
  CreateSupplierRiskInput,
  ProjectReportCounts,
  ProjectReportDetail,
  ProjectReportGenerationResult,
  ProjectReportItem,
  ProjectReportQuery,
  ProjectReportSnapshot,
  ProjectReportSummary,
  ReportDate,
  SetWorkbenchFollowInput,
  SupplyException,
  SupplierRisk,
  UpdateWorkbenchBriefSettingsInput,
  WorkbenchBrief,
  WorkbenchBriefGenerationResult,
  WorkbenchBriefSettings,
  WorkbenchDashboard,
  WorkbenchFocusItem,
  WorkbenchFollow,
  WorkbenchMeetingConclusion,
  WorkbenchRunException,
  WorkbenchSourceKind,
  WorkbenchSourceRef,
  WorkbenchTodo,
} from "@pluginmax/contracts";
import type { PoolClient } from "pg";
import type { AuthorizationRepository } from "./authorization-repository.js";
import type { Database } from "./database.js";

interface ProjectReportRow {
  id: string;
  project_id: string;
  project_name: string;
  report_date: string | Date;
  version: number;
  content_hash: string;
  snapshot: ProjectReportSnapshot;
  generated_by: string;
  generated_at: Date;
  read: boolean;
  latest: boolean;
}

interface ProjectReportSourceRow {
  source_kind: WorkbenchSourceKind;
  source_id: string;
  project_id: string;
  label: string;
  route: WorkbenchSourceRef["route"];
  target_id: string;
  metadata: Record<string, unknown>;
  position: number;
}

interface BriefRow {
  id: string;
  actor_id: string;
  brief_date: string | Date;
  version: number;
  content_hash: string;
  snapshot: WorkbenchBrief["snapshot"];
  generated_by: string;
  generated_at: Date;
  read: boolean;
}

interface BriefSettingsRow {
  actor_id: string;
  frequency: WorkbenchBriefSettings["frequency"];
  silent_start: string | null;
  silent_end: string | null;
  updated_at: Date;
}

interface FollowRow {
  actor_id: string;
  target_type: WorkbenchFollow["targetType"];
  target_id: string;
  project_id: string;
  created_at: Date;
}

interface SupplyExceptionRow {
  id: string;
  project_id: string;
  title: string;
  severity: SupplyException["severity"];
  suggested_action: string;
  owner_actor_id: string;
  due_at: Date | null;
  impact_scope: string;
  source_task_id: string | null;
  source_workflow_instance_id: string | null;
  status: SupplyException["status"];
  created_at: Date;
  updated_at: Date;
}

interface SupplierRiskRow {
  id: string;
  project_id: string;
  supplier_name: string;
  risk_type: string;
  risk_score: number;
  commitment_rate: string | null;
  quality_metric: string;
  purchase_share: string | null;
  suggested_action: string;
  status: SupplierRisk["status"];
  source_note: string;
  data_updated_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface AccessibleProjectRow {
  id: string;
  name: string;
  owner: boolean;
}

interface TaskFactRow {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  status: WorkbenchTodo["status"];
  updated_at: Date;
}

interface RunFactRow {
  id: string;
  task_id: string;
  project_id: string;
  project_name: string;
  title: string;
  status: string;
  error: string | null;
  updated_at: Date;
}

interface ReviewFactRow {
  id: string;
  task_id: string;
  project_id: string;
  project_name: string;
  task_title: string;
  decision: "approve" | "return";
  note: string;
  created_at: Date;
}

interface WorkflowFactRow {
  id: string;
  project_id: string;
  project_name: string;
  title: string;
  status: string;
  failure_reason: string | null;
  updated_at: Date;
}

interface MeetingFactRow {
  version_id: string;
  meeting_id: string;
  project_id: string;
  project_name: string;
  title: string;
  content: string;
  decisions: string[];
  published_at: Date;
}

interface ActionFactRow {
  id: string;
  meeting_id: string;
  project_id: string;
  title: string;
  status: string;
  priority: string;
  due_at: Date | null;
  task_id: string | null;
  updated_at: Date;
}

interface MemoryFactRow {
  id: string;
  topic_id: string;
  project_id: string;
  topic_title: string;
  content: string;
  version: number;
  created_at: Date;
}

const SYSTEM_ACTOR = "system";
const BRIEF_SOURCE_PRIORITY = {
  project: 2,
  workflow: 3,
  "direct-workflow": 4,
  task: 5,
} as const;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function contentHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function todayInShanghai(now = new Date()): ReportDate {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function dayBounds(reportDate: ReportDate): {
  readonly start: Date;
  readonly end: Date;
} {
  const start = new Date(`${reportDate}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime())) {
    throw new Error("invalid report date");
  }
  return {
    start,
    end: new Date(start.getTime() + 24 * 60 * 60 * 1_000),
  };
}

function sourceRef(input: {
  readonly kind: WorkbenchSourceKind;
  readonly id: string;
  readonly projectId: string;
  readonly label: string;
  readonly route: WorkbenchSourceRef["route"];
  readonly targetId: string;
  readonly available?: boolean;
}): WorkbenchSourceRef {
  return {
    kind: input.kind,
    id: input.id,
    projectId: input.projectId,
    label: input.label.slice(0, 500),
    route: input.route,
    targetId: input.targetId,
    available: input.available ?? true,
  };
}

function dedupeSources(
  sources: readonly WorkbenchSourceRef[],
): WorkbenchSourceRef[] {
  const unique = new Map<string, WorkbenchSourceRef>();
  for (const source of sources) {
    unique.set(`${source.kind}:${source.id}`, source);
  }
  return [...unique.values()];
}

function reportSummary(row: ProjectReportRow): ProjectReportSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    reportDate: dateOnly(row.report_date),
    version: row.version,
    generatedAt: row.generated_at.toISOString(),
    generatedBy: row.generated_by,
    read: row.read,
    readOnly: false,
    canGenerate: false,
    latest: row.latest,
  };
}

export class WorkbenchReportsRepository {
  constructor(
    private readonly database: Database,
    private readonly authorization: AuthorizationRepository,
  ) {}

  async generateProjectReport(input: {
    readonly projectId: string;
    readonly reportDate: ReportDate;
    readonly actorId: string;
  }): Promise<ProjectReportGenerationResult> {
    const generation = await this.database.transaction(async (client) => {
      const project = await client.query<{
        id: string;
        name: string;
        code: string;
      }>("SELECT id, name, code FROM projects WHERE id = $1", [
        input.projectId,
      ]);
      const projectRow = project.rows[0];
      if (projectRow === undefined) throw new Error("project not found");

      const snapshot = await this.buildProjectReportSnapshot(
        client,
        input.projectId,
        projectRow.name,
        projectRow.code,
        input.reportDate,
      );
      const hash = contentHash(snapshot);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`project-report:${input.projectId}:${input.reportDate}`],
      );
      const existing = await client.query<ProjectReportRow>(
        `SELECT
           report.*,
           project.name AS project_name,
           TRUE AS read,
           TRUE AS latest
         FROM project_reports AS report
         JOIN projects AS project ON project.id = report.project_id
         WHERE report.project_id = $1
           AND report.report_date = $2
           AND report.content_hash = $3`,
        [input.projectId, input.reportDate, hash],
      );
      const existingRow = existing.rows[0];
      if (existingRow !== undefined) {
        return {
          reportId: existingRow.id,
          created: false,
          reused: true,
        };
      }

      const next = await client.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0)::integer + 1 AS version
         FROM project_reports
         WHERE project_id = $1 AND report_date = $2`,
        [input.projectId, input.reportDate],
      );
      const reportId = randomUUID();
      await client.query(
        `INSERT INTO project_reports (
           id, project_id, report_date, version, content_hash, snapshot,
           generated_by, generated_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())`,
        [
          reportId,
          input.projectId,
          input.reportDate,
          next.rows[0]!.version,
          hash,
          JSON.stringify(snapshot),
          input.actorId,
        ],
      );
      const sources = dedupeSources(
        snapshot.items.flatMap((item) => item.sourceRefs),
      );
      for (const [position, source] of sources.entries()) {
        await client.query(
          `INSERT INTO project_report_sources (
             report_id, source_kind, source_id, project_id, label,
             route, target_id, metadata, position
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb, $8)
           ON CONFLICT (report_id, source_kind, source_id) DO NOTHING`,
          [
            reportId,
            source.kind,
            source.id,
            input.projectId,
            source.label,
            source.route,
            source.targetId,
            position,
          ],
        );
      }
      return { reportId, created: true, reused: false };
    });
    const report = await this.getProjectReport(
      input.projectId,
      generation.reportId,
      input.actorId,
    );
    if (report === undefined) throw new Error("generated report missing");
    return {
      report,
      created: generation.created,
      reused: generation.reused,
    };
  }

  async listProjectReports(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly query: ProjectReportQuery;
    readonly readOnly: boolean;
    readonly canGenerate: boolean;
  }): Promise<ProjectReportSummary[]> {
    const result = await this.database.query<ProjectReportRow>(
      `SELECT
         report.*,
         project.name AS project_name,
         (read.actor_id IS NOT NULL) AS read,
         report.version = MAX(report.version) OVER (
           PARTITION BY report.report_date
         ) AS latest
       FROM project_reports AS report
       JOIN projects AS project ON project.id = report.project_id
       LEFT JOIN project_report_reads AS read
         ON read.report_id = report.id
        AND read.actor_id = $2
       WHERE report.project_id = $1
         AND ($3::date IS NULL OR report.report_date >= $3)
         AND ($4::date IS NULL OR report.report_date <= $4)
         AND ($5::text IS NULL OR report.snapshot::text ILIKE '%' || $5 || '%')
       ORDER BY report.report_date DESC, report.version DESC`,
      [
        input.projectId,
        input.actorId,
        input.query.from ?? null,
        input.query.to ?? null,
        input.query.query?.trim() || null,
      ],
    );
    return result.rows.map((row) => ({
      ...reportSummary(row),
      readOnly: input.readOnly,
      canGenerate: input.canGenerate,
    }));
  }

  async getProjectReport(
    projectId: string,
    reportId: string,
    actorId: string,
  ): Promise<ProjectReportDetail | undefined> {
    const result = await this.database.query<ProjectReportRow>(
      `SELECT
         report.*,
         project.name AS project_name,
         (read.actor_id IS NOT NULL) AS read,
         report.version = (
           SELECT MAX(latest.version)
           FROM project_reports AS latest
           WHERE latest.project_id = report.project_id
             AND latest.report_date = report.report_date
         ) AS latest
       FROM project_reports AS report
       JOIN projects AS project ON project.id = report.project_id
       LEFT JOIN project_report_reads AS read
         ON read.report_id = report.id
        AND read.actor_id = $3
       WHERE report.project_id = $1 AND report.id = $2`,
      [projectId, reportId, actorId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const sourceResult = await this.database.query<ProjectReportSourceRow>(
      `SELECT
         source_kind, source_id, project_id, label, route,
         target_id, metadata, position
       FROM project_report_sources
       WHERE report_id = $1
       ORDER BY position, source_kind, source_id`,
      [reportId],
    );
    const sources = await this.resolveSourceAvailability(
      projectId,
      sourceResult.rows.map((source) => ({
        kind: source.source_kind,
        id: source.source_id,
        projectId: source.project_id,
        label: source.label,
        route: source.route,
        targetId: source.target_id,
        available: true,
      })),
    );
    const availability = new Map(
      sources.map((source) => [
        `${source.kind}:${source.id}`,
        source.available,
      ]),
    );
    return {
      ...reportSummary(row),
      snapshot: {
        ...row.snapshot,
        items: row.snapshot.items.map((item) => ({
          ...item,
          sourceRefs: item.sourceRefs.map((source) => ({
            ...source,
            available:
              availability.get(`${source.kind}:${source.id}`) ??
              source.available,
          })),
        })),
      },
      sources,
    };
  }

  async markProjectReportRead(input: {
    readonly projectId: string;
    readonly reportId: string;
    readonly actorId: string;
    readonly read: boolean;
  }): Promise<boolean> {
    const report = await this.database.query(
      "SELECT 1 FROM project_reports WHERE project_id = $1 AND id = $2",
      [input.projectId, input.reportId],
    );
    if (report.rowCount === 0) return false;
    if (input.read) {
      await this.database.query(
        `INSERT INTO project_report_reads (report_id, actor_id, read_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (report_id, actor_id)
         DO UPDATE SET read_at = EXCLUDED.read_at`,
        [input.reportId, input.actorId],
      );
    } else {
      await this.database.query(
        "DELETE FROM project_report_reads WHERE report_id = $1 AND actor_id = $2",
        [input.reportId, input.actorId],
      );
    }
    return true;
  }

  async generateWorkbenchBrief(input: {
    readonly actorId: string;
    readonly briefDate: ReportDate;
  }): Promise<WorkbenchBriefGenerationResult> {
    const projects = await this.accessibleProjects(input.actorId);
    const snapshot = await this.buildBriefSnapshot(
      input.actorId,
      input.briefDate,
      projects.map((project) => project.id),
    );
    const hash = contentHash(snapshot);
    return this.database.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`workbench-brief:${input.actorId}:${input.briefDate}`],
      );
      const existing = await client.query<BriefRow>(
        `SELECT
           brief.*,
           (read.actor_id IS NOT NULL) AS read
         FROM workbench_briefs AS brief
         LEFT JOIN workbench_brief_reads AS read
           ON read.brief_id = brief.id
          AND read.actor_id = brief.actor_id
         WHERE brief.actor_id = $1
           AND brief.brief_date = $2
           AND brief.content_hash = $3`,
        [input.actorId, input.briefDate, hash],
      );
      const existingRow = existing.rows[0];
      if (existingRow !== undefined) {
        return {
          brief: briefFromRow(existingRow),
          created: false,
          reused: true,
        };
      }
      const next = await client.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0)::integer + 1 AS version
         FROM workbench_briefs
         WHERE actor_id = $1 AND brief_date = $2`,
        [input.actorId, input.briefDate],
      );
      const inserted = await client.query<BriefRow>(
        `INSERT INTO workbench_briefs (
           id, actor_id, brief_date, version, content_hash, snapshot,
           generated_by, generated_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NOW())
         RETURNING *, FALSE AS read`,
        [
          randomUUID(),
          input.actorId,
          input.briefDate,
          next.rows[0]!.version,
          hash,
          JSON.stringify(snapshot),
          SYSTEM_ACTOR,
        ],
      );
      return {
        brief: briefFromRow(inserted.rows[0]!),
        created: true,
        reused: false,
      };
    });
  }

  async getLatestBrief(actorId: string): Promise<WorkbenchBrief | null> {
    const result = await this.database.query<BriefRow>(
      `SELECT
         brief.*,
         (read.actor_id IS NOT NULL) AS read
       FROM workbench_briefs AS brief
       LEFT JOIN workbench_brief_reads AS read
         ON read.brief_id = brief.id
        AND read.actor_id = brief.actor_id
       WHERE brief.actor_id = $1
       ORDER BY brief.brief_date DESC, brief.version DESC
       LIMIT 1`,
      [actorId],
    );
    const row = result.rows[0];
    return row === undefined ? null : briefFromRow(row);
  }

  async markBriefRead(input: {
    readonly actorId: string;
    readonly briefId: string;
    readonly read: boolean;
  }): Promise<boolean> {
    const brief = await this.database.query(
      "SELECT 1 FROM workbench_briefs WHERE id = $1 AND actor_id = $2",
      [input.briefId, input.actorId],
    );
    if (brief.rowCount === 0) return false;
    if (input.read) {
      await this.database.query(
        `INSERT INTO workbench_brief_reads (brief_id, actor_id, read_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (brief_id, actor_id)
         DO UPDATE SET read_at = EXCLUDED.read_at`,
        [input.briefId, input.actorId],
      );
    } else {
      await this.database.query(
        "DELETE FROM workbench_brief_reads WHERE brief_id = $1 AND actor_id = $2",
        [input.briefId, input.actorId],
      );
    }
    return true;
  }

  async getBriefSettings(actorId: string): Promise<WorkbenchBriefSettings> {
    const result = await this.database.query<BriefSettingsRow>(
      "SELECT * FROM workbench_brief_settings WHERE actor_id = $1",
      [actorId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return {
        actorId,
        frequency: "daily-0800",
        silentStart: null,
        silentEnd: null,
        updatedAt: new Date().toISOString(),
      };
    }
    return settingsFromRow(row);
  }

  async updateBriefSettings(
    actorId: string,
    input: UpdateWorkbenchBriefSettingsInput,
  ): Promise<WorkbenchBriefSettings> {
    const result = await this.database.query<BriefSettingsRow>(
      `INSERT INTO workbench_brief_settings (
         actor_id, frequency, silent_start, silent_end, updated_at
       ) VALUES ($1, $2, $3::time, $4::time, NOW())
       ON CONFLICT (actor_id) DO UPDATE
       SET
         frequency = EXCLUDED.frequency,
         silent_start = EXCLUDED.silent_start,
         silent_end = EXCLUDED.silent_end,
         updated_at = NOW()
       RETURNING *`,
      [
        actorId,
        input.frequency,
        input.silentStart ?? null,
        input.silentEnd ?? null,
      ],
    );
    return settingsFromRow(result.rows[0]!);
  }

  async listFollows(actorId: string): Promise<WorkbenchFollow[]> {
    const result = await this.database.query<FollowRow>(
      `SELECT * FROM workbench_follows
       WHERE actor_id = $1
       ORDER BY created_at DESC`,
      [actorId],
    );
    return result.rows.map((row) => ({
      actorId: row.actor_id,
      targetType: row.target_type,
      targetId: row.target_id,
      projectId: row.project_id,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async setFollow(
    actorId: string,
    input: SetWorkbenchFollowInput,
  ): Promise<boolean> {
    if (input.followed) {
      await this.database.query(
        `INSERT INTO workbench_follows (
           actor_id, target_type, target_id, project_id, created_at
         ) VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (actor_id, target_type, target_id) DO NOTHING`,
        [actorId, input.targetType, input.targetId, input.projectId],
      );
    } else {
      await this.database.query(
        `DELETE FROM workbench_follows
         WHERE actor_id = $1 AND target_type = $2 AND target_id = $3`,
        [actorId, input.targetType, input.targetId],
      );
    }
    return input.followed;
  }

  async resourceBelongsToProject(
    projectId: string,
    targetType: WorkbenchFollow["targetType"],
    targetId: string,
  ): Promise<boolean> {
    const sql =
      targetType === "task"
        ? "SELECT 1 FROM tasks WHERE project_id = $1 AND id = $2"
        : targetType === "workflow"
          ? "SELECT 1 FROM workflow_instances WHERE project_id = $1 AND id = $2"
          : targetType === "meeting"
            ? "SELECT 1 FROM meetings WHERE project_id = $1 AND id = $2"
            : "SELECT 1 FROM projects WHERE id = $1 AND id = $2";
    const result = await this.database.query(sql, [projectId, targetId]);
    return result.rowCount === 1;
  }

  async listSupplyExceptions(projectIds: readonly string[]) {
    if (projectIds.length === 0) return [];
    const result = await this.database.query<SupplyExceptionRow>(
      `SELECT * FROM supply_exceptions
       WHERE project_id = ANY($1::uuid[])
         AND status <> 'resolved'
       ORDER BY
         CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
         due_at NULLS LAST,
         updated_at DESC`,
      [[...projectIds]],
    );
    return result.rows.map(supplyExceptionFromRow);
  }

  async createSupplyException(
    actorId: string,
    input: CreateSupplyExceptionInput,
  ): Promise<SupplyException> {
    const result = await this.database.query<SupplyExceptionRow>(
      `INSERT INTO supply_exceptions (
         id, project_id, title, severity, suggested_action, owner_actor_id,
         due_at, impact_scope, source_task_id, source_workflow_instance_id,
         status, created_by, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW()
       ) RETURNING *`,
      [
        randomUUID(),
        input.projectId,
        input.title,
        input.severity,
        input.suggestedAction,
        input.ownerActorId,
        input.dueAt ?? null,
        input.impactScope,
        input.sourceTaskId ?? null,
        input.sourceWorkflowInstanceId ?? null,
        input.status,
        actorId,
      ],
    );
    return supplyExceptionFromRow(result.rows[0]!);
  }

  async listSupplierRisks(projectIds: readonly string[]) {
    if (projectIds.length === 0) return [];
    const result = await this.database.query<SupplierRiskRow>(
      `SELECT * FROM supplier_risks
       WHERE project_id = ANY($1::uuid[])
         AND status <> 'closed'
       ORDER BY risk_score DESC, data_updated_at DESC`,
      [[...projectIds]],
    );
    return result.rows.map(supplierRiskFromRow);
  }

  async createSupplierRisk(
    actorId: string,
    input: CreateSupplierRiskInput,
  ): Promise<SupplierRisk> {
    const result = await this.database.query<SupplierRiskRow>(
      `INSERT INTO supplier_risks (
         id, project_id, supplier_name, risk_type, risk_score,
         commitment_rate, quality_metric, purchase_share, suggested_action,
         status, source_note, data_updated_at, created_by, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12, NOW(), NOW()
       ) RETURNING *`,
      [
        randomUUID(),
        input.projectId,
        input.supplierName,
        input.riskType,
        input.riskScore,
        input.commitmentRate ?? null,
        input.qualityMetric,
        input.purchaseShare ?? null,
        input.suggestedAction,
        input.status,
        input.sourceNote,
        actorId,
      ],
    );
    return supplierRiskFromRow(result.rows[0]!);
  }

  async dashboard(actorId: string): Promise<WorkbenchDashboard> {
    const projects = await this.accessibleProjects(actorId);
    const projectIds = projects.map((project) => project.id);
    const briefDate = todayInShanghai();
    await this.generateWorkbenchBrief({ actorId, briefDate });
    const [
      brief,
      settings,
      todos,
      focus,
      meetingConclusions,
      runExceptions,
      projectReports,
      supplyExceptions,
      supplierRisks,
    ] = await Promise.all([
      this.getLatestBrief(actorId),
      this.getBriefSettings(actorId),
      this.listTodos(projectIds),
      this.listFocus(actorId, projectIds),
      this.listMeetingConclusions(projectIds),
      this.listRunExceptions(projectIds),
      this.listLatestProjectReports(projectIds, actorId),
      this.listSupplyExceptions(projectIds),
      this.listSupplierRisks(projectIds),
    ]);
    return {
      actorId,
      generatedAt: new Date().toISOString(),
      canManage: projects.some((project) => project.owner),
      readOnly: projects.length === 0,
      brief,
      settings,
      todos,
      focus,
      meetingConclusions,
      runExceptions,
      projectReports,
      supplyExceptions,
      supplierRisks,
    };
  }

  private async accessibleProjects(
    actorId: string,
  ): Promise<AccessibleProjectRow[]> {
    const principal = await this.authorization.getPrincipal(actorId);
    const readableProjectIds = await this.authorization.listReadableProjectIds({
      principalId: actorId,
      authSource:
        principal?.source === "local" ? "local-development" : "bearer",
    });
    if (readableProjectIds.length === 0) return [];
    const result = await this.database.query<AccessibleProjectRow>(
      `SELECT
         project.id,
         project.name,
         FALSE AS owner
       FROM projects AS project
       WHERE project.id = ANY($1::uuid[])
         AND project.status = 'active'
       ORDER BY project.name`,
      [readableProjectIds],
    );
    const capabilities = await Promise.all(
      result.rows.map((row) =>
        this.authorization.getProjectCapability({
          principalId: actorId,
          authSource:
            principal?.source === "local" ? "local-development" : "bearer",
          projectId: row.id,
        }),
      ),
    );
    return result.rows.map((row, index) => ({
      id: row.id,
      name: row.name,
      owner:
        capabilities[index]?.capability?.ownerSources.legacy === true ||
        capabilities[index]?.capability?.ownerSources.grant === true,
    }));
  }

  private async buildProjectReportSnapshot(
    client: PoolClient,
    projectId: string,
    projectName: string,
    projectCode: string,
    reportDate: ReportDate,
  ): Promise<ProjectReportSnapshot> {
    const { start, end } = dayBounds(reportDate);
    const tasksResult = await client.query<TaskFactRow>(
      `SELECT
           task.id, task.project_id, project.name AS project_name,
           task.title, task.status, task.updated_at
         FROM tasks AS task
         JOIN projects AS project ON project.id = task.project_id
         WHERE task.project_id = $1
         ORDER BY task.updated_at DESC, task.id`,
      [projectId],
    );
    const runsResult = await client.query<RunFactRow>(
      `SELECT
           run.id, run.task_id, run.project_id, project.name AS project_name,
           task.title, run.status, run.error, run.updated_at
         FROM runs AS run
         JOIN tasks AS task ON task.id = run.task_id
         JOIN projects AS project ON project.id = run.project_id
         WHERE run.project_id = $1
           AND run.updated_at >= $2
           AND run.updated_at < $3
         ORDER BY run.updated_at DESC, run.id`,
      [projectId, start, end],
    );
    const reviewsResult = await client.query<ReviewFactRow>(
      `SELECT
           review.id, review.task_id, task.project_id,
           project.name AS project_name, task.title AS task_title,
           review.decision, review.note, review.created_at
         FROM task_reviews AS review
         JOIN tasks AS task ON task.id = review.task_id
         JOIN projects AS project ON project.id = task.project_id
         WHERE task.project_id = $1
           AND review.created_at >= $2
           AND review.created_at < $3
         ORDER BY review.created_at DESC, review.id`,
      [projectId, start, end],
    );
    const workflowsResult = await client.query<WorkflowFactRow>(
      `SELECT
           instance.id, instance.project_id, project.name AS project_name,
           instance.title, instance.status, instance.failure_reason,
           instance.updated_at
         FROM workflow_instances AS instance
         JOIN projects AS project ON project.id = instance.project_id
         WHERE instance.project_id = $1
           AND (
             instance.status <> 'completed'
             OR (
               instance.updated_at >= $2
               AND instance.updated_at < $3
             )
           )
         ORDER BY instance.updated_at DESC, instance.id`,
      [projectId, start, end],
    );
    const meetingsResult = await client.query<MeetingFactRow>(
      `SELECT
           version.id AS version_id, version.meeting_id, version.project_id,
           project.name AS project_name, meeting.title, version.content,
           version.decisions, version.published_at
         FROM meeting_minutes_versions AS version
         JOIN meetings AS meeting ON meeting.id = version.meeting_id
         JOIN projects AS project ON project.id = version.project_id
         WHERE version.project_id = $1
           AND version.published_at >= $2
           AND version.published_at < $3
         ORDER BY version.published_at DESC, version.id`,
      [projectId, start, end],
    );
    const actionsResult = await client.query<ActionFactRow>(
      `SELECT
           item.id, item.meeting_id, item.project_id, item.title,
           item.status, item.priority, item.due_at, item.task_id,
           item.updated_at
         FROM meeting_action_items AS item
         WHERE item.project_id = $1
           AND item.updated_at >= $2
           AND item.updated_at < $3
         ORDER BY item.updated_at DESC, item.id`,
      [projectId, start, end],
    );
    const memoryResult = await client.query<MemoryFactRow>(
      `SELECT
           truth.id, truth.topic_id, truth.project_id,
           topic.title AS topic_title, truth.content, truth.version,
           truth.created_at
         FROM memory_truths AS truth
         JOIN memory_topics AS topic ON topic.id = truth.topic_id
         WHERE truth.project_id = $1
           AND truth.created_at >= $2
           AND truth.created_at < $3
         ORDER BY truth.created_at DESC, truth.id`,
      [projectId, start, end],
    );

    const items: ProjectReportItem[] = [];
    for (const meeting of meetingsResult.rows) {
      const decisions =
        meeting.decisions.length > 0 ? meeting.decisions : [meeting.content];
      for (const [index, decision] of decisions.entries()) {
        if (decision.trim() === "") continue;
        items.push({
          id: `meeting:${meeting.version_id}:decision:${index}`,
          section: "conclusion",
          text: `${meeting.title}：${decision}`,
          sourceRefs: [
            sourceRef({
              kind: "meeting",
              id: meeting.meeting_id,
              projectId,
              label: meeting.title,
              route: "meeting",
              targetId: meeting.meeting_id,
            }),
            sourceRef({
              kind: "minutes-version",
              id: meeting.version_id,
              projectId,
              label: `${meeting.title} 纪要版本`,
              route: "meeting",
              targetId: meeting.meeting_id,
            }),
          ],
        });
      }
    }
    for (const truth of memoryResult.rows) {
      items.push({
        id: `memory:${truth.id}`,
        section: "conclusion",
        text: `${truth.topic_title}：${truth.content}`,
        sourceRefs: [
          sourceRef({
            kind: "memory-topic",
            id: truth.topic_id,
            projectId,
            label: truth.topic_title,
            route: "memory",
            targetId: truth.topic_id,
          }),
          sourceRef({
            kind: "memory-truth",
            id: truth.id,
            projectId,
            label: `${truth.topic_title} v${truth.version}`,
            route: "memory",
            targetId: truth.topic_id,
          }),
        ],
      });
    }
    for (const task of tasksResult.rows) {
      if (task.status !== "done") continue;
      items.push({
        id: `task:${task.id}:progress`,
        section: "progress",
        text: `任务「${task.title}」已完成。`,
        sourceRefs: [
          sourceRef({
            kind: "task",
            id: task.id,
            projectId,
            label: task.title,
            route: "task",
            targetId: task.id,
          }),
        ],
      });
    }
    for (const run of runsResult.rows) {
      if (run.status !== "completed") continue;
      items.push({
        id: `run:${run.id}:progress`,
        section: "progress",
        text: `任务「${run.title}」的执行 Run 已完成。`,
        sourceRefs: [
          sourceRef({
            kind: "run",
            id: run.id,
            projectId,
            label: run.title,
            route: "run",
            targetId: run.task_id,
          }),
        ],
      });
    }
    for (const review of reviewsResult.rows) {
      if (review.decision !== "approve") continue;
      items.push({
        id: `review:${review.id}`,
        section: "progress",
        text: `任务「${review.task_title}」通过验收。`,
        sourceRefs: [
          sourceRef({
            kind: "review",
            id: review.id,
            projectId,
            label: review.task_title,
            route: "review",
            targetId: review.task_id,
          }),
        ],
      });
    }
    for (const task of tasksResult.rows) {
      if (task.status !== "review") continue;
      items.push({
        id: `task:${task.id}:risk`,
        section: "risk",
        text: `任务「${task.title}」等待验收。`,
        sourceRefs: [
          sourceRef({
            kind: "task",
            id: task.id,
            projectId,
            label: task.title,
            route: "task",
            targetId: task.id,
          }),
        ],
      });
    }
    for (const run of runsResult.rows) {
      if (!["failed", "timeout", "interrupted"].includes(run.status)) continue;
      items.push({
        id: `run:${run.id}:risk`,
        section: "risk",
        text: `任务「${run.title}」的执行 Run ${run.status}${run.error === null ? "。" : `：${run.error}`}`,
        sourceRefs: [
          sourceRef({
            kind: "run",
            id: run.id,
            projectId,
            label: run.title,
            route: "run",
            targetId: run.task_id,
          }),
        ],
      });
    }
    for (const workflow of workflowsResult.rows) {
      if (workflow.status === "completed" || workflow.failure_reason === null) {
        continue;
      }
      items.push({
        id: `workflow:${workflow.id}:risk`,
        section: "risk",
        text: `工作流「${workflow.title}」需要处理：${workflow.failure_reason}`,
        sourceRefs: [
          sourceRef({
            kind: "workflow",
            id: workflow.id,
            projectId,
            label: workflow.title,
            route: "workflow",
            targetId: workflow.id,
          }),
        ],
      });
    }
    for (const task of tasksResult.rows) {
      if (!["queued", "in_progress"].includes(task.status)) continue;
      items.push({
        id: `task:${task.id}:next-step`,
        section: "next-step",
        text: `继续推进任务「${task.title}」。`,
        sourceRefs: [
          sourceRef({
            kind: "task",
            id: task.id,
            projectId,
            label: task.title,
            route: "task",
            targetId: task.id,
          }),
        ],
      });
    }
    for (const workflow of workflowsResult.rows) {
      if (workflow.status === "completed") continue;
      items.push({
        id: `workflow:${workflow.id}:next-step`,
        section: "next-step",
        text: `继续推进工作流「${workflow.title}」。`,
        sourceRefs: [
          sourceRef({
            kind: "workflow",
            id: workflow.id,
            projectId,
            label: workflow.title,
            route: "workflow",
            targetId: workflow.id,
          }),
        ],
      });
    }
    for (const action of actionsResult.rows) {
      if (!["open", "in_progress"].includes(action.status)) continue;
      items.push({
        id: `action-item:${action.id}`,
        section: "next-step",
        text: `完成会议行动项「${action.title}」。`,
        sourceRefs: [
          sourceRef({
            kind: "action-item",
            id: action.id,
            projectId,
            label: action.title,
            route: action.task_id === null ? "meeting" : "task",
            targetId: action.task_id ?? action.meeting_id,
          }),
        ],
      });
    }
    if (items.length === 0) {
      items.push({
        id: "empty",
        section: "conclusion",
        text: "当前周期没有可汇总的项目活动。",
        sourceRefs: [],
      });
    }
    const counts: ProjectReportCounts = {
      tasks: tasksResult.rows.length,
      runs: runsResult.rows.length,
      reviews: reviewsResult.rows.length,
      workflows: workflowsResult.rows.length,
      meetings: meetingsResult.rows.length,
      actionItems: actionsResult.rows.length,
      memory: memoryResult.rows.length,
    };
    return {
      projectName,
      projectCode,
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      counts,
      items,
    };
  }

  private async buildBriefSnapshot(
    actorId: string,
    briefDate: ReportDate,
    projectIds: readonly string[],
  ): Promise<WorkbenchBrief["snapshot"]> {
    const { start, end } = dayBounds(briefDate);
    const [
      reports,
      todos,
      meetings,
      runExceptions,
      supplyExceptions,
      supplierRisks,
    ] = await Promise.all([
      this.listLatestProjectReports(projectIds, actorId),
      this.listTodos(projectIds),
      this.listMeetingConclusions(projectIds),
      this.listRunExceptions(projectIds),
      this.listSupplyExceptions(projectIds),
      this.listSupplierRisks(projectIds),
    ]);
    const items: WorkbenchBrief["snapshot"]["items"] = [];
    for (const report of reports) {
      const detail = await this.getProjectReport(
        report.projectId,
        report.id,
        actorId,
      );
      if (detail === undefined) continue;
      for (const item of detail.snapshot.items.slice(0, 8)) {
        items.push({
          id: `report:${report.id}:${item.id}`,
          section:
            item.section === "risk"
              ? "exception"
              : item.section === "next-step"
                ? "decision"
                : item.section === "progress"
                  ? "progress"
                  : "conclusion",
          title: `${report.projectName}项目日报`,
          body: item.text,
          severity: item.section === "risk" ? "watch" : "info",
          sourceRefs: [
            sourceRef({
              kind: "project",
              id: report.projectId,
              projectId: report.projectId,
              label: report.projectName,
              route: "report",
              targetId: report.id,
            }),
            ...item.sourceRefs,
          ],
        });
      }
    }
    for (const todo of todos.slice(0, 10)) {
      items.push({
        id: `todo:${todo.taskId}`,
        section: todo.status === "review" ? "decision" : "progress",
        title: todo.title,
        body: `${todo.projectName} · ${todo.status === "review" ? "等待验收" : "待处理"}`,
        severity: todo.priority === "P1" ? "watch" : "info",
        sourceRefs: [
          sourceRef({
            kind: "task",
            id: todo.taskId,
            projectId: todo.projectId,
            label: todo.title,
            route: "task",
            targetId: todo.taskId,
          }),
        ],
        dueAt: todo.dueAt,
      });
    }
    for (const meeting of meetings.slice(0, 8)) {
      items.push({
        id: `meeting:${meeting.meetingId}:brief`,
        section: "conclusion",
        title: meeting.title,
        body: meeting.conclusion,
        severity: "info",
        sourceRefs: [
          sourceRef({
            kind: "meeting",
            id: meeting.meetingId,
            projectId: meeting.projectId,
            label: meeting.title,
            route: "meeting",
            targetId: meeting.meetingId,
          }),
        ],
      });
    }
    for (const run of runExceptions.slice(0, 8)) {
      items.push({
        id: `run:${run.runId}:brief`,
        section: "exception",
        title: run.title,
        body: `${run.projectName} · Run ${run.status}${run.error === null ? "" : `：${run.error}`}`,
        severity: "risk",
        sourceRefs: [
          sourceRef({
            kind: "run",
            id: run.runId,
            projectId: run.projectId,
            label: run.title,
            route: "run",
            targetId: run.taskId,
          }),
        ],
      });
    }
    for (const exception of supplyExceptions.slice(0, 8)) {
      items.push({
        id: `supply:${exception.id}:brief`,
        section: "exception",
        title: exception.title,
        body:
          exception.suggestedAction ||
          `供给例外影响范围：${exception.impactScope || "待确认"}`,
        severity: exception.severity === "high" ? "risk" : "watch",
        sourceRefs: [
          sourceRef({
            kind: "supply-exception",
            id: exception.id,
            projectId: exception.projectId,
            label: exception.title,
            route: "supply-exception",
            targetId: exception.id,
          }),
        ],
        dueAt: exception.dueAt,
      });
    }
    for (const risk of supplierRisks.slice(0, 8)) {
      items.push({
        id: `supplier:${risk.id}:brief`,
        section: "exception",
        title: `${risk.supplierName} · ${risk.riskType}`,
        body: risk.suggestedAction || `风险评分 ${risk.riskScore}`,
        severity: risk.riskScore >= 70 ? "risk" : "watch",
        sourceRefs: [
          sourceRef({
            kind: "supplier-risk",
            id: risk.id,
            projectId: risk.projectId,
            label: risk.supplierName,
            route: "supplier-risk",
            targetId: risk.id,
          }),
        ],
      });
    }
    if (items.length === 0) {
      items.push({
        id: "empty",
        section: "conclusion",
        title: "当前周期没有新增简报",
        body: "项目日报、任务、会议、运行和风险数据均无新增。",
        severity: "info",
        sourceRefs: [],
      });
    }
    return {
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      items,
      sourceCount: items.reduce(
        (count, item) => count + item.sourceRefs.length,
        0,
      ),
    };
  }

  private async listTodos(
    projectIds: readonly string[],
  ): Promise<WorkbenchTodo[]> {
    if (projectIds.length === 0) return [];
    const result = await this.database.query<TaskFactRow>(
      `SELECT
         task.id, task.project_id, project.name AS project_name,
         task.title, task.status, task.updated_at
       FROM tasks AS task
       JOIN projects AS project ON project.id = task.project_id
       WHERE task.project_id = ANY($1::uuid[])
         AND project.status = 'active'
         AND task.status IN ('queued', 'in_progress', 'review')
       ORDER BY
         CASE task.status WHEN 'review' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
         task.updated_at,
         task.id
       LIMIT 100`,
      [[...projectIds]],
    );
    return result.rows.map((row) => ({
      taskId: row.id,
      projectId: row.project_id,
      projectName: row.project_name,
      title: row.title,
      status: row.status,
      priority:
        row.status === "review"
          ? "P1"
          : row.status === "in_progress"
            ? "P2"
            : "P3",
      dueAt: null,
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  private async listFocus(
    actorId: string,
    projectIds: readonly string[],
  ): Promise<WorkbenchFocusItem[]> {
    if (projectIds.length === 0) return [];
    const follows = await this.listFollows(actorId);
    const directTasks = new Set(
      follows
        .filter((follow) => follow.targetType === "task")
        .map((follow) => follow.targetId),
    );
    const directWorkflows = new Set(
      follows
        .filter((follow) => follow.targetType === "workflow")
        .map((follow) => follow.targetId),
    );
    const directProjects = new Set(
      follows
        .filter((follow) => follow.targetType === "project")
        .map((follow) => follow.targetId),
    );
    const tasks = await this.database.query<TaskFactRow>(
      `SELECT
         task.id, task.project_id, project.name AS project_name,
         task.title, task.status, task.updated_at
       FROM tasks AS task
       JOIN projects AS project ON project.id = task.project_id
       WHERE task.project_id = ANY($1::uuid[])
         AND task.status <> 'cancelled'
         AND (
           $2::uuid[] = '{}'::uuid[]
           OR task.id = ANY($2::uuid[])
           OR task.project_id = ANY($3::uuid[])
           OR EXISTS (
             SELECT 1
             FROM runs AS run
             WHERE run.task_id = task.id
               AND run.workflow_instance_id = ANY($4::uuid[])
           )
         )
       ORDER BY task.updated_at DESC, task.id`,
      [
        [...projectIds],
        [...directTasks],
        [...directProjects],
        [...directWorkflows],
      ],
    );
    const workflows = await this.database.query<WorkflowFactRow>(
      `SELECT
         instance.id, instance.project_id, project.name AS project_name,
         instance.title, instance.status, instance.failure_reason,
         instance.updated_at
       FROM workflow_instances AS instance
       JOIN projects AS project ON project.id = instance.project_id
       WHERE instance.project_id = ANY($1::uuid[])
         AND (
           $2::uuid[] = '{}'::uuid[]
           OR instance.id = ANY($2::uuid[])
           OR instance.project_id = ANY($3::uuid[])
         )
       ORDER BY instance.updated_at DESC, instance.id`,
      [[...projectIds], [...directWorkflows], [...directProjects]],
    );
    const items: WorkbenchFocusItem[] = [];
    for (const task of tasks.rows) {
      const direct = directTasks.has(task.id);
      const workflowInherited = await this.taskHasFollowedWorkflow(
        task.id,
        directWorkflows,
      );
      const projectInherited = directProjects.has(task.project_id);
      if (!direct && !workflowInherited && !projectInherited) continue;
      const followPriority = direct
        ? BRIEF_SOURCE_PRIORITY.task
        : workflowInherited
          ? BRIEF_SOURCE_PRIORITY.workflow
          : BRIEF_SOURCE_PRIORITY.project;
      items.push({
        type: "task",
        id: task.id,
        projectId: task.project_id,
        projectName: task.project_name,
        title: task.title,
        status: task.status,
        followPriority,
        directFollow: direct,
        followReason: direct
          ? "直接关注任务"
          : workflowInherited
            ? "所属工作流已关注"
            : "所属项目已关注",
        sourceRoute: "task",
        updatedAt: task.updated_at.toISOString(),
      });
    }
    for (const workflow of workflows.rows) {
      const direct = directWorkflows.has(workflow.id);
      const projectInherited = directProjects.has(workflow.project_id);
      if (!direct && !projectInherited) continue;
      items.push({
        type: "workflow",
        id: workflow.id,
        projectId: workflow.project_id,
        projectName: workflow.project_name,
        title: workflow.title,
        status: workflow.status,
        followPriority: direct
          ? BRIEF_SOURCE_PRIORITY["direct-workflow"]
          : BRIEF_SOURCE_PRIORITY.project,
        directFollow: direct,
        followReason: direct ? "直接关注工作流" : "所属项目已关注",
        sourceRoute: "workflow",
        updatedAt: workflow.updated_at.toISOString(),
      });
    }
    return items
      .sort(
        (left, right) =>
          right.followPriority - left.followPriority ||
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.id.localeCompare(right.id),
      )
      .slice(0, 50);
  }

  private async taskHasFollowedWorkflow(
    taskId: string,
    workflowIds: ReadonlySet<string>,
  ): Promise<boolean> {
    if (workflowIds.size === 0) return false;
    const result = await this.database.query(
      `SELECT 1 FROM runs
       WHERE task_id = $1
         AND workflow_instance_id = ANY($2::uuid[])
       LIMIT 1`,
      [taskId, [...workflowIds]],
    );
    return result.rowCount === 1;
  }

  private async listMeetingConclusions(
    projectIds: readonly string[],
  ): Promise<WorkbenchMeetingConclusion[]> {
    if (projectIds.length === 0) return [];
    const result = await this.database.query<MeetingFactRow>(
      `SELECT
         version.id AS version_id, version.meeting_id, version.project_id,
         project.name AS project_name, meeting.title, version.content,
         version.decisions, version.published_at
       FROM meeting_minutes_versions AS version
       JOIN meetings AS meeting ON meeting.id = version.meeting_id
       JOIN projects AS project ON project.id = version.project_id
       WHERE version.project_id = ANY($1::uuid[])
         AND version.version = (
           SELECT MAX(latest.version)
           FROM meeting_minutes_versions AS latest
           WHERE latest.meeting_id = version.meeting_id
         )
       ORDER BY version.published_at DESC, version.id
       LIMIT 20`,
      [[...projectIds]],
    );
    return result.rows.map((row) => ({
      meetingId: row.meeting_id,
      projectId: row.project_id,
      projectName: row.project_name,
      title: row.title,
      conclusion: row.content,
      decisions: row.decisions,
      generatedAt: row.published_at.toISOString(),
    }));
  }

  private async listRunExceptions(
    projectIds: readonly string[],
  ): Promise<WorkbenchRunException[]> {
    if (projectIds.length === 0) return [];
    const result = await this.database.query<RunFactRow>(
      `SELECT
         run.id, run.task_id, run.project_id, project.name AS project_name,
         task.title, run.status, run.error, run.updated_at
       FROM runs AS run
       JOIN tasks AS task ON task.id = run.task_id
       JOIN projects AS project ON project.id = run.project_id
       WHERE run.project_id = ANY($1::uuid[])
         AND run.status IN ('failed', 'timeout', 'interrupted')
       ORDER BY run.updated_at DESC, run.id
       LIMIT 20`,
      [[...projectIds]],
    );
    return result.rows.map((row) => ({
      runId: row.id,
      taskId: row.task_id,
      projectId: row.project_id,
      projectName: row.project_name,
      title: row.title,
      status: row.status,
      error: row.error,
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  private async listLatestProjectReports(
    projectIds: readonly string[],
    actorId: string,
  ): Promise<ProjectReportSummary[]> {
    if (projectIds.length === 0) return [];
    const result = await this.database.query<ProjectReportRow>(
      `SELECT
         report.*,
         project.name AS project_name,
         (read.actor_id IS NOT NULL) AS read,
         TRUE AS latest
       FROM project_reports AS report
       JOIN projects AS project ON project.id = report.project_id
       LEFT JOIN project_report_reads AS read
         ON read.report_id = report.id
        AND read.actor_id = $2
       WHERE report.project_id = ANY($1::uuid[])
         AND report.version = (
           SELECT MAX(latest.version)
           FROM project_reports AS latest
           WHERE latest.project_id = report.project_id
             AND latest.report_date = report.report_date
         )
       ORDER BY report.report_date DESC, report.generated_at DESC
       LIMIT 30`,
      [[...projectIds], actorId],
    );
    return result.rows.map((row) => ({
      ...reportSummary(row),
      canGenerate: false,
      readOnly: false,
    }));
  }

  private async resolveSourceAvailability(
    projectId: string,
    sources: readonly WorkbenchSourceRef[],
  ): Promise<WorkbenchSourceRef[]> {
    const available = new Set<string>();
    for (const kind of new Set(sources.map((source) => source.kind))) {
      const ids = sources
        .filter((source) => source.kind === kind)
        .map((source) => source.id);
      const sql = sourceAvailabilitySql(kind);
      if (sql === undefined || ids.length === 0) continue;
      const result = await this.database.query<{ id: string }>(sql, [
        projectId,
        ids,
      ]);
      for (const row of result.rows) available.add(`${kind}:${row.id}`);
    }
    return sources.map((source) => ({
      ...source,
      available: available.has(`${source.kind}:${source.id}`),
    }));
  }
}

function sourceAvailabilitySql(kind: WorkbenchSourceKind): string | undefined {
  switch (kind) {
    case "task":
      return `SELECT id::text AS id FROM tasks
              WHERE project_id = $1 AND id::text = ANY($2::text[])`;
    case "run":
      return `SELECT id::text AS id FROM runs
              WHERE project_id = $1 AND id::text = ANY($2::text[])`;
    case "review":
      return `SELECT review.id::text AS id
              FROM task_reviews AS review
              JOIN tasks AS task ON task.id = review.task_id
              WHERE task.project_id = $1 AND review.id::text = ANY($2::text[])`;
    case "workflow":
      return `SELECT id::text AS id FROM workflow_instances
              WHERE project_id = $1 AND id::text = ANY($2::text[])`;
    case "meeting":
      return `SELECT id::text AS id FROM meetings
              WHERE project_id = $1 AND id::text = ANY($2::text[])`;
    case "minutes-version":
      return `SELECT id::text AS id FROM meeting_minutes_versions
              WHERE project_id = $1 AND id::text = ANY($2::text[])`;
    case "action-item":
      return `SELECT id::text AS id FROM meeting_action_items
              WHERE project_id = $1 AND id::text = ANY($2::text[])`;
    case "memory-topic":
      return `SELECT id::text AS id FROM memory_topics
              WHERE project_id = $1 AND id::text = ANY($2::text[])`;
    case "memory-truth":
      return `SELECT id::text AS id FROM memory_truths
              WHERE project_id = $1 AND id::text = ANY($2::text[])`;
    case "supply-exception":
      return `SELECT id::text AS id FROM supply_exceptions
              WHERE project_id = $1 AND id::text = ANY($2::text[])`;
    case "supplier-risk":
      return `SELECT id::text AS id FROM supplier_risks
              WHERE project_id = $1 AND id::text = ANY($2::text[])`;
    case "project":
      return `SELECT id::text AS id FROM projects
              WHERE id = $1 AND id::text = ANY($2::text[])`;
  }
}

function briefFromRow(row: BriefRow): WorkbenchBrief {
  return {
    id: row.id,
    actorId: row.actor_id,
    briefDate: dateOnly(row.brief_date),
    version: row.version,
    generatedAt: row.generated_at.toISOString(),
    read: row.read,
    snapshot: row.snapshot,
  };
}

function dateOnly(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function settingsFromRow(row: BriefSettingsRow): WorkbenchBriefSettings {
  return {
    actorId: row.actor_id,
    frequency: row.frequency,
    silentStart: row.silent_start,
    silentEnd: row.silent_end,
    updatedAt: row.updated_at.toISOString(),
  };
}

function supplyExceptionFromRow(row: SupplyExceptionRow): SupplyException {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    severity: row.severity,
    suggestedAction: row.suggested_action,
    ownerActorId: row.owner_actor_id,
    dueAt: row.due_at?.toISOString() ?? null,
    impactScope: row.impact_scope,
    sourceTaskId: row.source_task_id,
    sourceWorkflowInstanceId: row.source_workflow_instance_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function supplierRiskFromRow(row: SupplierRiskRow): SupplierRisk {
  return {
    id: row.id,
    projectId: row.project_id,
    supplierName: row.supplier_name,
    riskType: row.risk_type,
    riskScore: Number(row.risk_score),
    commitmentRate:
      row.commitment_rate === null ? null : Number(row.commitment_rate),
    qualityMetric: row.quality_metric,
    purchaseShare:
      row.purchase_share === null ? null : Number(row.purchase_share),
    suggestedAction: row.suggested_action,
    status: row.status,
    sourceNote: row.source_note,
    dataUpdatedAt: row.data_updated_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
