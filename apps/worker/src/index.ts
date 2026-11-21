import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  PlatformApplication,
  RunExecutor,
  SharedSpaceApplication,
} from "@pluginmax/application";
import { loadConfig, loadLocalEnv } from "@pluginmax/config";
import { Database, PlatformRepositories } from "@pluginmax/database";
import {
  MCP_PROJECT_SOURCE_FLAG,
  MCP_RUNTIME_TOOL_BRIDGE_FLAG,
  MCP_TOOL_INVOCATION_FLAG,
} from "@pluginmax/contracts";
import { LocalFileStore } from "@pluginmax/files";
import { WorkerRuntime } from "./worker-runtime.js";
import { RuntimeMaintenanceService } from "./maintenance-service.js";
import { RuntimeProbeService } from "./runtime-probe-service.js";
import {
  HttpStreamableMcpProbeTransport,
  McpProviderProbeService,
} from "./mcp-provider-probe-service.js";
import { McpToolCallService } from "./mcp-tool-call-service.js";
import { RuntimeToolRequestBridge } from "./runtime-tool-request-bridge.js";
import {
  EnvironmentSecretStoreAdapter,
  ManagedSecretResolver,
  MountedFileSecretStoreAdapter,
} from "./secret-resolver.js";
import { McpProjectSourceAdapter } from "./project-source-mcp-adapter.js";

loadLocalEnv();
const config = loadConfig();
const database = new Database(config.databaseUrl);
const repositories = new PlatformRepositories(database);
const application = new PlatformApplication(repositories);
const sharedSpace = new SharedSpaceApplication(
  repositories,
  new LocalFileStore(config.fileStoreRoot),
);
const workerId = `worker-${randomUUID()}`;

