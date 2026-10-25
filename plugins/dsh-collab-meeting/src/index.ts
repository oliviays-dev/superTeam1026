import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  bearerToken,
  readJsonBody,
  sameOrigin,
  sendJson,
} from "@pluginmax/shared";
import {
  MeetingDelegateService,
  delegateInstructionInputSchema,
} from "./delegates.js";
import { MeetingFileService } from "./files.js";
import { MeetingReadService } from "./inbox.js";
import { MeetingMinutesService } from "./minutes.js";
import {
  MeetingMinutesRuntime,
  createAgentMinutesGenerator,
} from "./minutes-runtime.js";
import {
  type Delegate,
  type DelegateInstruction,
  type Facilitator,
  type MeetingMinutes,
  type MeetingFile,
  type MeetingRead,
  type MeetingTask,
  type MinuteVersion,
  phase1MeetingTables,
} from "./phase1-models.js";
import {
  type KvTableLike,
  MeetingError,
  displayNameSchema,
  idSchema,
  isoTimeSchema,
  nowIso,
  parseOrInvalid,
  tableValues,
} from "./shared.js";
import { MeetingTaskService } from "./tasks.js";

export { MeetingError, parseOrInvalid } from "./shared.js";
export type { KvTableLike } from "./shared.js";

export const name = "dsh-collab-meeting";
export const inject = [
  "storageDomain",
  "commands",
  "tools",
  "webServer",
  "agents",
  "agentDefaultModel",
];

export const SYSTEM_DEFAULT_WORKSPACE_ID = "system.default";
export const SYSTEM_DEFAULT_PROJECT_TITLE = "默认项目";

const titleSchema = z.string().trim().min(1).max(160);
const textSchema = z.string().trim().max(20_000);

/**
 * Participant kinds the meeting worker runtime may run and whose replies are
 * written back to the transcript. `agent` is the legacy worker kind;
 * `ai_teammate` and `ai_representative` are the phase-1 kinds.
 */
const AI_PARTICIPANT_KINDS: readonly MeetingParticipant["kind"][] = [
  "agent",
  "ai_teammate",
  "ai_representative",
];

const meetingSchema = z.object({
  id: z.string().min(1).max(160),
  workspaceId: idSchema,
  title: titleSchema,
  kind: z.enum(["meeting", "ai"]).default("meeting"),
  teammateInstanceId: idSchema.optional(),
  agenda: z.string().trim().max(20_000).default(""),
  status: z.enum(["draft", "active", "closed", "archived"]),
  createdBy: idSchema,
  /**
   * Human owner. Phase 1 keeps owner for title/agenda edits and minutes
   * confirmation only; membership, lifecycle, and facilitator operations are
   * open to any active human participant. Optional so existing records load.
   */
  ownerUserId: idSchema.optional(),
  ownerName: displayNameSchema.optional(),
  activeMinutesVersion: z.number().int().positive().optional(),
  parentSessionId: idSchema.optional(),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
  closedAt: isoTimeSchema.optional(),
  closedBy: idSchema.optional(),
  summary: textSchema.optional(),
  archivedAt: isoTimeSchema.optional(),
  archivedBy: idSchema.optional(),
});

const participantSchema = z.object({
  id: z.string().min(1).max(160),
  meetingId: z.string().min(1).max(160),
  kind: z.enum([
    "human",
    "agent",
    "ai_teammate",
    "ai_representative",
    "facilitator",
  ]),
  refId: idSchema,
  displayName: displayNameSchema,
  personaId: idSchema.optional(),
  basePersonaId: idSchema.optional(),
  ownerId: idSchema.optional(),
  ownerName: displayNameSchema.optional(),
  /** AI participant provenance: who a representative speaks for. */
  principalUserId: idSchema.optional(),
  principalName: displayNameSchema.optional(),
  /** Explicit AI Principal backing this runtime participant. */
  aiPrincipalId: idSchema.optional(),
  teammateInstanceId: idSchema.optional(),
  autoSpeak: z.enum(["all", "mentions", "manual"]).optional(),
  initialGreeting: z.boolean().optional(),
  delegationId: idSchema.optional(),
  delegationStatus: z
    .enum(["active", "paused", "revoked", "expired", "completed"])
    .optional(),
  principalType: z.enum(["direct", "delegation", "runtime"]).optional(),
  leader: z.boolean().default(false),
  status: z.enum(["pending", "active", "left"]),
  /**
   * `seat` stays in the enum only so legacy records still parse; seat-driven
   * participants are never created or read anymore.
   */
  source: z.enum(["direct", "seat", "spawned"]),
  hint: z.string().trim().max(500).optional(),
  joinedAt: isoTimeSchema.optional(),
  leftAt: isoTimeSchema.optional(),
  updatedAt: isoTimeSchema,
});

const deliverySchema = z.object({
  participantId: z.string().min(1).max(160),
  targetId: idSchema,
  status: z.enum(["pending", "delivered", "failed"]),
  at: isoTimeSchema.optional(),
  error: z.string().trim().max(500).optional(),
});

const messageSchema = z.object({
  id: z.string().min(1).max(160),
  sequence: z.number().int().positive(),
  meetingId: z.string().min(1).max(160),
  senderKind: z.enum(["human", "agent", "system"]),
  senderId: idSchema,
  senderName: displayNameSchema,
  content: textSchema,
  mentions: z.array(idSchema).default([]),
  /**
   * Attribute an AI message to its instance, delegate, and run. Optional so
   * existing human/system records load unchanged.
   */
  provenance: z
    .object({
      role: z.enum(["teammate", "representative", "facilitator"]),
      teammateInstanceId: idSchema.optional(),
      delegateId: idSchema.optional(),
      runId: idSchema.optional(),
    })
    .optional(),
  attachments: z
    .array(
      z.object({
        id: idSchema,
        name: z.string().trim().min(1).max(240),
        mime: z.string().trim().max(160).default(""),
        size: z.number().int().nonnegative().default(0),
        storageRef: z.string().trim().min(1).max(500),
      }),
    )
    .optional(),
  deliveries: z.array(deliverySchema).default([]),
  createdAt: isoTimeSchema,
});

const actorSchema = z.object({
  kind: z.enum(["user", "agent"]),
  id: idSchema,
  sessionId: idSchema.optional(),
  globalRole: z.enum(["admin", "owner", "member", "guest"]).optional(),
  workspaceRole: z.enum(["owner", "member", "guest"]).optional(),
});

export type Meeting = z.infer<typeof meetingSchema>;
export type MeetingParticipant = z.infer<typeof participantSchema>;
export type MeetingMessage = z.infer<typeof messageSchema>;
export type MeetingDelivery = z.infer<typeof deliverySchema>;
export type MeetingActor = z.infer<typeof actorSchema>;
export type MeetingTranscriptItem = MeetingMessage;

function parseMeeting(value: Meeting): Meeting {
  return parseOrInvalid(meetingSchema, value);
}

function parseParticipant(value: MeetingParticipant): MeetingParticipant {
  return parseOrInvalid(participantSchema, value);
}

function parseMessage(value: MeetingMessage): MeetingMessage {
  return parseOrInvalid(messageSchema, value);
}

/**
 * The message DSH raises for a target that can never resume.
 *
 * Kept narrow on purpose: an unrelated `… is unavailable` failure must not
 * retire a participant that is merely busy or briefly unreachable.
 */
const RETIRED_TARGET_PATTERN = /subagent\s+"[^"]*"\s+is unavailable/i;

/**
 * Reports whether a delivery failure means the target agent can never resume.
 *
 * DSH rejects a follow-up to a retired dispatch with a typed
 * `code: "NOT_RESUMABLE"` error. A recorded delivery keeps only the message
 * text, so the message shape is the fallback for evidence replayed from the
 * transcript.
 */
function isUnavailableTargetFailure(cause: unknown): boolean {
  if (cause instanceof Error) {
    if ((cause as { readonly code?: unknown }).code === "NOT_RESUMABLE")
      return true;
    return RETIRED_TARGET_PATTERN.test(cause.message);
  }
  return typeof cause === "string" && RETIRED_TARGET_PATTERN.test(cause);
}

/**
 * Participant ids a meeting already knows are dead.
 *
 * A dispatch-backed participant keeps its `dispatch-…` refId after the agent
 * that owned it retires, and nothing removes the row, so it stays `active` and
 * every later `post` re-selects it as a delivery target. Its own recorded
 * failed deliveries are the evidence that lets a later `post` skip it before
 * selecting targets instead of queueing another doomed delivery.
 */
function unavailableDeliveryParticipants(
  transcript: readonly MeetingMessage[],
): Set<string> {
  const unavailable = new Set<string>();
  for (const message of transcript) {
    for (const delivery of message.deliveries) {
      if (
        delivery.status === "failed" &&
        isUnavailableTargetFailure(delivery.error)
      ) {
        unavailable.add(delivery.participantId);
      }
    }
  }
  return unavailable;
}

/**
 * Retires every dispatch-backed participant at mount.
 *
 * A `direct` participant joined by a dispatched agent carries a `dispatch-…`
 * refId, and no dispatch outlives the process that owned it, so every such row
 * is dead as soon as a restart begins. Legacy spawned rows are also continuable
 * child ids; only rows with the runtime-owned `worker:` identity survive restart.
 */
export async function reapRestartedDispatchParticipants(
  participants: KvTableLike<MeetingParticipant>,
  now: () => Date,
): Promise<number> {
  const timestamp = nowIso(now);
  let reaped = 0;
  for (const participant of tableValues(participants)) {
    if (
      participant.status === "active" &&
      ((participant.source === "direct" &&
        participant.refId.startsWith("dispatch-")) ||
        (participant.source === "spawned" &&
          !participant.refId.startsWith("worker:")))
    ) {
      await participants.put(participant.id, {
        ...participant,
        status: "left",
        leftAt: timestamp,
        updatedAt: timestamp,
      });
      reaped += 1;
    }
  }
  return reaped;
}

/**
 * One-time decommission of the Lead model.
 *
 * The human `ownerUserId` is derived from the legacy first-human leader
 * (falling back to the creator) and `leader` is cleared. Seat records and seat
 * participants are no longer read at all; legacy `seats` / `seatId` /
 * `seatLabel` keys are simply dropped by the record schemas on the next write.
 *
 * Idempotent: a second run finds no meeting missing an owner and no participant
 * with `leader: true`, so it writes nothing.
 */
export async function migrateMeetingOwnership(
  meetings: KvTableLike<Meeting>,
  participants: KvTableLike<MeetingParticipant>,
  now: () => Date = () => new Date(),
): Promise<{ meetings: number; participants: number }> {
  const timestamp = nowIso(now);
  let migratedMeetings = 0;
  for (const value of tableValues(meetings)) {
    const meeting = parseMeeting(value);
    if (meeting.ownerUserId !== undefined) continue;
    const legacyLeader = tableValues(participants)
      .map(parseParticipant)
      .find(
        (participant) =>
          participant.meetingId === meeting.id &&
          participant.leader &&
          participant.kind === "human",
      );
    const ownerUserId = legacyLeader?.refId ?? meeting.createdBy;
    await meetings.put(
      meeting.id,
      parseMeeting({ ...meeting, ownerUserId, updatedAt: timestamp }),
    );
    migratedMeetings += 1;
  }
  let migratedParticipants = 0;
  for (const value of tableValues(participants)) {
    const participant = parseParticipant(value);
    if (participant.leader !== true) continue;
    await participants.put(
      participant.id,
      parseParticipant({
        ...participant,
        leader: false,
        updatedAt: timestamp,
      }),
    );
    migratedParticipants += 1;
  }
  return { meetings: migratedMeetings, participants: migratedParticipants };
}

function managerActor(actor: MeetingActor): boolean {
  return (
    actor.kind === "user" &&
    (actor.globalRole === "admin" || actor.workspaceRole === "owner")
  );
}

export interface SchemaLike {
  readonly type: "object";
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
}

export interface DomainSpecLike {
  readonly name: string;
  readonly version: number;
  readonly tables: Record<string, { readonly valueSchema: z.ZodType<unknown> }>;
}

export interface MeetingDomainLike {
  table(name: "meetings"): KvTableLike<Meeting>;
  table(name: "participants"): KvTableLike<MeetingParticipant>;
  table(name: "messages"): KvTableLike<MeetingMessage>;
  table(name: "facilitators"): KvTableLike<Facilitator>;
  table(name: "minutes"): KvTableLike<MeetingMinutes>;
  table(name: "minute_versions"): KvTableLike<MinuteVersion>;
  table(name: "delegates"): KvTableLike<Delegate>;
  table(name: "delegate_instructions"): KvTableLike<DelegateInstruction>;
  table(name: "meeting_reads"): KvTableLike<MeetingRead>;
  table(name: "meeting_files"): KvTableLike<MeetingFile>;
  table(name: "meeting_tasks"): KvTableLike<MeetingTask>;
  close(): Promise<void>;
}

export const meetingDomainSpec = {
  name: "collab_meeting",
  version: 1,
  tables: {
    meetings: {
      valueSchema: meetingSchema as unknown as z.ZodType<unknown>,
    },
    participants: {
      valueSchema: participantSchema as unknown as z.ZodType<unknown>,
    },
    messages: {
      valueSchema: messageSchema as unknown as z.ZodType<unknown>,
    },
    ...phase1MeetingTables,
  },
} as const satisfies DomainSpecLike;

export interface PersonaServiceLike {
  get(id: string): Promise<{
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly soul?: string;
  }>;
  preset(id: string, context: string): Promise<string>;
}

export interface AgentLike {
  readonly id: string;
  readonly session?: { readonly id?: string };
}

export interface SubagentContentLike {
  readonly type: "text";
  readonly text: string;
}

export interface MeetingWorkerResultLike {
  readonly output: readonly SubagentContentLike[];
  readonly stopReason: string;
  readonly diagnostic?: string;
}

export interface MeetingWorkerRunLike {
  readonly id: string;
  readonly result: Promise<MeetingWorkerResultLike>;
  dispose(): Promise<void>;
}

export interface SubagentStartLike {
  readonly provider: string;
  readonly label: string;
  readonly request: {
    readonly prompt: readonly SubagentContentLike[];
    readonly parent: AgentLike;
    readonly persona?: string;
    readonly toolFilter?: { readonly allow: readonly string[] };
  };
  readonly signal: AbortSignal;
}

export interface MeetingWorkerStartLike {
  readonly label?: string;
  readonly prompt: readonly SubagentContentLike[];
  readonly parent: AgentLike;
  readonly signal: AbortSignal;
  readonly persona?: string;
  readonly toolFilter?: { readonly allow: readonly string[] };
}

export interface SubagentsRuntimeLike {
  start(
    name: string,
    spec: MeetingWorkerStartLike,
  ): Promise<MeetingWorkerRunLike>;
}

export interface AgentHandleLike {
  readonly agent: AgentLike;
  dispose(): Promise<void>;
}

export interface AgentRegistryLike extends AgentsServiceLike {
  create(options: {
    readonly sessionId: string;
    readonly meta?: { readonly cwd?: string };
    readonly agentOptions?: {
      readonly provider: string;
      readonly model: string;
      readonly reasoningEffort?: string;
    };
  }): Promise<AgentHandleLike>;
}

