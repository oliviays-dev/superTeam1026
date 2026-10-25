import { describe, expect, it } from "vitest";
import { MeetingMinutesService } from "./minutes.ts";
import {
  MeetingMinutesRuntime,
  createAgentMinutesGenerator,
  type MinutesDispatchPort,
  type MinutesGenerator,
} from "./minutes-runtime.ts";
import type {
  Facilitator,
  MeetingMinutes,
  MinuteVersion,
} from "./phase1-models.ts";

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

describe("createAgentMinutesGenerator", () => {
  it("polls the run until it succeeds and returns its summary", async () => {
    let statusCalls = 0;
    const port: MinutesDispatchPort = {
      dispatch: async () => ({ runId: "run-1", dispatchKey: "k1" }),
      status: () => {
        statusCalls += 1;
        return statusCalls < 2
          ? { status: "running" }
          : { status: "succeeded", content: "# 纪要" };
      },
    };
    const generator = createAgentMinutesGenerator(port, {
      intervalMs: 1,
      timeoutMs: 200,
    });
    const result = await generator.generate({
      meetingId: "m1",
      versionId: "v1",
      trigger: "manual",
      requestedBy: "alice",
    });
    expect(result.content).toBe("# 纪要");
    expect(result.runId).toBe("run-1");
  });

  it("surfaces a failed run instead of returning empty minutes", async () => {
    const port: MinutesDispatchPort = {
      dispatch: async () => ({ dispatchKey: "k1" }),
      status: () => ({ status: "failed", error: "model unavailable" }),
    };
    const generator = createAgentMinutesGenerator(port, { intervalMs: 1 });
    await expect(
      generator.generate({
        meetingId: "m1",
        versionId: "v1",
        trigger: "manual",
        requestedBy: "alice",
      }),
    ).rejects.toThrow("model unavailable");
  });

  it("fails when no dialogue is available to summarize", async () => {
    const port: MinutesDispatchPort = {
      dispatch: async () => undefined,
      status: () => undefined,
    };
    const generator = createAgentMinutesGenerator(port);
    await expect(
      generator.generate({
        meetingId: "m1",
        versionId: "v1",
        trigger: "manual",
        requestedBy: "alice",
      }),
    ).rejects.toThrow("no meeting dialogue");
  });

  it("times out when the run never settles", async () => {
    const port: MinutesDispatchPort = {
      dispatch: async () => ({ dispatchKey: "k1" }),
      status: () => ({ status: "running" }),
    };
    const generator = createAgentMinutesGenerator(port, {
      intervalMs: 2,
      timeoutMs: 10,
    });
    await expect(
      generator.generate({
        meetingId: "m1",
        versionId: "v1",
        trigger: "manual",
        requestedBy: "alice",
      }),
    ).rejects.toThrow("did not settle");
  });
});

describe("MeetingMinutesRuntime", () => {
  it("records generated content on the allocated version", async () => {
    const minutes = minutesService();
    await minutes.openFacilitator("m1", "alice");
    const generator: MinutesGenerator = {
      generate: async () => ({ content: "# 生成纪要", runId: "run-9" }),
    };
    const runtime = new MeetingMinutesRuntime({ minutes, generator });
    const version = await runtime.trigger({
      meetingId: "m1",
      trigger: "manual",
      requestedBy: "alice",
    });
    expect(version.status).toBe("generating");
    await runtime.waitIdle();
    const stored = minutes
      .versions("m1")
      .find((candidate) => candidate.id === version.id);
    expect(stored).toMatchObject({
      status: "pending_confirm",
      content: "# 生成纪要",
      runId: "run-9",
    });
  });

  it("marks the version failed when generation throws", async () => {
    const minutes = minutesService();
    await minutes.openFacilitator("m1", "alice");
    const generator: MinutesGenerator = {
      generate: async () => {
        throw new Error("run timed out");
      },
    };
    const runtime = new MeetingMinutesRuntime({ minutes, generator });
    const version = await runtime.trigger({
      meetingId: "m1",
      trigger: "close_auto",
      requestedBy: "alice",
    });
    await runtime.waitIdle();
    expect(minutes.versions("m1").find((row) => row.id === version.id)).toMatchObject(
      { status: "failed", error: "run timed out" },
    );
  });

  it("notifies onCompleted once a version awaits confirmation", async () => {
    const minutes = minutesService();
    await minutes.openFacilitator("m1", "alice");
    const seen: string[] = [];
    const runtime = new MeetingMinutesRuntime({
      minutes,
      generator: { generate: async () => ({ content: "# 结构化纪要" }) },
      onCompleted: (version) => {
        seen.push(version.id);
      },
    });
    const version = await runtime.trigger({
      meetingId: "m1",
      trigger: "manual",
      requestedBy: "alice",
    });
    await runtime.waitIdle();
    expect(seen).toEqual([version.id]);
    expect(
      minutes.versions("m1").find((row) => row.id === version.id)?.status,
    ).toBe("pending_confirm");
  });
});
