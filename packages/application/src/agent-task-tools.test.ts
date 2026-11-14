import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  legacyTaskExecutionPolicy,
  type ActionTicket,
  type ExecutionGateRecord,
  type Run,
  type RunExecutionEnvelope,
  type SceneSessionBinding,
} from "@pluginmax/contracts";
import type { PlatformRepositories } from "@pluginmax/database";
import { AgentTaskToolFacade } from "./agent-task-tools.js";

const runId = "00000000-0000-4000-8000-000000007001";
const taskId = "00000000-0000-4000-8000-000000007002";
const agentId = "00000000-0000-4000-8000-000000007003";
const sceneSessionId = "00000000-0000-4000-8000-000000007004";
const ticketId = "00000000-0000-4000-8000-000000007005";
const gateId = "00000000-0000-4000-8000-000000007006";
const workspaceId = "workspace-m1b-unit";
const principalId = "local-admin";
const agentPrincipalId = "agent-principal-m1b";
const now = new Date("2026-11-13T00:00:00.000Z");
const digest = "a".repeat(64);

function envelope(): RunExecutionEnvelope {
  return {
    schemaVersion: 1,
    id: "run-envelope-m1b-unit",
    digest,
    contextType: "task",
    contextId: taskId,
    projectId: null,
    principalId,
    agentId,
    agentPrincipalId,
    authorization: {
      scope: "self",
      grantIds: [],
      effectivePermissions: ["read", "write"],
      membershipId: null,
      authSource: "local-development",
    },
    policy: {
      id: null,
      revision: 1,
      version: "task-execution-policy-v1:task:fixture:r1",
      contextType: "task",
      contextId: taskId,
      source: "legacy",
      policy: {
        ...legacyTaskExecutionPolicy(),
        toolPolicy: {
          allow: ["fs.write"],
          deny: [],
          requireApproval: [],
        },
      },
    },
    binding: { kind: "builtin", id: null, revision: 1 },
    runtime: {
      id: "builtin:fake",
      revision: 1,
      capabilitySnapshotId: null,
      capability: {
        schemaVersion: 1,
        runtimeId: "builtin:fake",
        runtimeRevision: "1",
        adapterId: "fake",
        provider: "pluginmax",
        protocol: "builtin",
        capabilities: {
          search: "unsupported",
          network: "unsupported",
          fileRead: "supported",
          fileWrite: "supported",
          shell: "unsupported",
          browser: "unsupported",
          mcp: "unsupported",
          sessionResume: "unsupported",
          structuredPlan: "supported",
          structuredToolEvents: "supported",
          structuredSubagent: "unsupported",
        },
        toolCategories: ["fs.write"],
        networkModes: ["none"],
        gateEnforcement: "blocking",
        limits: {},
        provenance: {
          adapter: true,
          probe: false,
          config: true,
          observedInRuns: false,
        },
        capturedAt: now.toISOString(),
      },
    },
    envelope: {
      schemaVersion: 1,
      id: "execution-envelope-m1b-unit",
      taskId,
      runId,
      workspaceId,
      principalId,
      runtimeId: "builtin:fake",
      adapterId: "fake",
      runtimeRevision: "1",
      policyVersion: "task-execution-policy-v1:task:fixture:r1",
      ticketId,
      resolved: {
        searchEnabled: false,
        networkAccess: "none",
        allowedToolCategories: ["fs.write"],
        approvalToolCategories: ["fs.write"],
        deniedToolCategories: [],
        sandbox: "workspace",
        gateEnforcement: "blocking",
        planVisibility: "structured",
      },
      launch: { provider: "pluginmax", authMode: "platform-managed" },
      unresolved: [],
      createdAt: now.toISOString(),
    },
    createdAt: now.toISOString(),
  };
}

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: runId,
    projectId: null,
    taskId,
    meetingTurnId: null,
    directChatTurnId: null,
    agentId,
    taskExecutionKind: "owner",
    taskTriggerMessageId: null,
    status: "running",
    contextPackId: null,
    inputSnapshot: {
      taskTitle: "M1b unit",
      taskDescription: "M1b unit",
      acceptance: [],
      instruction: "M1b unit",
      agentName: "Fake",
      runtimeKind: "fake",
    },
    executionSnapshot: null,
    executionEnvelope: envelope(),
    externalRuntimeId: null,
    externalRuntimeRevision: null,
    externalRuntimeProvider: null,
    externalRuntimeProtocol: null,
    externalSessionId: null,
    externalRuntimeVersion: null,
    externalStartedAt: null,
    output: null,
    error: null,
    attempt: 2,
    timeoutAt: null,
    workflowInstanceId: null,
    workflowNodeId: null,
    traceId: "0123456789abcdef0123456789abcdef",
    traceRootSpanId: "0123456789abcdef",
    observability: {
      planVisibility: "structured",
      toolEventCompleteness: "complete",
      textStreaming: "delta",
      subagentVisibility: "none",
    },
    createdAt: now.toISOString(),
    startedAt: now.toISOString(),
    endedAt: null,
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function scene(): SceneSessionBinding {
  return {
    id: sceneSessionId,
    sceneType: "task",
    sceneId: taskId,
    projectId: null,
    participantBindingId: null,
    agentId,
    agentPrincipalId,
    ownerPrincipalId: null,
    channelId: null,
    sessionHandle: "de-task-m1b-unit",
    generation: 0,
    status: "active",
    revision: 1,
    lastContextSeq: 0,
    contextUsageRatio: 0,
    compactionCount: 0,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function ticket(): ActionTicket {
  return {
    schemaVersion: 1,
    ticketId,
    ticketVersion: 1,
    principalId,
    workspaceId,
    contextType: "task",
    contextId: taskId,
    taskId,
    runId,
    allowedActions: ["agent.execute", "task.writeback"],
    deniedActions: [],
    resourceScopes: [
      `run:${runId}`,
      `workspace:${workspaceId}`,
      `context:task:${taskId}`,
      "tool:fs.write",
    ],
    policyId: null,
    policyRevision: 1,
    envelopeId: "run-envelope-m1b-unit",
    envelopeDigest: digest,
    authorizationSnapshot: {
      scope: "self",
      principalId,
      grantIds: [],
      effectivePermissions: ["read", "write"],
      membershipId: null,
    },
    executionEnvelope: envelope(),
    delegation: null,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    issuedBy: principalId,
  } as ActionTicket;
}

function gate(
  overrides: Partial<ExecutionGateRecord> = {},
): ExecutionGateRecord {
  return {
    gateId,
    ticketId,
    runId,
    taskId,
    projectId: null,
    gateKey: "tool-approval:fs.write",
    kind: "tool-approval",
    enforcement: "blocking",
    reason: "M1b unit Gate",
    requestedToolCategory: "fs.write",
    requestedSourceClass: null,
    resourceScopes: [`workspace:${workspaceId}`, "tool:fs.write"],
    policyId: null,
    policyRevision: 1,
    envelopeId: "run-envelope-m1b-unit",
    envelopeDigest: digest,
    requestedByPrincipalId: principalId,
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    status: "approved",
    decision: {
      decisionId: "00000000-0000-4000-8000-000000007007",
      gateId,
      decision: "approve",
      decidedByPrincipalId: principalId,
      basis: "M1b unit approval",
      decidedAt: now.toISOString(),
      policyRevision: 1,
      envelopeId: "run-envelope-m1b-unit",
      envelopeDigest: digest,
    },
    ...overrides,
  };
}

async function facadeFor(input: {
  readonly run?: Run;
  readonly ticket?: ActionTicket | null;
  readonly gate?: ExecutionGateRecord;
  readonly enabled?: boolean;
}) {
  const repositories = {
    runs: {
      get: vi.fn(async () => input.run ?? run()),
      appendEvent: vi.fn(async () => ({})),
    },
    sceneContext: { sessionForRun: vi.fn(async () => scene()) },
    featureFlags: {
      isEnabled: vi.fn(async () => input.enabled ?? true),
    },
    actionTickets: {
      getByRun: vi.fn(async () =>
        input.ticket === null ? undefined : (input.ticket ?? ticket()),
      ),
      getGate: vi.fn(async () => input.gate),
    },
    agentTools: {
      recordFailure: vi.fn(async () => ({})),
      begin: vi.fn(),
    },
  } as unknown as PlatformRepositories;
  return new AgentTaskToolFacade(repositories, {
    workspaceRoot: await mkdtemp(join(tmpdir(), "pluginmax-m1b-unit-")),
    now: () => now,
  });
}

const proof = {
  runId,
  runAttempt: 2,
  sceneSessionId,
};

const writeRequest = (gateIdValue?: string, suffix = "one") =>
  ({
    tool: "write_file" as const,
    idempotencyKey: `m1b-unit-${suffix}-${randomSuffix()}`,
    ...(gateIdValue === undefined ? {} : { gateId: gateIdValue }),
    payload: { path: "unit.txt", content: "unit" },
  });

let suffix = 0;
function randomSuffix(): string {
  suffix += 1;
  return `${Date.now()}-${suffix}`;
}

describe("AgentTaskToolFacade Gate defaults", () => {
  it("rejects self-reported identity fields through strict payload schemas", async () => {
    const facade = await facadeFor({ gate: gate() });
    await expect(
      facade.invoke(proof, {
        ...writeRequest(gateId),
        payload: {
          path: "unit.txt",
          content: "unit",
          actor: "model-supplied",
          projectId: taskId,
        },
      } as never),
    ).rejects.toMatchObject({ code: "agent_tool_invalid_arguments" });
  });

  it("denies a missing Execution Envelope before any side effect", async () => {
    const facade = await facadeFor({
      run: run({ executionEnvelope: null }),
      gate: gate(),
    });
    await expect(
      facade.invoke(proof, writeRequest(gateId)),
    ).rejects.toMatchObject({ code: "execution_envelope_missing" });
  });

  it("denies missing, expired, denied and cancelled Gates", async () => {
    const cases = [
      {
        facade: await facadeFor({}),
        expected: "execution_gate_missing",
      },
      {
        facade: await facadeFor({
          gate: gate({
            status: "expired",
            expiresAt: new Date(now.getTime() - 1_000).toISOString(),
          }),
        }),
        expected: "execution_gate_expired",
      },
      {
        facade: await facadeFor({
          gate: gate({
            status: "denied",
            decision: {
              ...gate().decision!,
              decision: "reject",
            },
          }),
        }),
        expected: "execution_gate_denied",
      },
      {
        facade: await facadeFor({
          gate: gate({
            status: "cancelled",
            decision: {
              ...gate().decision!,
              decision: "cancel",
            },
          }),
        }),
        expected: "execution_gate_cancelled",
      },
    ];
    for (const [index, item] of cases.entries()) {
      await expect(
        item.facade.invoke(
          proof,
          writeRequest(gateId, `deny-${index}`),
        ),
      ).rejects.toMatchObject({ code: item.expected });
    }
  });

  it("rejects a Gate from another Run", async () => {
    const facade = await facadeFor({
      gate: gate({
        runId: "00000000-0000-4000-8000-000000007099",
        ticketId: "00000000-0000-4000-8000-000000007098",
      }),
    });
    await expect(
      facade.invoke(proof, writeRequest(gateId)),
    ).rejects.toMatchObject({ code: "execution_gate_scope_mismatch" });
  });

  it("rejects a Ticket from another Run, Task or resource scope", async () => {
    const crossRun = await facadeFor({
      ticket: { ...ticket(), runId: "00000000-0000-4000-8000-000000007097" },
      gate: gate(),
    });
    await expect(
      crossRun.invoke(proof, writeRequest(gateId, "cross-run-ticket")),
    ).rejects.toMatchObject({ code: "action_ticket_scope_mismatch" });

    const crossTask = await facadeFor({
      ticket: { ...ticket(), taskId: "00000000-0000-4000-8000-000000007096" },
      gate: gate(),
    });
    await expect(
      crossTask.invoke(proof, writeRequest(gateId, "cross-task-ticket")),
    ).rejects.toMatchObject({ code: "action_ticket_scope_mismatch" });

    const missing = await facadeFor({ ticket: null, gate: gate() });
    await expect(
      missing.invoke(proof, writeRequest(gateId, "missing-ticket")),
    ).rejects.toMatchObject({ code: "action_ticket_missing" });
  });

  it("blocks when the capability Feature Flag is off", async () => {
    const facade = await facadeFor({ gate: gate(), enabled: false });
    await expect(
      facade.invoke(proof, writeRequest(gateId)),
    ).rejects.toMatchObject({ code: "agent_tool_feature_disabled" });
  });
});
