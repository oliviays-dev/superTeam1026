import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  facilitatorSchema,
  meetingMinutesSchema,
  minuteVersionSchema,
  minutesTriggerSchema,
  type Facilitator,
  type MeetingMinutes,
  type MinuteVersion,
  type MinutesSourceRefs,
} from "./phase1-models.js";
import {
  type KvTableLike,
  MeetingError,
  createKeyedMutex,
  idSchema,
  nowIso,
  parseOrInvalid,
  tableValues,
} from "./shared.js";

export interface MeetingMinutesDeps {
  readonly facilitators: KvTableLike<Facilitator>;
  readonly minutes: KvTableLike<MeetingMinutes>;
  readonly versions: KvTableLike<MinuteVersion>;
  readonly now?: () => Date;
  readonly runExclusive?: <T>(
    key: string,
    task: () => Promise<T>,
  ) => Promise<T>;
  /** Optional meeting-status lookup used to reject triggering on a draft. */
  readonly meetingStatus?: (
    meetingId: string,
  ) => "draft" | "active" | "closed" | "archived" | undefined;
}

const meetingIdSchema = z.string().min(1).max(160);

/**
 * Facilitator lifecycle plus the single-per-meeting minutes document.
 *
 * One service owns both because the Facilitator *is* the minutes generator:
 * splitting them would let a minutes version exist without a facilitator or a
 * facilitator drift away from its versions. The generator itself is injected
 * by the caller, so this module owns state and invariants, not prompting or
 * agent execution.
 */
export class MeetingMinutesService {
  private readonly now: () => Date;
  private readonly runExclusive: <T>(
    key: string,
    task: () => Promise<T>,
  ) => Promise<T>;

  constructor(private readonly deps: MeetingMinutesDeps) {
    this.now = deps.now ?? (() => new Date());
    this.runExclusive = deps.runExclusive ?? createKeyedMutex();
  }

  /** The meeting's single active facilitator, if one was opened. */
  activeFacilitator(meetingId: string): Facilitator | undefined {
    const parsed = parseOrInvalid(meetingIdSchema, meetingId);
    return tableValues(this.deps.facilitators)
      .map((value) => parseOrInvalid(facilitatorSchema, value))
      .find(
        (facilitator) =>
          facilitator.meetingId === parsed && facilitator.status === "active",
      );
  }

  facilitators(meetingId: string): Facilitator[] {
    const parsed = parseOrInvalid(meetingIdSchema, meetingId);
    return tableValues(this.deps.facilitators)
      .map((value) => parseOrInvalid(facilitatorSchema, value))
      .filter((facilitator) => facilitator.meetingId === parsed)
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
  }

