import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  MCP_PROVIDER_CONTROL_PLANE_FLAG,
  MCP_TOOL_CATEGORY,
  MCP_TOOL_INVOCATION_FLAG,
  legacyTaskExecutionPolicy,
  taskExecutionPolicySchema,
} from "../packages/contracts/src/index.js";
import { PlatformApplication } from "../packages/application/src/index.js";
import {
  Database,
  PlatformRepositories,
} from "../packages/database/src/index.js";
import type {
  McpCredentialResolver,
  McpToolCallTransport,
} from "../apps/worker/src/mcp-provider-probe-service.js";
import { McpToolCallService } from "../apps/worker/src/mcp-tool-call-service.js";

const databaseUrl = process.env.DATABASE_URL;
const fixturePath = process.env.M13B_E2E_FIXTURE_PATH;
if (databaseUrl === undefined || fixturePath === undefined) {
  throw new Error("DATABASE_URL and M13B_E2E_FIXTURE_PATH are required");
}

const database = new Database(databaseUrl);
const repositories = new PlatformRepositories(database);
const application = new PlatformApplication(repositories);
const admin = {
  principalId: "local-admin",
  platformAdministrator: true,
} as const;
const inputSecret = `m13b-e2e-input-${randomUUID()}`;
const outputSecret = `m13b-e2e-output-${randomUUID()}`;

