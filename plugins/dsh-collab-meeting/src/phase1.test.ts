import { describe, expect, it } from "vitest";
import { MeetingDelegateService } from "./delegates.ts";
import { MeetingFileService } from "./files.ts";
import { MeetingReadService } from "./inbox.ts";
import { MeetingMinutesService } from "./minutes.ts";
import type {
  Delegate,
  DelegateInstruction,
  Facilitator,
  MeetingFile,
  MeetingMinutes,
  MeetingRead,
  MeetingTask,
  MinuteVersion,
} from "./phase1-models.ts";
import { MAX_MEETING_FILE_BYTES } from "./phase1-models.ts";
import { MeetingError } from "./shared.ts";
import { MeetingTaskService } from "./tasks.ts";

class FakeTable<V> {
  readonly records = new Map<string, V>();

  get(key: string): V | undefined {
    return this.records.get(key);
  }

  entries(): IterableIterator<[string, V]> {
    return this.records.entries();
  }

  keys(): IterableIterator<string> {
    return this.records.keys();
  }

  get size(): number {
    return this.records.size;
  }

  async put(key: string, value: V): Promise<void> {
    this.records.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.records.delete(key);
  }
}

function minutesService(): MeetingMinutesService {
  return new MeetingMinutesService({
    facilitators: new FakeTable<Facilitator>(),
    minutes: new FakeTable<MeetingMinutes>(),
    versions: new FakeTable<MinuteVersion>(),
    meetingStatus: () => "active",
  });
}

function delegateService(): MeetingDelegateService {
  return new MeetingDelegateService({
    delegates: new FakeTable<Delegate>(),
    instructions: new FakeTable<DelegateInstruction>(),
  });
}

