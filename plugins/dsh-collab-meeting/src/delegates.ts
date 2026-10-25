import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  delegateInstructionSchema,
  delegateSchema,
  speechModeSchema,
  type Delegate,
  type DelegateInstruction,
} from "./phase1-models.js";
import {
  type KvTableLike,
  MeetingError,
  createKeyedMutex,
  displayNameSchema,
  idSchema,
  nowIso,
  parseOrInvalid,
  tableValues,
} from "./shared.js";

export interface MeetingDelegateDeps {
  readonly delegates: KvTableLike<Delegate>;
  readonly instructions: KvTableLike<DelegateInstruction>;
  readonly now?: () => Date;
  readonly runExclusive?: <T>(
    key: string,
    task: () => Promise<T>,
  ) => Promise<T>;
}

const meetingIdSchema = z.string().min(1).max(160);
const shortTextSchema = z.string().trim().max(2_000);
const listSchema = z.array(z.string().trim().max(1_000)).max(100);

/**
 * Private commission fields. All optional so a caller can send a partial
 * update without restating the whole commission; the stored record is always
 * materialized by `delegateInstructionSchema` with its defaults.
 */
export const delegateInstructionInputSchema = z.object({
  goal: z.string().trim().max(4_000).optional(),
  stance: z.string().trim().max(4_000).optional(),
  mustSay: listSchema.optional(),
  focusPoints: listSchema.optional(),
  outputs: listSchema.optional(),
  controlPoints: listSchema.optional(),
  speechPolicy: shortTextSchema.optional(),
  behavior: shortTextSchema.optional(),
  informationBoundary: shortTextSchema.optional(),
  permissionBoundary: shortTextSchema.optional(),
  reportPlan: shortTextSchema.optional(),
});

export type DelegateInstructionInput = z.infer<
  typeof delegateInstructionInputSchema
>;

export interface DelegateAssignment {
  readonly delegate: Delegate;
  readonly instruction: DelegateInstruction;
}

/**
 * AI attendance bindings for a meeting.
 *
 * The public binding (`delegate`) and the private commission
 * (`delegate_instructions`) live in this one module because the invariant that
 * matters — at most one active delegate per principal per meeting, and a
 * commission that never leaks through the public projection — spans both
 * tables. Callers read `list()` for the transcript-facing projection and
 * `instructionFor()` only on behalf of the principal or the delegate's own
 * runtime.
 */
export class MeetingDelegateService {
  private readonly now: () => Date;
  private readonly runExclusive: <T>(
    key: string,
    task: () => Promise<T>,
  ) => Promise<T>;

  constructor(private readonly deps: MeetingDelegateDeps) {
    this.now = deps.now ?? (() => new Date());
    this.runExclusive = deps.runExclusive ?? createKeyedMutex();
  }

  get(delegateId: string): Delegate {
    const parsed = parseOrInvalid(idSchema, delegateId);
    const value = this.deps.delegates.get(parsed);
    if (value === undefined)
      throw new MeetingError("not_found", "delegate not found");
    return parseOrInvalid(delegateSchema, value);
  }

  /** Public projection for a meeting: bindings only, never commissions. */
  list(meetingId: string): Delegate[] {
    const parsed = parseOrInvalid(meetingIdSchema, meetingId);
    return tableValues(this.deps.delegates)
      .map((value) => parseOrInvalid(delegateSchema, value))
      .filter((delegate) => delegate.meetingId === parsed)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
  }

  active(meetingId: string): Delegate[] {
    return this.list(meetingId).filter(
      (delegate) => delegate.status === "active",
    );
  }

  activeFor(meetingId: string, principalUserId: string): Delegate | undefined {
    return this.active(meetingId).find(
      (delegate) => delegate.principalUserId === principalUserId,
    );
  }

