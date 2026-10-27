import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunCancelledError, RunExecutor } from "@pluginmax/application";
import type {
  Agent,
  DirectChatDetail,
  DirectChatSendResult,
  DirectChatThread,
  Meeting,
  Project,
  Task,
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

integration("AI direct chat", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let app: ReturnType<typeof buildApi>["app"];
  let executor: RunExecutor;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    const fileStoreRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-direct-chat-files-"),
    );
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "pluginmax-direct-chat-workspace-"),
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
      runtimeEffectPollIntervalMs: 50,
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

  async function createAgent(
    runtimeKind: Agent["runtimeKind"] = "fake",
    actorId = "local-admin",
  ): Promise<Agent> {
    const result = await request<Agent>(
      "POST",
      "/api/v1/agents",
      {
        name: `Direct chat agent ${randomUUID().slice(0, 8)}`,
        description: "Private direct chat integration agent",
        runtimeKind,
        soul: "Reply only from the private conversation context.",
      },
      actorId,
    );
    expect(result.statusCode).toBe(201);
    return result.body;
  }

  async function ensureChat(
    agentId: string,
    actorId = "local-admin",
  ): Promise<DirectChatThread> {
    const result = await request<DirectChatThread>(
      "POST",
      "/api/v1/direct-chats",
      { agentId },
      actorId,
    );
    expect(result.statusCode).toBe(200);
    return result.body;
  }

  async function send(
    threadId: string,
    content: string,
    clientMessageId = randomUUID(),
    actorId = "local-admin",
    idempotencyKey?: string,
  ): Promise<{ statusCode: number; body: DirectChatSendResult }> {
    return request<DirectChatSendResult>(
      "POST",
      `/api/v1/direct-chats/${threadId}/messages`,
      { content, clientMessageId },
      actorId,
      idempotencyKey,
    );
  }

  async function detail(
    threadId: string,
    actorId = "local-admin",
  ): Promise<DirectChatDetail> {
    const result = await request<DirectChatDetail>(
      "GET",
      `/api/v1/direct-chats/${threadId}`,
      undefined,
      actorId,
    );
    expect(result.statusCode).toBe(200);
    return result.body;
  }

  async function processJob(job: ClaimedJob, workerId: string): Promise<void> {
    await executor.execute(job.runId, {
      jobId: job.id,
      owner: workerId,
      leaseSeconds: 60,
      traceId: job.traceId,
      jobSpanId: job.spanId,
      assertLease: async () => undefined,
    });
    expect(
      await repositories.jobs.complete(job.id, workerId, job.leaseToken),
    ).toBe(true);
  }

  it("keeps one stable thread per owner-agent and isolates accounts, agents and meetings", async () => {
    const firstAgent = await createAgent();
    const secondAgent = await createAgent();
    const first = await ensureChat(firstAgent.id);
    const repeated = await ensureChat(firstAgent.id);
    const second = await ensureChat(secondAgent.id);
    expect(repeated.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);

    const firstThreads = await request<{
      items: Array<{ threadId: string | null; agent: Agent }>;
    }>("GET", "/api/v1/direct-chats");
    expect(firstThreads.statusCode).toBe(200);
    expect(
      firstThreads.body.items.filter((item) => item.threadId !== null),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: first.id }),
        expect.objectContaining({ threadId: second.id }),
      ]),
    );

    const sent = await send(first.id, "Only first agent may see this");
    expect(sent.statusCode).toBe(202);
    const firstDetail = await detail(first.id);
    const secondDetail = await detail(second.id);
    expect(firstDetail.messages.map((message) => message.content)).toContain(
      "Only first agent may see this",
    );
    expect(secondDetail.messages).toEqual([]);

    const outsiderRead = await request(
      "GET",
      `/api/v1/direct-chats/${first.id}`,
      undefined,
      "another-account",
    );
    expect(outsiderRead.statusCode).toBe(404);
    const outsiderSend = await send(
      first.id,
      "cross account send",
      randomUUID(),
      "another-account",
    );
    expect(outsiderSend.statusCode).toBe(404);
    const outsiderRun = await request(
      "GET",
      `/api/v1/runs/${sent.body.run.id}`,
      undefined,
      "another-account",
    );
    expect(outsiderRun.statusCode).toBe(403);
    expect(sent.body.run.traceId).not.toBeNull();
    const outsiderTrace = await request(
      "GET",
      `/api/v1/traces/${sent.body.run.traceId}`,
      undefined,
      "another-account",
    );
    expect(outsiderTrace.statusCode).toBe(403);

    const project = await request<Project>("POST", "/api/v1/projects", {
      name: `Direct chat meeting isolation ${randomUUID().slice(0, 8)}`,
      description: "Cross-domain isolation",
    });
    expect(project.statusCode).toBe(201);
    const member = await request(
      "POST",
      `/api/v1/projects/${project.body.id}/members`,
      {
        kind: "agent",
        agentId: firstAgent.id,
        responsibility: "Meeting isolation",
        roleIds: [],
      },
    );
    expect(member.statusCode).toBe(201);
    const meeting = await request<Meeting>("POST", "/api/v1/meetings", {
      projectId: project.body.id,
      title: "Private meeting must stay separate",
      agenda: "Meeting-only context",
      agentIds: [firstAgent.id],
    });
    expect(meeting.statusCode).toBe(201);
    await request("POST", `/api/v1/meetings/${meeting.body.id}/messages`, {
      content: "meeting-only message",
    });
    const afterMeeting = await detail(first.id);
    expect(
      afterMeeting.messages.some(
        (message) => message.content === "meeting-only message",
      ),
    ).toBe(false);
    const meetingDetail = await request<{
      messages: Array<{ content: string }>;
    }>("GET", `/api/v1/meetings/${meeting.body.id}`);
    expect(
      meetingDetail.body.messages.some(
        (message) => message.content === "Only first agent may see this",
      ),
    ).toBe(false);

    const empty = await send(first.id, "   ");
    expect(empty.statusCode).toBe(400);
  });

  it("deduplicates repeated and concurrent submissions in the database", async () => {
    const agent = await createAgent();
    const thread = await ensureChat(agent.id);
    const clientMessageId = randomUUID();
    const concurrent = await Promise.all([
      send(thread.id, "Concurrent idempotent message", clientMessageId),
      send(thread.id, "Concurrent idempotent message", clientMessageId),
    ]);
    expect(concurrent.map((result) => result.statusCode)).toEqual([202, 202]);
    expect(
      new Set(concurrent.map((result) => result.body.message.id)).size,
    ).toBe(1);
    expect(new Set(concurrent.map((result) => result.body.run.id)).size).toBe(
      1,
    );

    const replay = await send(
      thread.id,
      "Idempotency header message",
      clientMessageId,
      "local-admin",
      "direct-chat-http-replay",
    );
    expect(replay.statusCode).toBe(202);
    const replayAgain = await send(
      thread.id,
      "Idempotency header message",
      clientMessageId,
      "local-admin",
      "direct-chat-http-replay",
    );
    expect(replayAgain.statusCode).toBe(202);
    expect(replayAgain.body.message.id).toBe(replay.body.message.id);

    const counts = await database.query<{
      messages: string;
      turns: string;
      runs: string;
      jobs: string;
      outbox: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM direct_chat_messages
          WHERE thread_id = $1 AND sender_type = 'owner') AS messages,
         (SELECT COUNT(*)::text FROM direct_chat_turns
          WHERE thread_id = $1) AS turns,
         (SELECT COUNT(*)::text FROM runs
          WHERE direct_chat_turn_id IN (
            SELECT id FROM direct_chat_turns WHERE thread_id = $1
          )) AS runs,
         (SELECT COUNT(*)::text FROM jobs
          WHERE run_id IN (
            SELECT run_id FROM direct_chat_turns WHERE thread_id = $1
          )) AS jobs,
         (SELECT COUNT(*)::text FROM domain_outbox
          WHERE topic = 'direct.chat.reply'
            AND payload ->> 'threadId' = $1::text) AS outbox`,
      [thread.id],
    );
    expect(counts.rows[0]).toEqual({
      messages: "1",
      turns: "1",
      runs: "1",
      jobs: "1",
      outbox: "1",
    });
  });

  it("executes only in the worker with scoped context and idempotent writeback", async () => {
    const agent = await createAgent();
    const thread = await ensureChat(agent.id);
    const sent = await send(thread.id, "Explain the private scope");
    expect(sent.statusCode).toBe(202);
    const run = await repositories.runs.get(sent.body.run.id);
    expect(run).toMatchObject({
      projectId: null,
      taskId: null,
      meetingTurnId: null,
      directChatTurnId: sent.body.turn.id,
    });
    const contextBeforeWorker = await repositories.contexts.getByRun(
      sent.body.run.id,
    );
    expect(contextBeforeWorker).toBeUndefined();

    const job = await repositories.jobs.claimNext(
      "direct-chat-worker",
      60,
      sent.body.run.id,
    );
    await processJob(job!, "direct-chat-worker");
    let result = await detail(thread.id);
    expect(
      result.messages.filter((message) => message.senderType === "agent"),
    ).toHaveLength(1);
    const completed = result.messages.find(
      (message) => message.senderType === "agent",
    );
    expect(completed).toMatchObject({
      status: "sent",
      runId: sent.body.run.id,
      turnId: sent.body.turn.id,
    });
    expect(completed?.traceId).toBeTruthy();
    const context = await repositories.contexts.getByRun(sent.body.run.id);
    expect(context?.pack).toMatchObject({
      projectId: null,
      taskId: null,
      meetingTurnId: null,
      directChatTurnId: sent.body.turn.id,
    });
    expect(context?.pack.renderedPrompt).toContain(
      "This is a private one-to-one chat",
    );
    expect(context?.pack.renderedPrompt).not.toContain("meeting-only message");

    await database.query(
      `UPDATE jobs
       SET status = 'queued', available_at = NOW(), lease_owner = NULL,
           lease_token = NULL, lease_expires_at = NULL,
           max_attempts = GREATEST(max_attempts, attempts + 1), updated_at = NOW()
       WHERE run_id = $1`,
      [sent.body.run.id],
    );
    const replayJob = await repositories.jobs.claimNext(
      "direct-chat-replay",
      60,
      sent.body.run.id,
    );
    await processJob(replayJob!, "direct-chat-replay");
    result = await detail(thread.id);
    expect(
      result.messages.filter(
        (message) =>
          message.senderType === "agent" && message.status === "sent",
      ),
    ).toHaveLength(1);

    const leaseRecovery = await send(thread.id, "Recover after worker lease");
    const leaseJob = await repositories.jobs.claimNext(
      "direct-chat-lease-lost",
      60,
      leaseRecovery.body.run.id,
    );
    await database.query(
      "UPDATE jobs SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [leaseJob!.id],
    );
    const recovered = await repositories.jobs.recoverExpiredLeases(10, {
      baseBackoffMs: 0,
      maxBackoffMs: 0,
    });
    expect(
      recovered.some(
        (item) =>
          item.runId === leaseRecovery.body.run.id &&
          item.outcome === "retry_scheduled",
      ),
    ).toBe(true);
    const recoveredJob = await repositories.jobs.claimNext(
      "direct-chat-lease-recovered",
      60,
      leaseRecovery.body.run.id,
    );
    await processJob(recoveredJob!, "direct-chat-lease-recovered");
    const leaseMessages = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM direct_chat_messages
       WHERE turn_id = $1`,
      [leaseRecovery.body.turn.id],
    );
    expect(leaseMessages.rows[0]?.count).toBe("1");
  });

  it("cancels queued and running direct chat runs", async () => {
    const agent = await createAgent();
    const thread = await ensureChat(agent.id);
    const queued = await send(thread.id, "Cancel before worker claims");
    const queuedCancel = await request(
      "POST",
      `/api/v1/direct-chats/${thread.id}/turns/${queued.body.turn.id}/cancel`,
    );
    expect(queuedCancel.statusCode).toBe(202);
    expect(
      await repositories.jobs.claimNext(
        "direct-chat-cancel",
        60,
        queued.body.run.id,
      ),
    ).toBeUndefined();
    let cancelledDetail = await detail(thread.id);
    expect(
      cancelledDetail.messages.some(
        (message) =>
          message.turnId === queued.body.turn.id &&
          message.status === "cancelled",
      ),
    ).toBe(true);

    const running = await send(thread.id, "Cancel while runtime is active");
    await database.query(
      `UPDATE runs
       SET input_snapshot = jsonb_set(
         input_snapshot,
         '{runtimeOptions}',
         '{"delayMs":10000}'::jsonb,
         true
       )
       WHERE id = $1`,
      [running.body.run.id],
    );
    const job = await repositories.jobs.claimNext(
      "direct-chat-cancel-running",
      60,
      running.body.run.id,
    );
    const execution = executor.execute(job!.runId, {
      jobId: job!.id,
      owner: "direct-chat-cancel-running",
      leaseSeconds: 60,
      traceId: job!.traceId,
      jobSpanId: job!.spanId,
      assertLease: async () => undefined,
      leaseRenewIntervalMs: 200,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const cancelRunning = await request(
      "POST",
      `/api/v1/direct-chats/${thread.id}/turns/${running.body.turn.id}/cancel`,
    );
    expect(cancelRunning.statusCode).toBe(202);
    await expect(execution).rejects.toBeInstanceOf(RunCancelledError);
    const currentRun = await repositories.runs.get(running.body.run.id);
    expect(currentRun?.status).toBe("cancelled");
    cancelledDetail = await detail(thread.id);
    expect(
      cancelledDetail.messages.some(
        (message) =>
          message.turnId === running.body.turn.id &&
          message.status === "cancelled",
      ),
    ).toBe(true);
  });

  it("blocks disabled agents and unavailable runtimes while preserving history", async () => {
    const agent = await createAgent();
    const thread = await ensureChat(agent.id);
    const sent = await send(thread.id, "Keep this history readable");
    const job = await repositories.jobs.claimNext(
      "direct-chat-disable",
      60,
      sent.body.run.id,
    );
    await processJob(job!, "direct-chat-disable");
    const disabled = await request(
      "POST",
      `/api/v1/agents/${agent.id}/status`,
      { status: "disabled" },
    );
    expect(disabled.statusCode).toBe(200);
    const blocked = await send(thread.id, "Must not dispatch");
    expect(blocked.statusCode).toBe(409);
    expect(blocked.body).toMatchObject({ code: "agent_disabled" });
    const history = await detail(thread.id);
    expect(
      history.messages.some(
        (message) => message.content === "Keep this history readable",
      ),
    ).toBe(true);
    expect(
      history.messages.some(
        (message) => message.content === "Must not dispatch",
      ),
    ).toBe(false);

    const unavailable = await createAgent("codex-jsonl");
    const unavailableChat = await request("POST", "/api/v1/direct-chats", {
      agentId: unavailable.id,
    });
    expect(unavailableChat.statusCode).toBe(200);
    const unavailableSend = await send(
      (unavailableChat.body as { id: string }).id,
      "External runtime still needs a binding",
    );
    expect(unavailableSend.statusCode).toBe(409);
    expect(unavailableSend.body).toMatchObject({
      code: "runtime_binding_missing",
    });
  });

  it("persists runtime failure details and retries without duplicating successful replies", async () => {
    const agent = await createAgent();
    const thread = await ensureChat(agent.id);
    const clientMessageId = randomUUID();
    const sent = await send(
      thread.id,
      "This runtime call fails first",
      clientMessageId,
    );
    await database.query(
      `UPDATE runs
       SET input_snapshot = jsonb_set(
         input_snapshot,
         '{runtimeOptions}',
         '{"fault":"fail"}'::jsonb,
         true
       )
       WHERE id = $1`,
      [sent.body.run.id],
    );
    const job = await repositories.jobs.claimNext(
      "direct-chat-failure",
      60,
      sent.body.run.id,
    );
    await expect(processJob(job!, "direct-chat-failure")).rejects.toThrow(
      /Fake Runtime injected failure/,
    );
    await repositories.jobs.fail(
      job!.id,
      "direct-chat-failure",
      job!.leaseToken,
      "Fake Runtime injected failure",
      { baseBackoffMs: 0, maxBackoffMs: 0 },
    );
    const failedReplayJob = await repositories.jobs.claimNext(
      "direct-chat-failure-replay",
      60,
      sent.body.run.id,
    );
    await expect(
      processJob(failedReplayJob!, "direct-chat-failure-replay"),
    ).rejects.toThrow(/Action Ticket action is already in progress/);
    await repositories.jobs.fail(
      failedReplayJob!.id,
      "direct-chat-failure-replay",
      failedReplayJob!.leaseToken,
      "Action Ticket execution boundary is already in progress",
      { retryable: false },
    );
    const failedDetail = await detail(thread.id);
    const failedMessage = failedDetail.messages.find(
      (message) => message.status === "failed",
    );
    expect(failedMessage).toMatchObject({
      runId: sent.body.run.id,
      errorCode: "direct_chat_runtime_failed",
      turnId: sent.body.turn.id,
    });
    expect(failedMessage?.traceId).toBeTruthy();
    const failedReplay = await send(
      thread.id,
      "This runtime call fails first",
      clientMessageId,
    );
    expect(failedReplay.statusCode).toBe(202);
    expect(failedReplay.body).toMatchObject({
      replayed: true,
      turn: { id: sent.body.turn.id, status: "failed" },
    });

    const retry = await request<DirectChatSendResult>(
      "POST",
      `/api/v1/direct-chats/${thread.id}/turns/${sent.body.turn.id}/retry`,
      undefined,
      "local-admin",
      "direct-chat-failure-retry",
    );
    expect(retry.statusCode).toBe(202);
    expect(retry.body.turn.id).not.toBe(sent.body.turn.id);
    const retryJob = await repositories.jobs.claimNext(
      "direct-chat-failure-retry",
      60,
      retry.body.run.id,
    );
    await processJob(retryJob!, "direct-chat-failure-retry");
    const recovered = await detail(thread.id);
    expect(
      recovered.messages.filter(
        (message) =>
          message.status === "sent" && message.senderType === "agent",
      ),
    ).toHaveLength(1);
    expect(
      recovered.messages.some((message) => message.status === "failed"),
    ).toBe(true);
  });

  it("keeps legacy task runs and meetings readable after migration 20", async () => {
    const project = await request<Project>("POST", "/api/v1/projects", {
      name: `Legacy compatibility ${randomUUID().slice(0, 8)}`,
      description: "Legacy run compatibility",
    });
    expect(project.statusCode).toBe(201);
    const agent = await repositories.agents.default();
    const taskResult = await request<Task>("POST", "/api/v1/tasks", {
      projectId: project.body.id,
      title: "Legacy task",
      description: "Legacy task remains readable",
      agentId: agent.id,
    });
    expect(taskResult.statusCode).toBe(201);
    const runId = randomUUID();
    await repositories.runs.enqueue({
      runId,
      task: taskResult.body,
      inputSnapshot: {
        taskTitle: taskResult.body.title,
        taskDescription: taskResult.body.description,
        acceptance: [],
        instruction: taskResult.body.description,
        agentName: agent.name,
        runtimeKind: agent.runtimeKind,
      },
    });
    const legacyRun = await request<{
      run: { projectId: string; directChatTurnId: string | null };
    }>("GET", `/api/v1/runs/${runId}`);
    expect(legacyRun.statusCode).toBe(200);
    expect(legacyRun.body.run.projectId).toBe(project.body.id);
    expect(legacyRun.body.run.directChatTurnId).toBeNull();

    const meeting = await request<Meeting>("POST", "/api/v1/meetings", {
      projectId: project.body.id,
      title: "Legacy meeting",
      agenda: "Still readable",
      agentIds: [],
    });
    expect(meeting.statusCode).toBe(201);
    const meetingDetail = await request<unknown>(
      "GET",
      `/api/v1/meetings/${meeting.body.id}`,
    );
    expect(meetingDetail.statusCode).toBe(200);
  });
});