describe("MeetingMinutesService", () => {
  it("keeps at most one active facilitator and supports close/replace", async () => {
    const minutes = minutesService();
    const first = await minutes.openFacilitator("m1", "alice");
    expect(first.status).toBe("active");
    await expect(minutes.openFacilitator("m1", "bob")).rejects.toMatchObject({
      code: "conflict",
    });

    const replaced = await minutes.replaceFacilitator("m1", "bob");
    expect(replaced.id).not.toBe(first.id);
    expect(minutes.activeFacilitator("m1")?.id).toBe(replaced.id);
    expect(
      minutes.facilitators("m1").find((row) => row.id === first.id)?.status,
    ).toBe("replaced");

    const closed = await minutes.closeFacilitator("m1", "bob");
    expect(closed.status).toBe("inactive");
    expect(minutes.activeFacilitator("m1")).toBeUndefined();
  });

  it("requires a facilitator before allocating a minutes version", async () => {
    const minutes = minutesService();
    await expect(
      minutes.requestVersion({
        meetingId: "m1",
        trigger: "manual",
        requestedBy: "alice",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("allocates monotonic versions, supersedes stale pendings, and confirms", async () => {
    const minutes = minutesService();
    await minutes.openFacilitator("m1", "alice");
    const v1 = await minutes.requestVersion({
      meetingId: "m1",
      trigger: "manual",
      requestedBy: "alice",
    });
    expect(v1.version).toBe(1);
    await minutes.completeVersion(v1.id, "# 纪要 v1");

    const v2 = await minutes.requestVersion({
      meetingId: "m1",
      trigger: "manual",
      requestedBy: "alice",
    });
    expect(v2.version).toBe(2);
    await minutes.completeVersion(v2.id, "# 纪要 v2");
    expect(
      minutes.versions("m1").find((row) => row.id === v1.id)?.status,
    ).toBe("superseded");

    const confirmed = await minutes.confirmVersion({
      meetingId: "m1",
      versionId: v2.id,
      confirmedBy: "alice",
    });
    expect(confirmed.status).toBe("confirmed");
    expect(minutes.activeVersion("m1")?.id).toBe(v2.id);
  });

  it("records owner edits as a new confirmed version", async () => {
    const minutes = minutesService();
    await minutes.openFacilitator("m1", "alice");
    const generated = await minutes.requestVersion({
      meetingId: "m1",
      trigger: "close_auto",
      requestedBy: "alice",
    });
    await minutes.completeVersion(generated.id, "生成稿");

    const edited = await minutes.confirmVersion({
      meetingId: "m1",
      versionId: generated.id,
      confirmedBy: "alice",
      content: "负责人修订稿",
    });
    expect(edited.version).toBe(2);
    expect(edited.origin).toBe("edited");
    expect(edited.status).toBe("confirmed");
    expect(
      minutes.versions("m1").find((row) => row.id === generated.id)?.status,
    ).toBe("superseded");
  });

  it("marks a generating version as failed and does not confirm it", async () => {
    const minutes = minutesService();
    await minutes.openFacilitator("m1", "alice");
    const version = await minutes.requestVersion({
      meetingId: "m1",
      trigger: "manual",
      requestedBy: "alice",
    });
    const failed = await minutes.failVersion(version.id, "model timeout");
    expect(failed.status).toBe("failed");
    await expect(
      minutes.confirmVersion({
        meetingId: "m1",
        versionId: version.id,
        confirmedBy: "alice",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("MeetingDelegateService", () => {
  it("keeps one active delegate per principal and completes the previous one", async () => {
    const delegates = delegateService();
    const first = await delegates.assign({
      meetingId: "m1",
      principalUserId: "lisi",
      principalName: "李四",
      teammateInstanceId: "tm-1",
      speechMode: "mention",
    });
    const second = await delegates.assign({
      meetingId: "m1",
      principalUserId: "lisi",
      principalName: "李四",
      teammateInstanceId: "tm-2",
    });
    expect(delegates.active("m1")).toHaveLength(1);
    expect(delegates.active("m1")[0]?.id).toBe(second.delegate.id);
    expect(delegates.get(first.delegate.id).status).toBe("completed");
  });

  it("never exposes the private commission through the public list", async () => {
    const delegates = delegateService();
    const { delegate } = await delegates.assign({
      meetingId: "m1",
      principalUserId: "lisi",
      principalName: "李四",
      teammateInstanceId: "tm-1",
      instruction: {
        goal: "确认供应商切换风险",
        stance: "优先保障交付",
        mustSay: ["库存只能覆盖 7 天"],
      },
    });
    const projection = delegates.list("m1")[0]!;
    expect(projection).not.toHaveProperty("goal");
    expect(projection).not.toHaveProperty("instruction");

    expect(() => delegates.instructionFor(delegate.id, "zhangsan")).toThrow(
      MeetingError,
    );
    expect(delegates.instructionFor(delegate.id, "lisi").goal).toBe(
      "确认供应商切换风险",
    );
    expect(delegates.runtimeInstruction(delegate.id).stance).toBe(
      "优先保障交付",
    );
  });

  it("supports pause/resume/revoke and closes delegates with the meeting", async () => {
    const delegates = delegateService();
    const { delegate } = await delegates.assign({
      meetingId: "m1",
      principalUserId: "lisi",
      principalName: "李四",
      teammateInstanceId: "tm-1",
    });
    expect((await delegates.pause(delegate.id, "lisi")).status).toBe("paused");
    expect((await delegates.resume(delegate.id, "lisi")).status).toBe("active");
    expect((await delegates.revoke(delegate.id, "lisi")).status).toBe(
      "revoked",
    );

    const other = await delegates.assign({
      meetingId: "m1",
      principalUserId: "wangwu",
      principalName: "王五",
      teammateInstanceId: "tm-3",
    });
    expect(await delegates.completeByMeeting("m1")).toBe(1);
    expect(delegates.get(other.delegate.id).status).toBe("completed");
  });
});

describe("MeetingReadService", () => {
  it("advances a monotonic read cursor and ignores stale reports", async () => {
    const reads = new MeetingReadService({
      reads: new FakeTable<MeetingRead>(),
    });
    expect(reads.lastReadSeq("m1", "alice")).toBe(0);
    await reads.markRead("m1", "alice", 5);
    expect(reads.lastReadSeq("m1", "alice")).toBe(5);
    await reads.markRead("m1", "alice", 2);
    expect(reads.lastReadSeq("m1", "alice")).toBe(5);
    await reads.markRead("m1", "alice", 8);
    expect(reads.lastReadSeq("m1", "alice")).toBe(8);
    expect(reads.lastReadSeq("m1", "bob")).toBe(0);
  });
});

describe("MeetingFileService", () => {
  it("stores small files inline and rejects oversized ones", async () => {
    const files = new MeetingFileService({ files: new FakeTable<MeetingFile>() });
    const file = await files.put({
      meetingId: "m1",
      uploadedBy: "alice",
      name: "notes.txt",
      mime: "text/plain",
      data: Buffer.from("hello").toString("base64"),
    });
    expect(file.size).toBe(5);
    expect(files.get(file.id).name).toBe("notes.txt");
    await expect(
      files.put({
        meetingId: "m1",
        uploadedBy: "alice",
        name: "big.bin",
        data: Buffer.alloc(MAX_MEETING_FILE_BYTES + 1).toString("base64"),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("MeetingTaskService", () => {
  it("replaces stale pending items and completes on confirm", async () => {
    const tasks = new MeetingTaskService({
      tasks: new FakeTable<MeetingTask>(),
    });
    const first = await tasks.create({
      meetingId: "m1",
      kind: "minutes_confirm",
      targetId: "v1",
      assigneeUserId: "alice",
    });
    expect(tasks.pending("m1")).toHaveLength(1);
    await tasks.replacePending("m1", "v2");
    expect(
      tasks.list("m1").find((task) => task.id === first.id)?.status,
    ).toBe("replaced");
    const second = await tasks.create({
      meetingId: "m1",
      kind: "minutes_confirm",
      targetId: "v2",
      assigneeUserId: "alice",
    });
    expect(await tasks.completeByTarget("v2", "alice")).toBe(1);
    expect(
      tasks.list("m1").find((task) => task.id === second.id)?.status,
    ).toBe("done");
  });
});
