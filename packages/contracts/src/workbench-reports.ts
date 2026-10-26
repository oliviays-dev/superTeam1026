import { z } from "zod";
import { taskStatusSchema } from "./platform.js";

export const reportDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date");
export type ReportDate = z.infer<typeof reportDateSchema>;

export const workbenchSourceKindSchema = z.enum([
  "project",
  "task",
  "run",
  "review",
  "workflow",
  "meeting",
  "minutes-version",
  "action-item",
  "memory-topic",
  "memory-truth",
  "supply-exception",
  "supplier-risk",
]);
export type WorkbenchSourceKind = z.infer<typeof workbenchSourceKindSchema>;

export const workbenchSourceRouteSchema = z.enum([
  "project",
  "task",
  "run",
  "review",
  "workflow",
  "meeting",
  "memory",
  "report",
  "supply-exception",
  "supplier-risk",
]);
export type WorkbenchSourceRoute = z.infer<typeof workbenchSourceRouteSchema>;

export const workbenchSourceRefSchema = z.object({
  kind: workbenchSourceKindSchema,
  id: z.string().min(1).max(180),
  projectId: z.string().uuid(),
  label: z.string().max(500),
  route: workbenchSourceRouteSchema,
  targetId: z.string().min(1).max(180),
  available: z.boolean().default(true),
});
export type WorkbenchSourceRef = z.infer<typeof workbenchSourceRefSchema>;

export const projectReportSectionSchema = z.enum([
  "conclusion",
  "progress",
  "risk",
  "next-step",
]);
export type ProjectReportSection = z.infer<typeof projectReportSectionSchema>;

export const projectReportItemSchema = z.object({
  id: z.string().trim().min(1).max(240),
  section: projectReportSectionSchema,
  text: z.string().trim().min(1).max(8_000),
  sourceRefs: z.array(workbenchSourceRefSchema).max(50),
});
export type ProjectReportItem = z.infer<typeof projectReportItemSchema>;

export const projectReportCountsSchema = z.object({
  tasks: z.number().int().nonnegative(),
  runs: z.number().int().nonnegative(),
  reviews: z.number().int().nonnegative(),
  workflows: z.number().int().nonnegative(),
  meetings: z.number().int().nonnegative(),
  actionItems: z.number().int().nonnegative(),
  memory: z.number().int().nonnegative(),
});
export type ProjectReportCounts = z.infer<typeof projectReportCountsSchema>;

export const projectReportSnapshotSchema = z.object({
  projectName: z.string(),
  projectCode: z.string(),
  periodStart: z.string().datetime({ offset: true }),
  periodEnd: z.string().datetime({ offset: true }),
  counts: projectReportCountsSchema,
  items: z.array(projectReportItemSchema).max(500),
});
export type ProjectReportSnapshot = z.infer<typeof projectReportSnapshotSchema>;

export const projectReportSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  projectName: z.string(),
  reportDate: reportDateSchema,
  version: z.number().int().positive(),
  generatedAt: z.string().datetime({ offset: true }),
  generatedBy: z.string(),
  read: z.boolean(),
  readOnly: z.boolean(),
  canGenerate: z.boolean(),
  latest: z.boolean(),
});
export type ProjectReportSummary = z.infer<typeof projectReportSummarySchema>;

export const projectReportDetailSchema = projectReportSummarySchema.extend({
  snapshot: projectReportSnapshotSchema,
  sources: z.array(workbenchSourceRefSchema),
});
export type ProjectReportDetail = z.infer<typeof projectReportDetailSchema>;

export const projectReportGenerationResultSchema = z.object({
  report: projectReportDetailSchema,
  created: z.boolean(),
  reused: z.boolean(),
});
export type ProjectReportGenerationResult = z.infer<
  typeof projectReportGenerationResultSchema
>;

export const generateProjectReportInputSchema = z.object({
  reportDate: reportDateSchema.optional(),
});
export type GenerateProjectReportInput = z.infer<
  typeof generateProjectReportInputSchema
>;

export const projectReportQuerySchema = z.object({
  from: reportDateSchema.optional(),
  to: reportDateSchema.optional(),
  query: z.string().trim().max(200).optional(),
});
export type ProjectReportQuery = z.infer<typeof projectReportQuerySchema>;

export const markReportReadInputSchema = z.object({
  read: z.boolean().default(true),
});
export type MarkReportReadInput = z.infer<typeof markReportReadInputSchema>;

export const workbenchBriefSectionSchema = z.enum([
  "progress",
  "exception",
  "conclusion",
  "decision",
]);
export type WorkbenchBriefSection = z.infer<typeof workbenchBriefSectionSchema>;

