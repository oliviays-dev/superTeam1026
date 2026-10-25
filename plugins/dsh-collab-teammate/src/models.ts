import { z } from "zod";

export const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const idSchema = z.string().trim().regex(idPattern);
export const isoTimeSchema = z.string().datetime({ precision: 3 });
export const versionSchema = z
  .string()
  .trim()
  .regex(/^v\d+\.\d+$/)
  .max(20);

export const TEAMMATE_SOURCES = ["personal", "platform"] as const;
export const TEAMMATE_STATES = [
  "draft",
  "active",
  "paused",
  "inactive",
  "archived",
] as const;
export const TEAMMATE_EVENT_KINDS = [
  "created",
  "updated",
  "state",
  "archived",
] as const;
export const PROFILE_TEMPLATE_STATES = [
  "active",
  "disabled",
  "archived",
] as const;
export const TEAMMATE_TEMPLATE_STATES = PROFILE_TEMPLATE_STATES;

export const teammateSourceSchema = z.enum(TEAMMATE_SOURCES);
export const teammateStateSchema = z.enum(TEAMMATE_STATES);
export const teammateEventKindSchema = z.enum(TEAMMATE_EVENT_KINDS);
export const profileTemplateStateSchema = z.enum(PROFILE_TEMPLATE_STATES);
export const teammateTemplateStateSchema = z.enum(TEAMMATE_TEMPLATE_STATES);

const ruleSchema = z.string().trim().min(1).max(500);

export const teammateSchema = z.object({
  id: idSchema,
  source: teammateSourceSchema,
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(120).default(""),
  ownerUserId: idSchema,
  ownerName: z.string().trim().min(1).max(120),
  description: z.string().trim().max(4_000).default(""),
  soul: z.string().max(200_000).default(""),
  scenarios: z.array(ruleSchema).max(50).default([]),
  goals: z.array(ruleSchema).max(50).default([]),
  avatar: z.string().max(400_000).default(""),
  state: teammateStateSchema,
  version: versionSchema,
  /**
   * 所属模版（Al Teammate 定义）。迁移前的老记录允许缺失，
   * 由启动迁移补齐；模版承载平台/个人归属与定义内容。
   */
  templateId: idSchema.optional(),
  personaId: idSchema.optional(),
  employeeId: idSchema.optional(),
  principalId: z.string().trim().min(1).max(180).optional(),
  profileTemplateId: idSchema.optional(),
  execution: z.enum(["builtin", "external"]).optional(),
  externalRuntimeId: idSchema.optional(),
  createdBy: z.string().min(1).max(160),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});

/**
 * AI Teammate 模版：归属（平台/个人）与定义内容都只存在这一层。
 * 实例通过 `templateId` 引用模版，实例自身只保留 owner 与实例级覆盖。
 */
export const teammateTemplateSchema = z.object({
  id: idSchema,
  source: teammateSourceSchema,
  /** 个人模版的归属人；平台模版由管理员治理，这里留空。 */
  ownerUserId: idSchema.optional(),
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(120).default(""),
  description: z.string().trim().max(4_000).default(""),
  soul: z.string().max(200_000).default(""),
  scenarios: z.array(ruleSchema).max(50).default([]),
  goals: z.array(ruleSchema).max(50).default([]),
  tools: z.array(ruleSchema).max(100).default([]),
  state: teammateTemplateStateSchema,
  version: versionSchema,
  /**
   * 历史 persona 别名（`persona-<id>`）：roles 席位与员工 persona 仍按它引用，
   * 迁移时补齐，避免外部引用断裂。
   */
  personaAlias: idSchema.optional(),
  createdBy: z.string().min(1).max(160),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});

export const profileTemplateSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(120).default(""),
  description: z.string().trim().max(4_000).default(""),
  soul: z.string().max(200_000).default(""),
  scenarios: z.array(ruleSchema).max(50).default([]),
  goals: z.array(ruleSchema).max(50).default([]),
  tools: z.array(ruleSchema).max(100).default([]),
  state: profileTemplateStateSchema,
  version: versionSchema,
  createdBy: z.string().min(1).max(160),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});

export const teammateEventSchema = z.object({
  id: z.string().min(1).max(160),
  teammateId: idSchema,
  seq: z.number().int().nonnegative(),
  at: isoTimeSchema,
  actorUserId: z.string().min(1).max(160),
  actorName: z.string().min(1).max(160),
  kind: teammateEventKindSchema,
  message: z.string().trim().min(1).max(500),
});

export type TeammateSource = z.infer<typeof teammateSourceSchema>;
export type TeammateState = z.infer<typeof teammateStateSchema>;
export type TeammateTemplateState = z.infer<typeof teammateTemplateStateSchema>;
export type Teammate = z.infer<typeof teammateSchema>;
export type TeammateTemplate = z.infer<typeof teammateTemplateSchema>;
export type TeammateEvent = z.infer<typeof teammateEventSchema>;
export type ProfileTemplateState = z.infer<typeof profileTemplateStateSchema>;
export type ProfileTemplate = z.infer<typeof profileTemplateSchema>;

export const TEAMMATE_WORK_REPORT_AUTHOR_TYPES = ["ai-teammate"] as const;
export const TEAMMATE_AUDIT_ACTOR_TYPES = [
  "user",
  "ai-teammate",
  "system",
] as const;

export const teammateWorkReportAuthorTypeSchema = z.enum(
  TEAMMATE_WORK_REPORT_AUTHOR_TYPES,
);
export const teammateAuditActorTypeSchema = z.enum(TEAMMATE_AUDIT_ACTOR_TYPES);

export const teammateWorkReportSchema = z.object({
  id: idSchema,
  teammateId: idSchema,
  reportDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  generatedAt: isoTimeSchema,
  author: z.object({
    type: teammateWorkReportAuthorTypeSchema,
    id: idSchema,
    name: z.string().trim().min(1).max(120),
  }),
  title: z.string().trim().min(1).max(200),
  excerpt: z.string().trim().max(1_000),
  contentMarkdown: z.string().max(400_000),
  sourceRefs: z.array(z.string().min(1).max(300)).max(500).default([]),
});

export const teammateAuditEventSchema = z.object({
  id: idSchema,
  teammateId: idSchema,
  occurredAt: isoTimeSchema,
  actor: z.object({
    type: teammateAuditActorTypeSchema,
    id: z.string().min(1).max(160),
    name: z.string().trim().min(1).max(160).optional(),
  }),
  narrative: z.string().trim().min(1).max(2_000),
  refs: z
    .object({
      taskId: z.string().min(1).max(160).optional(),
      workflowRunId: z.string().min(1).max(180).optional(),
      reportId: z.string().min(1).max(180).optional(),
    })
    .optional(),
});

export type TeammateWorkReport = z.infer<typeof teammateWorkReportSchema>;
export type TeammateWorkReportAuthor = TeammateWorkReport["author"];
export type TeammateAuditEvent = z.infer<typeof teammateAuditEventSchema>;
