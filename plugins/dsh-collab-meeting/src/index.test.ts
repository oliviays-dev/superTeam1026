import type { ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  apply,
  createMeetingRoutes,
  FacilitatorMinutesService,
  inject,
  MEETING_MINUTES_NODE_ID,
  MEETING_FACILITATOR_TEAMMATE_ID,
  meetingDomainSpec,
  MeetingService,
  MeetingRuntime,
  migrateMeetingOwnership,
  reapRestartedDispatchParticipants,
  SYSTEM_DEFAULT_WORKSPACE_ID,
  type Meeting,
  type MeetingContext,
  type MeetingDomainLike,
  type MeetingMessage,
  type MeetingParticipant,
  type PersonaServiceLike,
  type MeetingWorkerStartLike,
  type SubagentsRuntimeLike,
  type WebRouteLike,
} from "./index.ts";

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

function tables() {
  return {
    meetings: new FakeTable<Meeting>(),
    participants: new FakeTable<MeetingParticipant>(),
    messages: new FakeTable<MeetingMessage>(),
  };
}

function fakeDomain(current: ReturnType<typeof tables>): MeetingDomainLike {
  return {
    table: ((name: string) =>
      current[
        name === "meetings"
          ? "meetings"
          : name === "participants"
            ? "participants"
            : "messages"
      ]) as unknown as MeetingDomainLike["table"],
    close: async () => undefined,
  };
}

const timestamp = "2026-01-01T00:00:00.000Z";

function personas(): PersonaServiceLike {
  return {
    get: async (id) => ({
      id,
      name: id === "architect" ? "架构师" : "执行者",
      description: "保持工程判断。",
      soul: `# ${id} SOUL\n保持工程判断。`,
    }),
    preset: async (id, context) => `# ${id} SOUL\n${context}\n保持工程判断。`,
  };
}

function subagents(
  starts: MeetingWorkerStartLike[],
  replies: string[] = [],
  failures: unknown[] = [],
): SubagentsRuntimeLike {
  return {
    start: async (_name, spec) => {
      starts.push(spec);
      const failure = failures.shift();
      const reply =
        failure === undefined
          ? (replies.shift() ?? `回复 ${starts.length}`)
          : undefined;
      return {
        id: `worker-run-${starts.length}`,
        result:
          failure === undefined
            ? Promise.resolve({
                output: [{ type: "text", text: reply! }],
                stopReason: "completed",
              })
            : Promise.resolve({
                output: [],
                stopReason: "error",
                diagnostic: String(failure),
              }),
        dispose: async () => undefined,
      };
    },
  };
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

  json(): unknown {
    return JSON.parse(this.body) as unknown;
  }
}

