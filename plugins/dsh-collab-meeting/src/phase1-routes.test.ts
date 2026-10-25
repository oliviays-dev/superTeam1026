import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { MeetingDelegateService } from "./delegates.ts";
import {
  createMeetingRoutes,
  MeetingService,
  type WebRouteLike,
} from "./index.ts";
import { MeetingReadService } from "./inbox.ts";
import { MeetingMinutesService } from "./minutes.ts";
import { MeetingMinutesRuntime } from "./minutes-runtime.ts";
import type {
  Delegate,
  DelegateInstruction,
  Facilitator,
  MeetingMinutes,
  MeetingRead,
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

class FakeResponse {
  status = 0;
  body = "";

  writeHead(status: number): ServerResponse {
    this.status = status;
    return this as unknown as ServerResponse;
  }

  end(body?: string): ServerResponse {
    if (body !== undefined) this.body = body;
    return this as unknown as ServerResponse;
  }

  json(): Record<string, unknown> {
    return JSON.parse(this.body) as Record<string, unknown>;
  }
}

function fakeRequest(
  method: string,
  url: string,
  options: { body?: unknown; token?: string } = {},
) {
  const body = options.body === undefined ? "" : JSON.stringify(options.body);
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1:33117",
      origin: "http://127.0.0.1:33117",
      ...(options.token === undefined
        ? {}
        : { authorization: `Bearer ${options.token}` }),
      ...(body === "" ? {} : { "content-type": "application/json" }),
    },
    async *[Symbol.asyncIterator]() {
      if (body !== "") yield Buffer.from(body);
    },
  };
}

async function call(route: WebRouteLike, request: unknown) {
  const response = new FakeResponse();
  await route.handler(
    request as Parameters<typeof route.handler>[0],
    response as unknown as ServerResponse,
  );
  return response;
}

function route(routes: readonly WebRouteLike[], path: string): WebRouteLike {
  const found = routes.find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error(`missing route: ${path}`);
  return found;
}

