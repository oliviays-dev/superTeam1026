import { z } from "zod";
import { meetingReadSchema, type MeetingRead } from "./phase1-models.js";
import {
  type KvTableLike,
  idSchema,
  nowIso,
  parseOrInvalid,
} from "./shared.js";

export interface MeetingReadDeps {
  readonly reads: KvTableLike<MeetingRead>;
  readonly now?: () => Date;
}

const meetingIdSchema = z.string().min(1).max(160);
const seqSchema = z.number().int().nonnegative();

/**
 * Per-user read cursor for one meeting's message stream. Unread and mention
 * counts are derived by the caller from the transcript, so this module stays a
 * tiny durable cursor and never duplicates message data.
 */
export class MeetingReadService {
  private readonly now: () => Date;

  constructor(private readonly deps: MeetingReadDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  read(meetingId: string, userId: string): MeetingRead | undefined {
    const parsedMeeting = parseOrInvalid(meetingIdSchema, meetingId);
    const parsedUser = parseOrInvalid(idSchema, userId);
    const value = this.deps.reads.get(`${parsedMeeting}:${parsedUser}`);
    return value === undefined
      ? undefined
      : parseOrInvalid(meetingReadSchema, value);
  }

  lastReadSeq(meetingId: string, userId: string): number {
    return this.read(meetingId, userId)?.lastReadSeq ?? 0;
  }

  /**
   * Advances the cursor. The cursor is monotonic: a stale report can never
   * move it backwards and re-open already-read messages.
   */
  async markRead(
    meetingId: string,
    userId: string,
    lastReadSeq: number,
  ): Promise<MeetingRead> {
    const parsedMeeting = parseOrInvalid(meetingIdSchema, meetingId);
    const parsedUser = parseOrInvalid(idSchema, userId);
    const parsedSeq = parseOrInvalid(seqSchema, lastReadSeq);
    const current = this.read(parsedMeeting, parsedUser);
    const next = Math.max(parsedSeq, current?.lastReadSeq ?? 0);
    const record = parseOrInvalid(meetingReadSchema, {
      meetingId: parsedMeeting,
      userId: parsedUser,
      lastReadSeq: next,
      updatedAt: nowIso(this.now),
    });
    await this.deps.reads.put(`${parsedMeeting}:${parsedUser}`, record);
    return record;
  }
}
