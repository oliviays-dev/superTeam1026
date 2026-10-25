import { z } from "zod";

export const isoTimeSchema = z.string().datetime({ precision: 3 });
export const idSchema = z.string().trim().min(1).max(200);

export const followTypeSchema = z.enum([
  "task",
  "workflow",
  "meeting",
  "project",
]);

export const followRecordSchema = z.object({
  userId: idSchema,
  type: followTypeSchema,
  targetId: idSchema,
  createdAt: isoTimeSchema,
});

export type FollowRecord = z.infer<typeof followRecordSchema>;
export type FollowType = z.infer<typeof followTypeSchema>;

export const metricsPreferenceSchema = z.object({
  userId: idSchema,
  selected: z.array(z.string().trim().min(1).max(80)).min(1).max(5),
  updatedAt: isoTimeSchema,
});

export type MetricsPreference = z.infer<typeof metricsPreferenceSchema>;

export const briefSectionSchema = z.enum(["risk", "escalation", "conclusion"]);
export const briefTagSchema = z.enum([
  "progress",
  "data",
  "conclusion",
  "decision",
  /** 「待我验收」：条目生命周期是「任务已交付、等责任人验收」，与操作按钮一一对应。 */
  "review",
  /** 「被催办」：派出方催过我，条目属于 escalation，但标签要说清是催办。 */
  "nudge",
]);
export const briefReadViaSchema = z.enum([
  "click",
  "downstream_action",
  "condition_gone",
]);
export const briefLinkRouteSchema = z.enum(["task", "workflow", "meeting"]);

export const briefDeepLinkSchema = z.object({
  route: briefLinkRouteSchema,
  refId: idSchema,
  workspaceId: idSchema.optional(),
  label: z.string().trim().max(200).default(""),
});

export type BriefDeepLink = z.infer<typeof briefDeepLinkSchema>;

export const briefConditionSchema = z.object({
  kind: z.enum([
    "run-terminal",
    "workflow-blocked",
    "workflow-approval",
    "task-escalation",
    "task-review",
  ]),
  refId: idSchema,
  auxId: idSchema.optional(),
});

export type BriefCondition = z.infer<typeof briefConditionSchema>;

export const briefItemRecordSchema = z.object({
  readerId: idSchema,
  itemId: z.string().trim().min(1).max(320),
  section: briefSectionSchema,
  tag: briefTagSchema,
  title: z.string().trim().min(1).max(300),
  conclusion: z.string().trim().min(1).max(4_000),
  /**
   * 为什么该条目出现在简报里：触发规则 + 来源范围 + 时间窗口。
   * 默认空串以兼容历史记录（旧条目没有该字段）。
   */
  reason: z.string().trim().max(400).default(""),
  executorName: z.string().trim().max(200).default(""),
  executorRole: z.string().trim().max(200).default(""),
  sourceDomain: z.enum(["task", "workflow", "agent-run"]),
  sourceId: idSchema,
  statusLabel: z.string().trim().max(160).default(""),
  actionLabel: z.string().trim().max(80).default("查看明细"),
  escalateReason: z.string().trim().max(200).optional(),
  suggestion: z
    .object({
      headline: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(1_200),
    })
    .optional(),
  readState: z.enum(["unread", "read"]).default("unread"),
  readAt: isoTimeSchema.optional(),
  readVia: briefReadViaSchema.optional(),
  priorityScore: z.number().int().min(0).max(20),
  occurredAt: isoTimeSchema,
  deadline: z.string().trim().max(80).optional(),
  deepLink: briefDeepLinkSchema,
  workspaceId: idSchema,
  workspaceName: z.string().trim().max(200).default(""),
  condition: briefConditionSchema,
  resolved: z.boolean().default(false),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});

export type BriefItemRecord = z.infer<typeof briefItemRecordSchema>;

export const briefReaderSchema = z.object({
  readerId: idSchema,
  lastMergeAt: isoTimeSchema.optional(),
  lastSeenAt: isoTimeSchema.optional(),
  briefMode: z.enum(["lastLeave", "manual"]).optional(),
  manualWindowFrom: isoTimeSchema.optional(),
  updatedAt: isoTimeSchema,
});

export type BriefReader = z.infer<typeof briefReaderSchema>;

export const briefItemKey = (readerId: string, itemId: string): string =>
  `${readerId}\u0000${itemId}`;

export const followKey = (
  userId: string,
  type: FollowType,
  targetId: string,
): string => `${userId}\u0000${type}\u0000${targetId}`;

export const workbenchDomainSpec = {
  name: "collab_workbench",
  version: 1,
  tables: {
    follows: { valueSchema: followRecordSchema },
    metrics: { valueSchema: metricsPreferenceSchema },
    brief_items: { valueSchema: briefItemRecordSchema },
    brief_readers: { valueSchema: briefReaderSchema },
  },
} as const;
