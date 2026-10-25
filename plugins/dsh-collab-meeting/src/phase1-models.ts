import { z } from "zod";
import { displayNameSchema, idSchema, isoTimeSchema } from "./shared.js";

/**
 * Phase 1 additions to the `collab_meeting` domain.
 *
 * The domain uses the `single` layout, so its stored `version` must stay at 1:
 * bumping it would reject every existing file at open. Instead this module
 * only *adds tables* and the existing record schemas only *gain optional or
 * defaulted fields*, which the single layout tolerates for older files.
 */

export const FACILITATOR_STATES = ["active", "inactive", "replaced"] as const;
export const MINUTES_VERSION_STATES = [
  "generating",
  "pending_confirm",
  "confirmed",
  "superseded",
  "failed",
] as const;
export const MINUTES_TRIGGERS = [
  "manual",
  "close_auto",
  "post_close_manual",
] as const;
export const MINUTES_ORIGINS = ["generated", "edited"] as const;
export const DELEGATE_STATES = [
  "pending",
  "active",
  "paused",
  "revoked",
  "completed",
] as const;
export const SPEECH_MODES = [
  "observe",
  "mention",
  "key_topic",
  "active",
] as const;

export const facilitatorStateSchema = z.enum(FACILITATOR_STATES);
export const minutesVersionStateSchema = z.enum(MINUTES_VERSION_STATES);
export const minutesTriggerSchema = z.enum(MINUTES_TRIGGERS);
export const minutesOriginSchema = z.enum(MINUTES_ORIGINS);
export const delegateStateSchema = z.enum(DELEGATE_STATES);
export const speechModeSchema = z.enum(SPEECH_MODES);

export const facilitatorSchema = z.object({
  id: idSchema,
  meetingId: idSchema,
  status: facilitatorStateSchema,
  createdBy: idSchema,
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
  deactivatedAt: isoTimeSchema.optional(),
  deactivatedBy: idSchema.optional(),
  replacedById: idSchema.optional(),
  /** Versioned, bounded runtime profile for reproducible minutes runs. */
  promptVersion: z.string().trim().min(1).max(80).default("v1"),
});

export const meetingMinutesSchema = z.object({
  meetingId: idSchema,
  currentVersion: z.number().int().nonnegative().default(0),
  activeVersion: z.number().int().positive().optional(),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});

export const minutesSourceRefsSchema = z.object({
  messageSeqs: z.array(z.number().int().nonnegative()).max(10_000).default([]),
  attachmentIds: z.array(idSchema).max(1_000).default([]),
});

export const minuteVersionSchema = z.object({
  id: idSchema,
  meetingId: idSchema,
  version: z.number().int().positive(),
  content: z.string().max(400_000).default(""),
  trigger: minutesTriggerSchema,
  origin: minutesOriginSchema.default("generated"),
  requestedBy: idSchema,
  requestedAt: isoTimeSchema,
  facilitatorId: idSchema.optional(),
  runId: idSchema.optional(),
  status: minutesVersionStateSchema,
  error: z.string().trim().max(500).optional(),
  sourceRefs: minutesSourceRefsSchema.default({
    messageSeqs: [],
    attachmentIds: [],
  }),
  confirmedBy: idSchema.optional(),
  confirmedAt: isoTimeSchema.optional(),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});

export const delegateSchema = z.object({
  id: idSchema,
  meetingId: idSchema,
  principalUserId: idSchema,
  principalName: displayNameSchema,
  teammateInstanceId: idSchema,
  employeeId: idSchema.optional(),
  status: delegateStateSchema,
  speechMode: speechModeSchema.default("mention"),
  participantId: idSchema.optional(),
  reportId: idSchema.optional(),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
  completedAt: isoTimeSchema.optional(),
});

/**
 * Private commission text. Stored apart from `delegates` so the public binding
 * projection can never leak the principal's stance by accident.
 */