export const workbenchBriefItemSchema = z.object({
  id: z.string().trim().min(1).max(240),
  section: workbenchBriefSectionSchema,
  title: z.string().trim().min(1).max(500),
  body: z.string().trim().max(8_000),
  severity: z.enum(["info", "watch", "risk"]).default("info"),
  sourceRefs: z.array(workbenchSourceRefSchema).max(50),
  aiSuggestion: z.string().trim().max(4_000).optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
});
export type WorkbenchBriefItem = z.infer<typeof workbenchBriefItemSchema>;

export const workbenchBriefSnapshotSchema = z.object({
  periodStart: z.string().datetime({ offset: true }),
  periodEnd: z.string().datetime({ offset: true }),
  items: z.array(workbenchBriefItemSchema).max(500),
  sourceCount: z.number().int().nonnegative(),
});
export type WorkbenchBriefSnapshot = z.infer<
  typeof workbenchBriefSnapshotSchema
>;

export const workbenchBriefSchema = z.object({
  id: z.string().uuid(),
  actorId: z.string(),
  briefDate: reportDateSchema,
  version: z.number().int().positive(),
  generatedAt: z.string().datetime({ offset: true }),
  read: z.boolean(),
  snapshot: workbenchBriefSnapshotSchema,
});
export type WorkbenchBrief = z.infer<typeof workbenchBriefSchema>;

export const workbenchBriefGenerationResultSchema = z.object({
  brief: workbenchBriefSchema,
  created: z.boolean(),
  reused: z.boolean(),
});
export type WorkbenchBriefGenerationResult = z.infer<
  typeof workbenchBriefGenerationResultSchema
>;

export const refreshWorkbenchBriefInputSchema = z.object({
  briefDate: reportDateSchema.optional(),
});
export type RefreshWorkbenchBriefInput = z.infer<
  typeof refreshWorkbenchBriefInputSchema
>;

export const workbenchBriefFrequencySchema = z.enum([
  "daily-0800",
  "daily-0800-1300",
  "every-4-hours",
  "weekly-monday-0800",
]);
export type WorkbenchBriefFrequency = z.infer<
  typeof workbenchBriefFrequencySchema
>;

