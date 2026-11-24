import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { MCP_RUNTIME_TOOL_BRIDGE_FLAG } from "../packages/contracts/src/index.js";
import {
  Database,
  PlatformRepositories,
} from "../packages/database/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const inputFixturePath = process.env.M13B_E2E_FIXTURE_PATH;
const outputFixturePath = process.env.M13C_E2E_FIXTURE_PATH;
if (
  databaseUrl === undefined ||
  inputFixturePath === undefined ||
  outputFixturePath === undefined
) {
  throw new Error(
    "DATABASE_URL, M13B_E2E_FIXTURE_PATH and M13C_E2E_FIXTURE_PATH are required",
  );
}

const fixture = JSON.parse(await readFile(inputFixturePath, "utf8")) as {
  readonly projectId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly runId: string;
  readonly providerId: string;
  readonly providerKey: string;
  readonly toolName: string;
  readonly toolKey: string;
  readonly callId: string;
  readonly inputSecret: string;
  readonly outputSecret: string;
};
const database = new Database(databaseUrl);
const repositories = new PlatformRepositories(database);
const requestId = randomUUID();
const leaseToken = randomUUID();

try {
  await repositories.featureFlags.set({
    flagKey: MCP_RUNTIME_TOOL_BRIDGE_FLAG,
    scopeType: "platform",
    scopeId: "platform",
    mode: "on",
    updatedBy: "m13c:e2e-seed",
  });
  await database.transaction(async (client) => {
    const call = await client.query<{
      readonly run_attempt: number;
      readonly task_id: string;
      readonly project_id: string;
      readonly agent_id: string;
      readonly agent_principal_id: string | null;
      readonly tool_key: string;
      readonly ticket_id: string;
      readonly gate_id: string;
      readonly policy_id: string;
      readonly policy_revision: number;
      readonly envelope_id: string;
      readonly envelope_digest: string;
      readonly idempotency_key: string;
      readonly request_digest: string;
      readonly input_summary: unknown;
      readonly output_summary: unknown;
      readonly output_digest: string | null;
    }>(
      `SELECT
         run_attempt, task_id, project_id, agent_id, agent_principal_id,
         tool_key, ticket_id, gate_id, policy_id, policy_revision,
         envelope_id, envelope_digest, idempotency_key, request_digest,
         input_summary, output_summary, output_digest
       FROM mcp_tool_calls
       WHERE id = $1`,
      [fixture.callId],
    );
    const row = call.rows[0];
    if (row === undefined) throw new Error("M13c E2E Tool call not found");
    await client.query(
      `INSERT INTO runtime_tool_requests (
         request_id, run_id, run_attempt, task_id, project_id, agent_id,
         agent_principal_id, tool_key, ticket_id, gate_id, policy_id,
         policy_revision, envelope_id, envelope_digest, call_id,
         idempotency_key, request_digest, status, input_summary, lease_owner,
         lease_token, lease_expires_at, started_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
         $15, $16, $17, 'running', $18::jsonb, 'm13c-e2e-runtime-worker',
         $19, NOW() + INTERVAL '5 minutes', NOW(), NOW(), NOW()
       )`,
      [
        requestId,
        fixture.runId,
        row.run_attempt,
        row.task_id,
        row.project_id,
        row.agent_id,
        row.agent_principal_id,
        row.tool_key,
        row.ticket_id,
        row.gate_id,
        row.policy_id,
        row.policy_revision,
        row.envelope_id,
        row.envelope_digest,
        fixture.callId,
        row.idempotency_key,
        row.request_digest,
        JSON.stringify(row.input_summary),
        leaseToken,
      ],
    );
    await client.query(
      `UPDATE runtime_tool_requests
       SET status = 'succeeded',
           output_summary = $2::jsonb,
           output_digest = $3,
           lease_owner = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE request_id = $1`,
      [
        requestId,
        JSON.stringify(row.output_summary),
        row.output_digest,
      ],
    );
  });
  await writeFile(
    outputFixturePath,
    `${JSON.stringify(
      {
        ...fixture,
        requestId,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `m13c_e2e_seed=ok run=${fixture.runId} request=${requestId}\n`,
  );
} finally {
  await database.close();
}