describe("phase 1 routes", () => {
  const now = () => new Date("2026-01-01T00:00:00.000Z");

  function setup() {
    const meetingTables = {
      meetings: new FakeTable<unknown>(),
      participants: new FakeTable<unknown>(),
      messages: new FakeTable<unknown>(),
    };
    const meetings = new MeetingService(meetingTables as never, { now });
    const minutes = new MeetingMinutesService({
      facilitators: new FakeTable<Facilitator>(),
      minutes: new FakeTable<MeetingMinutes>(),
      versions: new FakeTable<MinuteVersion>(),
      now,
    });
    const delegates = new MeetingDelegateService({
      delegates: new FakeTable<Delegate>(),
      instructions: new FakeTable<DelegateInstruction>(),
      now,
    });
    const reads = new MeetingReadService({
      reads: new FakeTable<MeetingRead>(),
      now,
    });
    const runtime = new MeetingMinutesRuntime({
      minutes,
      generator: { generate: async () => ({ content: "# 会议纪要" }) },
    });
    const team = {
      resolveToken: (token: string) =>
        ["alice-token", "bob-token", "carol-token"].includes(token)
          ? { userId: token.replace("-token", ""), role: "member" }
          : undefined,
      members: () => [
        { userId: "alice", name: "Alice", memberRole: "member" },
        { userId: "bob", name: "Bob", memberRole: "member" },
        { userId: "carol", name: "Carol", memberRole: "member" },
      ],
    };
    const routes = createMeetingRoutes(meetings, team as never, {
      minutes: () => minutes,
      minutesRuntime: () => runtime,
      delegates: () => delegates,
      reads: () => reads,
      principals: () => ({
        resolveReference: (reference) =>
          reference === "principal:principal-ai-tm-1"
            ? { id: "principal-ai-tm-1", kind: "ai", status: "active" }
            : reference === "tm-1" || reference === "employee-1"
              ? { id: "principal-ai-tm-1", kind: "ai", status: "active" }
              : undefined,
        preferredSubjectId: (principalId, subjectTypes) =>
          principalId === "principal-ai-tm-1"
            ? subjectTypes[0] === "teammate"
              ? "tm-1"
              : "employee-1"
            : undefined,
      }),
    });
    return { meetings, minutes, delegates, reads, runtime, routes };
  }

  async function joinedMeeting(
    meetings: MeetingService,
    creator = "alice",
  ) {
    const meeting = await meetings.create(
      { kind: "user", id: creator, workspaceRole: "member" },
      { workspaceId: "main", title: "供应商切换评审" },
    );
    await meetings.join(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "Alice",
    );
    await meetings.join(
      { kind: "user", id: "bob", workspaceRole: "member" },
      meeting.id,
      "Bob",
    );
    return meeting;
  }

  it("runs the facilitator -> minutes -> confirm flow", async () => {
    const { meetings, routes, runtime } = setup();
    const meeting = await joinedMeeting(meetings);

    const opened = await call(
      route(routes, "/api/collab/meeting/facilitator/open"),
      fakeRequest("POST", "/api/collab/meeting/facilitator/open", {
        token: "alice-token",
        body: { meetingId: meeting.id },
      }),
    );
    expect(opened.status).toBe(201);

    const triggered = await call(
      route(routes, "/api/collab/meeting/minutes/trigger"),
      fakeRequest("POST", "/api/collab/meeting/minutes/trigger", {
        token: "bob-token",
        body: { meetingId: meeting.id },
      }),
    );
    expect(triggered.status).toBe(202);
    const versionId = (triggered.json().version as { id: string }).id;
    await runtime.waitIdle();

    const listed = await call(
      route(routes, "/api/collab/meeting/minutes"),
      fakeRequest("GET", `/api/collab/meeting/minutes?meetingId=${meeting.id}`, {
        token: "alice-token",
      }),
    );
    const pending = (
      listed.json().versions as Array<{ id: string; status: string }>
    ).find((candidate) => candidate.id === versionId);
    expect(pending?.status).toBe("pending_confirm");

    const confirmed = await call(
      route(routes, "/api/collab/meeting/minutes/confirm"),
      fakeRequest("POST", "/api/collab/meeting/minutes/confirm", {
        token: "alice-token",
        body: { meetingId: meeting.id, versionId },
      }),
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.json().version).toMatchObject({ status: "confirmed" });
  });

  it("keeps facilitator seat and member list in sync both ways", async () => {
    const { meetings, minutes, routes } = setup();
    const meeting = await joinedMeeting(meetings);

    const opened = await call(
      route(routes, "/api/collab/meeting/facilitator/open"),
      fakeRequest("POST", "/api/collab/meeting/facilitator/open", {
        token: "alice-token",
        body: { meetingId: meeting.id },
      }),
    );
    expect(opened.status).toBe(201);
    const joined = meetings
      .participants(meeting.id)
      .find(
        (participant) =>
          participant.kind === "ai_teammate" &&
          participant.refId === "meeting-facilitator" &&
          participant.status === "active",
      );
    expect(joined?.autoSpeak).toBe("manual");

    // 反向：从成员列表移除 Facilitator 等同于停用席位。
    const removed = await call(
      route(routes, "/api/collab/meeting/participant/remove"),
      fakeRequest("POST", "/api/collab/meeting/participant/remove", {
        token: "bob-token",
        body: { meetingId: meeting.id, participantId: joined?.id },
      }),
    );
    expect(removed.status).toBe(200);
    expect(minutes.activeFacilitator(meeting.id)).toBeUndefined();

    // 再次开启复用同一条成员记录。
    const reopened = await call(
      route(routes, "/api/collab/meeting/facilitator/open"),
      fakeRequest("POST", "/api/collab/meeting/facilitator/open", {
        token: "alice-token",
        body: { meetingId: meeting.id },
      }),
    );
    expect(reopened.status).toBe(201);
    expect(
      meetings.participants(meeting.id).find((item) => item.id === joined?.id)
        ?.status,
    ).toBe("active");

    // 关闭席位 → 成员置 left。
    const closed = await call(
      route(routes, "/api/collab/meeting/facilitator/close"),
      fakeRequest("POST", "/api/collab/meeting/facilitator/close", {
        token: "alice-token",
        body: { meetingId: meeting.id },
      }),
    );
    expect(closed.status).toBe(200);
    expect(
      meetings.participants(meeting.id).find((item) => item.id === joined?.id)
        ?.status,
    ).toBe("left");
  });

  it("keeps a non-owner from confirming minutes", async () => {
    const { meetings, routes, runtime } = setup();
    const meeting = await joinedMeeting(meetings);
    await call(
      route(routes, "/api/collab/meeting/facilitator/open"),
      fakeRequest("POST", "/api/collab/meeting/facilitator/open", {
        token: "alice-token",
        body: { meetingId: meeting.id },
      }),
    );
    const triggered = await call(
      route(routes, "/api/collab/meeting/minutes/trigger"),
      fakeRequest("POST", "/api/collab/meeting/minutes/trigger", {
        token: "alice-token",
        body: { meetingId: meeting.id },
      }),
    );
    await runtime.waitIdle();
    const versionId = (triggered.json().version as { id: string }).id;

    const denied = await call(
      route(routes, "/api/collab/meeting/minutes/confirm"),
      fakeRequest("POST", "/api/collab/meeting/minutes/confirm", {
        token: "bob-token",
        body: { meetingId: meeting.id, versionId },
      }),
    );
    expect(denied.status).toBe(403);
  });

  it("rejects facilitator actions from non-participants", async () => {
    const { meetings, routes } = setup();
    const meeting = await joinedMeeting(meetings);
    const denied = await call(
      route(routes, "/api/collab/meeting/facilitator/open"),
      fakeRequest("POST", "/api/collab/meeting/facilitator/open", {
        token: "carol-token",
        body: { meetingId: meeting.id },
      }),
    );
    expect(denied.status).toBe(403);
  });

  it("keeps delegate commissions private to the principal", async () => {
    const { meetings, routes } = setup();
    const meeting = await joinedMeeting(meetings);
    const assigned = await call(
      route(routes, "/api/collab/meeting/delegate/assign"),
      fakeRequest("POST", "/api/collab/meeting/delegate/assign", {
        token: "bob-token",
        body: {
          meetingId: meeting.id,
          teammateInstanceId: "principal:principal-ai-tm-1",
          employeeId: "principal:principal-ai-tm-1",
          speechMode: "mention",
          instruction: { goal: "确认切换风险", stance: "保障交付" },
        },
      }),
    );
    expect(assigned.status).toBe(201);
    expect(assigned.json().delegate).toMatchObject({
      teammateInstanceId: "tm-1",
      employeeId: "employee-1",
    });
    const delegateId = (assigned.json().delegate as { id: string }).id;

    const asPrincipal = await call(
      route(routes, "/api/collab/meeting/delegate/instruction"),
      fakeRequest(
        "GET",
        `/api/collab/meeting/delegate/instruction?delegateId=${delegateId}`,
        { token: "bob-token" },
      ),
    );
    expect(
      (asPrincipal.json().instruction as { goal: string }).goal,
    ).toBe("确认切换风险");

    const asOther = await call(
      route(routes, "/api/collab/meeting/delegate/instruction"),
      fakeRequest(
        "GET",
        `/api/collab/meeting/delegate/instruction?delegateId=${delegateId}`,
        { token: "alice-token" },
      ),
    );
    expect(asOther.status).toBe(403);
  });

  it("advances the read cursor", async () => {
    const { meetings, routes, reads } = setup();
    const meeting = await joinedMeeting(meetings);
    const advanced = await call(
      route(routes, "/api/collab/meeting/read"),
      fakeRequest("POST", "/api/collab/meeting/read", {
        token: "alice-token",
        body: { meetingId: meeting.id, lastReadSeq: 4 },
      }),
    );
    expect(advanced.status).toBe(200);
    expect(reads.lastReadSeq(meeting.id, "alice")).toBe(4);
  });
});
