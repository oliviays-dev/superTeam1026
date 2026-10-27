import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { migrate } from "./migrate.js";
import { RuntimeEconomicsRepository } from "./runtime-economics-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("RuntimeEconomicsRepository PostgreSQL semantics", () => {
  const database = new Database(databaseUrl!);
  const repository = new RuntimeEconomicsRepository(database);
  const suffix = randomUUID().slice(0, 8);
  const projectId = randomUUID();
  const taskId = randomUUID();
  const runId = randomUUID();
  const jobId = randomUUID();
  const workspaceId = `runtime-economics-${suffix}`;

  beforeAll(async () => {
    await migrate(database);
    await database.query(
      `INSERT INTO projects (
         id, name, code, description, status, created_at, updated_at
       ) VALUES ($1, $2, $3, '', 'active', NOW(), NOW())`,
      [projectId, "Runtime economics test", `RTE-${suffix}`],
    );
    await database.query(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status,
         agent_id, created_at, updated_at
       ) VALUES (
         $1, $2, 'Runtime economics task', 'test', '[]'::jsonb, 'in_progress',
         '00000000-0000-4000-8000-000000000001', NOW(), NOW()
       )`,
      [taskId, projectId],
    );
    await database.query(
      `INSERT INTO runs (
         id, project_id, task_id, agent_id, status, input_snapshot,
         execution_context_type, execution_context_id,
         execution_envelope_snapshot, observability, attempt,
         created_at, updated_at, ended_at
       ) VALUES (
         $1, $2, $3, '00000000-0000-4000-8000-000000000001',
         'completed',
         '{"taskTitle":"test","taskDescription":"test","acceptance":[],"instruction":"test","agentName":"Fake","runtimeKind":"fake"}'::jsonb,
         'task', $5,
         $4::jsonb,
         '{"planVisibility":"structured","toolEventCompleteness":"complete","textStreaming":"delta","subagentVisibility":"none"}'::jsonb,
         1, NOW() - INTERVAL '2 seconds', NOW(), NOW()
       )`,
      [
        runId,
        projectId,
        taskId,
        JSON.stringify({
          workspaceId,
          contextType: "task",
          contextId: taskId,
          runtime: { id: "builtin:fake", revision: 1 },
          envelope: { launch: { provider: "fake" } },
        }),
        taskId,
      ],
    );
    await database.query(
      `INSERT INTO jobs (
         id, run_id, kind, status, attempts, max_attempts, available_at,
         created_at, updated_at
       ) VALUES ($1, $2, 'agent.run', 'completed', 1, 3, NOW(), NOW(), NOW())`,
      [jobId, runId],
    );
  });

  afterAll(async () => {
    await database.close();
  });

  it("deduplicates identical receipts and rejects conflicting replay payloads", async () => {
    const first = await repository.recordUsage({
      runId,
      runAttempt: 1,
      jobId,
      jobAttempt: 1,
      workspaceId,
      projectId,
      contextType: "task",
      contextId: taskId,
      runtimeId: "builtin:fake",
      runtimeRevision: 1,
      provider: "fake",
      usage: {
        inputTokens: 200,
        outputTokens: 50,
        totalTokens: 250,
        costAmount: 0.02,
        costCurrency: "USD",
      },
      durationMs: 1_200,
    });
    expect(first.kind).toBe("recorded");
    expect(first.receipt).toMatchObject({
      inputTokens: 200,
      outputTokens: 50,
      totalTokens: 250,
      costAmount: 0.02,
      costCurrency: "USD",
      source: "runtime-reported",
      durationMs: 1_200,
    });
    const replay = await repository.recordUsage({
      runId,
      runAttempt: 1,
      jobId,
      jobAttempt: 1,
      workspaceId,
      projectId,
      contextType: "task",
      contextId: taskId,
      runtimeId: "builtin:fake",
      runtimeRevision: 1,
      provider: "fake",
      usage: {
        inputTokens: 200,
        outputTokens: 50,
        totalTokens: 250,
        costAmount: 0.02,
        costCurrency: "USD",
      },
      durationMs: 1_200,
    });
    expect(replay.kind).toBe("replayed");
    const conflict = await repository.recordUsage({
      runId,
      runAttempt: 1,
      jobId,
      jobAttempt: 1,
      workspaceId,
      projectId,
      contextType: "task",
      contextId: taskId,
      runtimeId: "builtin:fake",
      runtimeRevision: 1,
      provider: "fake",
      usage: { inputTokens: 999, outputTokens: 1, totalTokens: 1_000 },
      durationMs: 1_200,
    });
    expect(conflict.kind).toBe("conflict");
    const counts = await database.query<{
      receipts: string;
      outbox: string;
      events: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM run_runtime_usage_receipts
          WHERE run_id = $1) AS receipts,
         (SELECT COUNT(*)::text FROM domain_outbox
          WHERE topic = 'runtime.usage.recorded'
            AND payload ->> 'runId' = $1::text) AS outbox,
         (SELECT COUNT(*)::text FROM run_events
          WHERE run_id = $1 AND type = 'runtime.usage_recorded') AS events`,
      [runId],
    );
    expect(counts.rows[0]).toEqual({
      receipts: "1",
      outbox: "1",
      events: "1",
    });
    await expect(
      database.query(
        `UPDATE run_runtime_usage_receipts
         SET input_tokens = 1
         WHERE run_id = $1`,
        [runId],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("keeps retry attempts distinct and preserves unknown fields", async () => {
    const second = await repository.recordUsage({
      runId,
      runAttempt: 2,
      jobId,
      jobAttempt: 2,
      workspaceId,
      projectId,
      contextType: "task",
      contextId: taskId,
      runtimeId: "builtin:fake",
      runtimeRevision: 1,
      provider: "fake",
      usage: { inputTokens: 20, outputTokens: 5 },
      durationMs: 300,
    });
    expect(second.kind).toBe("recorded");
    expect(second.receipt).toMatchObject({
      runAttempt: 2,
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      costAmount: null,
      unknownFields: expect.arrayContaining(["costAmount", "costCurrency"]),
    });
    expect(await repository.listUsage(runId)).toHaveLength(2);
    const sources = await repository.getRunSources(runId);
    expect(sources?.receipts).toHaveLength(2);
    expect(sources?.outbox).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ topic: "runtime.usage.recorded" }),
      ]),
    );
  });

  it("paginates execution history with stable boundaries", async () => {
    const firstPage = await repository.listExecutionHistory({
      workspaceId,
      limit: 1,
    });
    expect(firstPage.items).toHaveLength(1);
    const first = firstPage.items[0]!;
    const secondPage = await repository.listExecutionHistory({
      workspaceId,
      limit: 1,
      boundary: { createdAt: new Date(first.createdAt), id: first.runId },
    });
    expect(secondPage.items).toHaveLength(0);
  });
});
