import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunExecutor } from "@pluginmax/application";
import type {
  Meeting,
  MeetingAiParticipant,
  MeetingAiPolicy,
  MeetingMessage,
  TriggerMeetingAiResult,
} from "@pluginmax/contracts";
import {
  Database,
  LATEST_MIGRATION_VERSION,
  migrate,
  PlatformRepositories,
  type ClaimedJob,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("meeting multi-AI PostgreSQL integration", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let executor: RunExecutor;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-m5-meeting-files-"),
    );
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-m5-meeting-workspaces-"),
    );
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: LATEST_MIGRATION_VERSION,
    });
    app = built.app;
    await app.ready();
    executor = new RunExecutor(repositories, {
      workspaceRoot,
      fileStoreRoot,
      dsh: {
        dshBin: "dsh",
        profile: "sdk",
        dshHome: join(workspaceRoot, "dsh-home"),
        provider: "test",
        model: "test",
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: unknown,
  ): Promise<{ statusCode: number; body: T }> {
    const options: InjectOptions = {
      method,
      url,
      headers: { "x-pluginmax-actor": "local-admin" },
    };
    if (payload !== undefined) {
      options.payload = payload as Record<string, unknown>;
    }
    const response = await app.inject(options);
    return {
      statusCode: response.statusCode,
      body: response.json() as T,
    };
  }

  async function fixture(): Promise<{
    projectId: string;
    agents: Array<{ id: string; name: string }>;
    meeting: Meeting;
  }> {
    const project = await request<{ id: string }>("POST", "/api/v1/projects", {
      name: `M5 Meeting ${randomUUID().slice(0, 8)}`,
      description: "Meeting multi-AI",
    });
    expect(project.statusCode).toBe(201);
    const agents: Array<{ id: string; name: string }> = [];
    for (let index = 0; index < 2; index += 1) {
      const agent = await request<{ id: string; name: string }>(
        "POST",
        "/api/v1/agents",
        {
          name: `Meeting AI ${index}-${randomUUID().slice(0, 8)}`,
          runtimeKind: "fake",
        },
      );
      expect(agent.statusCode).toBe(201);
      agents.push(agent.body);
      const member = await request(
        "POST",
        `/api/v1/projects/${project.body.id}/members`,
        {
          kind: "agent",
          agentId: agent.body.id,
          responsibility: "Meeting participant",
          roleIds: [],
        },
      );
      expect(member.statusCode).toBe(201);
    }
    const meeting = await request<Meeting>("POST", "/api/v1/meetings", {
      projectId: project.body.id,
      title: `Multi AI meeting ${randomUUID().slice(0, 8)}`,
      agenda: "Independent directed replies",
      agentIds: agents.map((agent) => agent.id),
    });
    expect(meeting.statusCode).toBe(201);
    return { projectId: project.body.id, agents, meeting: meeting.body };
  }

  async function enablePolicy(
    meetingId: string,
    input: {
      readonly autoSpeak: "all" | "mentions" | "manual";
      readonly maxTriggerDepth?: number;
      readonly maxConcurrentAgentsPerScene?: number;
    },
  ): Promise<MeetingAiPolicy> {
    const current = await request<MeetingAiPolicy>(
      "GET",
      `/api/v1/meetings/${meetingId}/ai-policy`,
    );
    expect(current.statusCode).toBe(200);
    const updated = await request<MeetingAiPolicy>(
      "PUT",
      `/api/v1/meetings/${meetingId}/ai-policy`,
      {
        expectedRevision: current.body.revision,
        status: "active",
        autoSpeak: input.autoSpeak,
        triggerKinds: ["mention", "round", "agenda", "summary"],
        cooldownSeconds: 0,
        maxRounds: 20,
        maxMessages: 20,
        runBudgetMs: 5_000,
        maxTriggerDepth: input.maxTriggerDepth ?? 3,
        maxConcurrentAgentsPerScene:
          input.maxConcurrentAgentsPerScene ?? 3,
      },
    );
    expect(updated.statusCode).toBe(200);
    return updated.body;
  }

  async function processJob(job: ClaimedJob): Promise<void> {
    await executor.execute(job.runId, {
      jobId: job.id,
      owner: "m5-meeting-worker",
      leaseSeconds: 60,
      traceId: job.traceId,
      jobSpanId: job.spanId,
      assertLease: async () => undefined,
    });
    await repositories.jobs.complete(job.id, "m5-meeting-worker", job.leaseToken);
  }

  it("supports directed mentions, autoSpeak all/manual, and independent replies", async () => {
    const fixtureData = await fixture();
    await enablePolicy(fixtureData.meeting.id, { autoSpeak: "mentions" });
    const directed = await request<MeetingMessage>(
      "POST",
      `/api/v1/meetings/${fixtureData.meeting.id}/messages`,
      {
        content: `@${fixtureData.agents[0]!.name} answer only this question`,
        mentions: [fixtureData.agents[0]!.id],
      },
    );
    expect(directed.statusCode).toBe(201);
    const directedTurns = await database.query<{
      agent_id: string;
      run_id: string;
      id: string;
    }>(
      `SELECT agent_id, run_id, id
       FROM meeting_ai_turns
       WHERE meeting_id = $1
       ORDER BY created_at`,
      [fixtureData.meeting.id],
    );
    expect(directedTurns.rows.map((row) => row.agent_id)).toEqual([
      fixtureData.agents[0]!.id,
    ]);
    const repeated = await request<TriggerMeetingAiResult>(
      "POST",
      `/api/v1/meetings/${fixtureData.meeting.id}/ai-triggers`,
      {
        kind: "mention",
        agentIds: [fixtureData.agents[0]!.id],
        sourceMessageId: directed.body.id,
        reason: "repeat delivery should reuse",
      },
    );
    expect(repeated.statusCode).toBe(202);
    expect(repeated.body.outcome).toBe("reused");

    await enablePolicy(fixtureData.meeting.id, { autoSpeak: "all" });
    const broadcast = await request<MeetingMessage>(
      "POST",
      `/api/v1/meetings/${fixtureData.meeting.id}/messages`,
      { content: "Both AI participants should respond independently." },
    );
    expect(broadcast.statusCode).toBe(201);
    const allTurns = await database.query<{
      agent_id: string;
      run_id: string;
      id: string;
      participant_binding_id: string;
      agent_principal_id: string;
    }>(
      `SELECT agent_id, run_id, id, participant_binding_id, agent_principal_id
       FROM meeting_ai_turns
       WHERE meeting_id = $1
         AND source_message_id = $2
       ORDER BY agent_id`,
      [fixtureData.meeting.id, broadcast.body.id],
    );
    expect(allTurns.rows).toHaveLength(2);
    expect(new Set(allTurns.rows.map((row) => row.run_id)).size).toBe(2);
    expect(
      new Set(allTurns.rows.map((row) => row.participant_binding_id)).size,
    ).toBe(2);
    await enablePolicy(fixtureData.meeting.id, {
      autoSpeak: "manual",
      maxConcurrentAgentsPerScene: 5,
    });
    const beforeManual = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM meeting_ai_turns WHERE meeting_id = $1",
      [fixtureData.meeting.id],
    );
    const manual = await request(
      "POST",
      `/api/v1/meetings/${fixtureData.meeting.id}/messages`,
      { content: "Manual mode should not wake any AI." },
    );
    expect(manual.statusCode).toBe(201);
    const afterManual = await database.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM meeting_ai_turns WHERE meeting_id = $1",
      [fixtureData.meeting.id],
    );
    expect(afterManual.rows[0]?.count).toBe(beforeManual.rows[0]?.count);
    const explicit = await request<TriggerMeetingAiResult>(
      "POST",
      `/api/v1/meetings/${fixtureData.meeting.id}/ai-triggers`,
      {
        kind: "round",
        roundNumber: 3,
        agentIds: fixtureData.agents.map((agent) => agent.id),
      },
    );
    expect(explicit.statusCode).toBe(202);
    expect(explicit.body.outcome).toBe("queued");
    expect(explicit.body.turns).toHaveLength(2);
    for (const turn of explicit.body.turns) {
      const job = await repositories.jobs.claimNext(
        "m5-meeting-worker",
        60,
        turn.runId!,
      );
      expect(job).toBeDefined();
      await processJob(job!);
    }
    const replies = await database.query<{
      id: string;
      turn_id: string;
      run_id: string;
      participant_binding_id: string;
      sender_principal_id: string;
      trigger_depth: number;
    }>(
      `SELECT id, turn_id, run_id, participant_binding_id, sender_principal_id,
              trigger_depth
       FROM meeting_messages
       WHERE meeting_id = $1
         AND turn_id = ANY($2::uuid[])
       ORDER BY turn_id`,
      [
        fixtureData.meeting.id,
        explicit.body.turns.map((turn) => turn.id),
      ],
    );
    expect(replies.rows).toHaveLength(2);
    expect(
      replies.rows.every(
        (reply) =>
          reply.run_id !== null &&
          reply.participant_binding_id !== null &&
          reply.sender_principal_id !== null &&
          reply.trigger_depth === 1,
      ),
    ).toBe(true);
    const deliveries = await database.query<{
      message_id: string;
      count: string;
    }>(
      `SELECT message_id, COUNT(*)::text AS count
       FROM meeting_message_deliveries
       WHERE message_id = ANY($1::uuid[])
       GROUP BY message_id`,
      [replies.rows.map((reply) => reply.id)],
    );
    expect(
      deliveries.rows.every((delivery) => Number(delivery.count) >= 1),
    ).toBe(true);
    const replayedRound = await request<TriggerMeetingAiResult>(
      "POST",
      `/api/v1/meetings/${fixtureData.meeting.id}/ai-triggers`,
      {
        kind: "round",
        roundNumber: 3,
        agentIds: fixtureData.agents.map((agent) => agent.id),
      },
    );
    expect(replayedRound.statusCode).toBe(202);
    expect(replayedRound.body.outcome).toBe("reused");
    const replyCount = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM meeting_messages
       WHERE meeting_id = $1
         AND turn_id = ANY($2::uuid[])`,
      [
        fixtureData.meeting.id,
        explicit.body.turns.map((turn) => turn.id),
      ],
    );
    expect(replyCount.rows[0]?.count).toBe("2");
  });

  it("enforces participant pause, scene concurrency and trigger depth", async () => {
    const fixtureData = await fixture();
    await enablePolicy(fixtureData.meeting.id, {
      autoSpeak: "all",
      maxConcurrentAgentsPerScene: 1,
      maxTriggerDepth: 2,
    });
    const participants = await request<{
      items: MeetingAiParticipant[];
    }>(
      "GET",
      `/api/v1/meetings/${fixtureData.meeting.id}/ai-participants`,
    );
    expect(participants.statusCode).toBe(200);
    expect(participants.body.items).toHaveLength(2);
    const pausedParticipant = participants.body.items[0]!;
    const paused = await request<MeetingAiParticipant>(
      "PUT",
      `/api/v1/meetings/${fixtureData.meeting.id}/ai-participants/${pausedParticipant.agentId}`,
      {
        expectedRevision: pausedParticipant.revision,
        status: "paused",
        reason: "Pause one AI",
      },
    );
    expect(paused.statusCode).toBe(200);
    const participantAudit = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM identity_audit_events
       WHERE action = 'meeting.ai.participant.updated'
         AND metadata ->> 'meetingId' = $1
         AND metadata ->> 'agentId' = $2`,
      [fixtureData.meeting.id, pausedParticipant.agentId],
    );
    expect(participantAudit.rows[0]?.count).toBe("1");

    const first = await request<MeetingMessage>(
      "POST",
      `/api/v1/meetings/${fixtureData.meeting.id}/messages`,
      { content: "Only one active AI should queue." },
    );
    expect(first.statusCode).toBe(201);
    const queued = await database.query<{
      agent_id: string;
      run_id: string;
    }>(
      `SELECT agent_id, run_id
       FROM meeting_ai_turns
       WHERE meeting_id = $1
         AND source_message_id = $2`,
      [fixtureData.meeting.id, first.body.id],
    );
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]?.agent_id).not.toBe(pausedParticipant.agentId);
    await database.query(
      `UPDATE meeting_ai_turns
       SET status = 'running', started_at = NOW(), updated_at = NOW()
       WHERE id = (
         SELECT id FROM meeting_ai_turns
         WHERE meeting_id = $1
           AND source_message_id = $2
         LIMIT 1
       )`,
      [fixtureData.meeting.id, first.body.id],
    );
    await database.query(
      `UPDATE runs
       SET status = 'running', started_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [queued.rows[0]!.run_id],
    );
    const blockedByConcurrency = await request<TriggerMeetingAiResult>(
      "POST",
      `/api/v1/meetings/${fixtureData.meeting.id}/ai-triggers`,
      {
        kind: "round",
        roundNumber: 2,
        agentIds: [],
      },
    );
    expect(blockedByConcurrency.statusCode).toBe(202);
    expect(blockedByConcurrency.body.outcome).toBe("skipped");
    expect(blockedByConcurrency.body.skipped[0]?.reason).toBe(
      "max_concurrent_agents",
    );
    const resumedParticipant = await request<MeetingAiParticipant>(
      "PUT",
      `/api/v1/meetings/${fixtureData.meeting.id}/ai-participants/${pausedParticipant.agentId}`,
      {
        expectedRevision: paused.body.revision,
        status: "active",
        reason: "Resume one AI",
      },
    );
    expect(resumedParticipant.statusCode).toBe(200);
    expect(resumedParticipant.body.status).toBe("active");

    await database.query(
      `INSERT INTO meeting_messages (
         id, meeting_id, author_type, author_id, author_name, content,
         trigger_depth, created_at
       ) VALUES ($1, $2, 'human', 'local-admin', 'Local Admin', $3, 2, NOW())`,
      [
        randomUUID(),
        fixtureData.meeting.id,
        "A source at the trigger depth boundary",
      ],
    );
    const source = await database.query<{ id: string }>(
      `SELECT id FROM meeting_messages
       WHERE meeting_id = $1
         AND content = 'A source at the trigger depth boundary'`,
      [fixtureData.meeting.id],
    );
    const depthLimited = await request(
      "POST",
      `/api/v1/meetings/${fixtureData.meeting.id}/ai-triggers`,
      {
        kind: "mention",
        sourceMessageId: source.rows[0]!.id,
        agentIds: [queued.rows[0]!.agent_id],
      },
    );
    expect(depthLimited.statusCode).toBe(409);
    expect(depthLimited.body).toMatchObject({
      code: "meeting_ai_trigger_depth_exceeded",
    });
  });
});
