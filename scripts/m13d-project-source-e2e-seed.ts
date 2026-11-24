import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  BUSINESS_CHAIN_FLAG,
  MCP_PROJECT_SOURCE_FLAG,
  type BusinessChainDefinitionValue,
} from "../packages/contracts/src/index.js";
import { PlatformApplication } from "../packages/application/src/index.js";
import {
  Database,
  PlatformRepositories,
} from "../packages/database/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const fixturePath = process.env.M13D_E2E_FIXTURE_PATH;
if (databaseUrl === undefined || fixturePath === undefined) {
  throw new Error("DATABASE_URL and M13D_E2E_FIXTURE_PATH are required");
}

const database = new Database(databaseUrl);
const repositories = new PlatformRepositories(database);
const application = new PlatformApplication(repositories);
const outputSecret = `m13d-e2e-secret-${randomUUID()}`;
const endpoint = "https://must-not-appear.example.test/mcp";
const credentialRef = `secret://m13d/${randomUUID()}`;
const toolKey = "e".repeat(64);
const providerId = randomUUID();
const providerVersionId = randomUUID();

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
  await repositories.featureFlags.set({
    flagKey: MCP_PROJECT_SOURCE_FLAG,
    scopeType: "platform",
    scopeId: "platform",
    mode: "on",
    updatedBy: "m13d:e2e-seed",
  });
  const project = await application.createProject({
    name: `M13d 项目来源 ${randomUUID().slice(0, 8)}`,
    description: "M13d browser read-only project source",
  });
  const businessChainFlag =
    await repositories.projectBusinessChains.getFeatureFlagState(
      BUSINESS_CHAIN_FLAG,
      project.id,
    );
  await repositories.projectBusinessChains.setProjectFeatureFlag({
    flagKey: BUSINESS_CHAIN_FLAG,
    projectId: project.id,
    enabled: true,
    expectedRevision: businessChainFlag.revision,
    actorId: "local-admin",
  });
  const workflow = await application.createWorkflow({
    projectId: project.id,
    name: "只读 MCP 来源链路",
    description: "Browser reads snapshots only",
    stepNames: ["来源"],
    stepRoleIds: [],
  });
  const refKey = "m13d-e2e-erp:order:order-42";
  const definition: BusinessChainDefinitionValue = {
    chainKey: "M13D_E2E_ORDER",
    templateKey: "M13D_E2E_ORDER",
    displayName: "订单只读来源链路",
    projectTypeCodes: ["ORDER"],
    snapshotPolicy: "pin-at-project-create",
    allowUnboundSources: false,
    nodes: [
      {
        sequence: 1,
        stageCode: "ORDER",
        summaryMetric: "订单金额",
        fields: [
          {
            key: "amount",
            label: "订单金额",
            bindings: [
              {
                refKey,
                sourceKind: "mcp",
                sourceSystem: "m13d-e2e-erp",
                objectType: "order",
                objectId: "order-42",
                path: "amount",
                required: true,
                providerId,
                providerVersionId,
                providerRevision: 1,
                toolKey,
                readOnly: true,
              },
            ],
          },
        ],
      },
    ],
    expectedRevision: workflow.revision,
  };
  const configured = await application.configureWorkflowBusinessChain(
    workflow.id,
    definition,
    "local-admin",
    true,
  );
  await application.bindProjectBusinessChain(
    project.id,
    {
      workflowDefinitionId: configured.id,
      nodeBindings: [],
      expectedRevision: 0,
      reason: "M13d E2E source binding",
      upgrade: false,
    },
    "local-admin",
  );
  const now = new Date();
  await repositories.projectBusinessChains.recordSourceSnapshot({
    projectId: project.id,
    actorId: "system:project-source-worker",
    result: {
      refKey,
      sourceKind: "mcp",
      sourceSystem: "m13d-e2e-erp",
      objectType: "order",
      objectId: "order-42",
      sourceRevision: "e2e-revision-1",
      observedAt: now.toISOString(),
      effectiveAt: now.toISOString(),
      freshUntil: new Date(now.getTime() + 300_000).toISOString(),
      status: "fresh",
      payload: { amount: 420 },
      failureReason: null,
      isMock: false,
    },
  });
  await repositories.projectBusinessChains.recordSourceSnapshot({
    projectId: project.id,
    actorId: "system:project-source-worker",
    result: {
      refKey,
      sourceKind: "mcp",
      sourceSystem: "m13d-e2e-erp",
      objectType: "order",
      objectId: "order-42",
      sourceRevision: null,
      observedAt: new Date(now.getTime() + 1_000).toISOString(),
      effectiveAt: null,
      freshUntil: null,
      status: "error",
      payload: null,
      failureReason: "timeout:source_timeout",
      isMock: false,
    },
  });
  await repositories.projectBusinessChains.observeAlert({
    projectId: project.id,
    actorId: "system:project-source-worker",
    observation: {
      sourceSystem: "m13d-e2e-erp",
      sourceObjectType: "order",
      sourceObjectId: "order-42",
      conditionCode: "MCP_SOURCE_TIMEOUT",
      title: "MCP 项目来源超时",
      message: "保留最后有效快照并标记来源错误",
      severity: "critical",
      sourceRevision: null,
      observedAt: new Date(now.getTime() + 1_000).toISOString(),
      linkedNodeIds: [],
      linkedTaskIds: [],
      followTargetId: null,
    },
  });
  await writeFile(
    fixturePath,
    `${JSON.stringify(
      {
        projectId: project.id,
        projectName: project.name,
        refKey,
        providerId,
        providerVersionId,
        toolKey,
        outputSecret,
        endpoint,
        credentialRef,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(
    `m13d_e2e_seed=ok project=${project.id} source=${refKey}\n`,
  );
} finally {
  await database.close();
}