function agentActor(sessionId: string | undefined): MeetingActor {
  return {
    kind: "agent",
    id: sessionId ?? "agent",
    workspaceRole: "member",
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function actorKind(actor: MeetingActor): "human" | "agent" {
  return actor.kind === "user" ? "human" : "agent";
}

function resolvedDelegationStatus(
  status: string,
  expiresAt: string | undefined,
  now: Date,
): string {
  if (
    status === "active" &&
    expiresAt !== undefined &&
    new Date(expiresAt).getTime() <= now.getTime()
  ) {
    return "expired";
  }
  return status;
}

function nameTaken(
  participants: readonly MeetingParticipant[],
  displayName: string,
): boolean {
  const normalized = displayName.trim().toLowerCase();
  return participants.some(
    (participant) =>
      participant.displayName.trim().toLowerCase() === normalized &&
      participant.status !== "pending",
  );
}

function uniqueAgentName(
  participants: readonly MeetingParticipant[],
  baseName: string,
  ownerName: string | undefined,
): string {
  const candidates = [
    baseName,
    `${baseName} · ${ownerName ?? "Agent"}`,
    ...Array.from(
      { length: 20 },
      (_, index) => `${baseName} · ${ownerName ?? "Agent"} (${index + 2})`,
    ),
  ];
  const used = new Set(
    participants
      .filter((participant) => participant.status !== "pending")
      .map((participant) => participant.displayName.trim().toLowerCase()),
  );
  return (
    candidates.find((candidate) => !used.has(candidate.trim().toLowerCase())) ??
    `${baseName} · ${randomUUID().slice(0, 6)}`
  );
}

function personaPrompt(
  persona: Awaited<ReturnType<PersonaServiceLike["get"]>> | undefined,
  preset: string | undefined,
): string {
  if (preset !== undefined) return preset;
  if (persona === undefined) return "未指定人设；保持克制、具体、如实反馈。";
  return `# ${persona.name} SOUL\n\n${persona.description}`;
}

/** Renders a delegate instruction into the representative's worker prompt. */
function formatDelegateInstruction(instruction: DelegateInstruction): string {
  const bullet = (values: readonly string[]) =>
    values.map((value) => `- ${value}`).join("\n");
  return [
    instruction.goal === "" ? "" : `参会目标：${instruction.goal}`,
    instruction.stance === "" ? "" : `核心立场：${instruction.stance}`,
    instruction.mustSay.length === 0
      ? ""
      : `必须表达：\n${bullet(instruction.mustSay)}`,
    instruction.focusPoints.length === 0
      ? ""
      : `把控点：\n${bullet(instruction.focusPoints)}`,
    instruction.outputs.length === 0
      ? ""
      : `需要带回：\n${bullet(instruction.outputs)}`,
    instruction.speechPolicy === ""
      ? ""
      : `发言策略：${instruction.speechPolicy}`,
    instruction.behavior === "" ? "" : `行为要求：${instruction.behavior}`,
    instruction.permissionBoundary === ""
      ? ""
      : `权限边界：${instruction.permissionBoundary}`,
    instruction.reportPlan === "" ? "" : `会后汇报：${instruction.reportPlan}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function workerParticipant(
  participant: MeetingParticipant,
): MeetingParticipant {
  return {
    ...participant,
    kind: "agent" as const,
    status: "active" as const,
    refId: `worker:${randomUUID()}`,
    source: "spawned" as const,
  };
}

function workerText(result: MeetingWorkerResultLike): string {
  return result.output
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function workerFailure(result: MeetingWorkerResultLike): string {
  return result.diagnostic === undefined
    ? `worker ended with ${result.stopReason}`
    : `${result.stopReason}: ${result.diagnostic}`;
}

export interface MeetingWorkerDeps {
  readonly meetings: MeetingService;
  readonly subagents: () => SubagentsRuntimeLike | undefined;
  readonly agents: () => AgentRegistryLike | undefined;
  readonly defaultModel?: () => AgentDefaultModelLike | undefined;
  readonly personas?: () => PersonaServiceLike | undefined;
  readonly provider?: () => string;
  /** Private commission text for an AI attendance representative. */
  readonly delegateInstruction?: (delegateId: string) => string | undefined;
  readonly now?: () => Date;
}

export interface AgentDefaultModelLike {
  currentSelection(): {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
  };
}

/** 会议派遣时按 AI Teammate 定义开通/复用运行时身份。 */
interface TeammateRuntimeLike {
  ensureRuntime(input: {
    readonly teammateId: string;
    readonly workspaceId: string;
    readonly actor: {
      readonly userId: string;
      readonly name: string;
      readonly role: "admin" | "owner" | "member" | "guest";
    };
  }): Promise<{
    readonly teammateId: string;
    readonly employeeId?: string | undefined;
    readonly principalId?: string | undefined;
    readonly profileId: string;
    readonly personaId?: string | undefined;
    readonly execution?: "builtin" | "external" | undefined;
  }>;
  assignable?(actor: {
    readonly userId: string;
    readonly name: string;
    readonly role: "admin" | "owner" | "member" | "guest";
  }): readonly {
    readonly id: string;
    readonly employeeId?: string | undefined;
  }[];
  ownerOf?(
    ref: string,
  ): { readonly userId: string; readonly name: string } | undefined;
  ownersOf?(
    ref: string,
  ): readonly { readonly userId: string; readonly name: string }[];
}

interface WorkspaceRegistryLike {
  get(workspaceId: string): { readonly path: string } | undefined;
}

interface AgentRunLike {
  readonly id: string;
  readonly status: string;
  readonly source: string;
  readonly instanceId: string;
  readonly nodeId: string;
  readonly output?: { readonly summary?: string | undefined } | undefined;
  readonly error?: string | undefined;
  readonly payload: {
    readonly context: Readonly<Record<string, string | number | boolean>>;
  };
}

interface ChatAgentInputLike {
  readonly workspaceId: string;
  readonly workspacePath?: string | undefined;
  readonly profileId: string;
  readonly source: "chat";
  readonly instanceId: string;
  readonly nodeId: string;
  readonly dispatchKey: string;
  readonly trigger: "manual-dispatch";
  readonly attempt: number;
  readonly runSeq: number;
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly personaId?: string | undefined;
  readonly employeeId?: string | undefined;
  readonly principalId?: string | undefined;
  readonly principalType?:
    | "transitional-agent"
    | "digital-employee"
    | "principal-runtime"
    | undefined;
  readonly contextPackId?: string | undefined;
  readonly sessionBindingId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly payload: {
    readonly instanceTitle: string;
    readonly nodeName: string;
    readonly nodeDescription: string;
    readonly profileName: string;
    readonly deliverables: readonly [];
    readonly context: Readonly<Record<string, string | number | boolean>>;
  };
  readonly createdBy: string;
}

interface ChatAgentServiceLike {
  dispatch(input: ChatAgentInputLike): Promise<AgentRunLike>;
  run(runId: string): AgentRunLike | undefined;
  runs?(filter: {
    readonly workspaceId?: string | undefined;
    readonly instanceId?: string | undefined;
    readonly nodeId?: string | undefined;
  }): readonly AgentRunLike[];
}

interface ContextPackLike {
  readonly id: string;
  readonly sessionBindingId?: string | undefined;
  readonly rendered: {
    readonly systemText: string;
    readonly userText: string;
    readonly flattenedPrompt: string;
  };
}

interface MeetingChatContextAdapterLike {
  readonly scene: "chat";
  readonly chatCarrier: "meeting-ai";
  resolve(input: {
    readonly workspaceId?: string;
    readonly objectId: string;
    readonly agentPrincipalId: string;
    readonly actorPrincipalId: string;
    readonly chatCarrier?: "native-session" | "meeting-ai";
    readonly chatChannelId?: string;
  }): Promise<{
    readonly allowed: boolean;
    readonly workspaceId?: string;
    readonly sceneRevision: string;
    readonly sourceRefs: readonly {
      readonly type:
        | "task"
        | "meeting"
        | "minute-version"
        | "workflow"
        | "document"
        | "chat"
        | "human-edit";
      readonly id: string;
      readonly version?: string;
    }[];
  }>;
  loadFacts(input: {
    readonly workspaceId?: string;
    readonly objectId: string;
    readonly agentPrincipalId: string;
    readonly asOf: string;
  }): Promise<{
    readonly text: string;
    readonly sourceRefs: readonly {
      readonly type:
        | "task"
        | "meeting"
        | "minute-version"
        | "workflow"
        | "document"
        | "chat"
        | "human-edit";
      readonly id: string;
      readonly version?: string;
    }[];
    readonly historyText?: string;
  }>;
  policy(): Promise<{
    readonly version: string;
    readonly instructions: string;
    readonly allowedWriteback: readonly (
      | "agent-private-memory"
      | "run-evidence"
      | "memory-candidate"
    )[];
  }>;
}

interface ContextServiceLike {
  registerAdapter(adapter: MeetingChatContextAdapterLike): () => void;
  ensureChatChannel(input: {
    readonly workspaceId: string;
    readonly userPrincipalId: string;
    readonly agentPrincipalId: string;
    readonly teammateInstanceId: string;
    readonly carrier: "meeting-ai";
    readonly carrierRefId: string;
  }): Promise<{ readonly id: string }>;
  chatChannel?(channelId: string): {
    readonly id: string;
    readonly workspaceId: string;
    readonly userPrincipalId: string;
    readonly agentPrincipalId: string;
    readonly activeCarrierRefId: string;
  } | undefined;
  prepare(input: Record<string, unknown>): Promise<ContextPackLike>;
  session?(bindingId: string): {
    readonly sessionId: string;
    readonly generation: number;
  } | undefined;
  recordRuntime(input: {
    readonly runId: string;
    readonly contextPackId: string;
    readonly runtime: {
      readonly kind: "builtin" | "external";
      readonly provider?: string;
      readonly model?: string;
      readonly externalSessionId?: string;
    };
  }): Promise<unknown>;
}

interface MemoryIngestLike {
  ingestSource(input: {
    readonly sourceType: "meeting";
    readonly sourceId: string;
    readonly version: string;
    readonly workspaceId?: string;
    readonly payload?: {
      readonly title: string;
      readonly content: string;
      readonly actorPrincipalId?: string;
      readonly projectId?: string;
      readonly occurredAt?: string;
      readonly sourceRefs?: readonly {
        readonly type:
          | "task"
          | "meeting"
          | "minute-version"
          | "workflow"
          | "document"
          | "chat"
          | "human-edit";
        readonly id: string;
        readonly version?: string;
        readonly quote?: string;
      }[];
      readonly metadata?: Readonly<
        Record<string, string | number | boolean>
      >;
    };
  }): Promise<unknown>;
}

/** 任务域的最小投影：只用到「查找 / 建任务 / 派发」三件事。 */
interface TaskLinkLike {
  readonly type: string;
  readonly id: string;
}

interface TaskRecordLike {
  readonly id: string;
  readonly status: string;
  readonly receiverId?: string | undefined;
  readonly links: readonly TaskLinkLike[];
  readonly messages?: readonly TaskMessageLike[] | undefined;
}

interface TaskMessageLike {
  readonly id: string;
  readonly kind: string;
  readonly content: string;
  readonly state?: string | undefined;
}

interface TaskActorLike {
  readonly id: string;
  readonly name: string;
  readonly kind: "human" | "agent" | "system";
}

interface TaskServiceLike {
  list(workspaceId: string): readonly TaskRecordLike[];
  get(taskId: string): TaskRecordLike;
  create(
    actor: TaskActorLike,
    input: Record<string, unknown>,
  ): Promise<TaskRecordLike>;
  addMessage(
    actor: TaskActorLike,
    input: Record<string, unknown>,
  ): Promise<TaskRecordLike>;
}

interface TaskDispatchLike {
  dispatch(
    task: TaskRecordLike,
    actor: TaskActorLike,
    context?: {
      readonly scene: "task" | "meeting";
      readonly objectId: string;
      readonly content: string;
    },
  ): Promise<unknown>;
}

const MEETING_AGENT_TASK_TYPE = "会议";

/** 会议内给人看的时间戳：mm-dd hh:mm（本地时区）。 */
function meetingClock(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * 人类可读的会议编号：`MTG-<创建日期>-<id 前 4 位>`。
 * 任务描述、通知这类给人看的文案用它；内部关联仍然用完整 meeting id。
 */
function meetingCode(meeting: Meeting): string {
  const created = new Date(meeting.createdAt);
  const date = Number.isNaN(created.getTime())
    ? "00000000"
    : [
        created.getFullYear(),
        String(created.getMonth() + 1).padStart(2, "0"),
        String(created.getDate()).padStart(2, "0"),
      ].join("");
  const tail = meeting.id
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 4)
    .toUpperCase();
  return `MTG-${date}-${tail}`;
}

/** 找到某位 AI 参会方在任务域里的「会议」任务（同一会议 + 同一实例复用）。 */
function findAgentMeetingTask(
  service: TaskServiceLike,
  workspaceId: string,
  meetingId: string,
  teammateInstanceId: string,
): TaskRecordLike | undefined {
  return service
    .list(workspaceId)
    .find(
      (task) =>
        task.status !== "done" &&
        task.status !== "cancelled" &&
        task.receiverId === teammateInstanceId &&
        task.links.some(
          (link) => link.type === "meeting" && link.id === meetingId,
        ),
    );
}

/** 任务时间线里最新一条 agent 发言（用于回写会议与去重）。 */
function latestAgentMessage(
  task: TaskRecordLike | undefined,
): TaskMessageLike | undefined {
  return (task?.messages ?? [])
    .filter(
      (message) =>
        message.kind === "agent" &&
        // 只回写定稿发言：queued/running 是「已接收指令，正在执行…」这类占位。
        message.state !== "queued" &&
        message.state !== "running",
    )
    .at(-1);
}

/**
 * 把一条会议消息投递给 AI 参会方对应的任务会话：
 * 追加 task message（会议原文 + 附件名）→ 派发 run；
 * run 产出后再轮询任务时间线，把 agent 的发言贴回会议群聊。
 *
 * 主动/被动共用这条链路：`active` 每条会议消息都投递（含其他 agent 的发言），
 * `mention` 只在被 @ 时投递（由调用方的 deliveries 决定）。
 */
async function feedMeetingMessageToAgent(input: {
  readonly meeting: Meeting;
  readonly participant: MeetingParticipant;
  readonly message: MeetingMessage;
  readonly senderName: string;
  readonly taskService: TaskServiceLike | undefined;
  readonly taskDispatch: TaskDispatchLike | undefined;
}): Promise<void> {
  const service = input.taskService;
  const dispatcher = input.taskDispatch;
  const teammateInstanceId = input.participant.teammateInstanceId;
  if (
    service === undefined ||
    dispatcher === undefined ||
    teammateInstanceId === undefined
  )
    return;
  try {
    let task = findAgentMeetingTask(
      service,
      input.meeting.workspaceId,
      input.meeting.id,
      teammateInstanceId,
    );
    // 懒补建：功能上线前就已经在会里的 AI 参会方，第一次参与时补一条「会议」任务，
    // 后续消息就能落到它自己的 de-task-* 会话上（不额外派发，避免多跑一轮）。
    if (task === undefined) {
      const createdId = await ensureAgentMeetingTask({
        meeting: input.meeting,
        teammateInstanceId,
        teammateName: input.participant.displayName,
        actorId: input.message.senderId,
        actorName: input.senderName,
        dispatchInitial: false,
        taskService: service,
        taskDispatch: dispatcher,
      });
      if (createdId === undefined) return;
      task = findAgentMeetingTask(
        service,
        input.meeting.workspaceId,
        input.meeting.id,
        teammateInstanceId,
      );
    }
    if (task === undefined) return;
    const attachmentNames = (input.message.attachments ?? []).map(
      (attachment) => attachment.name,
    );
    const content = [
      `【会议消息】${input.senderName}：${input.message.content}`,
      attachmentNames.length === 0
        ? ""
        : `附件/文档：${attachmentNames.join("、")}`,
      `（会议：${input.meeting.title}）`,
    ]
      .filter((line) => line !== "")
      .join("\n");
    const actor: TaskActorLike = {
      id: input.message.senderId,
      name: input.senderName,
      kind: input.message.senderKind === "human" ? "human" : "system",
    };
    const updated = await service.addMessage(actor, {
      taskId: task.id,
      content,
    });
    await dispatcher.dispatch(updated, actor, {
      scene: "meeting",
      objectId: input.meeting.id,
      content,
    });
  } catch {
    // 任务域异常不阻断会议发言。
  }
}

/**
 * 把会议里的 AI 参会方接到任务域：每位 AI 在任务域有一条「会议」任务，
 * 并据此派发出一条 `de-task-*` 会话（左侧项目树可见，能看到它的思考与回答）。
 * 同一 (meetingId, teammateInstanceId) 复用同一条任务；任务域不可用时静默跳过，
 * 不阻断入会。
 */
async function ensureAgentMeetingTask(input: {
  readonly meeting: Meeting;
  readonly teammateInstanceId: string;
  readonly teammateName: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly instruction?: string | undefined;
  /** false = 只建任务不派发（调用方马上会带着会议消息派发）。 */
  readonly dispatchInitial?: boolean | undefined;
  readonly taskService: TaskServiceLike | undefined;
  readonly taskDispatch: TaskDispatchLike | undefined;
}): Promise<string | undefined> {
  const service = input.taskService;
  const dispatcher = input.taskDispatch;
  if (service === undefined || dispatcher === undefined) return undefined;
  try {
    const existing = service
      .list(input.meeting.workspaceId)
      .find(
        (task) =>
          task.status !== "done" &&
          task.status !== "cancelled" &&
          task.receiverId === input.teammateInstanceId &&
          task.links.some(
            (link) => link.type === "meeting" && link.id === input.meeting.id,
          ),
      );
    const taskActor: TaskActorLike = {
      id: input.actorId,
      name: input.actorName,
      kind: "human",
    };
    const task =
      existing ??
      (await service.create(taskActor, {
        workspaceId: input.meeting.workspaceId,
        title: `${input.meeting.title} · ${input.teammateName}`,
        type: MEETING_AGENT_TASK_TYPE,
        priority: "P2",
        status: "progress",
        receiverType: "agent",
        receiverId: input.teammateInstanceId,
        receiverName: input.teammateName,
        description: [
          `会议：${input.meeting.title}`,
          `会议号：${meetingCode(input.meeting)}`,
          input.meeting.agenda === "" ? "" : `议程：${input.meeting.agenda}`,
          input.instruction === undefined || input.instruction === ""
            ? ""
            : `主人嘱咐：${input.instruction}`,
          "",
          "你是这场会议的 AI 参会方：被 @ 时按定向指令回应，并按嘱咐主动关注会议进展。",
        ]
          .filter((line) => line !== undefined)
          .join("\n"),
        acceptance: ["被 @ 时给出反馈", "按主人嘱咐监控会议并主动发言"],
        links: [
          {
            type: "meeting",
            id: input.meeting.id,
            label: input.meeting.title,
          },
        ],
        autoSubmitReview: false,
      }));
    if (input.dispatchInitial !== false) {
      await dispatcher.dispatch(task, taskActor);
    }
    return task.id;
  } catch {
    return undefined;
  }
}

export interface MeetingDeliveryEnvelope {
  readonly meetingId: string;
  readonly messageId: string;
  readonly participant: MeetingParticipant;
}

const MAX_ACTIVE_WORKERS = 4;
const TRANSCRIPT_WINDOW = 20;

/**
 * Owns short-lived meeting worker execution.
 *
 * A worker is deliberately not a continuable subagent: its final output is the
 * only thing returned to this runtime, and this runtime is the only component
 * that writes it back into the scoped meeting transcript.
 */
export class MeetingRuntime {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly tasks = new Set<{
    readonly meetingId: string;
    readonly participantId: string;
    readonly controller: AbortController;
  }>();
  private host: Promise<AgentHandleLike> | undefined;
  private activeWorkers = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly deps: MeetingWorkerDeps) {}

  dispatch(
    message: MeetingMessage,
    targets: readonly MeetingParticipant[],
  ): void {
    for (const participant of targets) {
      this.enqueue(participant.id, () =>
        this.executeDelivery({
          meetingId: message.meetingId,
          messageId: message.id,
          participant,
        }),
      );
    }
  }

  greet(participant: MeetingParticipant): void {
    this.enqueue(participant.id, () =>
      this.executePrompt(
        participant,
        "派遣完成。请用一句话自我介绍，并说明你当前被配置的发言策略。",
      ),
    );
  }

  trigger(participant: MeetingParticipant, instruction: string): void {
    this.enqueue(participant.id, () =>
      this.executePrompt(participant, instruction),
    );
  }

  /** Test and graceful-shutdown seam for draining every participant queue. */
  async waitIdle(): Promise<void> {
    while (this.queues.size > 0) {
      await Promise.allSettled(this.queues.values());
    }
  }

  cancelParticipant(participantId: string): void {
    for (const task of this.tasks) {
      if (task.participantId === participantId)
        task.controller.abort("participant left");
    }
  }

  cancelMeeting(meetingId: string): void {
    for (const task of this.tasks) {
      if (task.meetingId === meetingId) task.controller.abort("meeting closed");
    }
  }

  async dispose(): Promise<void> {
    for (const task of this.tasks)
      task.controller.abort("meeting runtime disposed");
    const currentHost = this.host;
    this.host = undefined;
    if (currentHost !== undefined) {
      try {
        const handle = await currentHost;
        await handle.dispose();
      } catch {
        // The host is private to this runtime; startup failure needs no cleanup.
      }
    }
  }

  private enqueue(participantId: string, operation: () => Promise<void>): void {
    const previous = this.queues.get(participantId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(operation)
      .finally(() => {
        if (this.queues.get(participantId) === next)
          this.queues.delete(participantId);
      });
    this.queues.set(participantId, next);
  }

  private async acquire(): Promise<void> {
    if (this.activeWorkers < MAX_ACTIVE_WORKERS) {
      this.activeWorkers += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.activeWorkers += 1;
  }

  private release(): void {
    this.activeWorkers = Math.max(0, this.activeWorkers - 1);
    this.waiting.shift()?.();
  }

  private async hostAgent(): Promise<AgentLike> {
    if (this.host === undefined) {
      const agents = this.deps.agents();
      if (agents === undefined)
        throw new MeetingError("not_found", "agent registry is unavailable");
      const model = this.deps.defaultModel?.()?.currentSelection();
      const current = agents
        .create({
          sessionId: randomUUID(),
          meta: { cwd: process.cwd() },
          ...(model === undefined ? {} : { agentOptions: model }),
        })
        .catch((cause) => {
          if (this.host === current) this.host = undefined;
          throw cause;
        });
      this.host = current;
    }
    return (await this.host).agent;
  }

  private personaIdFor(participant: MeetingParticipant): string | undefined {
    return participant.personaId;
  }

  /**
   * 把参会者的 personaId 解析成人设文本。
   *
   * subagent 的 `persona` 参数语义是人设正文（会遮蔽 deployment:persona），
   * 传 id 只会让 worker 的 system prompt 里出现一串 identifier；这里统一取
   * SOUL.md 正文。取不到时返回空串，退回「无自定义人设」。
   */
  private async resolvePersonaSoul(
    personaId: string | undefined,
  ): Promise<string> {
    if (personaId === undefined || personaId === "") return "";
    const personas = this.deps.personas?.();
    if (personas === undefined) return "";
    try {
      const persona = await personas.get(personaId);
      return typeof persona.soul === "string" ? persona.soul.trim() : "";
    } catch {
      return "";
    }
  }

  private async buildPrompt(
    participant: MeetingParticipant,
    instruction: string,
  ): Promise<string> {
    const meeting = this.deps.meetings.get(participant.meetingId);
    const personaService = this.deps.personas?.();
    const meetingContext = `会议：${meeting.title}\n工作区：${meeting.workspaceId}`;
    let basePreset: string | undefined;
    if (
      participant.basePersonaId !== undefined &&
      personaService !== undefined
    ) {
      basePreset = await personaService.preset(
        participant.basePersonaId,
        meetingContext,
      );
    }
    let rolePersona: Awaited<ReturnType<PersonaServiceLike["get"]>> | undefined;
    if (
      participant.personaId !== undefined &&
      personaService !== undefined &&
      participant.personaId !== participant.basePersonaId
    ) {
      rolePersona = await personaService.get(participant.personaId);
    }
    let identitySection: string;
    if (basePreset !== undefined) {
      if (rolePersona !== undefined) {
        identitySection = [
          basePreset,
          "",
          "## 会议角色上下文",
          `在当前会议中，你以「${rolePersona.name}」的角色参与。`,
          rolePersona.description === ""
            ? ""
            : `角色说明：${rolePersona.description}`,
        ]
          .filter((line) => line !== "")
          .join("\n");
      } else {
        identitySection = basePreset;
      }
    } else if (rolePersona !== undefined) {
      const rolePreset = await personaService!.preset(
        participant.personaId!,
        meetingContext,
      );
      identitySection = personaPrompt(rolePersona, rolePreset);
    } else {
      let legacyPreset: string | undefined;
      if (
        participant.personaId !== undefined &&
        participant.basePersonaId === undefined &&
        personaService !== undefined
      ) {
        legacyPreset = await personaService.preset(
          participant.personaId,
          meetingContext,
        );
      }
      identitySection = personaPrompt(undefined, legacyPreset);
    }
    const participants = this.deps.meetings
      .participants(meeting.id)
      .map((candidate) => {
        const owner =
          candidate.ownerName === undefined
            ? ""
            : ` · ${candidate.ownerName}的分身`;
        return `- ${candidate.displayName}${owner} (${candidate.kind}/${candidate.status})`;
      });
    const transcript = this.deps.meetings
      .transcript(meeting.id)
      .slice(-TRANSCRIPT_WINDOW)
      .map((message) => `${message.senderName}: ${message.content}`);
    const strategy =
      participant.autoSpeak === "all"
        ? "所有会议消息都会转发给你。"
        : participant.autoSpeak === "mentions"
          ? "只有定向 @ 你的消息才会转发给你。"
          : "只有主人显式触发时才会运行你。";
    const delegateBrief =
      participant.delegationId === undefined
        ? ""
        : (this.deps.delegateInstruction?.(participant.delegationId) ?? "");
    return [
      "# DSH Pluginmax 会议 worker",
      "",
      identitySection,
      "",
      `这是为「${meeting.title}」运行的一次性会议任务。会议结束后这个 worker 不保留状态。`,
      participant.ownerName === undefined
        ? ""
        : `主人：${participant.ownerName}`,
      `工作区：${meeting.workspaceId}`,
      `发言策略：${strategy}`,
      ...(delegateBrief === ""
        ? []
        : ["", "## 本次会议委托（仅本次有效）", delegateBrief]),
      "",
      "当前参与者：",
      ...participants,
      "",
      "最近会议记录：",
      ...(transcript.length === 0 ? ["（暂无）"] : transcript),
      "",
      "任务：",
      instruction,
      "",
      "输出边界：",
      "- 你的最终回复就是写入会议的唯一发言；不要调用任何工具。",
      "- 只处理本次会议范围内的内容；不要向任何父会话、主人主对话框或外部渠道汇报。",
      "- 保持简短、具体；如果信息不足，明确说明缺失的信息。",
    ]
      .filter((line) => line !== "")
      .join("\n");
  }

  private async executeDelivery(
    envelope: MeetingDeliveryEnvelope,
  ): Promise<void> {
    const current = this.deps.meetings
      .participants(envelope.meetingId)
      .find((participant) => participant.id === envelope.participant.id);
    if (current === undefined || current.status !== "active") return;
    const message = this.deps.meetings
      .transcript(envelope.meetingId)
      .find((candidate) => candidate.id === envelope.messageId);
    if (message === undefined) return;
    const mentionNames = message.mentions.map(
      (participantId) =>
        this.deps.meetings
          .participants(envelope.meetingId)
          .find((participant) => participant.id === participantId)
          ?.displayName ?? participantId,
    );
    const instruction = [
      message.senderKind === "system"
        ? "请回应以下系统事项。"
        : "请回应以下消息。",
      message.mentions.includes(envelope.participant.id)
        ? `这条消息定向 @ ${envelope.participant.displayName}。`
        : message.mentions.length > 0
          ? `这条消息定向给 ${mentionNames.join("、")}，你可以看到它，但不是要求你回复。`
          : "这条消息是群发。",
      "",
      `发送者：${message.senderName}`,
      `内容：${message.content}`,
    ].join("\n");
    await this.runWorker(envelope.meetingId, current, message.id, instruction);
  }

  private async executePrompt(
    participant: MeetingParticipant,
    instruction: string,
  ): Promise<void> {
    await this.runWorker(
      participant.meetingId,
      participant,
      undefined,
      instruction,
    );
  }

  private async runWorker(
    meetingId: string,
    participant: MeetingParticipant,
    messageId: string | undefined,
    instruction: string,
  ): Promise<void> {
    if (this.deps.meetings.get(meetingId).status !== "active") return;
    const current = this.deps.meetings
      .participants(meetingId)
      .find((candidate) => candidate.id === participant.id);
    if (current === undefined || current.status !== "active") return;
    const subagents = this.deps.subagents();
    if (subagents === undefined)
      throw new MeetingError(
        "not_found",
        "meeting worker runtime is unavailable",
      );
    const controller = new AbortController();
    const task = {
      meetingId,
      participantId: current.id,
      controller,
    };
    this.tasks.add(task);
    await this.acquire();
    let started: MeetingWorkerRunLike | undefined;
    try {
      const prompt = await this.buildPrompt(current, instruction);
      const provider = this.deps.provider?.() ?? "spawn";
      const personaSoul = await this.resolvePersonaSoul(
        this.personaIdFor(current),
      );
      started = await subagents.start(provider, {
        label: `meeting-worker:${current.displayName}`,
        prompt: [{ type: "text", text: prompt }],
        parent: await this.hostAgent(),
        // persona 是人设正文，不是 id：传 SOUL 让 worker 真读到人设。
        ...(personaSoul === "" ? {} : { persona: personaSoul }),
        toolFilter: { allow: [] },
        signal: controller.signal,
      });
      const result = await started.result;
      if (controller.signal.aborted) return;
      const reply = workerText(result);
      if (result.stopReason !== "completed")
        throw new MeetingError("conflict", workerFailure(result));
      if (reply !== "")
        await this.deps.meetings.postWorkerReply(current.id, reply);
      if (messageId !== undefined) {
        await this.deps.meetings.markDelivery(
          messageId,
          current.id,
          "delivered",
        );
      }
    } catch (cause) {
      if (messageId !== undefined) {
        await this.deps.meetings.markDelivery(
          messageId,
          current.id,
          "failed",
          cause instanceof Error ? cause.message : "meeting worker failed",
        );
      }
    } finally {
      this.tasks.delete(task);
      this.release();
      if (this.tasks.size === 0) {
        const currentHost = this.host;
        this.host = undefined;
        if (currentHost !== undefined) {
          try {
            await (await currentHost).dispose();
          } catch {
            // Worker output has already settled; host cleanup is best effort.
          }
        }
      }
      if (started !== undefined) {
        try {
          await started.dispose();
        } catch {
          // A worker whose result already settled may race its own cleanup.
        }
      }
    }
  }
}
export interface DelegationReporterLike {
  generateDelegationReport(
    delegationId: string,
    transcript: string,
    options: { finalize?: boolean },
  ): Promise<unknown>;
  getDelegationStatus?(
    delegationId: string,
  ): { status: string; expiresAt?: string } | undefined;
}

/** Facilitator 席位的一次参会记录，供会议成员展示与「参会次数」统计使用。 */
export interface MeetingFacilitatorActivity {
  readonly teammateId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deactivatedAt?: string | undefined;
}

export class MeetingService {
  private delegationReporter: DelegationReporterLike | undefined;
  /**
   * Facilitator 生命周期读取器（由纪要服务注入）。
   *
   * Facilitator 是会议服务席位，只落在 facilitators 表、不占 participants 行；
   * 统计「参会次数」和会议成员展示都需要读它，这里做一次转发，避免让
   * MeetingService 直接依赖纪要服务。
   */
  private facilitatorReader:
    | ((meetingId: string) => readonly MeetingFacilitatorActivity[])
    | undefined;
  /**
   * 对话内容变化（发言、worker 回复、散会）时触发一次。
   * 仅由写入路径调用，读取 / 轮询路径绝不触发；实现方负责异步与去重。
   */
  onTranscriptChanged: ((meetingId: string) => void) | undefined;

  /**
   * Fired exactly once when a meeting transitions to `closed`. Phase 1 uses it
   * for the single automatic minutes trigger and for completing AI delegates;
   * unlike `onTranscriptChanged` it never fires on ordinary messages, so it
   * cannot reintroduce write-triggered minutes generation.
   */
  onMeetingClosed: ((meetingId: string) => void) | undefined;

  setDelegationReporter(reporter: DelegationReporterLike | undefined): void {
    this.delegationReporter = reporter;
  }

  setFacilitatorReader(
    reader:
      | ((meetingId: string) => readonly MeetingFacilitatorActivity[])
      | undefined,
  ): void {
    this.facilitatorReader = reader;
  }

  /** 会议内的 facilitator 生命周期记录（无则空数组）。 */
  facilitatorsOf(meetingId: string): readonly MeetingFacilitatorActivity[] {
    return this.facilitatorReader?.(meetingId) ?? [];
  }

  constructor(
    private readonly tables: {
      readonly meetings: KvTableLike<Meeting>;
      readonly participants: KvTableLike<MeetingParticipant>;
      readonly messages: KvTableLike<MeetingMessage>;
    },
    private readonly options: { readonly now: () => Date } = {
      now: () => new Date(),
    },
  ) {}

  async create(
    actor: MeetingActor,
    input: {
      readonly workspaceId: string;
      readonly title: string;
      readonly kind?: "meeting" | "ai" | undefined;
      readonly teammateInstanceId?: string | undefined;
      readonly agenda?: string | undefined;
      readonly parentSessionId?: string | undefined;
    },
  ): Promise<Meeting> {
    const parsedActor = parseOrInvalid(actorSchema, actor);
    const parsed = parseOrInvalid(
      z.object({
        workspaceId: idSchema,
        title: titleSchema,
        kind: z.enum(["meeting", "ai"]).default("meeting"),
        teammateInstanceId: idSchema.optional(),
        agenda: textSchema.optional(),
        parentSessionId: idSchema.optional(),
      }),
      input,
    );
    const timestamp = nowIso(this.options.now);
    const meeting = {
      id: randomUUID(),
      workspaceId: parsed.workspaceId,
      title: parsed.title,
      kind: parsed.kind,
      ...(parsed.teammateInstanceId === undefined
        ? {}
        : { teammateInstanceId: parsed.teammateInstanceId }),
      agenda: parsed.agenda ?? "",
      status: "active" as const,
      createdBy: parsedActor.id,
      // The creator is the meeting's human owner. Owner only gates title/agenda
      // edits and minutes confirmation; membership/lifecycle/facilitator
      // operations are open to any active human participant.
      ownerUserId: parsedActor.id,
      ...(parsed.parentSessionId === undefined
        ? {}
        : { parentSessionId: parsed.parentSessionId }),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.tables.meetings.put(meeting.id, meeting);
    return meeting;
  }

  list(workspaceId: string): Meeting[] {
    const parsed = parseOrInvalid(idSchema, workspaceId);
    return tableValues(this.tables.meetings)
      .map(parseMeeting)
      .filter((meeting) => meeting.workspaceId === parsed)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
  }

  get(meetingId: string): Meeting {
    const parsed = parseOrInvalid(z.string().min(1).max(160), meetingId);
    const meeting = this.tables.meetings.get(parsed);
    if (meeting === undefined)
      throw new MeetingError("not_found", "meeting not found");
    return parseMeeting(meeting);
  }

  participants(meetingId: string): MeetingParticipant[] {
    const meeting = this.get(meetingId);
    return tableValues(this.tables.participants)
      .map(parseParticipant)
      .filter((participant) => participant.meetingId === meeting.id)
      .sort(
        (left, right) =>
          left.displayName.localeCompare(right.displayName) ||
          left.id.localeCompare(right.id),
      );
  }

  transcript(meetingId: string): MeetingMessage[] {
    const meeting = this.get(meetingId);
    return tableValues(this.tables.messages)
      .map(parseMessage)
      .filter((message) => message.meetingId === meeting.id)
      .sort((left, right) => left.sequence - right.sequence);
  }

  /**
   * Retires participants whose own recorded deliveries already reported the
   * target unavailable, so target selection stops picking a dead row.
   */
  private async reapUnavailableParticipants(
    meetingId: string,
    transcript: readonly MeetingMessage[],
  ): Promise<void> {
    const unavailable = unavailableDeliveryParticipants(transcript);
    if (unavailable.size === 0) return;
    for (const participant of this.participants(meetingId)) {
      if (!unavailable.has(participant.id)) continue;
      await this.markParticipantLeft(participant.id);
    }
  }

  /** Retires one participant row so later target selection skips it. */
  private async markParticipantLeft(participantId: string): Promise<void> {
    const current = this.tables.participants.get(participantId);
    if (current === undefined) return;
    const participant = parseParticipant(current);
    if (participant.status === "left") return;
    const timestamp = nowIso(this.options.now);
    await this.tables.participants.put(participant.id, {
      ...participant,
      status: "left",
      leftAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async join(
    actor: MeetingActor,
    meetingId: string,
    displayName: string,
  ): Promise<MeetingParticipant> {
    const parsedActor = parseOrInvalid(actorSchema, actor);
    const meeting = this.get(meetingId);
    if (meeting.status !== "active")
      throw new MeetingError("conflict", "meeting is closed");
    const parsedName = parseOrInvalid(displayNameSchema, displayName);
    const participants = this.participants(meeting.id);
    const existing = participants.find(
      (participant) =>
        participant.kind === actorKind(parsedActor) &&
        participant.refId === parsedActor.id,
    );
    if (existing !== undefined && existing.status === "active") {
      // AI 重复入会直接复用已有参与者：不再新建，也不会被改名成「名字 · Agent」。
      if (parsedActor.kind !== "user") return existing;
      throw new MeetingError("conflict", "participant already joined");
    }
    const others =
      existing === undefined
        ? participants
        : participants.filter((candidate) => candidate.id !== existing.id);
    const uniqueName = nameTaken(others, parsedName)
      ? uniqueAgentName(others, parsedName, undefined)
      : parsedName;
    const timestamp = nowIso(this.options.now);
    if (existing !== undefined) {
      const reactivated: MeetingParticipant = {
        ...existing,
        displayName: uniqueName,
        status: "active",
        joinedAt: timestamp,
        leftAt: undefined,
        updatedAt: timestamp,
      };
      await this.tables.participants.put(reactivated.id, reactivated);
      return reactivated;
    }
    const participant = {
      id: randomUUID(),
      meetingId: meeting.id,
      kind: actorKind(parsedActor),
      refId: parsedActor.id,
      displayName: uniqueName,
      leader: false,
      status: "active" as const,
      source: "direct" as const,
      joinedAt: timestamp,
      updatedAt: timestamp,
    };
    await this.tables.participants.put(participant.id, participant);
    return participant;
  }

  async inviteParticipant(
    actor: MeetingActor,
    meetingId: string,
    input: {
      readonly targetId: string;
      readonly displayName: string;
    },
  ): Promise<MeetingParticipant> {
    const parsedActor = parseOrInvalid(actorSchema, actor);
    const meeting = this.get(meetingId);
    if (meeting.status !== "active")
      throw new MeetingError("conflict", "meeting is closed");
    const targetId = parseOrInvalid(idSchema, input.targetId);
    const displayName = parseOrInvalid(displayNameSchema, input.displayName);
    const participants = this.participants(meeting.id);
    const caller = participants.find(
      (candidate) =>
        candidate.status === "active" &&
        candidate.kind === actorKind(parsedActor) &&
        candidate.refId === parsedActor.id,
    );
    if (
      !(
        caller !== undefined ||
        meeting.createdBy === parsedActor.id ||
        managerActor(parsedActor)
      )
    ) {
      throw new MeetingError(
        "forbidden",
        "an active meeting participant, creator, or workspace owner role is required",
      );
    }
    const existing = participants.find(
      (candidate) => candidate.kind === "human" && candidate.refId === targetId,
    );
    if (existing !== undefined && existing.status === "active")
      throw new MeetingError("conflict", "participant already joined");
    const timestamp = nowIso(this.options.now);
    const invited = {
      ...existing,
      id: existing?.id ?? randomUUID(),
      meetingId: meeting.id,
      kind: "human" as const,
      refId: targetId,
      displayName,
      personaId: undefined,
      ownerId: undefined,
      ownerName: undefined,
      autoSpeak: undefined,
      initialGreeting: undefined,
      delegationId: undefined,
      principalType: undefined,
      leader: false,
      status: "active" as const,
      source: "direct" as const,
      hint: undefined,
      joinedAt: timestamp,
      leftAt: undefined,
      updatedAt: timestamp,
    };
    await this.tables.participants.put(invited.id, invited);
    const operator = caller?.displayName ?? parsedActor.id;
    const systemMessageId = randomUUID();
    await this.tables.messages.put(systemMessageId, {
      id: systemMessageId,
      sequence: (this.transcript(meeting.id).at(-1)?.sequence ?? 0) + 1,
      meetingId: meeting.id,
      senderKind: "system",
      senderId: "system",
      senderName: "系统",
      content: `${operator} 已邀请 ${displayName} 入会。`,
      mentions: [],
      deliveries: [],
      createdAt: timestamp,
    });
    return invited;
  }

  /**
   * Joins (or updates) the AI attendance representative for one delegate.
   *
   * The representative is a normal participant of kind `ai_representative`,
   * so the existing meeting worker runtime dispatches it and writes its reply
   * back to the transcript. `ownerId` is the principal so the member list can
   * group it under them and render「代表 X 参会」.
   */
  async addAiRepresentative(
    actor: MeetingActor,
    input: {
      readonly meetingId: string;
      readonly delegateId: string;
      readonly principalUserId: string;
      readonly principalName: string;
      readonly aiPrincipalId?: string;
      readonly teammateInstanceId: string;
      readonly speechMode: "observe" | "mention" | "key_topic" | "active";
      readonly personaId?: string;
      readonly basePersonaId?: string;
    },
  ): Promise<MeetingParticipant> {
    parseOrInvalid(actorSchema, actor);
    const parsed = parseOrInvalid(
      z.object({
        meetingId: z.string().min(1).max(160),
        delegateId: idSchema,
        principalUserId: idSchema,
        principalName: displayNameSchema,
        aiPrincipalId: idSchema.optional(),
        teammateInstanceId: idSchema,
        speechMode: z.enum(["observe", "mention", "key_topic", "active"]),
        personaId: idSchema.optional(),
        basePersonaId: idSchema.optional(),
      }),
      input,
    );
    const meeting = this.get(parsed.meetingId);
    if (meeting.status !== "active")
      throw new MeetingError("conflict", "meeting is closed");
    const autoSpeak =
      parsed.speechMode === "observe"
        ? "manual"
        : parsed.speechMode === "mention"
          ? "mentions"
          : "all";
    const timestamp = nowIso(this.options.now);
    const existing = this.participants(meeting.id).find(
      (participant) => participant.delegationId === parsed.delegateId,
    );
    const participant: MeetingParticipant = parseParticipant({
      ...existing,
      id: existing?.id ?? randomUUID(),
      meetingId: meeting.id,
      kind: "ai_representative",
      refId: parsed.delegateId,
      displayName: `${parsed.principalName} 的 AI 参会代表`,
      ...(parsed.personaId === undefined
        ? {}
        : { personaId: parsed.personaId }),
      ...(parsed.basePersonaId === undefined
        ? {}
        : { basePersonaId: parsed.basePersonaId }),
      ownerId: parsed.principalUserId,
      ownerName: parsed.principalName,
      principalUserId: parsed.principalUserId,
      principalName: parsed.principalName,
      ...(parsed.aiPrincipalId === undefined
        ? {}
        : { aiPrincipalId: parsed.aiPrincipalId }),
      teammateInstanceId: parsed.teammateInstanceId,
      delegationId: parsed.delegateId,
      principalType: "delegation",
      autoSpeak,
      leader: false,
      status: "active",
      source: "direct",
      joinedAt: existing?.status === "active" ? existing.joinedAt : timestamp,
      leftAt: undefined,
      updatedAt: timestamp,
    });
    await this.tables.participants.put(participant.id, participant);
    if (existing === undefined)
      await this.appendSystemMessage(
        meeting.id,
        `${parsed.principalName} 已指派 AI 参会代表（${parsed.teammateInstanceId}）入会。`,
      );
    return participant;
  }

  /** Retires the AI representative bound to a delegate (e.g. on revoke). */
  async removeAiRepresentative(delegateId: string): Promise<void> {
    const parsed = parseOrInvalid(idSchema, delegateId);
    const participant = tableValues(this.tables.participants)
      .map(parseParticipant)
      .find(
        (candidate) =>
          candidate.delegationId === parsed && candidate.status === "active",
      );
    if (participant === undefined) return;
    const timestamp = nowIso(this.options.now);
    await this.tables.participants.put(participant.id, {
      ...participant,
      status: "left",
      leftAt: timestamp,
      updatedAt: timestamp,
    });
    await this.appendSystemMessage(
      participant.meetingId,
      `${participant.displayName} 已退出会议。`,
    );
  }

  async leave(
    actor: MeetingActor,
    meetingId: string,
  ): Promise<MeetingParticipant> {
    const parsedActor = parseOrInvalid(actorSchema, actor);
    const meeting = this.get(meetingId);
    if (meeting.status !== "active")
      throw new MeetingError("conflict", "meeting is closed");
    const participants = this.participants(meeting.id);
    const participant = participants.find(
      (candidate) =>
        candidate.status === "active" &&
        candidate.kind === actorKind(parsedActor) &&
        candidate.refId === parsedActor.id,
    );
    if (participant === undefined)
      throw new MeetingError(
        "not_found",
        "active meeting participant not found",
      );
    const left = {
      ...participant,
      status: "left" as const,
      leftAt: nowIso(this.options.now),
      updatedAt: nowIso(this.options.now),
    };
    await this.tables.participants.put(left.id, left);
    await this.reportForDelegation(left, false);
    return left;
  }

  async removeParticipant(
    actor: MeetingActor,
    meetingId: string,
    participantId: string,
  ): Promise<MeetingParticipant> {
    const parsedActor = parseOrInvalid(actorSchema, actor);
    const parsedParticipantId = parseOrInvalid(idSchema, participantId);
    const meeting = this.get(meetingId);
    if (meeting.status !== "active")
      throw new MeetingError("conflict", "meeting is closed");
    const participants = this.participants(meeting.id);
    const caller = participants.find(
      (candidate) =>
        candidate.status === "active" &&
        candidate.kind === actorKind(parsedActor) &&
        candidate.refId === parsedActor.id,
    );
    if (
      !(
        (parsedActor.kind === "user" && caller !== undefined) ||
        managerActor(parsedActor)
      )
    ) {
      throw new MeetingError(
        "forbidden",
        "an active human participant or workspace owner role is required",
      );
    }
    const participant = participants.find(
      (candidate) => candidate.id === parsedParticipantId,
    );
    if (participant === undefined || participant.status === "left") {
      throw new MeetingError(
        "not_found",
        "active meeting participant not found",
      );
    }
    if (
      participant.status === "active" &&
      participant.kind === actorKind(parsedActor) &&
      participant.refId === parsedActor.id
    ) {
      throw new MeetingError("conflict", "use leave to remove yourself");
    }
    const timestamp = nowIso(this.options.now);
    const removed = {
      ...participant,
      status: "left" as const,
      leftAt: timestamp,
      updatedAt: timestamp,
    };
    const operator = caller?.displayName ?? parsedActor.id;
    await this.tables.participants.put(removed.id, removed);
    const systemMessageId = randomUUID();
    await this.tables.messages.put(systemMessageId, {
      id: systemMessageId,
      sequence: (this.transcript(meeting.id).at(-1)?.sequence ?? 0) + 1,
      meetingId: meeting.id,
      senderKind: "system",
      senderId: "system",
      senderName: "系统",
      content: `${participant.displayName} 已被 ${operator} 移出会议。`,
      mentions: [],
      deliveries: [],
      createdAt: timestamp,
    });
    await this.reportForDelegation(removed, false);
    return removed;
  }

  private async reportForDelegation(
    participant: MeetingParticipant,
    finalize: boolean,
  ): Promise<void> {
    if (
      participant.delegationId === undefined ||
      this.delegationReporter === undefined
    )
      return;
    const transcript = this.transcript(participant.meetingId)
      .map((message) => `${message.senderName}: ${message.content}`)
      .join("\n");
    // 会后个人报告是增值产物：委托记录缺失或生成失败时不应阻塞会议生命周期
    // （离会/关闭/归档），否则关闭会议会卡在「delegation does not exist」。
    try {
      await this.delegationReporter.generateDelegationReport(
        participant.delegationId,
        transcript,
        { finalize },
      );
    } catch {
      // 报告失败已在上游记录，这里仅保证会议状态机继续推进。
    }
  }

  private delegationState(participant: MeetingParticipant) {
    if (participant.delegationId === undefined) return undefined;
    const status = this.delegationReporter?.getDelegationStatus?.(
      participant.delegationId,
    );
    return status === undefined
      ? undefined
      : resolvedDelegationStatus(
          status.status,
          status.expiresAt,
          this.options.now(),
        );
  }

  private async appendSystemMessage(meetingId: string, content: string) {
    const timestamp = nowIso(this.options.now);
    const message = parseMessage({
      id: randomUUID(),
      sequence: (this.transcript(meetingId).at(-1)?.sequence ?? 0) + 1,
      meetingId,
      senderKind: "system",
      senderId: "system",
      senderName: "系统",
      content,
      mentions: [],
      deliveries: [],
      createdAt: timestamp,
    });
    await this.tables.messages.put(message.id, message);
    return message;
  }

  /** Public entry used for minutes delivery and pending-confirmation notices. */
  async postSystemMessage(
    meetingId: string,
    content: string,
  ): Promise<MeetingMessage> {
    this.get(meetingId);
    return this.appendSystemMessage(meetingId, content);
  }

  async spawnAgent(
    actor: MeetingActor,
    input: {
      readonly meetingId: string;
      readonly personaId?: string;
      readonly basePersonaId?: string;
      readonly displayName?: string;
      readonly provider?: string;
    },
    personas: PersonaServiceLike | undefined,
  ): Promise<MeetingParticipant> {
    const parsedActor = parseOrInvalid(actorSchema, actor);
    if (parsedActor.kind !== "agent")
      throw new MeetingError(
        "forbidden",
        "an exact live Agent must spawn a meeting Agent",
      );
    const parsed = parseOrInvalid(
      z.object({
        meetingId: z.string().min(1).max(160),
        personaId: idSchema.optional(),
        basePersonaId: idSchema.optional(),
        displayName: displayNameSchema.optional(),
        provider: z.string().trim().min(1).max(80).default("spawn"),
      }),
      input,
    );
    const meeting = this.get(parsed.meetingId);
    if (meeting.status !== "active")
      throw new MeetingError("conflict", "meeting is closed");
    const participants = this.participants(meeting.id);
    const personaId = parsed.personaId;
    let persona: Awaited<ReturnType<PersonaServiceLike["get"]>> | undefined;
    if (personas !== undefined && personaId !== undefined) {
      persona = await personas.get(personaId);
    }
    const displayName =
      parsed.displayName ??
      persona?.name ??
      `Agent-${randomUUID().slice(0, 8)}`;
    if (
      participants.some(
        (candidate) =>
          candidate.status !== "pending" &&
          candidate.displayName.trim().toLowerCase() ===
            displayName.trim().toLowerCase(),
      )
    )
      throw new MeetingError("conflict", "participant name is already used");
    const timestamp = nowIso(this.options.now);
    const participant = workerParticipant({
      id: randomUUID(),
      meetingId: meeting.id,
      kind: "agent",
      refId: "worker",
      displayName,
      ...(personaId === undefined ? {} : { personaId }),
      ...(parsed.basePersonaId === undefined
        ? {}
        : { basePersonaId: parsed.basePersonaId }),
      leader: false,
      status: "active",
      source: "spawned",
      joinedAt: timestamp,
      updatedAt: timestamp,
    });
    await this.tables.participants.put(participant.id, participant);
    return participant;
  }

  async spawnAgentForUser(
    actor: MeetingActor,
    input: {
      readonly meetingId: string;
      readonly personaId: string;
      readonly basePersonaId?: string;
      readonly displayName?: string;
      readonly provider?: string;
      readonly autoSpeak: "all" | "mentions" | "manual";
      readonly initialGreeting: boolean;
      readonly ownerName: string;
      readonly ownerEmployeeId?: string;
      readonly delegationId?: string;
    },
    personas: PersonaServiceLike,
  ): Promise<MeetingParticipant> {
    const parsedActor = parseOrInvalid(actorSchema, actor);
    if (parsedActor.kind !== "user")
      throw new MeetingError(
        "forbidden",
        "only humans can dispatch meeting agents",
      );
    const parsed = parseOrInvalid(
      z.object({
        meetingId: z.string().min(1).max(160),
        personaId: idSchema,
        basePersonaId: idSchema.optional(),
        displayName: displayNameSchema.optional(),
        provider: z.string().trim().min(1).max(80).default("spawn"),
        autoSpeak: z.enum(["all", "mentions", "manual"]),
        initialGreeting: z.boolean(),
        ownerName: displayNameSchema,
        ownerEmployeeId: idSchema.optional(),
        delegationId: idSchema.optional(),
      }),
      input,
    );
    const meeting = this.get(parsed.meetingId);
    if (meeting.status !== "active")
      throw new MeetingError("conflict", "meeting is closed");
    const requester = this.participants(meeting.id).find(
      (participant) =>
        participant.kind === "human" &&
        participant.refId === parsedActor.id &&
        participant.status === "active",
    );
    if (requester === undefined)
      throw new MeetingError(
        "forbidden",
        "join the meeting before dispatching an agent",
      );
    const persona = await personas.get(parsed.personaId);
    // 幂等：同一个人用同一个 persona 再 spawn 一次时，复用已有参与者更新配置。
    // 否则会新建第二条同名参与者，被 uniqueAgentName 改名成「名字 · Agent」，
    // 成员面板/@ 列表里就会出现两个看起来一样的 agent。
    // 复用键用「同一 owner + 同一基础名（或同一 persona）」而不是仅 persona：
    // 同一 teammate 反复 dispatch 时 persona/basePersona 的解析结果可能不同。
    const baseName = parsed.displayName ?? persona.name;
    const existingAgent = this.participants(meeting.id).find(
      (participant) =>
        participant.status === "active" &&
        participant.kind === "agent" &&
        participant.ownerId === parsedActor.id &&
        (participant.personaId === persona.id ||
          participant.displayName === baseName ||
          participant.displayName.startsWith(`${baseName} · `)),
    );
    if (existingAgent !== undefined) {
      const reused = parseParticipant({
        ...existingAgent,
        autoSpeak: parsed.autoSpeak,
        initialGreeting: parsed.initialGreeting,
        updatedAt: nowIso(this.options.now),
      });
      await this.tables.participants.put(reused.id, reused);
      return reused;
    }
    const displayName = uniqueAgentName(
      this.participants(meeting.id),
      parsed.displayName ?? persona.name,
      parsed.ownerName,
    );
    const timestamp = nowIso(this.options.now);
    const participant = workerParticipant({
      id: randomUUID(),
      meetingId: meeting.id,
      kind: "agent",
      refId: "worker",
      displayName,
      personaId: persona.id,
      ...(parsed.basePersonaId === undefined
        ? {}
        : { basePersonaId: parsed.basePersonaId }),
      ownerId: parsedActor.id,
      ownerName: parsed.ownerName,
      autoSpeak: parsed.autoSpeak,
      initialGreeting: parsed.initialGreeting,
      ...(parsed.ownerEmployeeId === undefined
        ? {}
        : { principalType: "delegation" as const }),
      ...(parsed.delegationId === undefined
        ? {}
        : { delegationId: parsed.delegationId }),
      leader: false,
      status: "active",
      source: "spawned",
      joinedAt: timestamp,
      updatedAt: timestamp,
    });
    await this.tables.participants.put(participant.id, participant);
    return participant;
  }

  async attachParent(
    meetingId: string,
    parentSessionId: string,
  ): Promise<Meeting> {
    const parsedParent = parseOrInvalid(idSchema, parentSessionId);
    const meeting = this.get(meetingId);
    if (meeting.status !== "active")
      throw new MeetingError("conflict", "meeting is closed");
    if (meeting.parentSessionId !== undefined) return meeting;
    const attached = {
      ...meeting,
      parentSessionId: parsedParent,
      updatedAt: nowIso(this.options.now),
    };
    await this.tables.meetings.put(attached.id, attached);
    return attached;
  }

  async post(
    actor: MeetingActor,
    meetingId: string,
    content: string,
    options: {
      readonly mentions?: readonly string[];
      readonly attachments?: NonNullable<MeetingMessage["attachments"]>;
    } = {},
  ): Promise<MeetingMessage> {
    const parsedActor = parseOrInvalid(actorSchema, actor);
    const meeting = this.get(meetingId);
    if (meeting.status !== "active")
      throw new MeetingError("conflict", "meeting is closed");
    const parsedContent = parseOrInvalid(textSchema, content);
    const mentionedIds = new Set(options.mentions ?? []);
    const participants = this.participants(meeting.id);
    // Parse `@名字` straight from the text so「被点名」works even when the GUI
    // did not attach an id (typed mention, or a client without autocomplete).
    for (const participant of participants) {
      if (participant.status !== "active") continue;
      if (
        participant.kind === actorKind(parsedActor) &&
        participant.refId === parsedActor.id
      )
        continue;
      const name = participant.displayName.trim();
      if (name !== "" && parsedContent.includes(`@${name}`))
        mentionedIds.add(participant.id);
    }
    if (
      ![...mentionedIds].every((participantId) =>
        participants.some((participant) => participant.id === participantId),
      )
    ) {
      throw new MeetingError(
        "invalid_input",
        "mention targets must be meeting participants",
      );
    }
    const sender = participants.find(
      (participant) =>
        participant.status === "active" &&
        participant.kind === actorKind(parsedActor) &&
        participant.refId === parsedActor.id,
    );
    if (sender === undefined)
      throw new MeetingError(
        "forbidden",
        "meeting participant role is required",
      );
    const transcript = this.transcript(meeting.id);
    const sequence = transcript.at(-1)?.sequence ?? 0;
    const timestamp = nowIso(this.options.now);
    // Reap before selecting targets: a participant whose own recorded delivery
    // already reported its agent unavailable can never resume, and reselecting
    // it would queue another doomed delivery on every later message.
    await this.reapUnavailableParticipants(meeting.id, transcript);
    const current = this.participants(meeting.id);
    const mentionedPrincipals = new Set(
      current
        .filter(
          (participant) =>
            participant.kind === "human" && mentionedIds.has(participant.id),
        )
        .map((participant) => participant.refId),
    );
    const targets = current.filter(
      (participant) =>
        participant.status === "active" &&
        AI_PARTICIPANT_KINDS.includes(participant.kind) &&
        participant.refId !== sender.refId &&
        (mentionedIds.size === 0 ||
          mentionedIds.has(participant.id) ||
          (participant.principalUserId !== undefined &&
            mentionedPrincipals.has(participant.principalUserId))) &&
        (participant.autoSpeak ?? "all") !== "manual" &&
        (mentionedIds.size > 0 || (participant.autoSpeak ?? "all") === "all"),
    );
    const message = {
      id: randomUUID(),
      sequence: sequence + 1,
      meetingId: meeting.id,
      senderKind: actorKind(parsedActor),
      senderId: parsedActor.id,
      senderName: sender.displayName,
      content: parsedContent,
      mentions: [...mentionedIds],
      ...(options.attachments === undefined
        ? {}
        : { attachments: options.attachments }),
      deliveries: targets.map((participant) => ({
        participantId: participant.id,
        targetId: participant.refId,
        status: "pending" as const,
      })),
      createdAt: timestamp,
    };
    await this.tables.messages.put(message.id, parseMessage(message));
    this.onTranscriptChanged?.(meeting.id);
    return this.transcript(meeting.id).at(-1) ?? message;
  }

  /** Writes a runtime-produced reply under the exact meeting participant scope. */
  async postWorkerReply(
    participantId: string,
    content: string,
  ): Promise<MeetingMessage> {
    const participant = this.tables.participants.get(participantId);
    if (participant === undefined)
      throw new MeetingError("not_found", "meeting participant not found");
    const current = parseParticipant(participant);
    const meeting = this.get(current.meetingId);
    if (meeting.status !== "active")
      throw new MeetingError("conflict", "meeting is closed");
    if (
      !AI_PARTICIPANT_KINDS.includes(current.kind) ||
      current.status !== "active"
    )
      throw new MeetingError("forbidden", "active meeting agent is required");
    const delegationStatus = this.delegationState(current);
    if (delegationStatus !== undefined && delegationStatus !== "active") {
      const reason =
        delegationStatus === "expired"
          ? "已到期"
          : delegationStatus === "paused"
            ? "已暂停"
            : delegationStatus === "revoked"
              ? "已被召回"
              : "已完成";
      await this.appendSystemMessage(
        meeting.id,
        `${current.displayName} 的委托${reason}，暂不能继续自动发言。请主人延期、恢复委托，或另行指派。`,
      );
      throw new MeetingError("conflict", `delegation is ${delegationStatus}`);
    }
    const parsedContent = parseOrInvalid(textSchema, content);
    const timestamp = nowIso(this.options.now);
    const provenance =
      current.kind === "ai_representative"
        ? {
            role: "representative" as const,
            ...(current.teammateInstanceId === undefined
              ? {}
              : { teammateInstanceId: current.teammateInstanceId }),
            ...(current.delegationId === undefined
              ? {}
              : { delegateId: current.delegationId }),
          }
        : current.kind === "ai_teammate"
          ? {
              role: "teammate" as const,
              ...(current.teammateInstanceId === undefined
                ? {}
                : { teammateInstanceId: current.teammateInstanceId }),
            }
          : undefined;
    const message = {
      id: randomUUID(),
      sequence: (this.transcript(meeting.id).at(-1)?.sequence ?? 0) + 1,
      meetingId: meeting.id,
      senderKind: "agent" as const,
      senderId: current.refId,
      senderName: current.displayName,
      content: parsedContent,
      mentions: [],
      ...(provenance === undefined ? {} : { provenance }),
      deliveries: [],
      createdAt: timestamp,
    };
    await this.tables.messages.put(message.id, parseMessage(message));
    const pending = [...this.transcript(meeting.id)]
      .reverse()
      .find((candidate) =>
        candidate.deliveries.some(
          (delivery) =>
            delivery.participantId === current.id &&
            delivery.status === "pending",
        ),
      );
    if (pending !== undefined) {
      await this.markDelivery(pending.id, current.id, "delivered");
    }
    this.onTranscriptChanged?.(meeting.id);
    return message;
  }

  async markDelivery(
    messageId: string,
    participantId: string,
    status: "delivered" | "failed",
    error?: string,
  ): Promise<void> {
    const current = this.tables.messages.get(messageId);
    if (current === undefined) return;
    const message = parseMessage(current);
    const deliveries = message.deliveries.map((delivery) =>
      delivery.participantId === participantId
        ? {
            ...delivery,
            status,
            at: nowIso(this.options.now),
            ...(error === undefined ? {} : { error: error.slice(0, 500) }),
          }
        : delivery,
    );
    await this.tables.messages.put(
      message.id,
      parseMessage({ ...message, deliveries }),
    );
  }

  async close(
    actor: MeetingActor,
    meetingId: string,
    summary: string,
  ): Promise<Meeting> {
    const parsedActor = parseOrInvalid(actorSchema, actor);
    const meeting = this.get(meetingId);
    if (meeting.status !== "active")
      throw new MeetingError("conflict", "meeting is closed");
    const parsedSummary = parseOrInvalid(textSchema, summary);
    const participants = this.participants(meeting.id);
    const caller = participants.find(
      (participant) =>
        participant.status === "active" &&
        participant.kind === actorKind(parsedActor) &&
        participant.refId === parsedActor.id,
    );
    // Product decision: any active human participant may close a meeting.
    // Owner/leader/manager are no longer required; an inactive or non-human
    // caller is still rejected.
    if (parsedActor.kind !== "user" || caller === undefined)
      throw new MeetingError(
        "forbidden",
        "an active human participant is required to close the meeting",
      );
    const timestamp = nowIso(this.options.now);
    const closed = {
      ...meeting,
      status: "closed" as const,
      closedAt: timestamp,
      closedBy: parsedActor.id,
      summary: parsedSummary,
      updatedAt: timestamp,
    };
    await this.tables.meetings.put(closed.id, closed);
    const systemMessage = {
      id: randomUUID(),
      sequence: (this.transcript(meeting.id).at(-1)?.sequence ?? 0) + 1,
      meetingId: closed.id,
      senderKind: "system" as const,
      senderId: "system",
      senderName: "系统",
      content: `会议关闭。\n${parsedSummary}`,
      mentions: [],
      deliveries: [],
      createdAt: timestamp,
    };
    await this.tables.messages.put(systemMessage.id, systemMessage);
    for (const participant of participants) {
      if (participant.status !== "active") continue;
      await this.tables.participants.put(participant.id, {
        ...participant,
        status: "left",
        leftAt: timestamp,
        updatedAt: timestamp,
      });
      await this.reportForDelegation({ ...participant, status: "left" }, true);
    }
    this.onTranscriptChanged?.(closed.id);
    this.onMeetingClosed?.(closed.id);
    return closed;
  }

  /**
   * Archives a closed meeting. Any human who took part may archive it; a
   * workspace owner/admin keeps an override. Closing first is required so the
   * archive never races the auto minutes trigger.
   */
  async archive(actor: MeetingActor, meetingId: string): Promise<Meeting> {
    const parsedActor = parseOrInvalid(actorSchema, actor);
    const meeting = this.get(meetingId);
    if (meeting.status !== "closed")
      throw new MeetingError(
        "conflict",
        "only a closed meeting can be archived",
      );
    const tookPart = this.participants(meeting.id).some(
      (participant) =>
        participant.kind === "human" && participant.refId === parsedActor.id,
    );
    if (
      parsedActor.kind !== "user" ||
      (!tookPart && !managerActor(parsedActor))
    )
      throw new MeetingError(
        "forbidden",
        "a human participant or workspace owner role is required",
      );
    const timestamp = nowIso(this.options.now);
    const archived = {
      ...meeting,
      status: "archived" as const,
      archivedAt: timestamp,
      archivedBy: parsedActor.id,
      updatedAt: timestamp,
    };
    await this.tables.meetings.put(archived.id, archived);
    await this.appendSystemMessage(meeting.id, "会议已归档。");
    this.onTranscriptChanged?.(archived.id);
    return archived;
  }

  /**
   * 修改会议名称/议程。按产品口径，标题与议程的修改权只保留在会议负责人
   * （ownerUserId，回退到 createdBy）手上，普通参会人只能聊天与邀请。
   */
  async update(
    actor: MeetingActor,
    meetingId: string,
    input: { title?: string; agenda?: string },
  ): Promise<Meeting> {
    const parsedActor = parseOrInvalid(actorSchema, actor);
    const meeting = this.get(meetingId);
    if (meeting.status === "archived")
      throw new MeetingError("conflict", "archived meeting is read-only");
    const owner = meeting.ownerUserId ?? meeting.createdBy;
    if (parsedActor.kind !== "user" || parsedActor.id !== owner)
      throw new MeetingError(
        "forbidden",
        "only the meeting owner can edit the title or agenda",
      );
    const parsed = parseOrInvalid(
      z.object({
        title: titleSchema.optional(),
        agenda: z.string().trim().max(20_000).optional(),
      }),
      input,
    );
    if (parsed.title === undefined && parsed.agenda === undefined)
      throw new MeetingError("invalid_input", "nothing to update");
    const timestamp = nowIso(this.options.now);
    const renamed =
      parsed.title !== undefined && parsed.title !== meeting.title;
    const next = parseMeeting({
      ...meeting,
      ...(parsed.title === undefined ? {} : { title: parsed.title }),
      ...(parsed.agenda === undefined ? {} : { agenda: parsed.agenda }),
      updatedAt: timestamp,
    });
    await this.tables.meetings.put(next.id, next);
    if (renamed) {
      await this.appendSystemMessage(
        meeting.id,
        `会议名称已更新为「${next.title}」。`,
      );
      this.onTranscriptChanged?.(next.id);
    }
    return next;
  }

  /**
   * Invites a team AI Teammate as an ordinary participant (it represents its
   * own role, not a person). Used when the meeting wants a standing AI member
   * rather than a per-person representative.
   */
  async addAiTeammate(
    actor: MeetingActor,
    input: {
      readonly meetingId: string;
      readonly teammateInstanceId: string;
      readonly displayName: string;
      readonly speechMode: "observe" | "mention" | "key_topic" | "active";
      readonly personaId?: string;
      /** false = 静默加入（存量数据补偿），不追加「进入会议」系统消息。 */
      readonly announce?: boolean;
    },
  ): Promise<MeetingParticipant> {
    parseOrInvalid(actorSchema, actor);
    const parsed = parseOrInvalid(
      z.object({
        meetingId: z.string().min(1).max(160),
        teammateInstanceId: idSchema,
        displayName: displayNameSchema,
        speechMode: z.enum(["observe", "mention", "key_topic", "active"]),
        personaId: idSchema.optional(),
        announce: z.boolean().optional(),
      }),
      input,
    );
    const meeting = this.get(parsed.meetingId);
    if (meeting.status !== "active")
      throw new MeetingError("conflict", "meeting is closed");
    const autoSpeak =
      parsed.speechMode === "observe"
        ? "manual"
        : parsed.speechMode === "mention"
          ? "mentions"
          : "all";
    const timestamp = nowIso(this.options.now);
    const existing = this.participants(meeting.id).find(
      (participant) =>
        participant.kind === "ai_teammate" &&
        participant.refId === parsed.teammateInstanceId,
    );
    const participant: MeetingParticipant = parseParticipant({
      ...existing,
      id: existing?.id ?? randomUUID(),
      meetingId: meeting.id,
      kind: "ai_teammate",
      refId: parsed.teammateInstanceId,
      displayName: parsed.displayName,
      ...(parsed.personaId === undefined
        ? {}
        : { personaId: parsed.personaId }),
      teammateInstanceId: parsed.teammateInstanceId,
      autoSpeak,
      leader: false,
      status: "active",
      source: "direct",
      joinedAt: existing?.joinedAt ?? timestamp,
      leftAt: undefined,
      updatedAt: timestamp,
    });
    await this.tables.participants.put(participant.id, participant);
    if (
      parsed.announce !== false &&
      (existing === undefined || existing.status !== "active")
    )
      await this.appendSystemMessage(
        meeting.id,
        parsed.teammateInstanceId === MEETING_FACILITATOR_TEAMMATE_ID
          ? "会议 Facilitator 已加入会议。"
          : `${parsed.displayName} 已作为 AI 成员加入会议。`,
      );
    return participant;
  }
}

/* ── 会议纪要 Facilitator ── */

/** 平台归属「会议 Facilitator」AI Teammate 的固定 id（数据种子）。 */
export const MEETING_FACILITATOR_TEAMMATE_ID = "meeting-facilitator";
/** 「会议 Facilitator」席位对应的人格 id（与 collab-roles 的 facilitator seat 一致）。 */
export const MEETING_FACILITATOR_PERSONA_ID = "persona-meeting-facilitator";
/** 纪要 run 的节点 id：工作台按它筛选会议来源的 agent run。 */
export const MEETING_MINUTES_NODE_ID = "meeting-minutes";
export const MEETING_AI_CHAT_NODE_ID = "meeting-ai-chat";

const MEETING_MINUTES_TIMEOUT_MS = 120_000;
/**
 * 纪要 prompt 的对话窗口：默认喂最近 100 条沟通记录 —— Facilitator 进会后
 * 发生的对话基本都落在这个窗口内（超过 100 条时以最近的为准），这样任何时刻
 * 触发都能基于"它看到过的会议内容"产出纪要，而不是只有零星几条。
 * 仍对总长度截尾，避免超过 run 的 prompt 上限。
 */
const MEETING_MINUTES_WINDOW = 100;
const MEETING_MINUTES_TRANSCRIPT_LIMIT = 60_000;

interface MeetingMinutesRunLike {
  readonly id?: string;
  readonly dispatchKey: string;
  readonly status: string;
  readonly output?: { readonly summary?: string } | undefined;
  readonly error?: string | undefined;
  readonly endedAt?: string | undefined;
}

interface MeetingMinutesAgentServiceLike {
  dispatch(input: {
    readonly workspaceId: string;
    readonly profileId: string;
    readonly source: "meeting";
    readonly instanceId: string;
    readonly nodeId: string;
    readonly dispatchKey: string;
    readonly trigger: "manual-dispatch" | "auto-on-ready";
    readonly attempt: number;
    readonly runSeq: number;
    readonly maxAttempts: number;
    readonly timeoutMs: number;
    readonly personaId?: string | undefined;
    readonly employeeId?: string | undefined;
    readonly principalId?: string | undefined;
    readonly principalType?:
      | "transitional-agent"
      | "digital-employee"
      | "principal-runtime"
      | undefined;
    readonly payload: {
      readonly instanceTitle: string;
      readonly nodeName: string;
      readonly nodeDescription: string;
      readonly profileName: string;
      readonly context: Record<string, string | number | boolean>;
      readonly deliverables: readonly unknown[];
    };
    readonly createdBy: string;
  }): Promise<unknown>;
  runs(filter: {
    readonly workspaceId?: string;
    readonly instanceId?: string;
    readonly nodeId?: string;
  }): readonly MeetingMinutesRunLike[];
}

/**
 * 会议纪要生成：用 Facilitator 的平台运行身份（teammate runtime
 * ensureRuntime）派发一次 agent run，结果写进 run 的 output.summary。
 *
 * 触发点只有两处：会议关闭时的单次自动触发，以及页面上的手动
 * trigger。它不再随每条消息变化而生成——那是早期的过度实现，会让每条
 * 发言都调一次模型并产出无人确认的版本。读取 / 轮询路径不会调模型。
 */
export class FacilitatorMinutesService {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly deps: {
      readonly meetings: MeetingService;
      readonly agents: () => MeetingMinutesAgentServiceLike | undefined;
      readonly teammateRuntime: () => TeammateRuntimeLike | undefined;
      readonly team: () => TeamServiceLike | undefined;
      readonly files?: () => MeetingFileService | undefined;
    },
  ) {}

  /** 事件触发入口：按会议串行，失败静默（卡片走散会摘要回退链）。 */
  schedule(meetingId: string): void {
    const previous = this.running.get(meetingId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.generate(meetingId))
      .catch(() => undefined)
      .finally(() => {
        if (this.running.get(meetingId) === next) {
          this.running.delete(meetingId);
        }
      });
    this.running.set(meetingId, next);
  }

  async waitIdle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()]);
    }
  }

  /**
   * 平台 teammate 的首次运行身份需要 workspace owner / admin 才能开通；
   * 优先用会议创建者（若是 owner），否则取该 workspace 的第一位 owner。
   */
  private actorFor(
    meeting: Meeting,
  ): { userId: string; name: string; role: "owner" } | undefined {
    const team = this.deps.team?.();
    if (team === undefined) return undefined;
    const members = workspaceMembers(team, meeting.workspaceId);
    const candidate =
      members.find(
        (member) =>
          member.userId === meeting.createdBy && member.memberRole === "owner",
      ) ?? members.find((member) => member.memberRole === "owner");
    if (candidate === undefined) return undefined;
    return {
      userId: candidate.userId,
      name: candidate.name ?? candidate.userId,
      role: "owner",
    };
  }

  /**
   * Dispatches (or finds) the bounded minutes run for a meeting.
   *
   * Returns the run identifiers so the phase-1 minutes runtime can await the
   * result and write it into the single minutes object. Returns `undefined`
   * when generation is not applicable: runtime unavailable, no dialogue, or no
   * workspace owner able to open the facilitator identity.
   */
  async dispatchMinutes(
    meetingId: string,
  ): Promise<{ runId?: string; dispatchKey: string } | undefined> {
    const agents = this.deps.agents?.();
    const teammateRuntime = this.deps.teammateRuntime?.();
    if (agents === undefined || teammateRuntime === undefined) return;
    const meeting = this.deps.meetings.get(meetingId);
    const transcript = this.deps.meetings.transcript(meetingId);
    const last = transcript.at(-1);
    if (last === undefined) return;
    // 无对话（只有加入/关闭等系统消息）不调模型，卡片直接显示「暂无对话记录」。
    const dialogue = transcript.filter(
      (message) => message.senderKind !== "system",
    );
    if (dialogue.length === 0) return;
    // 缓存 key：会议 id + 最后一条消息（条数 + 时间）。
    const dispatchKey = `${meetingId}:minutes:${last.sequence}:${last.createdAt}`;
    const existing = agents.runs({
      workspaceId: meeting.workspaceId,
      instanceId: meetingId,
      nodeId: MEETING_MINUTES_NODE_ID,
    });
    if (existing.some((run) => run.dispatchKey === dispatchKey))
      return { dispatchKey };
    const actor = this.actorFor(meeting);
    if (actor === undefined) return;
    const ensured = await teammateRuntime.ensureRuntime({
      teammateId: MEETING_FACILITATOR_TEAMMATE_ID,
      workspaceId: meeting.workspaceId,
      actor,
    });
    const run = await agents.dispatch({
      workspaceId: meeting.workspaceId,
      profileId: ensured.profileId,
      source: "meeting",
      instanceId: meetingId,
      nodeId: MEETING_MINUTES_NODE_ID,
      dispatchKey,
      trigger: "auto-on-ready",
      attempt: 1,
      runSeq: 1,
      maxAttempts: 1,
      timeoutMs: MEETING_MINUTES_TIMEOUT_MS,
      ...(ensured.personaId === undefined
        ? {}
        : { personaId: ensured.personaId }),
      ...(ensured.employeeId === undefined
        ? {}
        : { employeeId: ensured.employeeId }),
      ...(ensured.principalId === undefined
        ? {}
        : { principalId: ensured.principalId }),
      principalType:
        ensured.employeeId === undefined
          ? "principal-runtime"
          : "digital-employee",
      payload: {
        instanceTitle: meeting.title,
        nodeName: "会议纪要",
        nodeDescription: meeting.agenda,
        profileName: "会议 Facilitator",
        context: {
          transcript: dialogue
            .slice(-MEETING_MINUTES_WINDOW)
            .map((message) => `${message.senderName}: ${message.content}`)
            .join("\n")
            .slice(-MEETING_MINUTES_TRANSCRIPT_LIMIT),
          // 把会议关联的文本文件内容直接喂给 Facilitator，避免模型尝试用工具
          // 去找文件（无工具时会把工具调用标记写进纪要）。
          files: (this.deps.files?.()?.list(meetingId) ?? [])
            .filter(
              (file) =>
                /text|markdown|json|csv/i.test(file.mime) ||
                /\.(md|markdown|txt|json|csv)$/i.test(file.name),
            )
            .map(
              (file) =>
                `### ${file.name}\n${Buffer.from(file.data, "base64")
                  .toString("utf8")
                  .slice(0, 4_000)}`,
            )
            .join("\n\n")
            .slice(-8_000),
        },
        deliverables: [],
      },
      createdBy: actor.userId,
    });
    const runId =
      typeof run === "object" && run !== null && "id" in run
        ? (run as { readonly id?: unknown }).id
        : undefined;
    return {
      dispatchKey,
      ...(typeof runId === "string" ? { runId } : {}),
    };
  }

  /** Reads back a dispatched run's terminal status and summary text. */
  minutesRun(
    meetingId: string,
    dispatchKey: string,
  ): { status: string; content?: string; error?: string } | undefined {
    const agents = this.deps.agents?.();
    if (agents === undefined) return undefined;
    let meeting: Meeting;
    try {
      meeting = this.deps.meetings.get(meetingId);
    } catch {
      return undefined;
    }
    const run = agents
      .runs({
        workspaceId: meeting.workspaceId,
        instanceId: meetingId,
        nodeId: MEETING_MINUTES_NODE_ID,
      })
      .find((candidate) => candidate.dispatchKey === dispatchKey);
    if (run === undefined) return undefined;
    return {
      status: run.status,
      ...(run.output?.summary === undefined
        ? {}
        : { content: run.output.summary }),
      ...(run.error === undefined ? {} : { error: run.error }),
    };
  }

  private async generate(meetingId: string): Promise<void> {
    await this.dispatchMinutes(meetingId);
  }
}

interface CommandResultLike {
  readonly kind: "success" | "error";
  readonly text: string;
}

interface ToolOutputLike {
  readonly schema: { readonly type: "string" };
  render(
    args: Record<string, never>,
    value: string,
  ): Array<{ type: "text"; text: string }>;
}

export interface WebRouteLike {
  readonly kind: "exact";
  readonly path: string;
  handler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> | void;
}

interface TeamServiceLike {
  resolveToken(token: string): { userId: string; role: string } | undefined;
  users?(): Array<{
    id: string;
    name: string;
    role: string;
    status: string;
  }>;
  members(workspaceId: string): Array<{
    userId: string;
    memberRole: string;
    name?: string;
  }>;
}

interface EmployeeServiceLike {
  getByAuthUserId(authUserId: string):
    | {
        readonly id: string;
        readonly displayName: string;
      }
    | undefined;
  createDelegation(
    ownerAuthUserId: string,
    input: {
      displayName?: string;
      personaId?: string;
      workspaceId: string;
      ownerWorkspaceRole?: "viewer" | "member" | "owner";
      contextType: "meeting";
      contextId: string;
      objective: string;
      stance?: string;
      watchItems?: readonly string[];
      allowedActions: readonly string[];
      deniedActions?: readonly string[];
      speakPolicy: "manual" | "mentions" | "all";
      approvalPolicy: "never" | "suggest" | "explicit-only";
      durationMinutes?: number;
    },
  ): Promise<{ readonly id: string }>;
  attachParticipant(
    delegationId: string,
    participantId: string,
  ): Promise<unknown>;
  getDelegationStatus(
    delegationId: string,
  ): { status: string; expiresAt?: string } | undefined;
  generateDelegationReport(
    delegationId: string,
    transcript: string,
    options: { finalize?: boolean },
  ): Promise<unknown>;
}

interface AgentsServiceLike {
  get(id: string): AgentLike | undefined;
}

interface ToolExecLike {
  readonly signal: AbortSignal;
  readonly callId?: unknown;
  readonly agent?: AgentLike;
}

interface ToolDefinitionLike {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: ToolOutputLike;
  execute(args: unknown, exec: ToolExecLike): Promise<string>;
}

export interface MeetingContext {
  effect(register: () => () => void): void;
  /** Cordis 事件总线：订阅任务域变更，用于把 run 产出回写会议群聊。 */
  on?(event: string, handler: (payload: unknown) => void): unknown;
  provide(key: "collabMeeting", value: MeetingService): unknown;
  provide(key: "collabMeetingMinutes", value: MeetingMinutesService): unknown;
  provide(
    key: "collabMeetingMinutesRuntime",
    value: MeetingMinutesRuntime,
  ): unknown;
  provide(
    key: "collabMeetingDelegates",
    value: MeetingDelegateService,
  ): unknown;
  provide(key: "collabMeetingReads", value: MeetingReadService): unknown;
  provide(key: "collabMeetingFiles", value: MeetingFileService): unknown;
  provide(key: "collabMeetingTasks", value: MeetingTaskService): unknown;
  commands: {
    register(definition: {
      name: string;
      description: string;
      input: { hint: string; attachments: boolean };
      handler(invocation: { readonly rawInput: string }): CommandResultLike;
    }): unknown;
  };
  tools: { register(definition: ToolDefinitionLike): unknown };
  webServer: { register(route: WebRouteLike): unknown };
  storageDomain: {
    open(spec: typeof meetingDomainSpec): Promise<MeetingDomainLike>;
  };
  collabTeam?: TeamServiceLike;
  collabEmployee?: EmployeeServiceLike;
  collabPersonas?: PersonaServiceLike;
  agents?: AgentRegistryLike;
  agentDefaultModel?: AgentDefaultModelLike;
  subagents?: SubagentsRuntimeLike;
  get(key: "collabPersonas"): PersonaServiceLike | undefined;
  get(key: "agents"): AgentsServiceLike | undefined;
  get(key: "collabAgent"): MeetingMinutesAgentServiceLike | undefined;
  get(key: "subagents"): SubagentsRuntimeLike | undefined;
  get(key: "collabEmployee"): EmployeeServiceLike | undefined;
  get(key: "collabTeammateRuntime"): TeammateRuntimeLike | undefined;
  /** 任务域（dsh-collab-task 提供）；未安装时为 undefined，会议降级不建任务。 */
  get(key: "collabTasks"): TaskServiceLike | undefined;
  get(key: "collabTaskDispatch"): TaskDispatchLike | undefined;
  get(key: "collabPrincipal"): PrincipalServiceLike | undefined;
  get(key: "workspaceRegistry"): WorkspaceRegistryLike | undefined;
  get(key: "collabContext"): ContextServiceLike | undefined;
  get(key: "collabMemory"): MemoryIngestLike | undefined;
  inject(
    keys: readonly ["collabEmployee"],
    callback: (
      child: Omit<MeetingContext, "collabEmployee"> & {
        readonly collabEmployee?: EmployeeServiceLike;
      },
    ) => void,
  ): { dispose(): void };
  inject(
    keys: readonly ["collabTeam"],
    callback: (
      child: MeetingContext & { readonly collabTeam: TeamServiceLike },
    ) => void,
  ): { dispose(): void };
  inject(
    keys: readonly ["collabContext"],
    callback: () => void,
  ): { dispose(): void };
}

interface PrincipalServiceLike {
  resolveReference(reference: string):
    | {
        readonly id: string;
        readonly kind: "human" | "ai";
        readonly status: "active" | "suspended" | "archived";
      }
    | undefined;
  preferredSubjectId(
    principalId: string,
    subjectTypes: readonly ("auth-user" | "employee" | "teammate" | "hrm")[],
  ): string | undefined;
}

function workspaceMembers(
  team: TeamServiceLike,
  workspaceId: string,
): Array<{ userId: string; memberRole: string; name?: string }> {
  if (workspaceId !== SYSTEM_DEFAULT_WORKSPACE_ID)
    return team.members(workspaceId);
  return (team.users?.() ?? [])
    .filter((user) => user.status === "active")
    .map((user) => ({
      userId: user.id,
      memberRole: user.role === "admin" ? "owner" : "member",
      name: user.name,
    }));
}

function browserActor(
  team: TeamServiceLike,
  request: IncomingMessage,
  workspaceId: string,
): MeetingActor {
  const headers = request.headers;
  if (
    headers.origin !== undefined &&
    !sameOrigin(headers.origin, headers.host)
  ) {
    throw new MeetingError("forbidden", "same-origin requests are required");
  }
  const token = bearerToken({
    get: (name) =>
      name === "authorization" ? (headers.authorization ?? null) : null,
  });
  if (token === undefined)
    throw new MeetingError("unauthorized", "bearer token is required");
  const principal = team.resolveToken(token);
  if (principal === undefined)
    throw new MeetingError("unauthorized", "invalid bearer token");
  const member = workspaceMembers(team, workspaceId).find(
    (candidate) => candidate.userId === principal.userId,
  );
  if (member === undefined && principal.role !== "admin")
    throw new MeetingError("forbidden", "workspace member role is required");
  return {
    kind: "user",
    id: principal.userId,
    globalRole: principal.role as MeetingActor["globalRole"],
    ...(member === undefined
      ? {}
      : { workspaceRole: member.memberRole as MeetingActor["workspaceRole"] }),
  };
}

function errorStatus(code: MeetingError["code"]): number {
  if (code === "invalid_input") return 400;
  if (code === "unauthorized") return 401;
  if (code === "forbidden") return 403;
  if (code === "not_found") return 404;
  return 409;
}

async function runHandler(
  operation: () => Promise<void>,
  response: ServerResponse,
): Promise<void> {
  try {
    await operation();
  } catch (cause) {
    if (cause instanceof MeetingError) {
      sendJson(response, errorStatus(cause.code), {
        ok: false,
        error: { code: cause.code, message: cause.message },
      });
      return;
    }
    if (cause instanceof Error && cause.name === "EmployeeError") {
      const code = Reflect.get(cause, "code") as MeetingError["code"];
      const message =
        cause.message === "owner must have an active workspace role"
          ? "派遣前请先给当前真人员工配置工作区授权"
          : cause.message;
      sendJson(response, errorStatus(code), {
        ok: false,
        error: { code, message },
      });
      return;
    }
    sendJson(response, 500, {
      ok: false,
      error: { code: "internal_error", message: "meeting operation failed" },
    });
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  try {
    return await readJsonBody(request);
  } catch {
    throw new MeetingError("invalid_input", "valid JSON body is required");
  }
}

function queryParam(
  request: IncomingMessage,
  name: string,
): string | undefined {
  return (
    new URL(request.url ?? "/", "http://localhost").searchParams.get(name) ??
    undefined
  );
}

function requireQuery(request: IncomingMessage, name: string): string {
  const value = queryParam(request, name);
  if (value === undefined || value === "")
    throw new MeetingError("invalid_input", `${name} is required`);
  return value;
}

export function createMeetingRoutes(
  meetings: MeetingService,
  team: TeamServiceLike,
  dependencies: {
    readonly agents?: () => AgentsServiceLike | undefined;
    readonly personas?: () => PersonaServiceLike | undefined;
    readonly subagents?: () => SubagentsRuntimeLike | undefined;
    readonly runtime?: () => MeetingRuntime | undefined;
    readonly employees?: () => EmployeeServiceLike | undefined;
    readonly teammateRuntime?: () => TeammateRuntimeLike | undefined;
    readonly minutes?: () => MeetingMinutesService | undefined;
    readonly minutesRuntime?: () => MeetingMinutesRuntime | undefined;
    readonly delegates?: () => MeetingDelegateService | undefined;
    readonly reads?: () => MeetingReadService | undefined;
    readonly files?: () => MeetingFileService | undefined;
    readonly tasks?: () => MeetingTaskService | undefined;
    /** 任务域：会议里的 AI 参会方据此建「会议」任务并派发会话。 */
    readonly taskService?: () => TaskServiceLike | undefined;
    readonly taskDispatch?: () => TaskDispatchLike | undefined;
    readonly principals?: () => PrincipalServiceLike | undefined;
    readonly chatAgent?: () => ChatAgentServiceLike | undefined;
    readonly workspaces?: () => WorkspaceRegistryLike | undefined;
    readonly context?: () => ContextServiceLike | undefined;
  } = {},
): WebRouteLike[] {
  const resolveAgentReference = (
    reference: string,
    preferred: readonly ("employee" | "teammate")[],
  ): string => {
    const principals = dependencies.principals?.();
    const principal = principals?.resolveReference(reference);
    if (principals === undefined || principal === undefined) return reference;
    if (principal.kind !== "ai") {
      throw new MeetingError(
        "invalid_input",
        "AI 参会代表必须绑定 AI Principal",
      );
    }
    if (principal.status === "archived") {
      throw new MeetingError("conflict", "已归档 AI Principal 不能参会");
    }
    return principals.preferredSubjectId(principal.id, preferred) ?? reference;
  };
  const memberNames = (workspaceId: string) =>
    new Map(
      workspaceMembers(team, workspaceId).map((member) => [
        member.userId,
        member.name ?? member.userId,
      ]),
    );
  const canAccessMeeting = (meeting: Meeting, actor: MeetingActor): boolean => {
    if (meeting.kind !== "ai") return true;
    if (managerActor(actor) || meeting.createdBy === actor.id) return true;
    if (meeting.teammateInstanceId === undefined) return false;
    const runtime = dependencies.teammateRuntime?.();
    const primaryOwner = runtime?.ownerOf?.(meeting.teammateInstanceId);
    const owners =
      runtime?.ownersOf?.(meeting.teammateInstanceId) ??
      (primaryOwner === undefined ? [] : [primaryOwner]);
    return owners.some((owner) => owner.userId === actor.id);
  };
  const canListMeeting = (meeting: Meeting, actor: MeetingActor): boolean =>
    meeting.kind !== "ai" || meeting.createdBy === actor.id;
  const assertMeetingAccess = (meeting: Meeting, actor: MeetingActor): void => {
    if (canAccessMeeting(meeting, actor)) return;
    throw new MeetingError(
      "forbidden",
      "AI伙伴私聊仅对会话用户、对应 Owner 或管理员可见",
    );
  };
  const assertGroupMeeting = (meeting: Meeting): void => {
    if (meeting.kind === "ai") {
      throw new MeetingError(
        "forbidden",
        "AI伙伴一对一对话不支持会议成员、委托或纪要操作",
      );
    }
  };
  const meetingActor = (
    meeting: Meeting,
    request: IncomingMessage,
  ): MeetingActor => {
    const actor = browserActor(team, request, meeting.workspaceId);
    assertMeetingAccess(meeting, actor);
    return actor;
  };
  const activeHumanCaller = (
    meeting: Meeting,
    actor: MeetingActor,
  ): MeetingParticipant => {
    const caller = meetings
      .participants(meeting.id)
      .find(
        (candidate) =>
          candidate.status === "active" &&
          candidate.kind === actorKind(actor) &&
          candidate.refId === actor.id,
      );
    if (actor.kind !== "user" || caller === undefined)
      throw new MeetingError(
        "forbidden",
        "an active human participant is required",
      );
    return caller;
  };
  const ownerCaller = (meeting: Meeting, actor: MeetingActor): void => {
    const owner = meeting.ownerUserId ?? meeting.createdBy;
    if (actor.kind !== "user" || (actor.id !== owner && !managerActor(actor)))
      throw new MeetingError(
        "forbidden",
        "only the meeting owner can confirm minutes",
      );
  };
  const dispatchAiChat = async (input: {
    readonly meeting: Meeting;
    readonly participant: MeetingParticipant;
    readonly message: MeetingMessage;
    readonly actor: MeetingActor;
  }): Promise<AgentRunLike | undefined> => {
    const agent = dependencies.chatAgent?.();
    const teammateRuntime = dependencies.teammateRuntime?.();
    if (agent === undefined || teammateRuntime === undefined) return undefined;
    const teammateId =
      input.participant.teammateInstanceId ?? input.participant.refId;
    const actorName =
      memberNames(input.meeting.workspaceId).get(input.actor.id) ??
      input.actor.id;
    const ensured = await teammateRuntime.ensureRuntime({
      teammateId,
      workspaceId: input.meeting.workspaceId,
      actor: {
        userId: input.actor.id,
        name: actorName,
        role:
          input.actor.globalRole === "admin"
            ? "admin"
            : input.actor.workspaceRole === "owner"
              ? "owner"
              : input.actor.workspaceRole === "guest"
                ? "guest"
                : "member",
      },
    });
    const workspacePath = dependencies
      .workspaces?.()
      ?.get(input.meeting.workspaceId)?.path;
    const transcript = meetings
      .transcript(input.meeting.id)
      .filter((message) => message.id !== input.message.id)
      .slice(-TRANSCRIPT_WINDOW)
      .map((message) => `${message.senderName}: ${message.content}`)
      .join("\n");
    const previousRuns =
      agent.runs?.({
        workspaceId: input.meeting.workspaceId,
        instanceId: input.meeting.id,
        nodeId: MEETING_AI_CHAT_NODE_ID,
      }) ?? [];
    const agentPrincipalId = ensured.principalId ?? teammateId;
    const context = dependencies.context?.();
    const fallbackChannelId = [
      input.meeting.workspaceId,
      input.actor.id,
      teammateId,
    ]
      .join(":")
      .replace(/[^a-zA-Z0-9._-]/g, "-");
    const chatChannel =
      context === undefined
        ? undefined
        : await context.ensureChatChannel({
            workspaceId: input.meeting.workspaceId,
            userPrincipalId: input.actor.id,
            agentPrincipalId,
            teammateInstanceId: teammateId,
            carrier: "meeting-ai",
            carrierRefId: input.meeting.id,
          });
    const chatChannelId = chatChannel?.id ?? fallbackChannelId;
    const contextPack =
      context === undefined
        ? undefined
        : await context.prepare({
            requestId: `meeting-ai:${input.meeting.id}:${input.message.id}`,
            mode: "execute",
            scene: "chat",
            chatCarrier: "meeting-ai",
            chatChannelId,
            workspaceId: input.meeting.workspaceId,
            objectId: chatChannelId,
            agentPrincipalId,
            teammateId,
            actorPrincipalId: input.actor.id,
            input: {
              type: "user-message",
              messageId: input.message.id,
              content: input.message.content,
              attachments: [],
            },
            explicitRefs: [],
            pinnedMemoryIds: [],
            excludedSourceIds: [],
            runtimeCapabilities: {
              contextWindowTokens: 32_000,
              maxOutputTokens: 4_000,
              supportsSystemSections: true,
              isStateless: ensured.execution === "external",
            },
          });
    const contextSession =
      context !== undefined && contextPack?.sessionBindingId !== undefined
        ? context.session?.(contextPack.sessionBindingId)
        : undefined;
    const run = await agent.dispatch({
      workspaceId: input.meeting.workspaceId,
      ...(workspacePath === undefined ? {} : { workspacePath }),
      profileId: ensured.profileId,
      source: "chat",
      instanceId: input.meeting.id,
      nodeId: MEETING_AI_CHAT_NODE_ID,
      dispatchKey: `meeting-ai:${input.meeting.id}:${input.message.id}`,
      trigger: "manual-dispatch",
      attempt: 1,
      runSeq: previousRuns.length + 1,
      maxAttempts: 1,
      timeoutMs: 120_000,
      ...(ensured.personaId === undefined
        ? {}
        : { personaId: ensured.personaId }),
      ...(ensured.employeeId === undefined
        ? {}
        : { employeeId: ensured.employeeId }),
      ...(ensured.principalId === undefined
        ? {}
        : {
            principalId: ensured.principalId,
            principalType: "principal-runtime" as const,
          }),
      ...(contextPack?.id === undefined
        ? {}
        : { contextPackId: contextPack.id }),
      ...(contextPack?.sessionBindingId === undefined
        ? {}
        : { sessionBindingId: contextPack.sessionBindingId }),
      ...(ensured.execution === "external" || contextSession === undefined
        ? {}
        : { sessionId: contextSession.sessionId }),
      payload: {
        instanceTitle: input.meeting.title,
        nodeName: "AI 1:1 对话",
        nodeDescription: "",
        profileName: input.participant.displayName,
        deliverables: [],
        context: {
          instruction: contextPack?.rendered.userText ?? input.message.content,
          transcript,
          chatChannelId,
          chatUserId: input.actor.id,
          teammateId,
          participantId: input.participant.id,
          meetingId: input.meeting.id,
          messageId: input.message.id,
          ...(contextPack === undefined
            ? {}
            : { contextPackId: contextPack.id }),
        },
      },
      createdBy: input.actor.id,
    });
    if (context !== undefined && contextPack !== undefined) {
      await context.recordRuntime({
        runId: run.id,
        contextPackId: contextPack.id,
        runtime: {
          kind: ensured.execution === "external" ? "external" : "builtin",
        },
      });
    }
    return run;
  };
  const requireMinutes = (): MeetingMinutesService => {
    const service = dependencies.minutes?.();
    if (service === undefined)
      throw new MeetingError(
        "not_found",
        "meeting minutes service is unavailable",
      );
    return service;
  };
  /**
   * Facilitator 是会议成员：关闭席位时把它从成员列表移除（置 left），
   * 让成员列表与「参会次数」统计同源。成员状态异常不影响席位关闭结果。
   */
  const removeFacilitatorParticipant = async (
    meetingId: string,
    actor: MeetingActor,
  ): Promise<void> => {
    const participant = meetings
      .participants(meetingId)
      .find(
        (candidate) =>
          candidate.status === "active" &&
          candidate.kind === "ai_teammate" &&
          (candidate.teammateInstanceId ?? candidate.refId) ===
            MEETING_FACILITATOR_TEAMMATE_ID,
      );
    if (participant === undefined) return;
    try {
      await meetings.removeParticipant(actor, meetingId, participant.id);
    } catch {
      // 已不在成员列表时忽略：席位关闭不因成员状态回退而失败。
    }
  };
  const requireMinutesRuntime = (): MeetingMinutesRuntime => {
    const service = dependencies.minutesRuntime?.();
    if (service === undefined)
      throw new MeetingError("not_found", "minutes runtime is unavailable");
    return service;
  };
  const requireDelegates = (): MeetingDelegateService => {
    const service = dependencies.delegates?.();
    if (service === undefined)
      throw new MeetingError(
        "not_found",
        "meeting delegate service is unavailable",
      );
    return service;
  };
  const requireReads = (): MeetingReadService => {
    const service = dependencies.reads?.();
    if (service === undefined)
      throw new MeetingError(
        "not_found",
        "meeting read service is unavailable",
      );
    return service;
  };
  const requireFiles = (): MeetingFileService => {
    const service = dependencies.files?.();
    if (service === undefined)
      throw new MeetingError(
        "not_found",
        "meeting file service is unavailable",
      );
    return service;
  };
  const requireTasks = (): MeetingTaskService => {
    const service = dependencies.tasks?.();
    if (service === undefined)
      throw new MeetingError(
        "not_found",
        "meeting task service is unavailable",
      );
    return service;
  };
  const routes = [
    {
      method: "GET",
      path: "/api/collab/meetings",
      handler: (request: IncomingMessage, response: ServerResponse) => {
        const workspaceId = requireQuery(request, "workspaceId");
        const actor = browserActor(team, request, workspaceId);
        const visibleMeetings = meetings
          .list(workspaceId)
          .filter((meeting) => canListMeeting(meeting, actor))
          .map((meeting) => {
            const transcript = meetings.transcript(meeting.id);
            const conversation = transcript.filter(
              (message) => message.senderKind !== "system",
            );
            const lastMessage = conversation.at(-1);
            const lastReadSeq =
              dependencies.reads?.()?.lastReadSeq(meeting.id, actor.id) ?? 0;
            return {
              ...meeting,
              messageCount: conversation.length,
              unreadCount: conversation.filter(
                (message) =>
                  message.sequence > lastReadSeq &&
                  !(
                    message.senderKind === "human" &&
                    message.senderId === actor.id
                  ),
              ).length,
              lastMessage:
                lastMessage === undefined
                  ? null
                  : {
                      id: lastMessage.id,
                      senderKind: lastMessage.senderKind,
                      senderName: lastMessage.senderName,
                      content: lastMessage.content.slice(0, 240),
                      createdAt: lastMessage.createdAt,
                    },
              lastActivityAt: lastMessage?.createdAt ?? meeting.updatedAt,
            };
          });
        sendJson(response, 200, {
          ok: true,
          meetings: visibleMeetings,
          actorId: actor.id,
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meetings",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            workspaceId: idSchema.optional(),
            title: titleSchema,
            kind: z.enum(["meeting", "ai"]).default("meeting"),
            teammateInstanceId: idSchema.optional(),
            teammateName: displayNameSchema.optional(),
            agenda: textSchema.optional(),
            displayName: displayNameSchema.optional(),
            parentSessionId: idSchema.optional(),
          }),
          await readBody(request),
        );
        const workspaceId = body.workspaceId ?? SYSTEM_DEFAULT_WORKSPACE_ID;
        const actor = browserActor(team, request, workspaceId);
        if (body.kind === "ai" && body.teammateInstanceId === undefined)
          throw new MeetingError(
            "invalid_input",
            "teammateInstanceId is required for an AI conversation",
          );
        if (body.kind === "ai" && body.teammateInstanceId !== undefined) {
          const assignable = dependencies.teammateRuntime?.()?.assignable?.({
            userId: actor.id,
            name: memberNames(workspaceId).get(actor.id) ?? actor.id,
            role:
              actor.globalRole === "admin"
                ? "admin"
                : actor.workspaceRole === "owner"
                  ? "owner"
                  : actor.workspaceRole === "guest"
                    ? "guest"
                    : "member",
          });
          if (
            assignable !== undefined &&
            !assignable.some(
              (candidate) =>
                candidate.id === body.teammateInstanceId ||
                candidate.employeeId === body.teammateInstanceId,
            )
          ) {
            throw new MeetingError(
              "forbidden",
              "只能与可指派的 AI伙伴发起一对一对话",
            );
          }
        }
        const existing =
          body.kind === "ai"
            ? meetings
                .list(workspaceId)
                .find(
                  (meeting) =>
                    meeting.kind === "ai" &&
                    meeting.status === "active" &&
                    meeting.createdBy === actor.id &&
                    meeting.teammateInstanceId === body.teammateInstanceId,
                )
            : undefined;
        if (existing !== undefined) {
          const participants = meetings.participants(existing.id);
          sendJson(response, 200, {
            ok: true,
            meeting: existing,
            participant: participants.find(
              (participant) =>
                participant.kind === "human" && participant.refId === actor.id,
            ),
          });
          return;
        }
        const meeting = await meetings.create(actor, {
          ...body,
          workspaceId,
        });
        const participant = await meetings.join(
          actor,
          meeting.id,
          body.displayName ?? `用户-${actor.id.slice(0, 6)}`,
        );
        if (meeting.kind === "ai" && meeting.teammateInstanceId !== undefined) {
          await meetings.addAiTeammate(actor, {
            meetingId: meeting.id,
            teammateInstanceId: meeting.teammateInstanceId,
            displayName: body.teammateName ?? meeting.title,
            speechMode: "active",
            announce: false,
          });
        }
        // Phase 1 下线席位：建会不再默认物化「会议 Facilitator」席位。
        // 纪要服务改为由任意活跃人类参与者按需开启（/facilitator/open），
        // 旧的席位同步链路仅保留给历史数据。
        sendJson(response, 201, {
          ok: true,
          meeting,
          participant,
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/meeting",
      handler: (request: IncomingMessage, response: ServerResponse) => {
        const meetingId = requireQuery(request, "meetingId");
        const meeting = meetings.get(meetingId);
        const actor = meetingActor(meeting, request);
        const caller = meetings
          .participants(meeting.id)
          .find(
            (candidate) =>
              candidate.status === "active" &&
              candidate.kind === actorKind(actor) &&
              candidate.refId === actor.id,
          );
        const employees = dependencies.employees?.();
        const now = new Date();
        const participants = meetings
          .participants(meeting.id)
          .map((participant) => {
            if (participant.delegationId === undefined) return participant;
            const status = employees?.getDelegationStatus(
              participant.delegationId,
            );
            if (status === undefined) return participant;
            return {
              ...participant,
              delegationStatus: resolvedDelegationStatus(
                status.status,
                status.expiresAt,
                now,
              ),
            };
          });
        sendJson(response, 200, {
          ok: true,
          meeting,
          participants,
          transcript: meetings.transcript(meeting.id),
          actorId: actor.id,
          canRemove:
            (actor.kind === "user" && caller !== undefined) ||
            managerActor(actor),
          canInvite:
            caller !== undefined ||
            meeting.createdBy === actor.id ||
            managerActor(actor),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/participant/remove",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            meetingId: z.string().min(1).max(160),
            participantId: z.string().min(1).max(160),
          }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        const participant = meetings
          .participants(meeting.id)
          .find((candidate) => candidate.id === body.participantId);
        const runtime = dependencies.runtime?.();
        if (runtime !== undefined)
          runtime.cancelParticipant(participant?.id ?? "");
        const removed = await meetings.removeParticipant(
          actor,
          meeting.id,
          body.participantId,
        );
        // 反向联动：从成员列表移除 Facilitator 等同于停用它的会议席位。
        if (
          removed.kind === "ai_teammate" &&
          (removed.teammateInstanceId ?? removed.refId) ===
            MEETING_FACILITATOR_TEAMMATE_ID
        ) {
          const minutes = requireMinutes();
          if (minutes.activeFacilitator(meeting.id) !== undefined) {
            try {
              await minutes.closeFacilitator(meeting.id, actor.id);
            } catch {
              // 已停用或并发关闭：成员移除结果不受影响。
            }
          }
        }
        sendJson(response, 200, {
          ok: true,
          participant: removed,
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/join",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            meetingId: z.string().min(1).max(160),
            displayName: displayNameSchema,
          }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        sendJson(response, 201, {
          ok: true,
          participant: await meetings.join(actor, meeting.id, body.displayName),
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/meeting/people",
      handler: (request: IncomingMessage, response: ServerResponse) => {
        const meetingId = requireQuery(request, "meetingId");
        const meeting = meetings.get(meetingId);
        meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        const currentByUser = new Map(
          meetings
            .participants(meeting.id)
            .filter((participant) => participant.kind === "human")
            .map((participant) => [participant.refId, participant]),
        );
        const people = workspaceMembers(team, meeting.workspaceId).map(
          (member) => {
            const current = currentByUser.get(member.userId);
            return {
              id: member.userId,
              name: member.name ?? member.userId,
              role: member.memberRole,
              participantId: current?.id,
              state: current?.status,
            };
          },
        );
        sendJson(response, 200, { ok: true, people });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/participants/invite",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            meetingId: z.string().min(1).max(160),
            people: z
              .array(
                z.object({
                  targetId: z.string().trim().min(1).max(160),
                }),
              )
              .min(1)
              .max(100),
          }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        const members = new Map(
          workspaceMembers(team, meeting.workspaceId).map((member) => [
            member.userId,
            member,
          ]),
        );
        const targets = new Set(body.people.map((person) => person.targetId));
        if (targets.size !== body.people.length)
          throw new MeetingError("invalid_input", "duplicate invite targets");
        const invited: MeetingParticipant[] = [];
        for (const person of body.people) {
          const member = members.get(person.targetId);
          if (member === undefined)
            throw new MeetingError(
              "invalid_input",
              "invite target must be a workspace member",
            );
          invited.push(
            await meetings.inviteParticipant(actor, meeting.id, {
              targetId: member.userId,
              displayName: member.name ?? member.userId,
            }),
          );
        }
        sendJson(response, 201, { ok: true, participants: invited });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/message",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            meetingId: z.string().min(1).max(160),
            content: textSchema,
            mentions: z.array(z.string().min(1).max(160)).max(100).optional(),
          }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        const message = await meetings.post(
          actor,
          meeting.id,
          body.content,
          body.mentions === undefined ? {} : { mentions: body.mentions },
        );
        const runtime = dependencies.runtime?.();
        const delivered = meetings
          .participants(meeting.id)
          .filter((participant) =>
            message.deliveries.some(
              (delivery) => delivery.participantId === participant.id,
            ),
          );
        if (meeting.kind === "ai") {
          for (const participant of delivered) {
            if (participant.kind === "human") continue;
            try {
              const run = await dispatchAiChat({
                meeting,
                participant,
                message,
                actor,
              });
              if (run === undefined) {
                runtime?.dispatch(message, [participant]);
              }
            } catch (cause) {
              const reason =
                cause instanceof Error ? cause.message : "AI对话派发失败";
              await meetings.markDelivery(
                message.id,
                participant.id,
                "failed",
                reason,
              );
              await meetings.postSystemMessage(
                meeting.id,
                `${participant.displayName} 暂时无法回复：${reason}`,
              );
            }
          }
          sendJson(response, 201, { ok: true, message });
          return;
        }
        // AI 参会方分流：已绑定「会议」任务的走任务会话链路（被动 @ / 主动监听
        // 都落到它自己的任务上，run 产出经 collab/task-changed 回写群聊）；
        // 没绑定任务的仍用一次性 worker 兜底。两条路径互斥，避免重复跑模型。
        const taskService = dependencies.taskService?.();
        const taskDispatch = dependencies.taskDispatch?.();
        // 任务域可用时 AI 参会方统一走任务会话链路（缺任务会按需补建），
        // 只有任务域不可用时才退回一次性 worker。
        const bridgeReady =
          taskService !== undefined && taskDispatch !== undefined;
        for (const participant of delivered) {
          if (participant.kind === "human") continue;
          if (!bridgeReady || participant.teammateInstanceId === undefined) {
            runtime?.dispatch(message, [participant]);
            continue;
          }
          void feedMeetingMessageToAgent({
            meeting,
            participant,
            message,
            senderName: message.senderName,
            taskService,
            taskDispatch,
          });
        }
        sendJson(response, 201, { ok: true, message });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/leave",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({ meetingId: z.string().min(1).max(160) }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        const participant = meetings
          .participants(meeting.id)
          .find(
            (candidate) =>
              candidate.kind === actorKind(actor) &&
              candidate.refId === actor.id,
          );
        const runtime = dependencies.runtime?.();
        if (runtime !== undefined)
          runtime.cancelParticipant(participant?.id ?? "");
        sendJson(response, 200, {
          ok: true,
          participant: await meetings.leave(actor, meeting.id),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/close",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            meetingId: z.string().min(1).max(160),
            summary: textSchema,
          }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        const runtime = dependencies.runtime?.();
        if (runtime !== undefined) runtime.cancelMeeting(meeting.id);
        sendJson(response, 200, {
          ok: true,
          meeting: await meetings.close(actor, meeting.id, body.summary),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/archive",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({ meetingId: z.string().min(1).max(160) }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        sendJson(response, 200, {
          ok: true,
          meeting: await meetings.archive(actor, meeting.id),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/update",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            meetingId: z.string().min(1).max(160),
            title: titleSchema.optional(),
            agenda: z.string().trim().max(20_000).optional(),
          }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        sendJson(response, 200, {
          ok: true,
          meeting: await meetings.update(actor, meeting.id, {
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.agenda === undefined ? {} : { agenda: body.agenda }),
          }),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/participant/ai",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            meetingId: z.string().min(1).max(160),
            teammateInstanceId: z.string().min(1).max(240),
            displayName: displayNameSchema,
            speechMode: z
              .enum(["observe", "mention", "key_topic", "active"])
              .default("mention"),
          }),
          await readBody(request),
        );
        const teammateInstanceId = resolveAgentReference(
          body.teammateInstanceId,
          ["teammate", "employee"],
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        activeHumanCaller(meeting, actor);
        let personaId: string | undefined;
        const teammateRuntime = dependencies.teammateRuntime?.();
        if (teammateRuntime !== undefined) {
          try {
            const ensured = await teammateRuntime.ensureRuntime({
              teammateId: teammateInstanceId,
              workspaceId: meeting.workspaceId,
              actor: {
                userId: actor.id,
                name:
                  memberNames(meeting.workspaceId).get(actor.id) ?? actor.id,
                role:
                  actor.globalRole === "admin"
                    ? "admin"
                    : actor.workspaceRole === "owner"
                      ? "owner"
                      : actor.workspaceRole === "guest"
                        ? "guest"
                        : "member",
              },
            });
            personaId = ensured.personaId;
          } catch {
            // best effort
          }
        }
        const participant = await meetings.addAiTeammate(actor, {
          meetingId: meeting.id,
          teammateInstanceId,
          displayName: body.displayName,
          speechMode: body.speechMode,
          ...(personaId === undefined ? {} : { personaId }),
        });
        // AI 参会方入会即建「会议」任务并派发会话：左侧项目树能看到它的运行过程。
        const agentTaskId = await ensureAgentMeetingTask({
          meeting,
          teammateInstanceId,
          teammateName: body.displayName,
          actorId: actor.id,
          actorName: memberNames(meeting.workspaceId).get(actor.id) ?? actor.id,
          taskService: dependencies.taskService?.(),
          taskDispatch: dependencies.taskDispatch?.(),
        });
        sendJson(response, 201, { ok: true, participant, agentTaskId });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/agent/dispatch",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            meetingId: z.string().min(1).max(160),
            personaId: idSchema.optional(),
            teammateId: idSchema.optional(),
            teammateName: displayNameSchema.optional(),
            basePersonaId: idSchema.optional(),
            parentSessionId: idSchema.optional(),
            displayName: displayNameSchema.optional(),
            autoSpeak: z
              .enum(["all", "mentions", "manual"])
              .default("mentions"),
            initialGreeting: z.boolean().default(true),
            objective: z.string().trim().min(1).max(4_000).optional(),
            stance: z.string().trim().max(4_000).optional(),
            watchItems: z
              .array(z.string().trim().min(1).max(500))
              .max(20)
              .optional(),
            allowedActions: z
              .array(z.string().trim().min(1).max(120))
              .max(100)
              .optional(),
            speakPolicy: z.enum(["manual", "mentions", "all"]).optional(),
            durationMinutes: z.number().int().min(1).max(10_080).optional(),
          }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        if (actor.kind !== "user")
          throw new MeetingError(
            "forbidden",
            "only humans can dispatch agents",
          );
        const participants = meetings.participants(meeting.id);
        const requester = participants.find(
          (participant) =>
            participant.kind === "human" &&
            participant.refId === actor.id &&
            participant.status === "active",
        );
        if (requester === undefined)
          throw new MeetingError(
            "forbidden",
            "join the meeting before dispatching an agent",
          );
        const runtime = dependencies.runtime?.();
        const personas = dependencies.personas?.();
        if (dependencies.subagents?.() === undefined)
          throw new MeetingError(
            "not_found",
            "meeting worker runtime is unavailable",
          );
        if (runtime === undefined)
          throw new MeetingError("not_found", "meeting runtime is unavailable");
        if (personas === undefined)
          throw new MeetingError(
            "not_found",
            "roles persona service is unavailable",
          );
        const employees = dependencies.employees?.();
        if (employees === undefined) {
          throw new MeetingError(
            "not_found",
            "employee service is unavailable",
          );
        }
        const owner = employees.getByAuthUserId(actor.id);
        if (owner === undefined) {
          throw new MeetingError(
            "forbidden",
            "Human Employee record is required",
          );
        }
        const ownerName =
          memberNames(meeting.workspaceId).get(actor.id) ??
          requester.displayName;
        const teammateRuntime = dependencies.teammateRuntime?.();
        let teammatePersonaId: string | undefined;
        if (body.teammateId !== undefined) {
          if (teammateRuntime === undefined) {
            throw new MeetingError("not_found", "AI伙伴运行身份不可用");
          }
          const ensured = await teammateRuntime.ensureRuntime({
            teammateId: body.teammateId,
            workspaceId: meeting.workspaceId,
            actor: {
              userId: actor.id,
              name: ownerName,
              role: actor.globalRole ?? actor.workspaceRole ?? "member",
            },
          });
          teammatePersonaId = ensured.personaId;
        }
        const personaId = body.personaId ?? teammatePersonaId;
        if (personaId === undefined) {
          throw new MeetingError(
            "invalid_input",
            "personaId 或 teammateId 必填",
          );
        }
        const ownerWorkspaceRole =
          actor.workspaceRole === "owner" || actor.workspaceRole === "member"
            ? actor.workspaceRole
            : actor.globalRole === "admin"
              ? "owner"
              : undefined;
        const delegation = await employees.createDelegation(actor.id, {
          displayName:
            body.displayName ??
            `${ownerName} · ${meeting.title.slice(0, 20)} 分身`,
          personaId,
          ...(body.teammateId === undefined
            ? {}
            : {
                teammateId: body.teammateId,
                ...(body.teammateName === undefined
                  ? {}
                  : { teammateName: body.teammateName }),
              }),
          workspaceId: meeting.workspaceId,
          ...(ownerWorkspaceRole === undefined ? {} : { ownerWorkspaceRole }),
          contextType: "meeting",
          contextId: meeting.id,
          objective:
            body.objective ??
            `代表 ${ownerName} 参加「${meeting.title}」，如实表达指定立场并汇报结论。`,
          ...(body.stance === undefined ? {} : { stance: body.stance }),
          ...(body.watchItems === undefined
            ? {}
            : { watchItems: body.watchItems }),
          allowedActions: body.allowedActions ?? [
            "meeting.read",
            "meeting.speak",
          ],
          deniedActions: [
            "approval.final",
            "employee.manage",
            "workflow.approve",
          ],
          speakPolicy: body.speakPolicy ?? body.autoSpeak,
          approvalPolicy: "never",
          ...(body.durationMinutes === undefined
            ? {}
            : { durationMinutes: body.durationMinutes }),
        });
        const participant = await meetings.spawnAgentForUser(
          actor,
          {
            meetingId: meeting.id,
            personaId,
            ...(body.basePersonaId === undefined
              ? {}
              : { basePersonaId: body.basePersonaId }),
            ...(body.displayName === undefined
              ? {}
              : { displayName: body.displayName }),
            autoSpeak: body.autoSpeak,
            initialGreeting: body.initialGreeting,
            ownerName,
            ownerEmployeeId: owner.id,
            delegationId: delegation.id,
          },
          personas,
        );
        await employees.attachParticipant(delegation.id, participant.id);
        if (body.initialGreeting) runtime.greet(participant);
        sendJson(response, 201, {
          ok: true,
          participant,
          delegation,
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/agent/trigger",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            meetingId: z.string().min(1).max(160),
            participantId: z.string().min(1).max(160),
          }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        const participant = meetings
          .participants(meeting.id)
          .find((candidate) => candidate.id === body.participantId);
        if (
          participant === undefined ||
          participant.status !== "active" ||
          participant.ownerId !== actor.id
        )
          throw new MeetingError(
            "forbidden",
            "only the owner can trigger this agent",
          );
        const runtime = dependencies.runtime?.();
        if (runtime === undefined)
          throw new MeetingError("not_found", "meeting runtime is unavailable");
        runtime.trigger(
          participant,
          "主人显式触发。请基于最近会议记录给出当前最有用的回应。",
        );
        sendJson(response, 202, { ok: true, participant });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/facilitator/open",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({ meetingId: z.string().min(1).max(160) }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        activeHumanCaller(meeting, actor);
        // 双向联动：Facilitator 是会议成员，开启席位后要在成员列表里出现。
        await meetings.addAiTeammate(actor, {
          meetingId: meeting.id,
          teammateInstanceId: MEETING_FACILITATOR_TEAMMATE_ID,
          displayName: "会议 Facilitator",
          speechMode: "observe",
          personaId: MEETING_FACILITATOR_PERSONA_ID,
        });
        const facilitator = await requireMinutes().openFacilitator(
          meeting.id,
          actor.id,
        );
        sendJson(response, 201, { ok: true, facilitator });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/facilitator/close",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({ meetingId: z.string().min(1).max(160) }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        activeHumanCaller(meeting, actor);
        const facilitator = await requireMinutes().closeFacilitator(
          meeting.id,
          actor.id,
        );
        // 双向联动：席位关闭后，成员列表里也不应再留着 Facilitator。
        await removeFacilitatorParticipant(meeting.id, actor);
        sendJson(response, 200, { ok: true, facilitator });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/facilitator/replace",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({ meetingId: z.string().min(1).max(160) }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        activeHumanCaller(meeting, actor);
        const facilitator = await requireMinutes().replaceFacilitator(
          meeting.id,
          actor.id,
        );
        sendJson(response, 201, { ok: true, facilitator });
      },
    },
    {
      method: "GET",
      path: "/api/collab/meeting/minutes",
      handler: (request: IncomingMessage, response: ServerResponse) => {
        const meetingId = requireQuery(request, "meetingId");
        const meeting = meetings.get(meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        const minutes = requireMinutes();
        sendJson(response, 200, {
          ok: true,
          minutes: minutes.minutes(meeting.id) ?? null,
          activeVersion: minutes.activeVersion(meeting.id) ?? null,
          versions: minutes.versions(meeting.id),
          facilitator: minutes.activeFacilitator(meeting.id) ?? null,
          actorId: actor.id,
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/minutes/trigger",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            meetingId: z.string().min(1).max(160),
            trigger: z.enum(["manual", "post_close_manual"]).optional(),
          }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        activeHumanCaller(meeting, actor);
        const version = await requireMinutesRuntime().trigger({
          meetingId: meeting.id,
          trigger: body.trigger ?? "manual",
          requestedBy: actor.id,
        });
        sendJson(response, 202, { ok: true, version });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/minutes/confirm",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            meetingId: z.string().min(1).max(160),
            versionId: z.string().min(1).max(160),
            content: z.string().max(400_000).optional(),
          }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        ownerCaller(meeting, actor);
        const version = await requireMinutes().confirmVersion({
          meetingId: meeting.id,
          versionId: body.versionId,
          confirmedBy: actor.id,
          ...(body.content === undefined ? {} : { content: body.content }),
        });
        // 待确认事项完成：编辑确认会生成新版本，两个 id 都要清掉。
        // 任务服务缺失时不阻塞确认本身。
        const tasks = dependencies.tasks?.();
        if (tasks !== undefined) {
          await tasks.completeByTarget(body.versionId, actor.id);
          if (version.id !== body.versionId)
            await tasks.completeByTarget(version.id, actor.id);
        }
        sendJson(response, 200, { ok: true, version });
      },
    },
    {
      method: "GET",
      path: "/api/collab/meeting/delegates",
      handler: (request: IncomingMessage, response: ServerResponse) => {
        const meetingId = requireQuery(request, "meetingId");
        const meeting = meetings.get(meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        sendJson(response, 200, {
          ok: true,
          delegates: requireDelegates().list(meeting.id),
          actorId: actor.id,
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/delegate/assign",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            meetingId: z.string().min(1).max(160),
            teammateInstanceId: z.string().min(1).max(240),
            employeeId: z.string().min(1).max(240).optional(),
            speechMode: z
              .enum(["observe", "mention", "key_topic", "active"])
              .optional(),
            instruction: delegateInstructionInputSchema.optional(),
          }),
          await readBody(request),
        );
        const teammateInstanceId = resolveAgentReference(
          body.teammateInstanceId,
          ["teammate", "employee"],
        );
        const employeeId =
          body.employeeId === undefined
            ? undefined
            : resolveAgentReference(body.employeeId, ["employee", "teammate"]);
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        activeHumanCaller(meeting, actor);
        const principalName =
          memberNames(meeting.workspaceId).get(actor.id) ?? actor.id;
        const assigned = await requireDelegates().assign({
          meetingId: meeting.id,
          principalUserId: actor.id,
          principalName,
          teammateInstanceId,
          ...(employeeId === undefined ? {} : { employeeId }),
          ...(body.speechMode === undefined
            ? {}
            : { speechMode: body.speechMode }),
          ...(body.instruction === undefined
            ? {}
            : { instruction: body.instruction }),
        });
        // Provision the teammate runtime and join the representative so the
        // delegate actually attends (target selection + worker dispatch).
        let personaId: string | undefined;
        let aiPrincipalId: string | undefined;
        const teammateRuntime = dependencies.teammateRuntime?.();
        if (teammateRuntime !== undefined) {
          try {
            const ensured = await teammateRuntime.ensureRuntime({
              teammateId: teammateInstanceId,
              workspaceId: meeting.workspaceId,
              actor: {
                userId: actor.id,
                name: principalName,
                role:
                  actor.globalRole === "admin"
                    ? "admin"
                    : actor.workspaceRole === "owner"
                      ? "owner"
                      : actor.workspaceRole === "guest"
                        ? "guest"
                        : "member",
              },
            });
            personaId = ensured.personaId;
            aiPrincipalId = ensured.principalId;
          } catch {
            // Runtime provisioning is best effort; the binding still exists and
            // the representative retries dispatch once the runtime is ready.
          }
        }
        const participant = await meetings.addAiRepresentative(actor, {
          meetingId: meeting.id,
          delegateId: assigned.delegate.id,
          principalUserId: actor.id,
          principalName,
          teammateInstanceId,
          speechMode: body.speechMode ?? "mention",
          ...(personaId === undefined ? {} : { personaId }),
          ...(aiPrincipalId === undefined ? {} : { aiPrincipalId }),
        });
        // 参会代表同样落到任务域：任务描述带上主人的嘱咐。
        const agentTaskId = await ensureAgentMeetingTask({
          meeting,
          teammateInstanceId,
          teammateName: `${principalName} 的 AI 参会代表`,
          actorId: actor.id,
          actorName: principalName,
          instruction: formatDelegateInstruction(assigned.instruction),
          taskService: dependencies.taskService?.(),
          taskDispatch: dependencies.taskDispatch?.(),
        });
        sendJson(response, 201, {
          ok: true,
          delegate: assigned.delegate,
          participant,
          agentTaskId,
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/delegate/update",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            delegateId: z.string().min(1).max(160),
            teammateInstanceId: z.string().min(1).max(240).optional(),
            employeeId: z.string().min(1).max(240).optional(),
            speechMode: z
              .enum(["observe", "mention", "key_topic", "active"])
              .optional(),
            instruction: delegateInstructionInputSchema.optional(),
          }),
          await readBody(request),
        );
        const teammateInstanceId =
          body.teammateInstanceId === undefined
            ? undefined
            : resolveAgentReference(body.teammateInstanceId, [
                "teammate",
                "employee",
              ]);
        const employeeId =
          body.employeeId === undefined
            ? undefined
            : resolveAgentReference(body.employeeId, ["employee", "teammate"]);
        const delegates = requireDelegates();
        const meeting = meetings.get(delegates.get(body.delegateId).meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        const updated = await delegates.update({
          delegateId: body.delegateId,
          actorUserId: actor.id,
          ...(teammateInstanceId === undefined ? {} : { teammateInstanceId }),
          ...(employeeId === undefined ? {} : { employeeId }),
          ...(body.speechMode === undefined
            ? {}
            : { speechMode: body.speechMode }),
          ...(body.instruction === undefined
            ? {}
            : { instruction: body.instruction }),
        });
        const updatedMeeting = meetings.get(updated.delegate.meetingId);
        const representative =
          updatedMeeting.status === "active"
            ? await meetings.addAiRepresentative(actor, {
                meetingId: updatedMeeting.id,
                delegateId: updated.delegate.id,
                principalUserId: updated.delegate.principalUserId,
                principalName: updated.delegate.principalName,
                teammateInstanceId: updated.delegate.teammateInstanceId,
                speechMode: updated.delegate.speechMode,
              })
            : undefined;
        sendJson(response, 200, {
          ok: true,
          delegate: updated.delegate,
          ...(representative === undefined
            ? {}
            : { participant: representative }),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/delegate/state",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            delegateId: z.string().min(1).max(160),
            status: z.enum(["active", "paused", "revoked"]),
          }),
          await readBody(request),
        );
        const delegates = requireDelegates();
        const meeting = meetings.get(delegates.get(body.delegateId).meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        const delegate =
          body.status === "active"
            ? await delegates.resume(body.delegateId, actor.id)
            : body.status === "paused"
              ? await delegates.pause(body.delegateId, actor.id)
              : await delegates.revoke(body.delegateId, actor.id);
        if (body.status === "revoked")
          await meetings.removeAiRepresentative(body.delegateId);
        sendJson(response, 200, { ok: true, delegate });
      },
    },
    {
      method: "GET",
      path: "/api/collab/meeting/delegate/instruction",
      handler: (request: IncomingMessage, response: ServerResponse) => {
        const delegateId = requireQuery(request, "delegateId");
        const delegates = requireDelegates();
        const meeting = meetings.get(delegates.get(delegateId).meetingId);
        const actor = meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        sendJson(response, 200, {
          ok: true,
          instruction: delegates.instructionFor(delegateId, actor.id),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/read",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            meetingId: z.string().min(1).max(160),
            lastReadSeq: z.number().int().nonnegative(),
          }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        const read = await requireReads().markRead(
          meeting.id,
          actor.id,
          body.lastReadSeq,
        );
        sendJson(response, 200, { ok: true, read });
      },
    },
    {
      method: "GET",
      path: "/api/collab/meeting/read",
      handler: (request: IncomingMessage, response: ServerResponse) => {
        const meetingId = requireQuery(request, "meetingId");
        const meeting = meetings.get(meetingId);
        const actor = meetingActor(meeting, request);
        const reads = requireReads();
        sendJson(response, 200, {
          ok: true,
          read: reads.read(meeting.id, actor.id) ?? {
            meetingId: meeting.id,
            userId: actor.id,
            lastReadSeq: 0,
          },
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/meeting/tasks",
      handler: (request: IncomingMessage, response: ServerResponse) => {
        const meetingId = requireQuery(request, "meetingId");
        const meeting = meetings.get(meetingId);
        meetingActor(meeting, request);
        assertGroupMeeting(meeting);
        const tasks = requireTasks();
        sendJson(response, 200, {
          ok: true,
          tasks: tasks.list(meeting.id),
          pending: tasks.pending(meeting.id),
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/meeting/files",
      handler: (request: IncomingMessage, response: ServerResponse) => {
        const meetingId = requireQuery(request, "meetingId");
        const meeting = meetings.get(meetingId);
        meetingActor(meeting, request);
        const files = requireFiles().list(meeting.id);
        sendJson(response, 200, {
          ok: true,
          files: files.map((file) => ({
            id: file.id,
            name: file.name,
            mime: file.mime,
            size: file.size,
            uploadedBy: file.uploadedBy,
            createdAt: file.createdAt,
          })),
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/meeting/file",
      handler: (request: IncomingMessage, response: ServerResponse) => {
        const fileId = requireQuery(request, "fileId");
        const file = requireFiles().get(fileId);
        const meeting = meetings.get(file.meetingId);
        meetingActor(meeting, request);
        sendJson(response, 200, { ok: true, file });
      },
    },
    {
      method: "POST",
      path: "/api/collab/meeting/file",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            meetingId: z.string().min(1).max(160),
            name: z.string().trim().min(1).max(240),
            mime: z.string().trim().max(160).optional(),
            data: z.string().min(1).max(800_000),
          }),
          await readBody(request),
        );
        const meeting = meetings.get(body.meetingId);
        const actor = meetingActor(meeting, request);
        activeHumanCaller(meeting, actor);
        const file = await requireFiles().put({
          meetingId: meeting.id,
          uploadedBy: actor.id,
          name: body.name,
          ...(body.mime === undefined ? {} : { mime: body.mime }),
          data: body.data,
        });
        const message = await meetings.post(
          actor,
          meeting.id,
          `上传了文件：${file.name}`,
          {
            attachments: [
              {
                id: file.id,
                name: file.name,
                mime: file.mime,
                size: file.size,
                storageRef: file.id,
              },
            ],
          },
        );
        sendJson(response, 201, {
          ok: true,
          file: {
            id: file.id,
            name: file.name,
            mime: file.mime,
            size: file.size,
          },
          message,
        });
      },
    },
  ];
  return [...new Set(routes.map((route) => route.path))].map((path) => ({
    kind: "exact" as const,
    path,
    handler: (request: IncomingMessage, response: ServerResponse) =>
      runHandler(async () => {
        const route = routes.find(
          (candidate) =>
            candidate.path === path && candidate.method === request.method,
        );
        if (route === undefined) {
          sendJson(response, 405, {
            ok: false,
            error: {
              code: "method_not_allowed",
              message: "method not allowed",
            },
          });
          return;
        }
        await route.handler(request, response);
      }, response),
  }));
}

const stringToolOutput: ToolOutputLike = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: value }],
};

function agentFromExec(exec: ToolExecLike): AgentLike | undefined {
  return exec.agent;
}

function actorFromExec(exec: ToolExecLike): MeetingActor {
  const agent = agentFromExec(exec);
  return agentActor(agent?.session?.id ?? agent?.id);
}

function commandOperation(
  meetings: MeetingService,
  rawInput: string,
): CommandResultLike {
  const parts = rawInput.trim().split(/\s+/).filter(Boolean);
  const [operation, second, ...rest] = parts;
  const actor = agentActor("agent-command");
  try {
    if (operation === undefined || operation === "list") {
      const workspaceId = second ?? "main";
      return {
        kind: "success",
        text:
          meetings
            .list(workspaceId)
            .map(
              (meeting) => `${meeting.id}\t${meeting.status}\t${meeting.title}`,
            )
            .join("\n") || "no meetings",
      };
    }
    if (operation === "create" && second !== undefined && rest.length > 0) {
      const title = rest.join(" ");
      void meetings
        .create(actor, { workspaceId: second, title })
        .catch(() => undefined);
      return { kind: "success", text: "meeting creation accepted" };
    }
    if (operation === "join" && second !== undefined && rest.length > 0) {
      void meetings.join(actor, second, rest.join(" ")).catch(() => undefined);
      return { kind: "success", text: "meeting join accepted" };
    }
    if (operation === "read" && second !== undefined) {
      const meeting = meetings.get(second);
      return {
        kind: "success",
        text: JSON.stringify({
          meetingId: meeting.id,
          title: meeting.title,
          status: meeting.status,
          messages: meetings.transcript(second),
        }),
      };
    }
    if (operation === "say" && second !== undefined && rest.length > 0) {
      void meetings.post(actor, second, rest.join(" ")).catch(() => undefined);
      return { kind: "success", text: "meeting message accepted" };
    }
    if (operation === "leave" && second !== undefined) {
      void meetings.leave(actor, second).catch(() => undefined);
      return { kind: "success", text: "meeting leave accepted" };
    }
    if (operation === "close" && second !== undefined && rest.length > 0) {
      void meetings.close(actor, second, rest.join(" ")).catch(() => undefined);
      return { kind: "success", text: "meeting close accepted" };
    }
  } catch (cause) {
    return {
      kind: "error",
      text: cause instanceof Error ? cause.message : String(cause),
    };
  }
  return {
    kind: "error",
    text: "usage: /meeting [list <workspace>] | create <workspace> <title> | join <meeting> <name> | read <meeting> | say <meeting> <text> | leave <meeting> | close <meeting> <summary>",
  };
}

function registerMeetingInterfaces(
  ctx: MeetingContext,
  meetings: MeetingService,
): void {
  ctx.commands.register({
    name: "meeting",
    description: "manage DSH Pluginmax meetings",
    input: {
      hint: "list [workspace] | create <workspace> <title> | join <meeting> <name> | read <meeting> | say <meeting> <text> | leave <meeting> | close <meeting> <summary>",
      attachments: false,
    },
    handler: (invocation) => commandOperation(meetings, invocation.rawInput),
  });
  ctx.tools.register({
    name: "collab_meeting",
    description:
      "Create or inspect meetings, join, speak, leave, or spawn a bounded meeting Agent.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: [
            "list",
            "create",
            "join",
            "read",
            "say",
            "leave",
            "close",
            "spawn",
          ],
        },
        workspaceId: { type: "string" },
        meetingId: { type: "string" },
        title: { type: "string" },
        displayName: { type: "string" },
        content: { type: "string" },
        summary: { type: "string" },
        personaId: { type: "string" },
        basePersonaId: { type: "string" },
        provider: { type: "string" },
      },
      required: ["operation"],
    },
    output: stringToolOutput,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted();
      const parsed = parseOrInvalid(
        z.object({
          operation: z.enum([
            "list",
            "create",
            "join",
            "read",
            "say",
            "leave",
            "close",
            "spawn",
          ]),
          workspaceId: idSchema.optional(),
          meetingId: z.string().min(1).max(160).optional(),
          title: titleSchema.optional(),
          displayName: displayNameSchema.optional(),
          content: textSchema.optional(),
          summary: textSchema.optional(),
          personaId: idSchema.optional(),
          basePersonaId: idSchema.optional(),
          provider: z.string().trim().min(1).max(80).optional(),
        }),
        args,
      );
      const actor = actorFromExec(exec);
      // 会议里只有人类能拉参会者进来：AI 调用会议工具时只允许「看」和「说」，
      // create / join / leave / close / spawn 一律拒绝（否则会出现 AI 自己拉人、
      // 甚至把自己重复拉进会里被改名成「名字 · Agent」的情况）。
      if (
        actor.kind !== "user" &&
        !["list", "read", "say"].includes(parsed.operation)
      ) {
        throw new MeetingError(
          "forbidden",
          "只有人类可以把参会者拉进会议；AI 只能查看会议与发言",
        );
      }
      if (parsed.operation === "list") {
        if (parsed.workspaceId === undefined)
          throw new MeetingError("invalid_input", "workspaceId is required");
        return meetings
          .list(parsed.workspaceId)
          .map(
            (meeting) => `${meeting.id}\t${meeting.status}\t${meeting.title}`,
          )
          .join("\n");
      }
      if (parsed.meetingId === undefined)
        throw new MeetingError("invalid_input", "meetingId is required");
      if (parsed.operation === "create") {
        if (parsed.workspaceId === undefined || parsed.title === undefined)
          throw new MeetingError(
            "invalid_input",
            "workspaceId and title are required",
          );
        const agent = agentFromExec(exec);
        const meeting = await meetings.create(actor, {
          workspaceId: parsed.workspaceId,
          title: parsed.title,
          ...(agent === undefined ? {} : { parentSessionId: agent.id }),
        });
        return `created meeting ${meeting.id}: ${meeting.title}`;
      }
      if (parsed.operation === "join") {
        if (parsed.displayName === undefined)
          throw new MeetingError("invalid_input", "displayName is required");
        const participant = await meetings.join(
          actor,
          parsed.meetingId,
          parsed.displayName,
        );
        return `joined ${participant.meetingId} as ${participant.displayName}`;
      }
      if (parsed.operation === "read") {
        const meeting = meetings.get(parsed.meetingId);
        return JSON.stringify({
          meetingId: meeting.id,
          title: meeting.title,
          status: meeting.status,
          messages: meetings.transcript(parsed.meetingId),
        });
      }
      if (parsed.operation === "say") {
        if (parsed.content === undefined)
          throw new MeetingError("invalid_input", "content is required");
        const message = await meetings.post(
          actor,
          parsed.meetingId,
          parsed.content,
        );
        return `message ${message.sequence} recorded`;
      }
      if (parsed.operation === "leave") {
        const participant = await meetings.leave(actor, parsed.meetingId);
        return `left ${participant.meetingId}; display name is retained`;
      }
      if (parsed.operation === "close") {
        const summary = parsed.summary ?? "";
        const meeting = await meetings.close(actor, parsed.meetingId, summary);
        return `closed ${meeting.id}`;
      }
      const participant = await meetings.spawnAgent(
        actor,
        {
          meetingId: parsed.meetingId,
          ...(parsed.personaId === undefined
            ? {}
            : { personaId: parsed.personaId }),
          ...(parsed.basePersonaId === undefined
            ? {}
            : { basePersonaId: parsed.basePersonaId }),
          ...(parsed.displayName === undefined
            ? {}
            : { displayName: parsed.displayName }),
          ...(parsed.provider === undefined
            ? {}
            : { provider: parsed.provider }),
        },
        ctx.get("collabPersonas"),
      );
      return `spawned ${participant.displayName} (${participant.id})`;
    },
  });
}

export async function apply(ctx: MeetingContext): Promise<void | (() => void)> {
  const domain = await ctx.storageDomain.open(meetingDomainSpec);
  // Mount is the one moment no dispatch can still be live, so the restart sweep
  // retires every dispatch-backed row at once; runtime delivery reaps the rest.
  await reapRestartedDispatchParticipants(
    domain.table("participants"),
    () => new Date(),
  );
  // Phase 1 正式下线席位 / Lead：清除 leader 并补齐人类 owner。
  // 席位记录不再读取，旧字段由记录 schema 在下次写入时丢弃。幂等。
  await migrateMeetingOwnership(
    domain.table("meetings"),
    domain.table("participants"),
    () => new Date(),
  );
  const meetings = new MeetingService({
    meetings: domain.table("meetings"),
    participants: domain.table("participants"),
    messages: domain.table("messages"),
  });
  const delegateInstructionRef: {
    current?: (delegateId: string) => string | undefined;
  } = {};
  const runtime = new MeetingRuntime({
    meetings,
    agents: () => ctx.agents,
    defaultModel: () => ctx.agentDefaultModel,
    personas: () => ctx.get("collabPersonas"),
    subagents: () => ctx.get("subagents"),
    delegateInstruction: (delegateId) =>
      delegateInstructionRef.current?.(delegateId),
  });
  ctx.provide("collabMeeting", meetings);
  ctx.effect(() => () => void domain.close());
  ctx.effect(() => () => void runtime.dispose());
  // Phase 1 领域服务：Facilitator/纪要、AI 参会代表绑定、已读游标。
  // 各自独立持有新增表，不改变旧 MeetingService 的行为契约。
  const meetingMinutes = new MeetingMinutesService({
    facilitators: domain.table("facilitators"),
    minutes: domain.table("minutes"),
    versions: domain.table("minute_versions"),
    meetingStatus: (meetingId) => {
      try {
        return meetings.get(meetingId).status;
      } catch {
        return undefined;
      }
    },
  });
  // Facilitator 是服务席位、只落在 facilitators 表：把生命周期转给会议服务，
  // 让「参会次数」统计与成员展示都能看到它实际进过会。
  meetings.setFacilitatorReader((meetingId) =>
    meetingMinutes.facilitators(meetingId).map((facilitator) => ({
      teammateId: MEETING_FACILITATOR_TEAMMATE_ID,
      status: facilitator.status,
      createdAt: facilitator.createdAt,
      updatedAt: facilitator.updatedAt,
      ...(facilitator.deactivatedAt === undefined
        ? {}
        : { deactivatedAt: facilitator.deactivatedAt }),
    })),
  );
  // 存量补偿：旧版本只开了 Facilitator 席位、没写成员记录。启动后静默补齐，
  // 让成员列表与席位状态同源（幂等：已有活跃成员则跳过，不追加系统消息）。
  void (async () => {
    for (const meeting of tableValues(domain.table("meetings"))) {
      if (meeting.status !== "active") continue;
      if (meetingMinutes.activeFacilitator(meeting.id) === undefined) continue;
      const joined = meetings
        .participants(meeting.id)
        .some(
          (candidate) =>
            candidate.status === "active" &&
            candidate.kind === "ai_teammate" &&
            (candidate.teammateInstanceId ?? candidate.refId) ===
              MEETING_FACILITATOR_TEAMMATE_ID,
        );
      if (joined) continue;
      await meetings.addAiTeammate(
        { kind: "user", id: meeting.createdBy, workspaceRole: "member" },
        {
          meetingId: meeting.id,
          teammateInstanceId: MEETING_FACILITATOR_TEAMMATE_ID,
          displayName: "会议 Facilitator",
          speechMode: "observe",
          personaId: MEETING_FACILITATOR_PERSONA_ID,
          announce: false,
        },
      );
    }
  })().catch(() => undefined);
  const meetingDelegates = new MeetingDelegateService({
    delegates: domain.table("delegates"),
    instructions: domain.table("delegate_instructions"),
  });
  delegateInstructionRef.current = (delegateId) => {
    try {
      return formatDelegateInstruction(
        meetingDelegates.runtimeInstruction(delegateId),
      );
    } catch {
      return undefined;
    }
  };
  const meetingReads = new MeetingReadService({
    reads: domain.table("meeting_reads"),
  });
  const meetingFiles = new MeetingFileService({
    files: domain.table("meeting_files"),
  });
  const meetingTasks = new MeetingTaskService({
    tasks: domain.table("meeting_tasks"),
  });
  ctx.provide("collabMeetingMinutes", meetingMinutes);
  ctx.provide("collabMeetingDelegates", meetingDelegates);
  ctx.provide("collabMeetingReads", meetingReads);
  ctx.provide("collabMeetingFiles", meetingFiles);
  ctx.provide("collabMeetingTasks", meetingTasks);
  // 纪要：只在写入事件里触发；读取 / 轮询路径不调模型。
  let teamService: TeamServiceLike | undefined;
  const minutes = new FacilitatorMinutesService({
    meetings,
    agents: () => ctx.get("collabAgent"),
    teammateRuntime: () => ctx.get("collabTeammateRuntime"),
    team: () => teamService,
    files: () => meetingFiles,
  });
  const minutesRuntime = new MeetingMinutesRuntime({
    minutes: meetingMinutes,
    generator: createAgentMinutesGenerator({
      dispatch: (meetingId) => minutes.dispatchMinutes(meetingId),
      status: (meetingId, dispatchKey) =>
        minutes.minutesRun(meetingId, dispatchKey),
    }),
    onCompleted: async (version) => {
      // 纪要在右侧面板展示：群聊里不再贴全文，也不再建「待确认」任务，
      // 只留一条中性的「已生成」通知。
      try {
        await meetings.postSystemMessage(
          version.meetingId,
          `会议纪要 v${version.version} 已生成。`,
        );
      } catch {
        // 纪要版本已落库；发帖失败不回滚版本。
      }
    },
  });
  ctx.provide("collabMeetingMinutesRuntime", minutesRuntime);
  // 过度实现修正：纪要不再随每条消息自动生成。触发点收敛为「手动按钮」
  // 与「会议关闭」两处，避免每条发言都调一次模型、产生无人确认的版本。
  meetings.onMeetingClosed = (meetingId) => {
    const closedMeeting = meetings.get(meetingId);
    if (closedMeeting.kind === "ai") return;
    void ctx
      .get("collabMemory")
      ?.ingestSource({
        sourceType: "meeting",
        sourceId: meetingId,
        version: closedMeeting.updatedAt,
        workspaceId: closedMeeting.workspaceId,
        payload: {
          title: closedMeeting.title,
          content: [
            closedMeeting.agenda === ""
              ? ""
              : `## 议程\n${closedMeeting.agenda}`,
            "",
            "## 会议转写",
            ...meetings
              .transcript(meetingId)
              .map((message) => `${message.senderName}：${message.content}`),
          ]
            .filter(Boolean)
            .join("\n")
            .slice(0, 200_000),
          actorPrincipalId:
            closedMeeting.ownerUserId ?? closedMeeting.createdBy,
          projectId: closedMeeting.workspaceId,
          occurredAt: closedMeeting.closedAt ?? closedMeeting.updatedAt,
          sourceRefs: [{ type: "meeting", id: meetingId }],
          metadata: {
            participants: meetings.participants(meetingId).length,
            kind: closedMeeting.kind,
          },
        },
      })
      .catch(() => undefined);
    void meetingDelegates.completeByMeeting(meetingId).catch(() => undefined);
    // 已有新 Facilitator 时走单一纪要对象；否则保留旧纪要卡片路径。
    const facilitator = meetingMinutes.activeFacilitator(meetingId);
    if (facilitator === undefined) {
      minutes.schedule(meetingId);
      return;
    }
    let requestedBy = facilitator.createdBy;
    try {
      const meeting = meetings.get(meetingId);
      requestedBy = meeting.ownerUserId ?? meeting.createdBy;
    } catch {
      // keep the facilitator creator as the requester
    }
    void minutesRuntime
      .trigger({ meetingId, trigger: "close_auto", requestedBy })
      .catch(() => undefined);
  };
  ctx.effect(() => () => {
    void minutes.waitIdle();
  });
  ctx.effect(() => () => {
    void minutesRuntime.waitIdle();
  });
  let disposeChatContextAdapter: (() => void) | undefined;
  let disposeMeetingContextAdapter: (() => void) | undefined;
  const contextFiber = ctx.inject(["collabContext"], () => {
    const collabContext = ctx.get("collabContext");
    if (collabContext === undefined) return;
    const chatCarrier = (objectId: string, channelId?: string) => {
      const resolvedChannelId = channelId ?? objectId;
      const channel = collabContext.chatChannel?.(resolvedChannelId);
      return {
        channel,
        meeting: meetings.get(channel?.activeCarrierRefId ?? objectId),
      };
    };
    disposeChatContextAdapter?.();
    disposeMeetingContextAdapter?.();
    disposeChatContextAdapter = collabContext.registerAdapter({
      scene: "chat",
      chatCarrier: "meeting-ai",
      resolve: async (input) => {
        const { channel, meeting } = chatCarrier(
          input.objectId,
          input.chatChannelId,
        );
        return {
          allowed:
            meeting.kind === "ai" &&
            (channel === undefined ||
              (channel.userPrincipalId === input.actorPrincipalId &&
                channel.agentPrincipalId === input.agentPrincipalId)) &&
            (input.workspaceId === undefined ||
              input.workspaceId === meeting.workspaceId),
          workspaceId: meeting.workspaceId,
          sceneRevision: meeting.updatedAt,
          sourceRefs: [{ type: "chat", id: channel?.id ?? meeting.id }],
        };
      },
      loadFacts: async (input) => {
        const { channel, meeting } = chatCarrier(input.objectId);
        const transcript = meetings
          .transcript(meeting.id)
          .slice(-TRANSCRIPT_WINDOW)
          .map((message) => `${message.senderName}: ${message.content}`)
          .join("\n");
        return {
          text: transcript === "" ? "（暂无历史对话）" : transcript,
          sourceRefs: [{ type: "chat", id: channel?.id ?? meeting.id }],
          historyText: transcript,
        };
      },
      policy: async () => ({
        version: "meeting-ai-chat-v1",
        instructions: [
          "这是用户与当前 AI伙伴的一对一私密对话。",
          "只处理当前对话和显式带入的项目上下文。",
          "不得提及或读取其他用户的一对一对话。",
          "直接回复用户，不生成会议纪要或任务交付报告。",
        ].join("\n"),
        allowedWriteback: ["agent-private-memory", "run-evidence"],
      }),
    });
    disposeMeetingContextAdapter = collabContext.registerAdapter({
      scene: "meeting",
      resolve: async (input: {
        readonly workspaceId?: string;
        readonly objectId: string;
        readonly agentPrincipalId: string;
        readonly actorPrincipalId: string;
      }) => {
        const meeting = meetings.get(input.objectId);
        return {
          allowed:
            meeting.kind === "meeting" &&
            (input.workspaceId === undefined ||
              input.workspaceId === meeting.workspaceId),
          workspaceId: meeting.workspaceId,
          sceneRevision: meeting.updatedAt,
          sourceRefs: [{ type: "meeting", id: meeting.id }],
        };
      },
      loadFacts: async (input: {
        readonly workspaceId?: string;
        readonly objectId: string;
        readonly agentPrincipalId: string;
        readonly asOf: string;
      }) => {
        const meeting = meetings.get(input.objectId);
        const transcript = meetings
          .transcript(meeting.id)
          .slice(-TRANSCRIPT_WINDOW);
        const text = [
          `# ${meeting.title}`,
          `状态: ${meeting.status}`,
          `议程: ${meeting.agenda || "未填写"}`,
          "",
          "## 最近会议转写",
          ...transcript.map(
            (message) => `${message.senderName}: ${message.content}`,
          ),
        ].join("\n");
        return {
          text,
          structured: {
            id: meeting.id,
            title: meeting.title,
            agenda: meeting.agenda,
            status: meeting.status,
            participants: meetings.participants(meeting.id).map((item) => ({
              id: item.id,
              displayName: item.displayName,
              kind: item.kind,
              status: item.status,
            })),
          },
          sourceRefs: [{ type: "meeting", id: meeting.id }],
          historyText: transcript
            .map((message) => `${message.senderName}: ${message.content}`)
            .join("\n"),
        };
      },
      policy: async () => ({
        version: "group-meeting-context-v1",
        instructions: [
          "你正在一个多人会议中作为 AI 参会方发言。",
          "只依据当前会议转写、参与者和 ContextPack 中授权的项目事实回应。",
          "被 @ 时回应定向指令；主动发言必须有明确价值，不得复述已有结论。",
          "不得读取其他会议或私人聊天。",
        ].join("\n"),
        allowedWriteback: ["agent-private-memory", "run-evidence"],
      }),
    } as never);
  });
  ctx.effect(() => () => {
    disposeChatContextAdapter?.();
    disposeMeetingContextAdapter?.();
  });
  registerMeetingInterfaces(ctx, meetings);
  // 任务域 → 会议回写：AI 参会方在任务会话里产出的定稿发言，落回会议群聊。
  // 走 collab/task-changed 事件（任务域每次写入都会 emit），不再轮询。
  const mirroredAgentReplies = new Set<string>();
  const mirrorTaskReplyToMeeting = async (change: unknown): Promise<void> => {
    const taskId =
      change !== null && typeof change === "object" && "taskId" in change
        ? String((change as { taskId?: unknown }).taskId ?? "")
        : "";
    if (taskId === "") return;
    const taskService = ctx.get("collabTasks");
    if (taskService === undefined) return;
    let task: TaskRecordLike;
    try {
      task = taskService.get(taskId);
    } catch {
      return;
    }
    const link = task.links.find((item) => item.type === "meeting");
    if (link === undefined) return;
    const reply = latestAgentMessage(task);
    if (reply === undefined || mirroredAgentReplies.has(reply.id)) return;
    let meeting: Meeting;
    try {
      meeting = meetings.get(link.id);
    } catch {
      return;
    }
    if (meeting.status !== "active") return;
    const participant = meetings
      .participants(meeting.id)
      .find(
        (candidate) =>
          candidate.status === "active" &&
          candidate.kind !== "human" &&
          candidate.teammateInstanceId !== undefined &&
          candidate.teammateInstanceId === task.receiverId,
      );
    if (participant === undefined) return;
    mirroredAgentReplies.add(reply.id);
    try {
      await meetings.postWorkerReply(participant.id, reply.content);
    } catch {
      // 参与者可能已离会：忽略，任务时间线仍然保留这条发言。
    }
  };
  ctx.on?.("collab/task-changed", (change: unknown) => {
    void mirrorTaskReplyToMeeting(change);
  });
  const handledChatRuns = new Set<string>();
  const mirrorChatRunToMeeting = async (change: unknown): Promise<void> => {
    const runId =
      change !== null && typeof change === "object" && "runId" in change
        ? String((change as { runId?: unknown }).runId ?? "")
        : "";
    if (runId === "" || handledChatRuns.has(runId)) return;
    const agent = ctx.get("collabAgent") as ChatAgentServiceLike | undefined;
    const run = agent?.run(runId);
    if (
      run === undefined ||
      run.source !== "chat" ||
      run.nodeId !== MEETING_AI_CHAT_NODE_ID
    ) {
      return;
    }
    const meetingId = String(run.payload.context.meetingId ?? run.instanceId);
    const participantId = String(run.payload.context.participantId ?? "");
    const messageId = String(run.payload.context.messageId ?? "");
    if (meetingId === "" || participantId === "" || messageId === "") return;
    let meeting: Meeting;
    try {
      meeting = meetings.get(meetingId);
    } catch {
      return;
    }
    if (meeting.kind !== "ai") return;
    if (run.status === "succeeded") {
      const reply = run.output?.summary?.trim() ?? "";
      if (reply === "") {
        await meetings.markDelivery(
          messageId,
          participantId,
          "failed",
          "AI伙伴未返回文本回复",
        );
        handledChatRuns.add(runId);
        return;
      }
      await meetings.postWorkerReply(participantId, reply);
      await meetings.markDelivery(messageId, participantId, "delivered");
      handledChatRuns.add(runId);
      return;
    }
    if (
      run.status === "failed" ||
      run.status === "timeout" ||
      run.status === "cancelled" ||
      run.status === "interrupted"
    ) {
      const reason = run.error ?? `AI对话运行${run.status}`;
      await meetings.markDelivery(messageId, participantId, "failed", reason);
      await meetings.postSystemMessage(
        meeting.id,
        `AI伙伴暂时无法回复：${reason}`,
      );
      handledChatRuns.add(runId);
    }
  };
  ctx.on?.("collab/agent-run-settled", (change: unknown) => {
    void mirrorChatRunToMeeting(change);
  });
  let routeDisposers: Array<() => void> = [];
  const identityFiber = ctx.inject(["collabTeam"], (child) => {
    teamService = child.collabTeam;
    routeDisposers = createMeetingRoutes(meetings, child.collabTeam, {
      agents: () => ctx.get("agents"),
      personas: () => ctx.get("collabPersonas"),
      subagents: () => ctx.get("subagents"),
      runtime: () => runtime,
      employees: () => ctx.get("collabEmployee"),
      teammateRuntime: () => ctx.get("collabTeammateRuntime"),
      minutes: () => meetingMinutes,
      minutesRuntime: () => minutesRuntime,
      delegates: () => meetingDelegates,
      reads: () => meetingReads,
      files: () => meetingFiles,
      tasks: () => meetingTasks,
      taskService: () => ctx.get("collabTasks"),
      taskDispatch: () => ctx.get("collabTaskDispatch"),
      principals: () => ctx.get("collabPrincipal"),
      chatAgent: () =>
        ctx.get("collabAgent") as ChatAgentServiceLike | undefined,
      workspaces: () =>
        ctx.get("workspaceRegistry") as WorkspaceRegistryLike | undefined,
      context: () => ctx.get("collabContext") as ContextServiceLike | undefined,
    }).map((route) => ctx.webServer.register(route)) as Array<() => void>;
  });
  const employeeFiber = ctx.inject(["collabEmployee"], (child) => {
    meetings.setDelegationReporter(child.collabEmployee);
  });
  return () => {
    identityFiber.dispose();
    contextFiber.dispose();
    employeeFiber?.dispose();
    for (const dispose of routeDisposers) dispose();
  };
}