export const workbenchBriefSettingsSchema = z.object({
  actorId: z.string(),
  frequency: workbenchBriefFrequencySchema,
  silentStart: z.string().nullable(),
  silentEnd: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type WorkbenchBriefSettings = z.infer<
  typeof workbenchBriefSettingsSchema
>;

export const updateWorkbenchBriefSettingsInputSchema = z
  .object({
    frequency: workbenchBriefFrequencySchema,
    silentStart: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
    silentEnd: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
  })
  .superRefine((input, context) => {
    if ((input.silentStart === null) !== (input.silentEnd === null)) {
      context.addIssue({
        code: "custom",
        path: ["silentEnd"],
        message: "silentStart and silentEnd must be set together",
      });
    }
  });
export type UpdateWorkbenchBriefSettingsInput = z.infer<
  typeof updateWorkbenchBriefSettingsInputSchema
>;

export const followTargetTypeSchema = z.enum([
  "task",
  "workflow",
  "project",
  "meeting",
]);
export type FollowTargetType = z.infer<typeof followTargetTypeSchema>;

export const workbenchFollowSchema = z.object({
  actorId: z.string(),
  targetType: followTargetTypeSchema,
  targetId: z.string().uuid(),
  projectId: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
});
export type WorkbenchFollow = z.infer<typeof workbenchFollowSchema>;

export const setWorkbenchFollowInputSchema = z.object({
  targetType: followTargetTypeSchema,
  targetId: z.string().uuid(),
  projectId: z.string().uuid(),
  followed: z.boolean(),
});
export type SetWorkbenchFollowInput = z.infer<
  typeof setWorkbenchFollowInputSchema
>;

export const workbenchTodoSchema = z.object({
  taskId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectName: z.string(),
  title: z.string(),
  status: taskStatusSchema,
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  dueAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type WorkbenchTodo = z.infer<typeof workbenchTodoSchema>;

export const workbenchFocusItemSchema = z.object({
  type: z.enum(["task", "workflow"]),
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  projectName: z.string(),
  title: z.string(),
  status: z.string(),
  followPriority: z.number().int().min(1).max(5),
  directFollow: z.boolean(),
  followReason: z.string(),
  sourceRoute: z.enum(["task", "workflow"]),
  updatedAt: z.string().datetime({ offset: true }),
});
export type WorkbenchFocusItem = z.infer<typeof workbenchFocusItemSchema>;

export const workbenchMeetingConclusionSchema = z.object({
  meetingId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectName: z.string(),
  title: z.string(),
  conclusion: z.string(),
  decisions: z.array(z.string()),
  generatedAt: z.string().datetime({ offset: true }),
});
export type WorkbenchMeetingConclusion = z.infer<
  typeof workbenchMeetingConclusionSchema
>;

export const workbenchRunExceptionSchema = z.object({
  runId: z.string().uuid(),
  taskId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectName: z.string(),
  title: z.string(),
  status: z.string(),
  error: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type WorkbenchRunException = z.infer<typeof workbenchRunExceptionSchema>;

export const supplyExceptionSeveritySchema = z.enum([
  "high",
  "medium",
  "watch",
]);
export type SupplyExceptionSeverity = z.infer<
  typeof supplyExceptionSeveritySchema
>;

export const supplyExceptionStatusSchema = z.enum([
  "open",
  "acknowledged",
  "resolved",
]);
export type SupplyExceptionStatus = z.infer<typeof supplyExceptionStatusSchema>;

export const supplyExceptionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string(),
  severity: supplyExceptionSeveritySchema,
  suggestedAction: z.string(),
  ownerActorId: z.string(),
  dueAt: z.string().datetime({ offset: true }).nullable(),
  impactScope: z.string(),
  sourceTaskId: z.string().uuid().nullable(),
  sourceWorkflowInstanceId: z.string().uuid().nullable(),
  status: supplyExceptionStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type SupplyException = z.infer<typeof supplyExceptionSchema>;

export const createSupplyExceptionInputSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().trim().min(1).max(500),
  severity: supplyExceptionSeveritySchema,
  suggestedAction: z.string().trim().max(4_000).default(""),
  ownerActorId: z.string().trim().min(1).max(180),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
  impactScope: z.string().trim().max(2_000).default(""),
  sourceTaskId: z.string().uuid().nullable().optional(),
  sourceWorkflowInstanceId: z.string().uuid().nullable().optional(),
  status: supplyExceptionStatusSchema.default("open"),
});
export type CreateSupplyExceptionInput = z.infer<
  typeof createSupplyExceptionInputSchema
>;

export const supplierRiskStatusSchema = z.enum([
  "open",
  "monitoring",
  "closed",
]);
export type SupplierRiskStatus = z.infer<typeof supplierRiskStatusSchema>;

export const supplierRiskSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  supplierName: z.string(),
  riskType: z.string(),
  riskScore: z.number().int().min(0).max(100),
  commitmentRate: z.number().min(0).max(100).nullable(),
  qualityMetric: z.string(),
  purchaseShare: z.number().min(0).max(100).nullable(),
  suggestedAction: z.string(),
  status: supplierRiskStatusSchema,
  sourceNote: z.string(),
  dataUpdatedAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type SupplierRisk = z.infer<typeof supplierRiskSchema>;

export const createSupplierRiskInputSchema = z.object({
  projectId: z.string().uuid(),
  supplierName: z.string().trim().min(1).max(300),
  riskType: z.string().trim().min(1).max(200),
  riskScore: z.number().int().min(0).max(100),
  commitmentRate: z.number().min(0).max(100).nullable().optional(),
  qualityMetric: z.string().trim().max(2_000).default(""),
  purchaseShare: z.number().min(0).max(100).nullable().optional(),
  suggestedAction: z.string().trim().max(4_000).default(""),
  status: supplierRiskStatusSchema.default("monitoring"),
  sourceNote: z.string().trim().max(2_000).default(""),
});
export type CreateSupplierRiskInput = z.infer<
  typeof createSupplierRiskInputSchema
>;

export const workbenchDashboardSchema = z.object({
  actorId: z.string(),
  generatedAt: z.string().datetime({ offset: true }),
  canManage: z.boolean(),
  readOnly: z.boolean(),
  brief: workbenchBriefSchema.nullable(),
  settings: workbenchBriefSettingsSchema,
  todos: z.array(workbenchTodoSchema),
  focus: z.array(workbenchFocusItemSchema),
  meetingConclusions: z.array(workbenchMeetingConclusionSchema),
  runExceptions: z.array(workbenchRunExceptionSchema),
  projectReports: z.array(projectReportSummarySchema),
  supplyExceptions: z.array(supplyExceptionSchema),
  supplierRisks: z.array(supplierRiskSchema),
});
export type WorkbenchDashboard = z.infer<typeof workbenchDashboardSchema>;