export const delegateInstructionSchema = z.object({
  delegateId: idSchema,
  goal: z.string().trim().max(4_000).default(""),
  stance: z.string().trim().max(4_000).default(""),
  mustSay: z.array(z.string().trim().max(1_000)).max(100).default([]),
  focusPoints: z.array(z.string().trim().max(1_000)).max(100).default([]),
  outputs: z.array(z.string().trim().max(1_000)).max(100).default([]),
  controlPoints: z.array(z.string().trim().max(1_000)).max(100).default([]),
  speechPolicy: z.string().trim().max(2_000).default(""),
  behavior: z.string().trim().max(2_000).default(""),
  informationBoundary: z.string().trim().max(2_000).default(""),
  permissionBoundary: z.string().trim().max(2_000).default(""),
  reportPlan: z.string().trim().max(2_000).default(""),
  updatedAt: isoTimeSchema,
});

export const meetingReadSchema = z.object({
  meetingId: idSchema,
  userId: idSchema,
  lastReadSeq: z.number().int().nonnegative().default(0),
  updatedAt: isoTimeSchema,
});

/** A file shared into a meeting. Bytes are capped and stored inline (base64). */
export const MAX_MEETING_FILE_BYTES = 512 * 1024;
export const meetingFileSchema = z.object({
  id: idSchema,
  meetingId: idSchema,
  name: z.string().trim().min(1).max(240),
  mime: z.string().trim().max(160).default(""),
  size: z.number().int().nonnegative().max(MAX_MEETING_FILE_BYTES),
  /** Base64 payload; ~4/3 of `size`. */
  data: z.string().max(800_000),
  uploadedBy: idSchema,
  createdAt: isoTimeSchema,
});

/**
 * A durable pending item (待确认事项) surfaced independently of chat. Phase 1
 * only uses `minutes_confirm`.
 */
export const meetingTaskSchema = z.object({
  id: idSchema,
  meetingId: idSchema,
  kind: z.enum(["minutes_confirm"]),
  targetId: idSchema,
  assigneeUserId: idSchema,
  status: z.enum(["pending", "done", "replaced"]),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
  doneAt: isoTimeSchema.optional(),
  doneBy: idSchema.optional(),
});

export type Facilitator = z.infer<typeof facilitatorSchema>;
export type MeetingMinutes = z.infer<typeof meetingMinutesSchema>;
export type MinuteVersion = z.infer<typeof minuteVersionSchema>;
export type MinutesSourceRefs = z.infer<typeof minutesSourceRefsSchema>;
export type Delegate = z.infer<typeof delegateSchema>;
export type DelegateInstruction = z.infer<typeof delegateInstructionSchema>;
export type MeetingRead = z.infer<typeof meetingReadSchema>;
export type MeetingFile = z.infer<typeof meetingFileSchema>;
export type MeetingTask = z.infer<typeof meetingTaskSchema>;

/**
 * Table declarations appended to `meetingDomainSpec`. Adding tables at the
 * unchanged version 1 is safe for existing single-layout files: a table the
 * file does not contain loads as empty.
 */
export const phase1MeetingTables = {
  facilitators: {
    valueSchema: facilitatorSchema as unknown as z.ZodType<unknown>,
  },
  minutes: {
    valueSchema: meetingMinutesSchema as unknown as z.ZodType<unknown>,
  },
  minute_versions: {
    valueSchema: minuteVersionSchema as unknown as z.ZodType<unknown>,
  },
  delegates: {
    valueSchema: delegateSchema as unknown as z.ZodType<unknown>,
  },
  delegate_instructions: {
    valueSchema: delegateInstructionSchema as unknown as z.ZodType<unknown>,
  },
  meeting_reads: {
    valueSchema: meetingReadSchema as unknown as z.ZodType<unknown>,
  },
  meeting_files: {
    valueSchema: meetingFileSchema as unknown as z.ZodType<unknown>,
  },
  meeting_tasks: {
    valueSchema: meetingTaskSchema as unknown as z.ZodType<unknown>,
  },
} as const;
