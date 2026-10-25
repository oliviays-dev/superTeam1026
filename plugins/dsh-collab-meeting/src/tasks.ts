import { randomUUID } from "node:crypto";
import { z } from "zod";
import { meetingTaskSchema, type MeetingTask } from "./phase1-models.js";
import {
  type KvTableLike,
  idSchema,
  nowIso,
  parseOrInvalid,
  tableValues,
} from "./shared.js";

export interface MeetingTaskDeps {
  readonly tasks: KvTableLike<MeetingTask>;
  readonly now?: () => Date;
}

/**
 * Durable pending items for a meeting, surfaced independently of the chat
 * transcript. Phase 1 only uses `minutes_confirm`: one pending item per minutes
 * version awaiting the owner, replaced when a newer version supersedes it.
 */
export class MeetingTaskService {
  private readonly now: () => Date;

  constructor(private readonly deps: MeetingTaskDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async create(input: {
    readonly meetingId: string;
    readonly kind: "minutes_confirm";
    readonly targetId: string;
    readonly assigneeUserId: string;
  }): Promise<MeetingTask> {
    const parsed = parseOrInvalid(
      z.object({
        meetingId: z.string().min(1).max(160),
        kind: z.enum(["minutes_confirm"]),
        targetId: idSchema,
        assigneeUserId: idSchema,
      }),
      input,
    );
    const timestamp = nowIso(this.now);
    const task = parseOrInvalid(meetingTaskSchema, {
      id: randomUUID(),
      meetingId: parsed.meetingId,
      kind: parsed.kind,
      targetId: parsed.targetId,
      assigneeUserId: parsed.assigneeUserId,
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.deps.tasks.put(task.id, task);
    return task;
  }

  list(meetingId: string): MeetingTask[] {
    return tableValues(this.deps.tasks)
      .map((value) => parseOrInvalid(meetingTaskSchema, value))
      .filter((task) => task.meetingId === meetingId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  pending(meetingId: string): MeetingTask[] {
    return this.list(meetingId).filter((task) => task.status === "pending");
  }

  /** Marks the task for a confirmed/resolved target as done. */
  async completeByTarget(targetId: string, doneBy: string): Promise<number> {
    const parsedTarget = parseOrInvalid(idSchema, targetId);
    const parsedActor = parseOrInvalid(idSchema, doneBy);
    const timestamp = nowIso(this.now);
    let completed = 0;
    for (const task of tableValues(this.deps.tasks).map((value) =>
      parseOrInvalid(meetingTaskSchema, value),
    )) {
      if (task.targetId !== parsedTarget || task.status !== "pending") continue;
      await this.deps.tasks.put(
        task.id,
        parseOrInvalid(meetingTaskSchema, {
          ...task,
          status: "done",
          doneAt: timestamp,
          doneBy: parsedActor,
          updatedAt: timestamp,
        }),
      );
      completed += 1;
    }
    return completed;
  }

  /** Supersedes stale pending items when a newer minutes version arrives. */
  async replacePending(meetingId: string, keepTargetId: string): Promise<number> {
    const timestamp = nowIso(this.now);
    let replaced = 0;
    for (const task of this.list(meetingId)) {
      if (task.status !== "pending" || task.targetId === keepTargetId) continue;
      await this.deps.tasks.put(
        task.id,
        parseOrInvalid(meetingTaskSchema, {
          ...task,
          status: "replaced",
          updatedAt: timestamp,
        }),
      );
      replaced += 1;
    }
    return replaced;
  }
}
