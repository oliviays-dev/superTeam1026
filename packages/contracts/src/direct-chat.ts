import { z } from "zod";
import { agentSchema, runStatusSchema, type Run } from "./platform.js";
import { traceIdSchema } from "./trace.js";

export const directChatMessageSenderTypeSchema = z.enum([
  "owner",
  "agent",
  "system",
]);
export type DirectChatMessageSenderType = z.infer<
  typeof directChatMessageSenderTypeSchema
>;

export const directChatTurnStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type DirectChatTurnStatus = z.infer<typeof directChatTurnStatusSchema>;

export const directChatRunSummarySchema = z.object({
  id: z.string().uuid(),
  status: runStatusSchema,
  traceId: traceIdSchema.nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  endedAt: z.string().datetime({ offset: true }).nullable(),
});
export type DirectChatRunSummary = z.infer<typeof directChatRunSummarySchema>;

export const directChatThreadSchema = z.object({
  id: z.string().uuid(),
  ownerId: z.string(),
  agent: agentSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type DirectChatThread = z.infer<typeof directChatThreadSchema>;

export const directChatMessageSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  sequence: z.number().int().positive(),
  senderType: directChatMessageSenderTypeSchema,
  senderId: z.string(),
  senderName: z.string(),
  content: z.string(),
  clientMessageId: z.string().uuid().nullable(),
  turnId: z.string().uuid().nullable(),
  runId: z.string().uuid().nullable(),
  traceId: traceIdSchema.nullable(),
  status: z.enum(["sent", "failed", "cancelled"]),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type DirectChatMessage = z.infer<typeof directChatMessageSchema>;

export const directChatTurnSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
  agentId: z.string().uuid(),
  attempt: z.number().int().positive(),
  status: directChatTurnStatusSchema,
  run: directChatRunSummarySchema.nullable(),
  responseMessageId: z.string().uuid().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type DirectChatTurn = z.infer<typeof directChatTurnSchema>;

export const directChatThreadListItemSchema = z.object({
  threadId: z.string().uuid().nullable(),
  ownerId: z.string(),
  agent: agentSchema,
  latestMessage: directChatMessageSchema.nullable(),
  activeTurn: directChatTurnSchema.nullable(),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
});
export type DirectChatThreadListItem = z.infer<
  typeof directChatThreadListItemSchema
>;

export const directChatDetailSchema = z.object({
  thread: directChatThreadSchema,
  messages: z.array(directChatMessageSchema),
  turns: z.array(directChatTurnSchema),
});
export type DirectChatDetail = z.infer<typeof directChatDetailSchema>;

export const createDirectChatInputSchema = z.object({
  agentId: z.string().uuid(),
});
export type CreateDirectChatInput = z.infer<typeof createDirectChatInputSchema>;

export const sendDirectChatMessageInputSchema = z.object({
  content: z.string().trim().min(1).max(20_000),
  clientMessageId: z.string().uuid(),
});
export type SendDirectChatMessageInput = z.infer<
  typeof sendDirectChatMessageInputSchema
>;

export const directChatSendResultSchema = z.object({
  message: directChatMessageSchema,
  turn: directChatTurnSchema,
  run: directChatRunSummarySchema,
  replayed: z.boolean(),
});
export type DirectChatSendResult = z.infer<typeof directChatSendResultSchema>;

export type DirectChatRun = Pick<
  Run,
  "id" | "status" | "traceId" | "error" | "createdAt" | "startedAt" | "endedAt"
>;