  /**
   * Assigns (or replaces) the caller's AI attendance for one meeting. A
   * principal may only have one active delegate; replacing one completes the
   * previous binding so its historical messages stay attributable.
   */
  async assign(input: {
    readonly meetingId: string;
    readonly principalUserId: string;
    readonly principalName: string;
    readonly teammateInstanceId: string;
    readonly employeeId?: string;
    readonly speechMode?: z.infer<typeof speechModeSchema>;
    readonly instruction?: DelegateInstructionInput;
  }): Promise<DelegateAssignment> {
    const parsed = parseOrInvalid(
      z.object({
        meetingId: meetingIdSchema,
        principalUserId: idSchema,
        principalName: displayNameSchema,
        teammateInstanceId: idSchema,
        employeeId: idSchema.optional(),
        speechMode: speechModeSchema.optional(),
        instruction: delegateInstructionInputSchema.optional(),
      }),
      input,
    );
    return this.runExclusive(
      `delegate:${parsed.meetingId}:${parsed.principalUserId}`,
      async () => {
        const timestamp = nowIso(this.now);
        const existing = this.activeFor(
          parsed.meetingId,
          parsed.principalUserId,
        );
        if (existing !== undefined) {
          await this.deps.delegates.put(
            existing.id,
            parseOrInvalid(delegateSchema, {
              ...existing,
              status: "completed",
              completedAt: timestamp,
              updatedAt: timestamp,
            }),
          );
        }
        const delegate = parseOrInvalid(delegateSchema, {
          id: randomUUID(),
          meetingId: parsed.meetingId,
          principalUserId: parsed.principalUserId,
          principalName: parsed.principalName,
          teammateInstanceId: parsed.teammateInstanceId,
          status: "active",
          speechMode: parsed.speechMode ?? "mention",
          ...(parsed.employeeId === undefined
            ? {}
            : { employeeId: parsed.employeeId }),
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        const instruction = this.materialize(
          delegate.id,
          parsed.instruction ?? {},
          timestamp,
        );
        await this.deps.delegates.put(delegate.id, delegate);
        await this.deps.instructions.put(instruction.delegateId, instruction);
        return { delegate, instruction };
      },
    );
  }

  /** Updates the caller's own delegate binding and/or commission. */
  async update(input: {
    readonly delegateId: string;
    readonly actorUserId: string;
    readonly teammateInstanceId?: string;
    readonly employeeId?: string;
    readonly speechMode?: z.infer<typeof speechModeSchema>;
    readonly instruction?: DelegateInstructionInput;
  }): Promise<DelegateAssignment> {
    const parsed = parseOrInvalid(
      z.object({
        delegateId: idSchema,
        actorUserId: idSchema,
        teammateInstanceId: idSchema.optional(),
        employeeId: idSchema.optional(),
        speechMode: speechModeSchema.optional(),
        instruction: delegateInstructionInputSchema.optional(),
      }),
      input,
    );
    const current = this.get(parsed.delegateId);
    this.assertPrincipal(current, parsed.actorUserId);
    if (current.status === "completed" || current.status === "revoked")
      throw new MeetingError("conflict", "delegate is no longer active");
    return this.runExclusive(
      `delegate:${current.meetingId}:${current.principalUserId}`,
      async () => {
        const timestamp = nowIso(this.now);
        const delegate = parseOrInvalid(delegateSchema, {
          ...current,
          ...(parsed.teammateInstanceId === undefined
            ? {}
            : { teammateInstanceId: parsed.teammateInstanceId }),
          ...(parsed.employeeId === undefined
            ? {}
            : { employeeId: parsed.employeeId }),
          ...(parsed.speechMode === undefined
            ? {}
            : { speechMode: parsed.speechMode }),
          updatedAt: timestamp,
        });
        const existing = this.deps.instructions.get(current.id);
        const merged = parsed.instruction ?? {};
        const instruction = this.materialize(
          current.id,
          merged,
          timestamp,
          existing === undefined
            ? undefined
            : parseOrInvalid(delegateInstructionSchema, existing),
        );
        await this.deps.delegates.put(delegate.id, delegate);
        await this.deps.instructions.put(instruction.delegateId, instruction);
        return { delegate, instruction };
      },
    );
  }

  pause(delegateId: string, actorUserId: string): Promise<Delegate> {
    return this.transition(delegateId, actorUserId, "paused");
  }

  resume(delegateId: string, actorUserId: string): Promise<Delegate> {
    return this.transition(delegateId, actorUserId, "active");
  }

  revoke(delegateId: string, actorUserId: string): Promise<Delegate> {
    return this.transition(delegateId, actorUserId, "revoked");
  }

  /** Completes every non-terminal delegate when its meeting closes. */
  async completeByMeeting(meetingId: string): Promise<number> {
    const parsed = parseOrInvalid(meetingIdSchema, meetingId);
    return this.runExclusive(`delegate-meeting:${parsed}`, async () => {
      const timestamp = nowIso(this.now);
      let completed = 0;
      for (const delegate of this.list(parsed)) {
        if (delegate.status === "completed" || delegate.status === "revoked")
          continue;
        await this.deps.delegates.put(
          delegate.id,
          parseOrInvalid(delegateSchema, {
            ...delegate,
            status: "completed",
            completedAt: timestamp,
            updatedAt: timestamp,
          }),
        );
        completed += 1;
      }
      return completed;
    });
  }

  /** The private commission; readable only by the principal. */
  instructionFor(delegateId: string, actorUserId: string): DelegateInstruction {
    const delegate = this.get(delegateId);
    this.assertPrincipal(delegate, actorUserId);
    const value = this.deps.instructions.get(delegate.id);
    if (value === undefined)
      throw new MeetingError("not_found", "delegate instruction not found");
    return parseOrInvalid(delegateInstructionSchema, value);
  }

  /**
   * The private commission for the delegate's own runtime. Unlike
   * `instructionFor`, this does not require the *principal* identity because
   * the runtime acts with the delegate's own id; callers must only reach this
   * from the bound run, never from a browser request.
   */
  runtimeInstruction(delegateId: string): DelegateInstruction {
    const delegate = this.get(delegateId);
    const value = this.deps.instructions.get(delegate.id);
    if (value === undefined)
      throw new MeetingError("not_found", "delegate instruction not found");
    return parseOrInvalid(delegateInstructionSchema, value);
  }

  private async transition(
    delegateId: string,
    actorUserId: string,
    status: "active" | "paused" | "revoked",
  ): Promise<Delegate> {
    const current = this.get(delegateId);
    this.assertPrincipal(current, actorUserId);
    if (current.status === "completed")
      throw new MeetingError("conflict", "delegate already completed");
    const timestamp = nowIso(this.now);
    const updated = parseOrInvalid(delegateSchema, {
      ...current,
      status,
      completedAt: undefined,
      updatedAt: timestamp,
    });
    await this.deps.delegates.put(updated.id, updated);
    return updated;
  }

  private assertPrincipal(delegate: Delegate, actorUserId: string): void {
    if (delegate.principalUserId !== actorUserId)
      throw new MeetingError(
        "forbidden",
        "only the principal can manage this delegate",
      );
  }

  private materialize(
    delegateId: string,
    patch: DelegateInstructionInput,
    timestamp: string,
    base?: DelegateInstruction,
  ): DelegateInstruction {
    return parseOrInvalid(delegateInstructionSchema, {
      delegateId,
      ...base,
      ...patch,
      updatedAt: timestamp,
    });
  }
}
