import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunExecutor } from "@pluginmax/application";
import type {
  Meeting,
  MeetingAiPolicy,
  MeetingMessage,
} from "@pluginmax/contracts";
import {
  Database,
  migrate,
  PlatformRepositories,
  type ClaimedJob,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("meeting AI participation", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let executor: RunExecutor;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-meeting-ai-test-"),
    );
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-meeting-ai-workspace-"),
    );
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot,
      logger: false,
      localActorId: "local-admin",
      expectedMigrationVersion: 29,
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
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    actorId = "local-admin",
    idempotencyKey?: string,
  ): Promise<{ statusCode: number; body: T }> {
    const headers: Record<string, string> = {
      "x-pluginmax-actor": actorId,
    };
    if (idempotencyKey !== undefined) {
      headers["idempotency-key"] = idempotencyKey;
    }
    const options: InjectOptions = { method, url, headers };
    if (payload !== undefined) {
      options.payload = payload as Record<string, unknown>;
    }
    const response = await app.inject(options);
    return {
      statusCode: response.statusCode,
      body: response.json() as T,
    };
  }

  async function createProject(): Promise<{ id: string; name: string }> {
    const result = await request<{ id: string; name: string }>(
      "POST",
      "/api/v1/projects",
      {
        name: `Meeting AI ${randomUUID().slice(0, 8)}`,
        description: "Batch 12A integration fixture",
      },
    );
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function createAgent(): Promise<{ id: string; name: string }> {
    const result = await request<{ id: string; name: string }>(
      "POST",
      "/api/v1/agents",
      {
        name: `Meeting AI agent ${randomUUID().slice(0, 8)}`,
        runtimeKind: "fake",
      },
    );
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function addMember(projectId: string, agentId: string): Promise<void> {
    const result = await request(
      "POST",
      `/api/v1/projects/${projectId}/members`,
      {
        kind: "agent",
        agentId,
        responsibility: "Meeting AI participation",
        roleIds: [],
      },
    );
    expect(result.statusCode).toBe(201);
  }

  async function createMeeting(
    projectId: string,
    agentId: string,
  ): Promise<Meeting> {
    const result = await request<Meeting>("POST", "/api/v1/meetings", {
      projectId,
      title: `Meeting AI ${randomUUID().slice(0, 8)}`,
      agenda: "Review deterministic participation",
      agentIds: [agentId],
    });
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function meetingFixture(): Promise<{
    project: { id: string; name: string };
    agent: { id: string; name: string };
    meeting: Meeting;
  }> {
    const project = await createProject();
    const agent = await createAgent();
    await addMember(project.id, agent.id);
    const meeting = await createMeeting(project.id, agent.id);
    return { project, agent, meeting };
  }

  async function getPolicy(meetingId: string): Promise<MeetingAiPolicy> {
    const result = await request<MeetingAiPolicy>(
      "GET",
      `/api/v1/meetings/${meetingId}/ai-policy`,
    );
    expect(result.statusCode).toBe(200);
    return result.body;
  }

  async function enablePolicy(
    meetingId: string,
    patch: {
      readonly cooldownSeconds?: number;
      readonly maxRounds?: number;
      readonly maxMessages?: number;
      readonly runBudgetMs?: number;
    } = {},
  ): Promise<MeetingAiPolicy> {
    const policy = await getPolicy(meetingId);
    const result = await request<MeetingAiPolicy>(
      "PUT",
      `/api/v1/meetings/${meetingId}/ai-policy`,
      {
        expectedRevision: policy.revision,
        status: "active",
        triggerKinds: ["mention", "round", "agenda", "summary"],
        cooldownSeconds: patch.cooldownSeconds ?? 0,
        maxRounds: patch.maxRounds ?? 10,
        maxMessages: patch.maxMessages ?? 20,
        runBudgetMs: patch.runBudgetMs ?? 5_000,
      },
    );
    expect(result.statusCode).toBe(200);
    return result.body;
  }

  async function trigger(
    meetingId: string,
    payload: Record<string, unknown>,
    idempotencyKey?: string,
  ) {
    return request<{
      outcome: "queued" | "reused" | "skipped";
      roundNumber: number | null;
      policy: MeetingAiPolicy;
      turns: Array<{
        id: string;
        runId: string | null;
        status: string;
      }>;
      skipped: Array<{ agentId: string; reason: string }>;
    }>(
      "POST",
      `/api/v1/meetings/${meetingId}/ai-triggers`,
      payload,
      "local-admin",
      idempotencyKey,
    );
  }

  async function processJob(
    job: ClaimedJob,
    workerId = "meeting-ai-worker",
  ): Promise<void> {
    await executor.execute(job.runId, {
      jobId: job.id,
      owner: workerId,
      leaseSeconds: 60,
      traceId: job.traceId,
      jobSpanId: job.spanId,
      assertLease: async () => undefined,
    });
    await repositories.jobs.complete(job.id, workerId, job.leaseToken);
  }

  it("enforces project control, project membership and meeting isolation", async () => {
    const fixture = await meetingFixture();
    const policy = await getPolicy(fixture.meeting.id);
    const forbidden = await request(
      "PUT",
      `/api/v1/meetings/${fixture.meeting.id}/ai-policy`,
      {
        expectedRevision: policy.revision,
        status: "active",
      },
      "project-outsider",
    );
    expect(forbidden.statusCode).toBe(403);

    const outsiderAgent = await createAgent();
    const nonMemberMeeting = await request("POST", "/api/v1/meetings", {
      projectId: fixture.project.id,
      title: "Non-member Agent meeting",
      agentIds: [outsiderAgent.id],
    });
    expect(nonMemberMeeting.statusCode).toBe(409);
    expect(nonMemberMeeting.body).toMatchObject({
      code: "meeting_ai_agent_not_member",
    });

    await enablePolicy(fixture.meeting.id);
    const other = await meetingFixture();
    const crossMeetingMention = await request(
      "POST",
      `/api/v1/meetings/${fixture.meeting.id}/messages`,
      {
        content: "Please inspect the other meeting",
        mentions: [other.agent.id],
      },
    );
    expect(crossMeetingMention.statusCode).toBe(409);
    expect(crossMeetingMention.body).toMatchObject({
      code: "meeting_mention_not_participant",
    });

    const otherMessageResult = await request<MeetingMessage>(
      "POST",
      `/api/v1/meetings/${other.meeting.id}/messages`,
      { content: "Other meeting context only" },
    );
    const crossMeetingSource = await trigger(fixture.meeting.id, {
      kind: "mention",
      agentIds: [fixture.agent.id],
      sourceMessageId: otherMessageResult.body.id,
    });
    expect(crossMeetingSource.statusCode).toBe(409);
    expect(crossMeetingSource.body).toMatchObject({
      code: "meeting_ai_source_not_found",
    });
  });

  it("queues mention, round, agenda and summary triggers deterministically", async () => {
    const fixture = await meetingFixture();
    await enablePolicy(fixture.meeting.id);
    expect(
      (
        await database.query<{ status: string }>(
          "SELECT status FROM meetings WHERE id = $1",
          [fixture.meeting.id],
        )
      ).rows[0]?.status,
    ).toBe("open");
    const posted = await request<MeetingMessage>(
      "POST",
      `/api/v1/meetings/${fixture.meeting.id}/messages`,
      {
        content: `@${fixture.agent.name} please respond`,
        mentions: [fixture.agent.id],
      },
    );
    expect(posted.statusCode).toBe(201);
    const duplicateMention = await trigger(fixture.meeting.id, {
      kind: "mention",
      agentIds: [fixture.agent.id],
      sourceMessageId: posted.body.id,
    });
    expect(duplicateMention.statusCode).toBe(202);
    expect(duplicateMention.body.outcome).toBe("reused");
    const mentionTurn = duplicateMention.body.turns[0];
    expect(mentionTurn?.runId).toBeTruthy();
    const runProjection = await database.query<{
      task_id: string | null;
      meeting_turn_id: string | null;
    }>("SELECT task_id, meeting_turn_id FROM runs WHERE id = $1", [
      mentionTurn?.runId,
    ]);
    expect(runProjection.rows[0]).toEqual({
      task_id: null,
      meeting_turn_id: mentionTurn?.id,
    });
    const outbox = await database.query<{ topic: string }>(
      `SELECT topic
       FROM domain_outbox
       WHERE payload ->> 'meetingId' = $1
         AND payload ->> 'turnId' = $2`,
      [fixture.meeting.id, mentionTurn?.id],
    );
    expect(outbox.rows).toEqual([{ topic: "meeting.ai.speak" }]);

    const round = await trigger(fixture.meeting.id, {
      kind: "round",
      roundNumber: 2,
      agentIds: [fixture.agent.id],
    });
    expect(round.statusCode).toBe(202);
    expect(round.body.outcome).toBe("queued");
    const concurrent = await Promise.all([
      trigger(
        fixture.meeting.id,
        { kind: "agenda", agendaItem: "Decision review", agentIds: [] },
        `agenda-a-${fixture.meeting.id}`,
      ),
      trigger(
        fixture.meeting.id,
        { kind: "agenda", agendaItem: "Decision review", agentIds: [] },
        `agenda-b-${fixture.meeting.id}`,
      ),
    ]);
    expect(
      concurrent
        .map((result) => result.body.outcome)
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(["queued", "reused"]);

    const summary = await trigger(fixture.meeting.id, {
      kind: "summary",
      sourceMessageId: posted.body.id,
      agentIds: [],
    });
    expect(summary.statusCode).toBe(202);
    expect(summary.body.outcome).toBe("queued");

    const rounds = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM meeting_ai_rounds
       WHERE meeting_id = $1`,
      [fixture.meeting.id],
    );
    const turns = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM meeting_ai_turns
       WHERE meeting_id = $1`,
      [fixture.meeting.id],
    );
    expect(rounds.rows[0]?.count).toBe("4");
    expect(turns.rows[0]?.count).toBe("4");
    const published = await request<MeetingMessage>(
      "POST",
      `/api/v1/meetings/${fixture.meeting.id}/messages`,
      { content: "   " },
    );
    expect(published.statusCode).toBe(400);
  });

  it("enforces cooldown and configured round/message budgets", async () => {
    const cooldown = await meetingFixture();
    await enablePolicy(cooldown.meeting.id, { cooldownSeconds: 3_600 });
    const first = await trigger(cooldown.meeting.id, {
      kind: "round",
      roundNumber: 1,
      agentIds: [],
    });
    expect(first.body.outcome).toBe("queued");
    const cooling = await trigger(cooldown.meeting.id, {
      kind: "round",
      roundNumber: 2,
      agentIds: [],
    });
    expect(cooling.body.outcome).toBe("skipped");
    expect(cooling.body.skipped[0]?.reason).toBe("cooldown_active");

    const maxMessages = await meetingFixture();
    await enablePolicy(maxMessages.meeting.id, { maxMessages: 1 });
    expect(
      (
        await trigger(maxMessages.meeting.id, {
          kind: "round",
          roundNumber: 1,
          agentIds: [],
        })
      ).statusCode,
    ).toBe(202);
    const messageCap = await trigger(maxMessages.meeting.id, {
      kind: "round",
      roundNumber: 2,
      agentIds: [],
    });
    expect(messageCap.statusCode).toBe(409);
    expect(messageCap.body).toMatchObject({ code: "meeting_ai_max_messages" });

    const maxRounds = await meetingFixture();
    await enablePolicy(maxRounds.meeting.id, { maxRounds: 1 });
    expect(
      (
        await trigger(maxRounds.meeting.id, {
          kind: "round",
          roundNumber: 1,
          agentIds: [],
        })
      ).statusCode,
    ).toBe(202);
    const roundCap = await trigger(maxRounds.meeting.id, {
      kind: "round",
      roundNumber: 2,
      agentIds: [],
    });
    expect(roundCap.statusCode).toBe(409);
    expect(roundCap.body).toMatchObject({ code: "meeting_ai_max_rounds" });
  });

  it("stops on pause, close, archive and disabled Agent boundaries", async () => {
    const pausedFixture = await meetingFixture();
    const active = await enablePolicy(pausedFixture.meeting.id);
    const queued = await trigger(pausedFixture.meeting.id, {
      kind: "round",
      roundNumber: 1,
      agentIds: [],
    });
    const runId = queued.body.turns[0]?.runId;
    expect(runId).toBeTruthy();
    const paused = await request<MeetingAiPolicy>(
      "POST",
      `/api/v1/meetings/${pausedFixture.meeting.id}/ai-policy/pause`,
      { expectedRevision: active.revision, reason: "test pause" },
    );
    expect(paused.statusCode).toBe(200);
    const cancelledRun = await repositories.runs.get(runId!);
    expect(cancelledRun?.status).toBe("cancelled");
    const pausedTrigger = await trigger(pausedFixture.meeting.id, {
      kind: "round",
      roundNumber: 2,
      agentIds: [],
    });
    expect(pausedTrigger.statusCode).toBe(409);
    expect(pausedTrigger.body).toMatchObject({ code: "meeting_ai_paused" });
    const resumed = await request<MeetingAiPolicy>(
      "POST",
      `/api/v1/meetings/${pausedFixture.meeting.id}/ai-policy/resume`,
      { expectedRevision: paused.body.revision, reason: "test resume" },
    );
    expect(resumed.statusCode).toBe(200);
    expect(
      (
        await trigger(pausedFixture.meeting.id, {
          kind: "round",
          roundNumber: 2,
          agentIds: [],
        })
      ).statusCode,
    ).toBe(202);
    const terminated = await request<MeetingAiPolicy>(
      "POST",
      `/api/v1/meetings/${pausedFixture.meeting.id}/ai-policy/terminate`,
      { expectedRevision: resumed.body.revision, reason: "test terminate" },
    );
    expect(terminated.statusCode).toBe(200);
    const terminatedTrigger = await trigger(pausedFixture.meeting.id, {
      kind: "round",
      roundNumber: 3,
      agentIds: [],
    });
    expect(terminatedTrigger.statusCode).toBe(409);
    expect(terminatedTrigger.body).toMatchObject({
      code: "meeting_ai_terminated",
    });

    const closedFixture = await meetingFixture();
    await enablePolicy(closedFixture.meeting.id);
    const closed = await request(
      "POST",
      `/api/v1/meetings/${closedFixture.meeting.id}/close`,
      { summary: "" },
    );
    expect(closed.statusCode).toBe(200);
    const closedTrigger = await trigger(closedFixture.meeting.id, {
      kind: "summary",
      agentIds: [],
    });
    expect(closedTrigger.statusCode).toBe(409);
    expect(closedTrigger.body).toMatchObject({ code: "meeting_closed" });

    const archivedFixture = await meetingFixture();
    await enablePolicy(archivedFixture.meeting.id);
    const archivedTriggerQueued = await trigger(archivedFixture.meeting.id, {
      kind: "round",
      roundNumber: 1,
      agentIds: [],
    });
    const archivedRunId = archivedTriggerQueued.body.turns[0]?.runId;
    const archived = await request(
      "PATCH",
      `/api/v1/projects/${archivedFixture.project.id}`,
      { status: "archived" },
    );
    expect(archived.statusCode).toBe(200);
    expect((await repositories.runs.get(archivedRunId!))?.status).toBe(
      "cancelled",
    );
    const projectArchived = await trigger(archivedFixture.meeting.id, {
      kind: "round",
      roundNumber: 2,
      agentIds: [],
    });
    expect(projectArchived.statusCode).toBe(409);
    expect(projectArchived.body).toMatchObject({ code: "project_archived" });

    const disabledFixture = await meetingFixture();
    await enablePolicy(disabledFixture.meeting.id);
    await request("POST", `/api/v1/agents/${disabledFixture.agent.id}/status`, {
      status: "disabled",
    });
    const disabled = await trigger(disabledFixture.meeting.id, {
      kind: "round",
      roundNumber: 1,
      agentIds: [],
    });
    expect(disabled.statusCode).toBe(202);
    expect(disabled.body.skipped).toEqual([
      {
        agentId: disabledFixture.agent.id,
        agentName: disabledFixture.agent.name,
        reason: "agent_disabled",
      },
    ]);

    const project = await createProject();
    const legacyMeetingId = randomUUID();
    await database.query(
      `INSERT INTO meetings (
         id, project_id, title, agenda, status, participants, summary,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'Legacy meeting without AI policy', '', 'open',
         '[{"id":"local-admin","name":"Local Admin","kind":"human"}]'::jsonb,
         '', NOW(), NOW()
       )`,
      [legacyMeetingId, project.id],
    );
    const legacyPolicy = await request(
      "GET",
      `/api/v1/meetings/${legacyMeetingId}/ai-policy`,
    );
    expect(legacyPolicy.statusCode).toBe(404);
    const legacyMessage = await request(
      "POST",
      `/api/v1/meetings/${legacyMeetingId}/messages`,
      { content: "Legacy meeting remains usable" },
    );
    expect(legacyMessage.statusCode).toBe(201);
  });

  it("executes through the Runtime Adapter and remains idempotent across retries and leases", async () => {
    const fixture = await meetingFixture();
    await enablePolicy(fixture.meeting.id);
    const firstTrigger = await trigger(fixture.meeting.id, {
      kind: "round",
      roundNumber: 1,
      agentIds: [],
    });
    const firstRunId = firstTrigger.body.turns[0]?.runId;
    const firstTurnId = firstTrigger.body.turns[0]?.id;
    expect(firstRunId).toBeTruthy();
    const firstJob = await repositories.jobs.claimNext(
      "meeting-ai-worker",
      60,
      firstRunId!,
    );
    expect(firstJob).toBeDefined();
    await processJob(firstJob!);
    let messages = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM meeting_messages
       WHERE turn_id = $1`,
      [firstTurnId],
    );
    expect(messages.rows[0]?.count).toBe("1");
    const provenance = await database.query<{
      author_type: string;
      author_id: string;
      policy_id: string | null;
      trigger_kind: string | null;
      trigger_reason: string | null;
      run_id: string | null;
      trace_id: string | null;
      status: string;
    }>(
      `SELECT author_type, author_id, policy_id, trigger_kind,
              trigger_reason, run_id, trace_id, status
       FROM meeting_messages
       WHERE turn_id = $1`,
      [firstTurnId],
    );
    expect(provenance.rows[0]).toMatchObject({
      author_type: "agent",
      author_id: fixture.agent.id,
      trigger_kind: "round",
      run_id: firstRunId,
      status: "sent",
    });
    expect(provenance.rows[0]?.policy_id).toBeTruthy();
    expect(provenance.rows[0]?.trigger_reason).toBeTruthy();
    expect(provenance.rows[0]?.trace_id).toBeTruthy();

    await database.query(
      `UPDATE jobs
       SET status = 'queued', available_at = NOW(), lease_owner = NULL,
           lease_token = NULL, lease_expires_at = NULL,
           max_attempts = GREATEST(max_attempts, attempts + 1), updated_at = NOW()
       WHERE run_id = $1`,
      [firstRunId],
    );
    const replayJob = await repositories.jobs.claimNext(
      "meeting-ai-worker-replay",
      60,
      firstRunId!,
    );
    await processJob(replayJob!, "meeting-ai-worker-replay");
    messages = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM meeting_messages
       WHERE turn_id = $1`,
      [firstTurnId],
    );
    expect(messages.rows[0]?.count).toBe("1");

    const retryTrigger = await trigger(fixture.meeting.id, {
      kind: "round",
      roundNumber: 2,
      agentIds: [],
    });
    const retryRunId = retryTrigger.body.turns[0]?.runId;
    const retryTurnId = retryTrigger.body.turns[0]?.id;
    await database.query(
      `UPDATE runs
       SET input_snapshot = jsonb_set(
         input_snapshot,
         '{runtimeOptions}',
         '{"fault":"fail"}'::jsonb,
         true
       )
       WHERE id = $1`,
      [retryRunId],
    );
    const failedJob = await repositories.jobs.claimNext(
      "meeting-ai-worker-fail",
      60,
      retryRunId!,
    );
    expect(
      (await repositories.runs.get(retryRunId!))?.inputSnapshot.runtimeOptions,
    ).toEqual({ fault: "fail" });
    expect(
      (
        await database.query<{ status: string }>(
          "SELECT status FROM meeting_ai_turns WHERE id = $1",
          [retryTurnId],
        )
      ).rows[0]?.status,
    ).toBe("queued");
    const executionError = await processJob(
      failedJob!,
      "meeting-ai-worker-fail",
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(executionError).toBeInstanceOf(Error);
    expect(String(executionError)).toMatch(/Fake Runtime injected failure/);
    const retry = await repositories.jobs.fail(
      failedJob!.id,
      "meeting-ai-worker-fail",
      failedJob!.leaseToken,
      "Fake Runtime injected failure",
      { baseBackoffMs: 0, maxBackoffMs: 0 },
    );
    expect(retry.outcome).toBe("retry_scheduled");
    await database.query(
      "UPDATE runs SET input_snapshot = input_snapshot - 'runtimeOptions' WHERE id = $1",
      [retryRunId],
    );
    await database.query(
      "UPDATE jobs SET available_at = NOW() WHERE run_id = $1",
      [retryRunId],
    );
    const recoveredJob = await repositories.jobs.claimNext(
      "meeting-ai-worker-recovered",
      60,
      retryRunId!,
    );
    await expect(
      processJob(recoveredJob!, "meeting-ai-worker-recovered"),
    ).rejects.toThrow(/Action Ticket action is already in progress/);
    await repositories.jobs.fail(
      recoveredJob!.id,
      "meeting-ai-worker-recovered",
      recoveredJob!.leaseToken,
      "Action Ticket execution boundary is already in progress",
      { retryable: false },
    );
    messages = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM meeting_messages
       WHERE turn_id = $1 AND status = 'sent'`,
      [retryTurnId],
    );
    expect(messages.rows[0]?.count).toBe("0");

    const leaseTrigger = await trigger(fixture.meeting.id, {
      kind: "round",
      roundNumber: 3,
      agentIds: [],
    });
    const leaseRunId = leaseTrigger.body.turns[0]?.runId;
    const leaseTurnId = leaseTrigger.body.turns[0]?.id;
    const leaseJob = await repositories.jobs.claimNext(
      "meeting-ai-worker-lease",
      60,
      leaseRunId!,
    );
    await database.query(
      "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [leaseJob!.id],
    );
    const recovered = await repositories.jobs.recoverExpiredLeases(10, {
      baseBackoffMs: 0,
      maxBackoffMs: 0,
    });
    expect(recovered.some((job) => job.runId === leaseRunId)).toBe(true);
    const finalReplay = await repositories.jobs.claimNext(
      "meeting-ai-worker-final",
      60,
      leaseRunId!,
    );
    await processJob(finalReplay!, "meeting-ai-worker-final");
    messages = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM meeting_messages
       WHERE turn_id = $1`,
      [leaseTurnId],
    );
    expect(messages.rows[0]?.count).toBe("1");

    const failureTrigger = await trigger(fixture.meeting.id, {
      kind: "summary",
      agentIds: [],
    });
    const failureRunId = failureTrigger.body.turns[0]?.runId;
    const failureTurnId = failureTrigger.body.turns[0]?.id;
    await database.query(
      `UPDATE runs
       SET input_snapshot = jsonb_set(
         input_snapshot,
         '{runtimeOptions}',
         '{"fault":"fail"}'::jsonb,
         true
       )
       WHERE id = $1`,
      [failureRunId],
    );
    const failureJob = await repositories.jobs.claimNext(
      "meeting-ai-failure-1",
      60,
      failureRunId!,
    );
    await expect(
      processJob(failureJob!, "meeting-ai-failure-1"),
    ).rejects.toThrow(/Fake Runtime injected failure/);
    await repositories.jobs.fail(
      failureJob!.id,
      "meeting-ai-failure-1",
      failureJob!.leaseToken,
      "Fake Runtime injected failure",
      { baseBackoffMs: 0, maxBackoffMs: 0 },
    );
    const failureReplay = await repositories.jobs.claimNext(
      "meeting-ai-failure-2",
      60,
      failureRunId!,
    );
    await expect(
      processJob(failureReplay!, "meeting-ai-failure-2"),
    ).rejects.toThrow(/Action Ticket action is already in progress/);
    await repositories.jobs.fail(
      failureReplay!.id,
      "meeting-ai-failure-2",
      failureReplay!.leaseToken,
      "Action Ticket execution boundary is already in progress",
      { retryable: false },
    );
    const failedMessages = await database.query<{
      status: string;
      error_code: string;
    }>(
      `SELECT status, error_code
       FROM meeting_messages
       WHERE turn_id = $1`,
      [failureTurnId],
    );
    expect(failedMessages.rows).toEqual([
      {
        status: "failed",
        error_code: "meeting_ai_runtime_failed",
      },
    ]);
    const finalPolicy = await getPolicy(fixture.meeting.id);
    expect(finalPolicy.stats.messagesSent).toBe(2);
    expect(finalPolicy.stats.messagesFailed).toBe(2);
  });
});