  /**
   * Opens the meeting's only active facilitator. Any active human participant
   * may call this; the first writer wins and later writers get `conflict`.
   */
  async openFacilitator(
    meetingId: string,
    actorUserId: string,
  ): Promise<Facilitator> {
    const parsedMeeting = parseOrInvalid(meetingIdSchema, meetingId);
    const parsedActor = parseOrInvalid(idSchema, actorUserId);
    return this.runExclusive(`facilitator:${parsedMeeting}`, async () => {
      if (this.activeFacilitator(parsedMeeting) !== undefined)
        throw new MeetingError(
          "conflict",
          "an active facilitator already exists for this meeting",
        );
      const timestamp = nowIso(this.now);
      const facilitator: Facilitator = parseOrInvalid(facilitatorSchema, {
        id: randomUUID(),
        meetingId: parsedMeeting,
        status: "active",
        createdBy: parsedActor,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.deps.facilitators.put(facilitator.id, facilitator);
      return facilitator;
    });
  }

  /** Deactivates the active facilitator, keeping the row for history. */
  async closeFacilitator(
    meetingId: string,
    actorUserId: string,
  ): Promise<Facilitator> {
    const parsedMeeting = parseOrInvalid(meetingIdSchema, meetingId);
    const parsedActor = parseOrInvalid(idSchema, actorUserId);
    return this.runExclusive(`facilitator:${parsedMeeting}`, async () => {
      const active = this.activeFacilitator(parsedMeeting);
      if (active === undefined)
        throw new MeetingError("not_found", "no active facilitator");
      const timestamp = nowIso(this.now);
      const updated = parseOrInvalid(facilitatorSchema, {
        ...active,
        status: "inactive",
        deactivatedAt: timestamp,
        deactivatedBy: parsedActor,
        updatedAt: timestamp,
      });
      await this.deps.facilitators.put(updated.id, updated);
      return updated;
    });
  }

  /** Replaces the active facilitator, linking old and new rows. */
  async replaceFacilitator(
    meetingId: string,
    actorUserId: string,
  ): Promise<Facilitator> {
    const parsedMeeting = parseOrInvalid(meetingIdSchema, meetingId);
    const parsedActor = parseOrInvalid(idSchema, actorUserId);
    return this.runExclusive(`facilitator:${parsedMeeting}`, async () => {
      const active = this.activeFacilitator(parsedMeeting);
      if (active === undefined)
        throw new MeetingError("not_found", "no active facilitator");
      const timestamp = nowIso(this.now);
      const nextId = randomUUID();
      const replaced = parseOrInvalid(facilitatorSchema, {
        ...active,
        status: "replaced",
        deactivatedAt: timestamp,
        deactivatedBy: parsedActor,
        replacedById: nextId,
        updatedAt: timestamp,
      });
      const next = parseOrInvalid(facilitatorSchema, {
        id: nextId,
        meetingId: parsedMeeting,
        status: "active",
        createdBy: parsedActor,
        promptVersion: active.promptVersion,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.deps.facilitators.put(replaced.id, replaced);
      await this.deps.facilitators.put(next.id, next);
      return next;
    });
  }

  /**
   * Allocates the next minutes version in `generating`. Triggering never
   * happens implicitly here; callers arrive from an explicit button or the
   * single close hook.
   */
  async requestVersion(input: {
    readonly meetingId: string;
    readonly trigger: z.infer<typeof minutesTriggerSchema>;
    readonly requestedBy: string;
    readonly sourceRefs?: MinutesSourceRefs;
  }): Promise<MinuteVersion> {
    const parsed = parseOrInvalid(
      z.object({
        meetingId: meetingIdSchema,
        trigger: minutesTriggerSchema,
        requestedBy: idSchema,
        sourceRefs: z
          .object({
            messageSeqs: z.array(z.number().int().nonnegative()).max(10_000),
            attachmentIds: z.array(idSchema).max(1_000),
          })
          .optional(),
      }),
      input,
    );
    const status = this.deps.meetingStatus?.(parsed.meetingId);
    if (status === "draft")
      throw new MeetingError("conflict", "meeting has not started");
    const facilitator = this.activeFacilitator(parsed.meetingId);
    if (facilitator === undefined)
      throw new MeetingError(
        "conflict",
        "facilitator_required: no active facilitator for this meeting",
      );
    return this.runExclusive(`minutes:${parsed.meetingId}`, async () => {
      const timestamp = nowIso(this.now);
      const document = await this.ensureMinutes(parsed.meetingId, timestamp);
      const version = document.currentVersion + 1;
      // 纪要是「整场会议的纪要」而不是增量：新版本先继承上一版全文，
      // 生成完成后再整体替换，避免中途出现「内容为空的更新版」。
      const previousContent = [...this.versions(parsed.meetingId)]
        .reverse()
        .find((item) => String(item.content ?? "").trim() !== "")?.content;
      const record: MinuteVersion = parseOrInvalid(minuteVersionSchema, {
        id: randomUUID(),
        meetingId: parsed.meetingId,
        version,
        trigger: parsed.trigger,
        requestedBy: parsed.requestedBy,
        requestedAt: timestamp,
        facilitatorId: facilitator.id,
        status: "generating",
        content: previousContent ?? "",
        ...(parsed.sourceRefs === undefined
          ? {}
          : { sourceRefs: parsed.sourceRefs }),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.deps.versions.put(record.id, record);
      await this.deps.minutes.put(
        document.meetingId,
        parseOrInvalid(meetingMinutesSchema, {
          ...document,
          currentVersion: version,
          updatedAt: timestamp,
        }),
      );
      return record;
    });
  }

  /** Marks a generating version as generated and awaiting owner confirmation. */
  async completeVersion(
    versionId: string,
    content: string,
    options: {
      readonly sourceRefs?: MinutesSourceRefs;
      readonly runId?: string;
    } = {},
  ): Promise<MinuteVersion> {
    const current = this.versionOrThrow(versionId);
    if (current.status !== "generating")
      throw new MeetingError("conflict", "minutes version is not generating");
    return this.runExclusive(`minutes:${current.meetingId}`, async () => {
      const timestamp = nowIso(this.now);
      const updated = parseOrInvalid(minuteVersionSchema, {
        ...current,
        content,
        status: "pending_confirm",
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(options.sourceRefs === undefined
          ? {}
          : { sourceRefs: options.sourceRefs }),
        updatedAt: timestamp,
      });
      await this.deps.versions.put(updated.id, updated);
      await this.supersedeOtherPending(updated.meetingId, updated.id, timestamp);
      return updated;
    });
  }

  async failVersion(versionId: string, reason: string): Promise<MinuteVersion> {
    const current = this.versionOrThrow(versionId);
    return this.runExclusive(`minutes:${current.meetingId}`, async () => {
      const timestamp = nowIso(this.now);
      const updated = parseOrInvalid(minuteVersionSchema, {
        ...current,
        status: "failed",
        error: reason.slice(0, 500),
        updatedAt: timestamp,
      });
      await this.deps.versions.put(updated.id, updated);
      return updated;
    });
  }

  versions(meetingId: string): MinuteVersion[] {
    const parsed = parseOrInvalid(meetingIdSchema, meetingId);
    return tableValues(this.deps.versions)
      .map((value) => parseOrInvalid(minuteVersionSchema, value))
      .filter((version) => version.meetingId === parsed)
      .sort(
        (left, right) =>
          left.version - right.version || left.id.localeCompare(right.id),
      );
  }

  activeVersion(meetingId: string): MinuteVersion | undefined {
    const document = this.minutes(meetingId);
    if (document?.activeVersion === undefined) return undefined;
    return this.versions(meetingId).find(
      (version) => version.version === document.activeVersion,
    );
  }

  minutes(meetingId: string): MeetingMinutes | undefined {
    const parsed = parseOrInvalid(meetingIdSchema, meetingId);
    const value = this.deps.minutes.get(parsed);
    return value === undefined
      ? undefined
      : parseOrInvalid(meetingMinutesSchema, value);
  }

  /**
   * Confirms a pending version. When the owner supplies changed content the
   * confirmation is recorded as a new `edited` version so the generated text
   * and the owner's text both remain in history.
   */
  async confirmVersion(input: {
    readonly meetingId: string;
    readonly versionId: string;
    readonly confirmedBy: string;
    readonly content?: string;
  }): Promise<MinuteVersion> {
    const parsed = parseOrInvalid(
      z.object({
        meetingId: meetingIdSchema,
        versionId: idSchema,
        confirmedBy: idSchema,
        content: z.string().max(400_000).optional(),
      }),
      input,
    );
    const target = this.versionOrThrow(parsed.versionId);
    if (target.meetingId !== parsed.meetingId)
      throw new MeetingError("not_found", "minutes version not found");
    if (target.status !== "pending_confirm" && target.status !== "confirmed")
      throw new MeetingError(
        "conflict",
        "minutes version is not awaiting confirmation",
      );
    return this.runExclusive(`minutes:${parsed.meetingId}`, async () => {
      const timestamp = nowIso(this.now);
      const edited =
        parsed.content !== undefined && parsed.content !== target.content;
      let confirmed: MinuteVersion;
      if (edited) {
        const document = await this.ensureMinutes(parsed.meetingId, timestamp);
        const version = document.currentVersion + 1;
        confirmed = parseOrInvalid(minuteVersionSchema, {
          ...target,
          id: randomUUID(),
          version,
          content: parsed.content,
          origin: "edited",
          status: "confirmed",
          confirmedBy: parsed.confirmedBy,
          confirmedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        await this.deps.versions.put(confirmed.id, confirmed);
        await this.deps.versions.put(
          target.id,
          parseOrInvalid(minuteVersionSchema, {
            ...target,
            status: "superseded",
            updatedAt: timestamp,
          }),
        );
        await this.deps.minutes.put(
          document.meetingId,
          parseOrInvalid(meetingMinutesSchema, {
            ...document,
            currentVersion: version,
            activeVersion: version,
            updatedAt: timestamp,
          }),
        );
      } else {
        confirmed = parseOrInvalid(minuteVersionSchema, {
          ...target,
          status: "confirmed",
          confirmedBy: parsed.confirmedBy,
          confirmedAt: timestamp,
          updatedAt: timestamp,
        });
        await this.deps.versions.put(confirmed.id, confirmed);
        const document = await this.ensureMinutes(parsed.meetingId, timestamp);
        await this.deps.minutes.put(
          document.meetingId,
          parseOrInvalid(meetingMinutesSchema, {
            ...document,
            activeVersion: confirmed.version,
            updatedAt: timestamp,
          }),
        );
      }
      await this.supersedeOtherPending(
        parsed.meetingId,
        confirmed.id,
        timestamp,
      );
      return confirmed;
    });
  }

  private versionOrThrow(versionId: string): MinuteVersion {
    const parsed = parseOrInvalid(idSchema, versionId);
    const value = this.deps.versions.get(parsed);
    if (value === undefined)
      throw new MeetingError("not_found", "minutes version not found");
    return parseOrInvalid(minuteVersionSchema, value);
  }

  private async ensureMinutes(
    meetingId: string,
    timestamp: string,
  ): Promise<MeetingMinutes> {
    const existing = this.deps.minutes.get(meetingId);
    if (existing !== undefined)
      return parseOrInvalid(meetingMinutesSchema, existing);
    const document = parseOrInvalid(meetingMinutesSchema, {
      meetingId,
      currentVersion: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.deps.minutes.put(document.meetingId, document);
    return document;
  }

  private async supersedeOtherPending(
    meetingId: string,
    keepId: string,
    timestamp: string,
  ): Promise<void> {
    for (const version of this.versions(meetingId)) {
      if (version.id === keepId || version.status !== "pending_confirm")
        continue;
      await this.deps.versions.put(
        version.id,
        parseOrInvalid(minuteVersionSchema, {
          ...version,
          status: "superseded",
          updatedAt: timestamp,
        }),
      );
    }
  }
}