const log = (event: string, data: Record<string, unknown> = {}) => {
  process.stdout.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: "info",
      workerId,
      event,
      ...data,
    })}\n`,
  );
};

const sweep = async () => {
  if (
    await repositories.featureFlags.isEnabled(MCP_PROJECT_SOURCE_FLAG)
  ) {
    const reconciled = await projectSourceMcp.reconcileExpired(
      config.workerRecoveryBatchSize,
    );
    if (reconciled > 0) {
      log("project_source_mcp.reconciled", { count: reconciled });
    }
  }
  if (
    await repositories.featureFlags.isEnabled(MCP_RUNTIME_TOOL_BRIDGE_FLAG)
  ) {
    const reconciled =
      await repositories.runtimeToolRequests.reconcileExpired(
        config.workerRecoveryBatchSize,
      );
    if (reconciled > 0) {
      log("runtime_tool_request.reconciled", { count: reconciled });
    }
  }
  if (await repositories.featureFlags.isEnabled(MCP_TOOL_INVOCATION_FLAG)) {
    const reconciled = await repositories.mcpToolCalls.reconcileExpired(
      config.workerRecoveryBatchSize,
    );
    if (reconciled > 0) {
      log("mcp_tool_call.reconciled", { count: reconciled });
    }
  }
  const expiredGates = await application.expireExecutionGates(
    config.workerRecoveryBatchSize,
  );
  if (expiredGates.length > 0) {
    log("execution_gate.expired", { count: expiredGates.length });
  }
  const result = await application.sweepWorkflowInstances(workerId, {
    batchSize: config.workflowSweepBatchSize,
    leaseSeconds: config.workflowSweepLeaseSeconds,
    staleAfterSeconds: config.workflowSweepStaleSeconds,
  });
  if (result.claimed > 0) {
    log("workflow.sweep", result);
  }
  const planSweep = await application.sweepWorkflowPlans(workerId, {
    batchSize: config.workflowSweepBatchSize,
    leaseSeconds: config.workflowSweepLeaseSeconds,
    staleAfterSeconds: config.workflowSweepStaleSeconds,
  });
  if (planSweep.claimed > 0 || planSweep.fenced > 0) {
    log("workflow_plan.sweep", { ...planSweep });
  }
  const planningSweep = await application.runPlanningRuntimeOnce({
    limit: config.workerRecoveryBatchSize,
  });
  if (planningSweep.claimed > 0) {
    log("planning_runtime.sweep", planningSweep);
  }
  const sharedSpaceRecovery = await sharedSpace.recoverApprovedWrites(
    config.workerRecoveryBatchSize,
  );
  if (
    sharedSpaceRecovery.written > 0 ||
    sharedSpaceRecovery.failed > 0 ||
    sharedSpaceRecovery.expiredLocks > 0 ||
    sharedSpaceRecovery.expiredClaims > 0 ||
    sharedSpaceRecovery.expiredRequests > 0
  ) {
    log("shared_space.recovery", sharedSpaceRecovery);
  }
  const delegationSweep = await application.delegations.sweepDue();
  if (
    delegationSweep.expired > 0 ||
    delegationSweep.expiryNotifications > 0 ||
    delegationSweep.confirmationsExpired > 0 ||
    delegationSweep.reportsGenerated > 0 ||
    delegationSweep.reportsFailed > 0
  ) {
    log("delegation.sweep", delegationSweep);
  }
};

const maintenance = new RuntimeMaintenanceService(
  repositories,
  application,
  {
    owner: workerId,
    claimLeaseSeconds: config.maintenanceLeaseSeconds,
    approvalSlaBatchSize: config.approvalSlaBatchSize,
    recoveryBatchSize: config.workerRecoveryBatchSize,
    retryBaseDelayMs: config.workerRetryBaseDelayMs,
    retryMaxDelayMs: config.workerRetryMaxDelayMs,
    idempotencyRetentionSeconds: config.idempotencyRetentionSeconds,
    idempotencyCleanupBatchSize: config.idempotencyCleanupBatchSize,
  },
  log,
);
const runtimeProbe = new RuntimeProbeService(
  repositories,
  {
    owner: workerId,
    workspaceRoot: resolve(config.agentWorkspaceRoot, "runtime-probes"),
    timeoutMs: config.runtimeProbeTimeoutMs,
    leaseSeconds: config.runtimeProbeLeaseSeconds,
  },
  log,
);
const mcpTransport = new HttpStreamableMcpProbeTransport({
  allowHttp: process.env.MCP_PROVIDER_ALLOW_HTTP === "1",
  allowPrivateHosts: process.env.MCP_PROVIDER_ALLOW_PRIVATE_HOSTS === "1",
  allowedHosts: (process.env.MCP_PROVIDER_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),
});
const mcpCredentials = new ManagedSecretResolver(
  {
    timeoutMs: config.secretResolutionTimeoutMs,
    cacheTtlMs: config.secretResolutionCacheTtlMs,
  },
  [
    new EnvironmentSecretStoreAdapter(),
    ...(config.secretStoreFile === undefined
      ? []
      : [
          new MountedFileSecretStoreAdapter(config.secretStoreFile, {
            allowLoosePermissions:
              config.secretStoreAllowLoosePermissions,
          }),
        ]),
  ],
);
const mcpProviderProbe = new McpProviderProbeService(
  repositories,
  {
    owner: workerId,
    leaseSeconds: config.runtimeProbeLeaseSeconds,
  },
  mcpTransport,
  mcpCredentials,
  log,
);
const mcpToolCall = new McpToolCallService(
  repositories,
  {
    owner: workerId,
    leaseSeconds: config.runtimeProbeLeaseSeconds,
  },
  mcpTransport,
  mcpCredentials,
  log,
);
const runtimeToolBridge = new RuntimeToolRequestBridge(
  repositories,
  mcpToolCall,
  {
    owner: workerId,
    leaseSeconds: Math.max(config.workerLeaseSeconds, 300),
  },
  log,
);
const projectSourceMcp = new McpProjectSourceAdapter(
  repositories,
  runtimeToolBridge,
  {
    owner: workerId,
    leaseSeconds: Math.max(config.workerLeaseSeconds, 300),
  },
  log,
);
const executor = new RunExecutor(repositories, {
  workspaceRoot: config.agentWorkspaceRoot,
  fileStoreRoot: config.fileStoreRoot,
  runtimeEffectPollIntervalMs: config.runtimeEffectPollIntervalMs,
  runtimeToolBridge,
  dsh: {
    dshBin: config.dshBin,
    profile: config.dshProfile,
    dshHome: config.dshHome,
    provider: config.dshProvider,
    model: config.dshModel,
  },
});

const runtime = new WorkerRuntime(
  {
    workerId,
    concurrency: config.workerConcurrency,
    pollIntervalMs: config.workerPollIntervalMs,
    leaseSeconds: config.workerLeaseSeconds,
    leaseRenewIntervalMs: config.workerLeaseRenewIntervalMs,
    shutdownGraceMs: config.workerShutdownGraceMs,
    recoveryBatchSize: config.workerRecoveryBatchSize,
    retryBaseDelayMs: config.workerRetryBaseDelayMs,
    retryMaxDelayMs: config.workerRetryMaxDelayMs,
    heartbeatIntervalMs: config.workerHeartbeatIntervalMs,
    workerHeartbeatStaleAfterSeconds: config.workerHeartbeatStaleAfterSeconds,
    sweepIntervalMs: config.workflowSweepIntervalMs,
    maintenanceIntervalMs: config.maintenancePollIntervalMs,
    runtimeProbePollIntervalMs: config.runtimeProbePollIntervalMs,
    mcpProviderProbePollIntervalMs: config.runtimeProbePollIntervalMs,
  },
  {
    repositories,
    executor,
    sweep,
    maintenance,
    runtimeProbe,
    mcpProviderProbe,
    mcpToolCall,
    log,
  },
);

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log("worker.signal_received", { signal });
  await runtime.stop(signal);
};

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

try {
  await runtime.run();
} finally {
  await database.close();
}