function fakeRequest(
  method: string,
  url: string,
  options: { body?: unknown; token?: string; origin?: string } = {},
) {
  const body = options.body === undefined ? "" : JSON.stringify(options.body);
  return {
    method,
    url,
    headers: {
      host: "127.0.0.1:33117",
      ...(options.origin === undefined ? {} : { origin: options.origin }),
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

function findRoute(routes: readonly WebRouteLike[], path: string) {
  const found = routes.find((route) => route.path === path);
  if (found === undefined) throw new Error(`missing route: ${path}`);
  return found;
}

describe("dsh-collab-meeting", () => {
  let current: ReturnType<typeof tables>;
  let service: MeetingService;

  beforeEach(() => {
    current = tables();
    service = new MeetingService(current, {
      now: () => new Date(timestamp),
    });
  });

  afterEach(() => {
    expect(current.meetings.size).toBeGreaterThanOrEqual(0);
  });

  it("adds the creator as a direct browser participant on create", async () => {
    const team = {
      resolveToken: (token: string) =>
        token === "alice-token"
          ? { userId: "alice", role: "member" }
          : undefined,
      members: () => [{ userId: "alice", name: "Alice", memberRole: "member" }],
    };
    const routes = createMeetingRoutes(service, team);
    const response = await call(
      findRoute(routes, "/api/collab/meetings"),
      fakeRequest("POST", "/api/collab/meetings", {
        token: "alice-token",
        origin: "http://127.0.0.1:33117",
        body: {
          workspaceId: "main",
          title: "创建即入会",
          displayName: "Alice",
        },
      }),
    );

    expect(response.status).toBe(201);
    const meeting = (response.json() as { meeting: Meeting }).meeting;
    expect(service.participants(meeting.id)).toHaveLength(1);
    expect(service.participants(meeting.id)[0]).toMatchObject({
      kind: "human",
      refId: "alice",
      displayName: "Alice",
      source: "direct",
      status: "active",
      leader: false,
    });
  });

  it("creates and lists meetings in the system default project without membership", async () => {
    const team = {
      resolveToken: (token: string) =>
        token === "alice-token"
          ? { userId: "alice", role: "member" }
          : undefined,
      members: () => [],
      users: () => [
        {
          id: "alice",
          name: "Alice",
          role: "member",
          status: "active",
        },
      ],
    };
    const routes = createMeetingRoutes(service, team);
    const response = await call(
      findRoute(routes, "/api/collab/meetings"),
      fakeRequest("POST", "/api/collab/meetings", {
        token: "alice-token",
        origin: "http://127.0.0.1:33117",
        body: {
          title: "无项目会议",
          displayName: "Alice",
        },
      }),
    );

    expect(response.status).toBe(201);
    const meeting = (response.json() as { meeting: Meeting }).meeting;
    expect(meeting.workspaceId).toBe(SYSTEM_DEFAULT_WORKSPACE_ID);
    expect(service.participants(meeting.id)[0]).toMatchObject({
      refId: "alice",
      status: "active",
    });

    const list = await call(
      findRoute(routes, "/api/collab/meetings"),
      fakeRequest(
        "GET",
        `/api/collab/meetings?workspaceId=${SYSTEM_DEFAULT_WORKSPACE_ID}`,
        {
          token: "alice-token",
          origin: "http://127.0.0.1:33117",
        },
      ),
    );
    expect(list.status).toBe(200);
    expect(
      (list.json() as { meetings: Meeting[] }).meetings.map((item) => item.id),
    ).toContain(meeting.id);
  });

  it("creates and reuses an AI conversation with one teammate", async () => {
    const team = {
      resolveToken: (token: string) =>
        token === "alice-token"
          ? { userId: "alice", role: "member" }
          : undefined,
      members: () => [{ userId: "alice", name: "Alice", memberRole: "member" }],
    };
    const routes = createMeetingRoutes(service, team);
    const createRoute = findRoute(routes, "/api/collab/meetings");
    const body = {
      workspaceId: "main",
      title: "研究伙伴",
      kind: "ai",
      teammateInstanceId: "tm-research",
      teammateName: "研究伙伴",
      displayName: "Alice",
    };
    const first = await call(
      createRoute,
      fakeRequest("POST", "/api/collab/meetings", {
        token: "alice-token",
        origin: "http://127.0.0.1:33117",
        body,
      }),
    );
    expect(first.status).toBe(201);
    const firstMeeting = (first.json() as { meeting: Meeting }).meeting;
    expect(firstMeeting).toMatchObject({
      kind: "ai",
      teammateInstanceId: "tm-research",
    });
    expect(
      service
        .participants(firstMeeting.id)
        .map((participant) => participant.kind),
    ).toEqual(["human", "ai_teammate"]);

    const second = await call(
      createRoute,
      fakeRequest("POST", "/api/collab/meetings", {
        token: "alice-token",
        origin: "http://127.0.0.1:33117",
        body,
      }),
    );
    expect(second.status).toBe(200);
    expect((second.json() as { meeting: Meeting }).meeting.id).toBe(
      firstMeeting.id,
    );
  });

  it("keeps AI conversations private from other workspace members", async () => {
    const team = {
      resolveToken: (token: string) =>
        token === "alice-token"
          ? { userId: "alice", role: "member" as const }
          : token === "bob-token"
            ? { userId: "bob", role: "member" as const }
            : token === "charlie-token"
              ? { userId: "charlie", role: "member" as const }
              : undefined,
      members: () => [
        { userId: "alice", name: "Alice", memberRole: "member" as const },
        { userId: "bob", name: "Bob", memberRole: "member" as const },
        { userId: "charlie", name: "Charlie", memberRole: "member" as const },
      ],
    };
    const routes = createMeetingRoutes(service, team, {
      teammateRuntime: () => ({
        ensureRuntime: async () => {
          throw new Error("not used");
        },
        ownersOf: () => [{ userId: "charlie", name: "Charlie" }],
      }),
    });
    const created = await call(
      findRoute(routes, "/api/collab/meetings"),
      fakeRequest("POST", "/api/collab/meetings", {
        token: "alice-token",
        origin: "http://127.0.0.1:33117",
        body: {
          workspaceId: "main",
          title: "Alice 的私聊",
          kind: "ai",
          teammateInstanceId: "tm-research",
          teammateName: "研究伙伴",
          displayName: "Alice",
        },
      }),
    );
    const meeting = (created.json() as { meeting: Meeting }).meeting;

    const list = await call(
      findRoute(routes, "/api/collab/meetings"),
      fakeRequest("GET", "/api/collab/meetings?workspaceId=main", {
        token: "bob-token",
        origin: "http://127.0.0.1:33117",
      }),
    );
    expect(
      (list.json() as { meetings: Meeting[] }).meetings.map((item) => item.id),
    ).not.toContain(meeting.id);

    const denied = await call(
      findRoute(routes, "/api/collab/meeting"),
      fakeRequest(
        "GET",
        `/api/collab/meeting?meetingId=${encodeURIComponent(meeting.id)}`,
        {
          token: "bob-token",
          origin: "http://127.0.0.1:33117",
        },
      ),
    );
    expect(denied.status).toBe(403);

    const ownerAccess = await call(
      findRoute(routes, "/api/collab/meeting"),
      fakeRequest(
        "GET",
        `/api/collab/meeting?meetingId=${encodeURIComponent(meeting.id)}`,
        {
          token: "charlie-token",
          origin: "http://127.0.0.1:33117",
        },
      ),
    );
    expect(ownerAccess.status).toBe(200);

    const allowed = await call(
      findRoute(routes, "/api/collab/meeting"),
      fakeRequest(
        "GET",
        `/api/collab/meeting?meetingId=${encodeURIComponent(meeting.id)}`,
        {
          token: "alice-token",
          origin: "http://127.0.0.1:33117",
        },
      ),
    );
    expect(allowed.status).toBe(200);

    const minutes = await call(
      findRoute(routes, "/api/collab/meeting/minutes"),
      fakeRequest(
        "GET",
        `/api/collab/meeting/minutes?meetingId=${encodeURIComponent(meeting.id)}`,
        {
          token: "alice-token",
          origin: "http://127.0.0.1:33117",
        },
      ),
    );
    expect(minutes.status).toBe(403);
  });

  it("dispatches AI conversation messages as chat runs, not meeting tasks", async () => {
    const team = {
      resolveToken: (token: string) =>
        token === "alice-token"
          ? { userId: "alice", role: "member" as const }
          : undefined,
      members: () => [
        { userId: "alice", name: "Alice", memberRole: "member" as const },
      ],
    };
    const dispatched: Array<Record<string, any>> = [];
    const preparedRequests: Array<Record<string, any>> = [];
    const recordedRuns: Array<Record<string, any>> = [];
    const chatAgent = {
      dispatch: async (input: Record<string, any>) => {
        dispatched.push(input);
        return {
          id: "run-chat-1",
          status: "queued",
          source: "chat",
          instanceId: input.instanceId,
          nodeId: input.nodeId,
          payload: input.payload,
        };
      },
      run: () => undefined,
    };
    const routes = createMeetingRoutes(service, team, {
      teammateRuntime: () => ({
        ensureRuntime: async () => ({
          teammateId: "tm-research",
          principalId: "principal-tm-research",
          profileId: "agent-profile-research",
          personaId: "persona-tm-research",
        }),
      }),
      chatAgent: () => chatAgent as never,
      workspaces: () => ({
        get: () => ({ path: "/tmp/workspace" }),
      }),
      context: () => ({
        registerAdapter: () => () => undefined,
        ensureChatChannel: async () => ({ id: "chat-channel-main-alice" }),
        prepare: async (request: Record<string, any>) => {
          preparedRequests.push(request);
          return {
            id: "pack-chat-1",
            sessionBindingId: "chat:chat-channel-main-alice:principal-tm-research:g0",
            rendered: {
              systemText: "system",
              userText: "已装配的聊天上下文",
              flattenedPrompt: "system\n\n已装配的聊天上下文",
            },
          };
        },
        session: () => ({
          sessionId:
            "de-chat-main-chat-channel-main-alice-principal-tm-research",
          generation: 0,
        }),
        recordRuntime: async (request: Record<string, any>) => {
          recordedRuns.push(request);
        },
      }),
    });
    const created = await call(
      findRoute(routes, "/api/collab/meetings"),
      fakeRequest("POST", "/api/collab/meetings", {
        token: "alice-token",
        origin: "http://127.0.0.1:33117",
        body: {
          workspaceId: "main",
          title: "Alice 与 研究伙伴",
          kind: "ai",
          teammateInstanceId: "tm-research",
          teammateName: "研究伙伴",
          displayName: "Alice",
        },
      }),
    );
    const meeting = (created.json() as { meeting: Meeting }).meeting;
    const posted = await call(
      findRoute(routes, "/api/collab/meeting/message"),
      fakeRequest("POST", "/api/collab/meeting/message", {
        token: "alice-token",
        origin: "http://127.0.0.1:33117",
        body: {
          meetingId: meeting.id,
          content: "帮我分析这周的风险。",
        },
      }),
    );

    expect(posted.status).toBe(201);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      source: "chat",
      instanceId: meeting.id,
      principalId: "principal-tm-research",
      contextPackId: "pack-chat-1",
      sessionBindingId:
        "chat:chat-channel-main-alice:principal-tm-research:g0",
      sessionId:
        "de-chat-main-chat-channel-main-alice-principal-tm-research",
      payload: {
        context: {
          instruction: "已装配的聊天上下文",
          chatChannelId: "chat-channel-main-alice",
          meetingId: meeting.id,
          contextPackId: "pack-chat-1",
        },
      },
    });
    expect(preparedRequests[0]).toMatchObject({
      scene: "chat",
      chatCarrier: "meeting-ai",
      chatChannelId: "chat-channel-main-alice",
      objectId: "chat-channel-main-alice",
      workspaceId: "main",
      teammateId: "tm-research",
    });
    expect(recordedRuns[0]).toMatchObject({
      runId: "run-chat-1",
      contextPackId: "pack-chat-1",
      runtime: { kind: "builtin" },
    });
  });

  it("reuses the AI participant when an agent joins the same meeting twice", async () => {
    const meeting = await service.create(
      { kind: "user", id: "admin", globalRole: "admin" },
      { workspaceId: "main", title: "周会" },
    );
    await service.join(
      { kind: "user", id: "admin", globalRole: "admin" },
      meeting.id,
      "Admin",
    );
    const first = await service.join(
      { kind: "agent", id: "tm-1" },
      meeting.id,
      "江问01 产品",
    );
    const second = await service.join(
      { kind: "agent", id: "tm-1" },
      meeting.id,
      "江问01 产品",
    );
    // AI 重复入会复用同一条参与者，不会多出「名字 · Agent」的第二条。
    expect(second.id).toBe(first.id);
    expect(
      service
        .participants(meeting.id)
        .filter((participant) => participant.kind !== "human")
        .map((participant) => participant.displayName),
    ).toEqual(["江问01 产品"]);
  });

  it("announces Facilitator joining again after it was removed", async () => {
    const actor = {
      kind: "user" as const,
      id: "admin",
      globalRole: "admin" as const,
    };
    const meeting = await service.create(actor, {
      workspaceId: "main",
      title: "Facilitator 重入",
    });
    await service.join(actor, meeting.id, "Admin");
    const first = await service.addAiTeammate(actor, {
      meetingId: meeting.id,
      teammateInstanceId: MEETING_FACILITATOR_TEAMMATE_ID,
      displayName: "会议 Facilitator",
      speechMode: "observe",
    });
    await service.removeParticipant(actor, meeting.id, first.id);
    const second = await service.addAiTeammate(actor, {
      meetingId: meeting.id,
      teammateInstanceId: MEETING_FACILITATOR_TEAMMATE_ID,
      displayName: "会议 Facilitator",
      speechMode: "observe",
    });

    expect(second.id).toBe(first.id);
    expect(service.transcript(meeting.id).at(-1)?.content).toBe(
      "会议 Facilitator 已加入会议。",
    );
  });

  it("declares services and the meeting storage domain", () => {
    expect(inject).toEqual([
      "storageDomain",
      "commands",
      "tools",
      "webServer",
      "agents",
      "agentDefaultModel",
    ]);
    expect(meetingDomainSpec).toMatchObject({
      name: "collab_meeting",
      version: 1,
    });
    expect(Object.keys(meetingDomainSpec.tables)).toEqual([
      "meetings",
      "participants",
      "messages",
      "facilitators",
      "minutes",
      "minute_versions",
      "delegates",
      "delegate_instructions",
      "meeting_reads",
      "meeting_files",
      "meeting_tasks",
    ]);
  });

  it("records transcript and keeps left names unused", async () => {
    const meeting = await service.create(
      { kind: "user", id: "admin", globalRole: "admin" },
      { workspaceId: "main", title: "周会" },
    );
    const alice = await service.join(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "Alice",
    );
    await service.join(
      { kind: "user", id: "bob", workspaceRole: "owner" },
      meeting.id,
      "Bob",
    );
    await expect(
      service.post(
        { kind: "user", id: "carol", workspaceRole: "member" },
        meeting.id,
        "not a participant",
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const message = await service.post(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "先确认本周目标。",
    );
    expect(message).toMatchObject({ sequence: 1, senderName: "Alice" });
    await service.leave(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
    );
    const renamed = await service.join(
      { kind: "user", id: "carol", workspaceRole: "member" },
      meeting.id,
      "Alice",
    );
    expect(renamed.displayName).toBe("Alice · Agent");
    await expect(
      service.close(
        { kind: "user", id: "alice", workspaceRole: "member" },
        meeting.id,
        "Alice left and cannot close.",
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const returned = await service.join(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "Alice",
    );
    expect(returned).toMatchObject({ id: alice.id, status: "active" });
    const closed = await service.close(
      { kind: "user", id: "bob", workspaceRole: "owner" },
      meeting.id,
      "目标已确认。",
    );
    expect(closed).toMatchObject({ status: "closed", summary: "目标已确认。" });
    expect(service.transcript(meeting.id).at(-1)?.senderKind).toBe("system");
    expect(
      service
        .participants(meeting.id)
        .every((participant) => participant.status === "left"),
    ).toBe(true);
  });

  it("invites workspace members directly", async () => {
    const meeting = await service.create(
      { kind: "user", id: "admin", globalRole: "admin" },
      { workspaceId: "main", title: "直邀评审" },
    );
    await service.join(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "Alice",
    );

    const invited = await service.inviteParticipant(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      { targetId: "bob", displayName: "Bob" },
    );
    expect(invited).toMatchObject({
      kind: "human",
      refId: "bob",
      displayName: "Bob",
      status: "active",
      source: "direct",
      leader: false,
    });
    await expect(
      service.inviteParticipant(
        { kind: "user", id: "alice", workspaceRole: "member" },
        meeting.id,
        { targetId: "bob", displayName: "Bob" },
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    expect(service.transcript(meeting.id).at(-1)).toMatchObject({
      senderKind: "system",
      content: "Alice 已邀请 Bob 入会。",
    });

    const team = {
      resolveToken: (token: string) =>
        token === "alice-token"
          ? { userId: "alice", role: "member" }
          : token === "bob-token"
            ? { userId: "bob", role: "member" }
            : token === "outsider-token"
              ? { userId: "outsider", role: "member" }
              : undefined,
      members: () => [
        { userId: "alice", name: "Alice", memberRole: "member" },
        { userId: "bob", name: "Bob", memberRole: "member" },
      ],
    };
    const routes = createMeetingRoutes(service, team);
    const peopleResponse = await call(
      findRoute(routes, "/api/collab/meeting/people"),
      fakeRequest("GET", `/api/collab/meeting/people?meetingId=${meeting.id}`, {
        token: "alice-token",
        origin: "http://127.0.0.1:33117",
      }),
    );
    expect(peopleResponse.status).toBe(200);
    expect(
      (
        peopleResponse.json() as {
          people: Array<{ id: string; state?: string }>;
        }
      ).people,
    ).toMatchObject([
      { id: "alice", state: "active" },
      { id: "bob", state: "active" },
    ]);

    const outsiderResponse = await call(
      findRoute(routes, "/api/collab/meeting/participants/invite"),
      fakeRequest("POST", "/api/collab/meeting/participants/invite", {
        token: "alice-token",
        origin: "http://127.0.0.1:33117",
        body: {
          meetingId: meeting.id,
          people: [{ targetId: "outsider" }],
        },
      }),
    );
    expect(outsiderResponse.status).toBe(400);
    expect(
      service
        .participants(meeting.id)
        .some((participant) => participant.refId === "outsider"),
    ).toBe(false);
  });

  it("lets authorized participants remove users and avatars", async () => {
    const reports: Array<{
      delegationId: string;
      finalize: boolean | undefined;
    }> = [];
    service.setDelegationReporter({
      generateDelegationReport: async (delegationId, _transcript, options) => {
        reports.push({ delegationId, finalize: options.finalize });
      },
    });
    const meeting = await service.create(
      { kind: "user", id: "admin", globalRole: "admin" },
      { workspaceId: "main", title: "移出参会者" },
    );
    const alice = await service.join(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "Alice",
    );
    const bob = await service.join(
      { kind: "user", id: "bob", workspaceRole: "member" },
      meeting.id,
      "Bob",
    );
    const avatar = await service.spawnAgentForUser(
      { kind: "user", id: "alice", workspaceRole: "member" },
      {
        meetingId: meeting.id,
        personaId: "architect",
        displayName: "Alice 的分身",
        ownerName: "Alice",
        autoSpeak: "manual",
        initialGreeting: false,
        delegationId: "delegation-01",
      },
      personas(),
    );

    // Any active human participant may remove members; a non-participant may not.
    await expect(
      service.removeParticipant(
        { kind: "user", id: "carol", workspaceRole: "member" },
        meeting.id,
        avatar.id,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const removedAvatar = await service.removeParticipant(
      { kind: "user", id: "bob", workspaceRole: "member" },
      meeting.id,
      avatar.id,
    );
    await expect(
      service.removeParticipant(
        { kind: "user", id: "alice", workspaceRole: "member" },
        meeting.id,
        alice.id,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    const removedBob = await service.removeParticipant(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      bob.id,
    );

    expect(removedBob).toMatchObject({ id: bob.id, status: "left" });
    expect(removedAvatar).toMatchObject({ id: avatar.id, status: "left" });
    expect(
      service
        .participants(meeting.id)
        .filter((participant) => participant.status === "active")
        .map((participant) => participant.id),
    ).toEqual([alice.id]);
    expect(
      service
        .transcript(meeting.id)
        .filter((message) => message.senderKind === "system")
        .map((message) => message.content),
    ).toEqual([
      "Alice 的分身 已被 Bob 移出会议。",
      "Bob 已被 Alice 移出会议。",
    ]);
    expect(reports).toEqual([
      { delegationId: avatar.delegationId, finalize: false },
    ]);
  });

  it("creates durable worker-backed participants without binding to an Agent", async () => {
    const meeting = await service.create(
      { kind: "agent", id: "root-agent", workspaceRole: "member" },
      { workspaceId: "main", title: "架构评审" },
    );
    const starts: MeetingWorkerStartLike[] = [];
    const participant = await service.spawnAgent(
      { kind: "agent", id: "root-agent", workspaceRole: "member" },
      { meetingId: meeting.id, personaId: "builder" },
      personas(),
    );
    expect(participant).toMatchObject({
      kind: "agent",
      refId: expect.stringMatching(/^worker:[\da-f-]{36}$/),
      personaId: "builder",
      status: "active",
    });
    expect(starts).toHaveLength(0);
  });

  it("runs one-shot workers and writes their final output only to the meeting", async () => {
    const meeting = await service.create(
      { kind: "agent", id: "root-agent", workspaceRole: "member" },
      { workspaceId: "main", title: "协作会" },
    );
    await service.join(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "Alice",
    );
    const starts: MeetingWorkerStartLike[] = [];
    const disposed: string[] = [];
    const runtime = new MeetingRuntime({
      meetings: service,
      agents: () => ({
        get: () => undefined,
        create: async (options) => ({
          agent: { id: options.sessionId },
          dispose: async () => void disposed.push(options.sessionId),
        }),
      }),
      personas: () => personas(),
      subagents: () => subagents(starts, ["边界如下"]),
    });
    await service.spawnAgent(
      { kind: "agent", id: "root-agent", workspaceRole: "member" },
      { meetingId: meeting.id, personaId: "architect", displayName: "架构师" },
      personas(),
    );
    const participant = service
      .participants(meeting.id)
      .find((candidate) => candidate.kind === "agent")!;
    const message = await service.post(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "请给出边界建议。",
    );
    runtime.dispatch(
      message,
      service
        .participants(meeting.id)
        .filter((candidate) =>
          message.deliveries.some(
            (delivery) => delivery.participantId === candidate.id,
          ),
        ),
    );
    await runtime.waitIdle();
    expect(starts).toHaveLength(1);
    expect(starts[0]?.parent.id).toMatch(/^[\da-f-]{36}$/i);
    expect(starts[0]?.toolFilter).toEqual({ allow: [] });
    // persona 参数必须是人设正文，而不是 personaId。
    expect(starts[0]?.persona).toBe("# architect SOUL\n保持工程判断。");
    expect(starts[0]?.prompt[0]?.text).toContain("# architect SOUL");
    expect(starts[0]?.prompt[0]?.text).toContain("请给出边界建议。");
    expect(
      service
        .transcript(meeting.id)
        .find((candidate) => candidate.id === message.id)?.deliveries,
    ).toMatchObject([{ participantId: participant.id, status: "delivered" }]);
    expect(service.transcript(meeting.id).at(-1)).toMatchObject({
      senderKind: "agent",
      senderName: "架构师",
      content: "边界如下",
    });

    const recovered = new MeetingService(current, {
      now: () => new Date(timestamp),
    });
    expect(recovered.list("main")).toHaveLength(1);
    expect(recovered.transcript(meeting.id)).toHaveLength(2);
    expect(
      recovered
        .participants(meeting.id)
        .map((participant) => participant.refId),
    ).toContain(participant.refId);
  });

  it("composes base soul and role overlay when both personas are present", async () => {
    const meeting = await service.create(
      { kind: "agent", id: "root-agent", workspaceRole: "member" },
      { workspaceId: "main", title: "角色叠加会议" },
    );
    await service.join(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "Alice",
    );
    const starts: MeetingWorkerStartLike[] = [];
    const runtime = new MeetingRuntime({
      meetings: service,
      agents: () => ({
        get: () => undefined,
        create: async (options) => ({
          agent: { id: options.sessionId },
          dispose: async () => undefined,
        }),
      }),
      personas: () => personas(),
      subagents: () => subagents(starts, ["好的"]),
    });
    await service.spawnAgent(
      { kind: "agent", id: "root-agent", workspaceRole: "member" },
      {
        meetingId: meeting.id,
        personaId: "architect",
        basePersonaId: "builder",
        displayName: "双重人设",
      },
      personas(),
    );
    const participant = service
      .participants(meeting.id)
      .find((candidate) => candidate.kind === "agent")!;
    const message = await service.post(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "请回复。",
    );
    runtime.dispatch(
      message,
      service
        .participants(meeting.id)
        .filter((candidate) =>
          message.deliveries.some(
            (delivery) => delivery.participantId === candidate.id,
          ),
        ),
    );
    await runtime.waitIdle();
    expect(starts).toHaveLength(1);
    const prompt = starts[0]?.prompt[0]?.text ?? "";
    expect(prompt).toContain("# builder SOUL");
    expect(prompt).toContain("## 会议角色上下文");
    expect(prompt).toContain("架构师");
  });

  it("protects browser routes with same-origin, bearer, and workspace checks", async () => {
    const meeting = await service.create(
      { kind: "user", id: "admin", globalRole: "admin" },
      { workspaceId: "main", title: "安全评审" },
    );
    const team = {
      resolveToken: (token: string) =>
        token === "member-token"
          ? { userId: "alice", role: "member" }
          : token === "outsider-token"
            ? { userId: "outsider", role: "member" }
            : undefined,
      members: () => [{ userId: "alice", memberRole: "member" }],
    };
    const routes = createMeetingRoutes(service, team);
    const list = findRoute(routes, "/api/collab/meetings");
    const crossOrigin = await call(
      list,
      fakeRequest("GET", "/api/collab/meetings?workspaceId=main", {
        token: "member-token",
        origin: "https://evil.example",
      }),
    );
    expect(crossOrigin.status).toBe(403);
    const badToken = await call(
      list,
      fakeRequest("GET", "/api/collab/meetings?workspaceId=main", {
        token: "invalid",
        origin: "http://127.0.0.1:33117",
      }),
    );
    expect(badToken.status).toBe(401);
    const outsider = await call(
      list,
      fakeRequest("GET", "/api/collab/meetings?workspaceId=main", {
        token: "outsider-token",
        origin: "http://127.0.0.1:33117",
      }),
    );
    expect(outsider.status).toBe(403);
    const member = await call(
      list,
      fakeRequest("GET", "/api/collab/meetings?workspaceId=main", {
        token: "member-token",
        origin: "http://127.0.0.1:33117",
      }),
    );
    expect(member.status).toBe(200);
    expect(member.json()).toMatchObject({ ok: true, meetings: [meeting] });
    expect(
      (
        member.json() as {
          meetings: Array<{
            messageCount: number;
            lastMessage: unknown;
            lastActivityAt: string;
          }>;
        }
      ).meetings[0],
    ).toMatchObject({
      messageCount: 0,
      lastMessage: null,
      lastActivityAt: meeting.updatedAt,
    });
    await service.join(
      { kind: "user", id: "admin", globalRole: "admin" },
      meeting.id,
      "Admin",
    );
    await service.post(
      { kind: "user", id: "admin", globalRole: "admin" },
      meeting.id,
      "最新消息内容",
    );
    const withUnread = await call(
      list,
      fakeRequest("GET", "/api/collab/meetings?workspaceId=main", {
        token: "member-token",
        origin: "http://127.0.0.1:33117",
      }),
    );
    expect(withUnread.status).toBe(200);
    expect(
      (
        withUnread.json() as {
          meetings: Array<{
            messageCount: number;
            unreadCount: number;
            lastMessage: { content: string; createdAt: string };
            lastActivityAt: string;
          }>;
        }
      ).meetings[0],
    ).toMatchObject({
      messageCount: 1,
      unreadCount: 1,
      lastMessage: {
        content: "最新消息内容",
      },
    });

    await service.join(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "Alice",
    );
    const all = await service.spawnAgentForUser(
      { kind: "user", id: "alice", workspaceRole: "member" },
      {
        meetingId: meeting.id,
        personaId: "architect",
        autoSpeak: "mentions",
        initialGreeting: true,
        ownerName: "Alice",
      },
      personas(),
    );
    const manual = await service.spawnAgentForUser(
      { kind: "user", id: "alice", workspaceRole: "member" },
      {
        meetingId: meeting.id,
        personaId: "builder",
        autoSpeak: "manual",
        initialGreeting: false,
        ownerName: "Alice",
      },
      personas(),
    );
    expect(all).toMatchObject({
      kind: "agent",
      ownerId: "alice",
      ownerName: "Alice",
      autoSpeak: "mentions",
      initialGreeting: true,
    });
    expect(manual.displayName).not.toBe(all.displayName);

    const group = await service.post(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "群发消息",
    );
    expect(group.deliveries).toEqual([]);

    const direct = await service.post(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "定向消息",
      {
        mentions: [all.id],
      },
    );
    expect(direct.mentions).toEqual([all.id]);
    expect(direct.deliveries).toMatchObject([
      { participantId: all.id, targetId: all.refId, status: "pending" },
    ]);
  });

  it("拒绝 AI 通过会议工具把参会者拉进会议（只允许 list/read/say）", async () => {
    const tools: Array<{
      execute: (args: unknown, exec: unknown) => Promise<unknown>;
    }> = [];
    const ctx: MeetingContext = {
      effect: () => undefined,
      provide: () => undefined,
      commands: { register: () => undefined },
      tools: {
        register: (definition: unknown) => tools.push(definition as never),
      },
      webServer: { register: () => () => undefined },
      storageDomain: { open: async () => fakeDomain(current) },
      get: () => undefined,
      inject: (
        _keys: readonly string[],
        callback: (context: unknown) => void,
      ) => {
        callback(ctx as MeetingContext & { readonly collabTeam: unknown });
        return { dispose: () => undefined };
      },
    } as unknown as MeetingContext;
    await apply(ctx);
    expect(tools).toHaveLength(1);

    const agentExec = {
      signal: { throwIfAborted: () => undefined },
      agent: { id: "agent-1", session: { id: "session-1" } },
    };
    for (const operation of ["join", "spawn", "create", "leave", "close"]) {
      await expect(
        tools[0]!.execute(
          { operation, meetingId: "m-1", workspaceId: "main", title: "T" },
          agentExec,
        ),
      ).rejects.toThrow(/只有人类/);
    }
    // 只读与发言仍然放行（这里只验证没被权限挡住：list 会正常返回文本）。
    await expect(
      tools[0]!.execute({ operation: "list", workspaceId: "main" }, agentExec),
    ).resolves.toBeDefined();
  });

  it("registers Agent surfaces and only installs browser routes in identity fiber", async () => {
    const provided: string[] = [];
    const commands: unknown[] = [];
    const tools: unknown[] = [];
    const routes: WebRouteLike[] = [];
    const disposers: Array<() => void> = [];
    const registeredAdapters: Array<{
      readonly scene?: string;
      readonly chatCarrier?: string;
    }> = [];
    const chatContext = {
      registerAdapter: (adapter: {
        readonly scene?: string;
        readonly chatCarrier?: string;
      }) => {
        registeredAdapters.push(adapter);
        return () => undefined;
      },
    };
    const ctx: MeetingContext = {
      effect: (register) => disposers.push(register()),
      provide: (key) => provided.push(key),
      commands: { register: (definition) => commands.push(definition) },
      tools: { register: (definition) => tools.push(definition) },
      webServer: { register: (route) => routes.push(route) },
      storageDomain: { open: async () => fakeDomain(current) },
      get: (key) =>
        key === "collabContext" ? (chatContext as never) : undefined,
      inject: (_keys, callback) => {
        callback(
          ctx as MeetingContext & {
            readonly collabTeam: {
              resolveToken: () => undefined;
              members: () => [];
            };
          },
        );
        return { dispose: () => undefined };
      },
    };
    const dispose = await apply(ctx);
    expect(provided).toEqual([
      "collabMeeting",
      "collabMeetingMinutes",
      "collabMeetingDelegates",
      "collabMeetingReads",
      "collabMeetingFiles",
      "collabMeetingTasks",
      "collabMeetingMinutesRuntime",
    ]);
    expect(commands).toHaveLength(1);
    expect(tools).toHaveLength(1);
    expect(registeredAdapters).toEqual([
      expect.objectContaining({
        scene: "chat",
        chatCarrier: "meeting-ai",
      }),
      expect.objectContaining({ scene: "meeting" }),
    ]);
    expect(routes.map((route) => route.path)).toContain("/api/collab/meetings");
    expect(typeof dispose).toBe("function");
  });

  function participantRow(
    overrides: Partial<MeetingParticipant> &
      Pick<MeetingParticipant, "id" | "meetingId" | "refId">,
  ): MeetingParticipant {
    return {
      kind: "agent",
      displayName: "Agent",
      leader: false,
      status: "active",
      source: "spawned",
      joinedAt: timestamp,
      updatedAt: timestamp,
      ...overrides,
    };
  }

  async function meetingWithAlice(): Promise<Meeting> {
    const meeting = await service.create(
      { kind: "user", id: "admin", globalRole: "admin" },
      { workspaceId: "main", title: "需求讨论" },
    );
    await service.join(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "Alice",
    );
    return meeting;
  }

  it("migrates legacy Lead ownership out of the authoritative model", async () => {
    const legacyMeeting: Meeting = {
      id: "m-legacy",
      workspaceId: "main",
      title: "旧会议",
      kind: "meeting",
      agenda: "",
      status: "active",
      createdBy: "admin",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await current.meetings.put(legacyMeeting.id, legacyMeeting);
    await current.participants.put(
      "p-1",
      participantRow({
        id: "p-1",
        meetingId: "m-legacy",
        refId: "alice",
        kind: "human",
        displayName: "Alice",
        leader: true,
        source: "seat",
      }),
    );

    const result = await migrateMeetingOwnership(
      current.meetings,
      current.participants,
      () => new Date(timestamp),
    );
    expect(result).toEqual({ meetings: 1, participants: 1 });
    const migrated = service.get("m-legacy");
    expect(migrated.ownerUserId).toBe("alice");
    const participant = service.participants("m-legacy")[0]!;
    expect(participant.leader).toBe(false);

    // Idempotent: a second mount writes nothing.
    const second = await migrateMeetingOwnership(
      current.meetings,
      current.participants,
      () => new Date(timestamp),
    );
    expect(second).toEqual({ meetings: 0, participants: 0 });
  });

  it("joins an AI representative that attends for its principal", async () => {
    const meeting = await meetingWithAlice();
    const representative = await service.addAiRepresentative(
      { kind: "user", id: "alice", workspaceRole: "member" },
      {
        meetingId: meeting.id,
        delegateId: "delegate-1",
        principalUserId: "alice",
        principalName: "Alice",
        aiPrincipalId: "principal-ai-tm-1",
        teammateInstanceId: "tm-1",
        speechMode: "mention",
      },
    );
    expect(representative).toMatchObject({
      kind: "ai_representative",
      displayName: "Alice 的 AI 参会代表",
      principalUserId: "alice",
      aiPrincipalId: "principal-ai-tm-1",
      autoSpeak: "mentions",
    });

    const aliceParticipant = service
      .participants(meeting.id)
      .find(
        (participant) =>
          participant.kind === "human" && participant.refId === "alice",
      )!;
    const asked = await service.post(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "请 Alice 确认切换窗口。",
      { mentions: [aliceParticipant.id] },
    );
    // @委托人也会触发其 AI 参会代表。
    expect(asked.deliveries).toMatchObject([
      { participantId: representative.id, status: "pending" },
    ]);

    const reply = await service.postWorkerReply(
      representative.id,
      "我代表 Alice 确认：窗口不超过 3 天。",
    );
    expect(reply).toMatchObject({
      senderKind: "agent",
      senderName: "Alice 的 AI 参会代表",
      provenance: { role: "representative", delegateId: "delegate-1" },
    });
    expect(
      service.transcript(meeting.id).find((message) => message.id === asked.id)
        ?.deliveries,
    ).toMatchObject([{ status: "delivered" }]);
  });

  it("archives a closed meeting and rejects archiving an active one", async () => {
    const meeting = await meetingWithAlice();
    await expect(
      service.archive(
        { kind: "user", id: "alice", workspaceRole: "member" },
        meeting.id,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await service.close(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "目标已确认。",
    );
    const archived = await service.archive(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
    );
    expect(archived.status).toBe("archived");
  });

  it("parses typed @mentions from the message text", async () => {
    const meeting = await meetingWithAlice();
    await service.join(
      { kind: "user", id: "bob", workspaceRole: "member" },
      meeting.id,
      "Bob",
    );
    const representative = await service.addAiRepresentative(
      { kind: "user", id: "alice", workspaceRole: "member" },
      {
        meetingId: meeting.id,
        delegateId: "delegate-typed",
        principalUserId: "alice",
        principalName: "Alice",
        teammateInstanceId: "tm-typed",
        speechMode: "mention",
      },
    );
    // Bob types `@Alice` without selecting anyone from a picker.
    const message = await service.post(
      { kind: "user", id: "bob", workspaceRole: "member" },
      meeting.id,
      "@Alice 请确认切换窗口。",
    );
    expect(message.mentions.length).toBe(1);
    expect(message.deliveries).toMatchObject([
      { participantId: representative.id, status: "pending" },
    ]);
  });

  it("keeps mentions targeted while group messages remain visible context", async () => {
    const meeting = await meetingWithAlice();
    const all = await service.spawnAgentForUser(
      { kind: "user", id: "alice", workspaceRole: "member" },
      {
        meetingId: meeting.id,
        personaId: "architect",
        displayName: "架构师",
        autoSpeak: "mentions",
        initialGreeting: false,
        ownerName: "Alice",
      },
      personas(),
    );
    await service.spawnAgentForUser(
      { kind: "user", id: "alice", workspaceRole: "member" },
      {
        meetingId: meeting.id,
        personaId: "builder",
        displayName: "执行者",
        autoSpeak: "manual",
        initialGreeting: false,
        ownerName: "Alice",
      },
      personas(),
    );

    const direct = await service.post(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "请架构师判断边界",
      { mentions: [all.id] },
    );
    expect(direct.deliveries).toEqual([
      {
        participantId: all.id,
        targetId: all.refId,
        status: "pending",
      },
    ]);

    const group = await service.post(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "这条只是同步",
    );
    expect(group.deliveries).toEqual([]);
  });

  it("records worker failures without retiring the durable participant", async () => {
    const meeting = await meetingWithAlice();
    const starts: MeetingWorkerStartLike[] = [];
    const runtime = new MeetingRuntime({
      meetings: service,
      agents: () => ({
        get: () => undefined,
        create: async (options) => ({
          agent: { id: options.sessionId },
          dispose: async () => undefined,
        }),
      }),
      subagents: () => subagents(starts, [], ["model overloaded"]),
    });
    const participant = await service.spawnAgentForUser(
      { kind: "user", id: "alice", workspaceRole: "member" },
      {
        meetingId: meeting.id,
        personaId: "architect",
        autoSpeak: "all",
        initialGreeting: false,
        ownerName: "Alice",
      },
      personas(),
    );
    const message = await service.post(
      { kind: "user", id: "alice", workspaceRole: "member" },
      meeting.id,
      "开始吧",
    );
    runtime.dispatch(message, [participant]);
    await runtime.waitIdle();
    expect(message.deliveries).toMatchObject([{ status: "pending" }]);
    expect(service.transcript(meeting.id).at(-1)?.deliveries).toMatchObject([
      { status: "failed", error: "error: model overloaded" },
    ]);
    expect(
      service.participants(meeting.id).find(({ id }) => id === participant.id)
        ?.status,
    ).toBe("active");
  });

  it("marks expired meeting avatars and blocks their worker replies", async () => {
    const meeting = await meetingWithAlice();
    service.setDelegationReporter({
      generateDelegationReport: async () => undefined,
      getDelegationStatus: () => ({
        status: "active",
        expiresAt: "2025-12-31T23:59:59.000Z",
      }),
    });
    const avatar = await service.spawnAgentForUser(
      { kind: "user", id: "alice", workspaceRole: "member" },
      {
        meetingId: meeting.id,
        personaId: "architect",
        displayName: "过期分身",
        autoSpeak: "mentions",
        initialGreeting: false,
        ownerName: "Alice",
        delegationId: "delegation-expired",
      },
      personas(),
    );

    await expect(
      service.postWorkerReply(avatar.id, "我还能回复"),
    ).rejects.toThrow("delegation is expired");
    expect(service.transcript(meeting.id).at(-1)).toMatchObject({
      senderKind: "system",
      content: expect.stringContaining("的委托已到期"),
    });
  });

  it("isolates same-persona participants across meetings", async () => {
    const first = await meetingWithAlice();
    const second = await service.create(
      { kind: "user", id: "admin", globalRole: "admin" },
      { workspaceId: "main", title: "另一个会议" },
    );
    await service.join(
      { kind: "user", id: "bob", workspaceRole: "member" },
      second.id,
      "Bob",
    );
    const starts: MeetingWorkerStartLike[] = [];
    const runtime = new MeetingRuntime({
      meetings: service,
      agents: () => ({
        get: () => undefined,
        create: async (options) => ({
          agent: { id: options.sessionId },
          dispose: async () => undefined,
        }),
      }),
      subagents: () => subagents(starts, ["隔离回复", "隔离回复"]),
    });
    const left = await service.spawnAgentForUser(
      { kind: "user", id: "alice", workspaceRole: "member" },
      {
        meetingId: first.id,
        personaId: "architect",
        displayName: "架构师",
        autoSpeak: "all",
        initialGreeting: false,
        ownerName: "Alice",
      },
      personas(),
    );
    const right = await service.spawnAgentForUser(
      { kind: "user", id: "bob", workspaceRole: "member" },
      {
        meetingId: second.id,
        personaId: "architect",
        displayName: "架构师",
        autoSpeak: "all",
        initialGreeting: false,
        ownerName: "Bob",
      },
      personas(),
    );
    const leftMessage = await service.post(
      { kind: "user", id: "alice", workspaceRole: "member" },
      first.id,
      "第一场问题",
    );
    const rightMessage = await service.post(
      { kind: "user", id: "bob", workspaceRole: "member" },
      second.id,
      "第二场问题",
    );
    runtime.dispatch(leftMessage, [left]);
    runtime.dispatch(rightMessage, [right]);
    await runtime.waitIdle();
    expect(left.id).not.toBe(right.id);
    expect(service.transcript(first.id).at(-1)?.content).toBe("隔离回复");
    expect(service.transcript(second.id).at(-1)?.content).toBe("隔离回复");
    expect(starts.map((start) => start.prompt[0]?.text)).toEqual([
      expect.stringContaining("第一场问题"),
      expect.stringContaining("第二场问题"),
    ]);
  });

  it("rejects unscoped reply writes", async () => {
    const meeting = await meetingWithAlice();
    const participant = await service.spawnAgentForUser(
      { kind: "user", id: "alice", workspaceRole: "member" },
      {
        meetingId: meeting.id,
        personaId: "architect",
        autoSpeak: "manual",
        initialGreeting: false,
        ownerName: "Alice",
      },
      personas(),
    );
    current.participants.records.set(participant.id, {
      ...participant,
      status: "left",
      leftAt: timestamp,
      updatedAt: timestamp,
    });
    await expect(
      service.postWorkerReply(participant.id, "太迟了"),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("retires only dispatch-backed rows on the restart sweep", async () => {
    const table = new FakeTable<MeetingParticipant>();
    const base = { meetingId: "meeting-1", updatedAt: timestamp };
    await table.put(
      "dead",
      participantRow({
        ...base,
        id: "dead",
        refId: "dispatch-1",
        source: "direct",
      }),
    );
    await table.put(
      "spawned-child",
      participantRow({ ...base, id: "spawned-child", refId: "child-1" }),
    );
    await table.put(
      "legacy-child",
      participantRow({
        ...base,
        id: "legacy-child",
        refId: "child-2",
        source: "seat",
      }),
    );
    await table.put(
      "already-gone",
      participantRow({
        ...base,
        id: "already-gone",
        refId: "dispatch-2",
        source: "direct",
        status: "left",
      }),
    );

    const reaped = await reapRestartedDispatchParticipants(
      table,
      () => new Date(timestamp),
    );
    expect(reaped).toBe(2);
    expect(table.get("dead")?.status).toBe("left");
    expect(table.get("dead")?.leftAt).toBe(timestamp);
    expect(table.get("spawned-child")?.status).toBe("left");
    expect(table.get("legacy-child")?.status).toBe("active");
    expect(table.get("already-gone")?.status).toBe("left");
  });

  it("dispatches one facilitator minutes run per transcript version", async () => {
    const meeting = await service.create(
      { kind: "user", id: "admin", globalRole: "admin" },
      { workspaceId: "main", title: "周会", agenda: "对齐产能" },
    );
    const actor = {
      kind: "user" as const,
      id: "admin",
      globalRole: "admin" as const,
    };
    await service.join(actor, meeting.id, "Admin");
    await service.post(actor, meeting.id, "替代产能锁定在 11 月底。");

    interface Dispatched {
      source: string;
      nodeId: string;
      instanceId: string;
      dispatchKey: string;
      profileId: string;
      personaId?: string | undefined;
      payload: { instanceTitle: string; context: Record<string, unknown> };
    }
    const dispatched: Dispatched[] = [];
    const storedRuns: Array<{ dispatchKey: string; status: string }> = [];
    const ensured: string[] = [];
    const minutes = new FacilitatorMinutesService({
      meetings: service,
      agents: () => ({
        dispatch: async (input: Dispatched) => {
          dispatched.push(input);
          storedRuns.push({ dispatchKey: input.dispatchKey, status: "queued" });
          return {};
        },
        runs: () => storedRuns,
      }),
      teammateRuntime: () => ({
        ensureRuntime: async (input) => {
          ensured.push(input.teammateId);
          return {
            teammateId: input.teammateId,
            employeeId: "emp-facilitator",
            profileId: "profile-facilitator",
            personaId: "persona-meeting-facilitator",
          };
        },
      }),
      team: () => ({
        resolveToken: () => undefined,
        members: () => [
          { userId: "admin", memberRole: "owner", name: "Admin" },
        ],
      }),
    });
    service.onTranscriptChanged = (meetingId) => minutes.schedule(meetingId);

    minutes.schedule(meeting.id);
    minutes.schedule(meeting.id);
    await minutes.waitIdle();
    expect(ensured).toEqual(["meeting-facilitator"]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      source: "meeting",
      nodeId: MEETING_MINUTES_NODE_ID,
      instanceId: meeting.id,
      profileId: "profile-facilitator",
      personaId: "persona-meeting-facilitator",
    });
    expect(dispatched[0]!.dispatchKey).toContain(meeting.id);
    expect(dispatched[0]!.payload.instanceTitle).toBe("周会");
    expect(String(dispatched[0]!.payload.context.transcript)).toContain(
      "替代产能锁定在 11 月底",
    );

    // 散会再触发一次：新的消息版本 → 新 run。
    await service.close(actor, meeting.id, "手填散会摘要。");
    await minutes.waitIdle();
    expect(dispatched).toHaveLength(2);
  });

  it("skips facilitator minutes without dialogue and swallows runtime failures", async () => {
    const meeting = await service.create(
      { kind: "user", id: "admin", globalRole: "admin" },
      { workspaceId: "main", title: "空会议" },
    );
    let dispatchCount = 0;
    const minutes = new FacilitatorMinutesService({
      meetings: service,
      agents: () => ({
        dispatch: async () => {
          dispatchCount += 1;
          return {};
        },
        runs: () => [],
      }),
      teammateRuntime: () => ({
        ensureRuntime: async () => {
          throw new Error("no owner available");
        },
      }),
      team: () => ({ resolveToken: () => undefined, members: () => [] }),
    });
    // 无对话：不派发
    minutes.schedule(meeting.id);
    await minutes.waitIdle();
    expect(dispatchCount).toBe(0);

    // 有对话但 ensureRuntime 失败：静默，不抛错、不派发。
    const actor = {
      kind: "user" as const,
      id: "admin",
      globalRole: "admin" as const,
    };
    await service.join(actor, meeting.id, "Admin");
    await service.post(actor, meeting.id, "第一条发言。");
    minutes.schedule(meeting.id);
    await minutes.waitIdle();
    expect(dispatchCount).toBe(0);
  });
});