try {
  await database.query(
    `INSERT INTO principals (
       id, kind, display_name, status, status_authority, source,
       version, created_at, updated_at
     ) VALUES (
       'local-admin', 'human', 'Local Admin', 'active', 'system', 'local',
       1, NOW(), NOW()
     )
     ON CONFLICT (id) DO NOTHING`,
  );
  await setFlag(MCP_PROVIDER_CONTROL_PLANE_FLAG, true);
  await setFlag(MCP_TOOL_INVOCATION_FLAG, true);
  const project = await application.createProject({
    name: `M13b Tool E2E ${randomUUID().slice(0, 8)}`,
    description: "M13b MCP Tool call browser verification",
  });
  const agent = await application.createAgent({
    name: `M13b Tool Agent ${randomUUID().slice(0, 8)}`,
    description: "M13b E2E Agent",
    soul: "Execute governed MCP Tool calls.",
    scenarios: ["M13b E2E"],
    goals: ["Show safe Tool call status"],
    tools: [],
    runtimeKind: "fake",
    source: "platform",
  });
  await application.createProjectMember(project.id, {
    kind: "agent",
    agentId: agent.id,
    responsibility: "M13b E2E execution",
    roleIds: [],
  });
  const providerKey = `m13b.e2e.${randomUUID().slice(0, 8)}`;
  const providerInput = {
    providerKey,
    name: "M13b E2E Provider",
    description: "M13b E2E Provider",
    transport: "streamable-http" as const,
    endpointUrl: `https://${providerKey}.example.test/mcp`,
    authKind: "none" as const,
    credentialRef: null,
    credentialHeaderName: null,
    requestTimeoutMs: 1_000,
  };
  const createdProvider = await application.mcpProviders.create(
    admin,
    providerInput,
  );
  const requestedProbe = await application.mcpProviders.requestProbe(
    admin,
    createdProvider.provider.id,
    { expectedRevision: createdProvider.provider.revision },
  );
  const probeJob = await repositories.mcpProviders.claimProbeJob(
    "m13b-e2e-probe",
    30,
  );
  if (probeJob === undefined) throw new Error("M13b E2E probe was not claimed");
  await repositories.mcpProviders.completeProbeJob({
    probeId: requestedProbe.probe.id,
    owner: "m13b-e2e-probe",
    leaseToken: probeJob.leaseToken,
    passed: true,
    durationMs: 10,
    tools: [
      {
        name: "orders.lookup",
        description: "Lookup an order",
        inputSchema: {
          type: "object",
          properties: { orderId: { type: "string" } },
        },
        outputSchema: null,
        schemaDigest: "a".repeat(64),
      },
    ],
  });
  const probedProvider = await application.mcpProviders.get(
    admin,
    createdProvider.provider.id,
  );
  const provider = await application.mcpProviders.activate(
    admin,
    createdProvider.provider.id,
    {
      expectedRevision: probedProvider.provider.revision,
      reason: "M13b E2E activation",
    },
  );
  const task = await application.createTask({
    projectId: project.id,
    title: `M13b Tool Task ${randomUUID().slice(0, 8)}`,
    description: "Show a governed MCP Tool call in the Run view.",
    acceptance: [],
    agentId: agent.id,
    autoSubmit: false,
  });
  await application.updateTaskExecutionPolicy(
    "task",
    task.id,
    {
      expectedRevision: 0,
      policy: taskExecutionPolicySchema.parse({
        ...legacyTaskExecutionPolicy(),
        runtime: {
          selection: "recommended",
          allowedRuntimeIds: ["builtin:fake"],
          requiredCapabilities: [
            { key: "mcp", necessity: "required", value: "supported" },
          ],
        },
        sourcePolicy: {
          allow: [
            "workspace",
            "task-attachments",
            "project-memory",
            "connector-data",
          ],
          deny: ["private-local-data"],
          citation: "none",
          requirePublishedAt: false,
          requireAccessedAt: false,
        },
        toolPolicy: {
          allow: [MCP_TOOL_CATEGORY],
          deny: [],
          requireApproval: [MCP_TOOL_CATEGORY],
        },
        budget: {
          timeoutMs: 30_000,
          maxToolCalls: 10,
        },
      }),
    },
    "local-admin",
  );
  const dispatched = await application.dispatchTask(
    task.id,
    undefined,
    "local-admin",
    true,
  );
  const bundle = await repositories.actionTickets.getBundle(dispatched.runId);
  const gate = bundle?.gates.find(
    (candidate) =>
      candidate.requestedToolCategory === MCP_TOOL_CATEGORY &&
      candidate.enforcement === "blocking",
  );
  if (gate === undefined) throw new Error("M13b E2E Gate was not issued");
  await application.decideExecutionGate(
    gate.gateId,
    {
      decision: "approve",
      basis: "M13b E2E browser fixture",
    },
    "local-admin",
  );
  await repositories.runs.markRunning(dispatched.runId);
  const transport: McpToolCallTransport = {
    callTool: async () => ({
      content: [{ type: "text", text: outputSecret }],
      isError: false,
    }),
  };
  const credentials: McpCredentialResolver = {
    resolve: async () => undefined,
  };
  const service = new McpToolCallService(
    repositories,
    {
      owner: "m13b-e2e-tool-worker",
      leaseSeconds: 30,
    },
    transport,
    credentials,
  );
  const call = await service.invoke({
    runId: dispatched.runId,
    runAttempt: 1,
    toolKey: provider.tools[0]!.toolKey,
    gateId: gate.gateId,
    idempotencyKey: "m13b-e2e-tool-call",
    arguments: {
      orderId: "order-e2e",
      note: inputSecret,
    },
  });
  await writeFile(
    fixturePath,
    `${JSON.stringify(
      {
        projectId: project.id,
        taskId: task.id,
        taskTitle: task.title,
        runId: dispatched.runId,
        providerId: provider.provider.id,
        providerKey,
        toolName: "orders.lookup",
        toolKey: provider.tools[0]!.toolKey,
        callId: call.call.id,
        inputSecret,
        outputSecret,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `m13b_e2e_seed=ok run=${dispatched.runId} call=${call.call.id}\n`,
  );
} finally {
  await database.close();
}

async function setFlag(flagKey: string, enabled: boolean): Promise<void> {
  await repositories.featureFlags.set({
    flagKey,
    scopeType: "platform",
    scopeId: "platform",
    mode: enabled ? "on" : "off",
    updatedBy: "m13b:e2e-seed",
  });
}
