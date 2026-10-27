import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  legacyTaskExecutionPolicy,
  type ActionTicket,
  type ExecutionGateRecord,
  type Run,
  type RunExecutionEnvelope,
} from "@pluginmax/contracts";
import type { PlatformRepositories } from "@pluginmax/database";
import {
  ExecutionGateError,
  ExecutionGateService,
} from "./execution-gate.js";
import { executionEnvelopeDigest } from "./task-execution-preflight.js";

function fixture() {
  const now = new Date("2026-10-27T00:00:00.000Z");
  const runId = randomUUID();
  const ticketId = randomUUID();
  const principalId = "local-admin";
  const taskId = randomUUID();
  const noDigest: Omit<RunExecutionEnvelope, "digest"> = {
    schemaVersion: 1,
    id: "run-envelope-gate-fixture",
    contextType: "task",
    contextId: taskId,
    projectId: null,
    principalId,
    agentId: "00000000-0000-4000-8000-000000000001",
    agentPrincipalId: null,
    authorization: {
      scope: "self",
      grantIds: [],
      effectivePermissions: ["read", "write"],
      membershipId: null,
      authSource: "local-development",
    },
    policy: {
      id: null,
      revision: 0,
      version: "legacy-task-execution-policy-v1",
      contextType: "task",
      contextId: taskId,
      source: "legacy",
      policy: legacyTaskExecutionPolicy(),
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
          fileRead: "unsupported",
          fileWrite: "unsupported",
          shell: "unsupported",
          browser: "unsupported",
          mcp: "unsupported",
          sessionResume: "unsupported",
          structuredPlan: "supported",
          structuredToolEvents: "supported",
          structuredSubagent: "unsupported",
        },
        toolCategories: [],
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
      id: "execution-envelope-gate-fixture",
      taskId,
      runId,
      workspaceId: "direct-chat/fixture",
      principalId,
      runtimeId: "builtin:fake",
      adapterId: "fake",
      runtimeRevision: "1",
      policyVersion: "legacy-task-execution-policy-v1",
      ticketId,
      resolved: {
        searchEnabled: false,
        networkAccess: "none",
        allowedToolCategories: [],
        approvalToolCategories: [],
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
  const executionEnvelope: RunExecutionEnvelope = {
    ...noDigest,
    digest: executionEnvelopeDigest(noDigest),
  };
  const run: Run = {
    id: runId,
    projectId: null,
    taskId: null,
    meetingTurnId: null,
    directChatTurnId: null,
    agentId: "00000000-0000-4000-8000-000000000001",
    taskExecutionKind: "owner",
    taskTriggerMessageId: null,
    status: "queued",
    contextPackId: null,
    inputSnapshot: {
      taskTitle: "fixture",
      taskDescription: "fixture",
      acceptance: [],
      instruction: "fixture",
      agentName: "Fake",
      runtimeKind: "fake",
    },
    executionSnapshot: null,
    executionEnvelope,
    externalRuntimeId: null,
    externalRuntimeRevision: null,
    externalRuntimeProvider: null,
    externalRuntimeProtocol: null,
    externalSessionId: null,
    externalRuntimeVersion: null,
    externalStartedAt: null,
    output: null,
    error: null,
    attempt: 1,
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
    startedAt: null,
    endedAt: null,
    updatedAt: now.toISOString(),
  };
  const ticket: ActionTicket = {
    schemaVersion: 1,
    ticketId,
    ticketVersion: 1,
    principalId,
    workspaceId: "direct-chat/fixture",
    contextType: "task",
    contextId: taskId,
    taskId,
    runId,
    allowedActions: ["agent.execute", "task.writeback"],
    deniedActions: [],
    resourceScopes: [
      `run:${runId}`,
      "workspace:direct-chat/fixture",
      `context:task:${taskId}`,
    ],
    policyId: null,
    policyRevision: 0,
    envelopeId: executionEnvelope.id,
    envelopeDigest: executionEnvelope.digest,
    authorizationSnapshot: {
      scope: "self",
      principalId,
      grantIds: [],
      effectivePermissions: ["read", "write"],
      membershipId: null,
    },
    executionEnvelope,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    issuedBy: principalId,
  };
  return { now, run, ticket };
}

function repositories(input: {
  readonly run: Run;
  readonly ticket?: ActionTicket;
  readonly gates?: readonly ExecutionGateRecord[];
  readonly principalStatus?: "active" | "suspended" | "archived";
}) {
  return {
    runs: { get: vi.fn(async () => input.run) },
    actionTickets: {
      getByRun: vi.fn(async () => input.ticket),
      listGatesByRun: vi.fn(async () => input.gates ?? []),
      getUsage: vi.fn(async () => undefined),
      beginUsage: vi.fn(),
      completeUsage: vi.fn(),
    },
    authorization: {
      getPrincipal: vi.fn(async () => ({
        id: "local-admin",
        kind: "human" as const,
        displayName: "Local Admin",
        status: input.principalStatus ?? ("active" as const),
        statusAuthority: "system" as const,
        source: "local" as const,
        accountId: null,
        accountStatus: null,
      })),
      authorizeProject: vi.fn(),
    },
    taskExecutionPolicies: {
      getRevision: vi.fn(),
    },
    directChats: {
      canAccessRun: vi.fn(async () => true),
    },
  } as unknown as PlatformRepositories;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "allowed";
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionGateError);
    return (error as ExecutionGateError).code;
  }
}

describe("ExecutionGateService ticket validation", () => {
  it("fails closed without a ticket and rejects an expired ticket", async () => {
    const { run, ticket, now } = fixture();
    expect(
      await codeOf(
        new ExecutionGateService(repositories({ run })).assertRunAction({
          runId: run.id,
          action: "agent.execute",
        }),
      ),
    ).toBe("action_ticket_missing");

    const service = new ExecutionGateService(repositories({ run, ticket }), {
      now: () => new Date(now.getTime() + 61_000),
    });
    expect(
      await codeOf(
        service.assertRunAction({
          runId: run.id,
          action: "agent.execute",
        }),
      ),
    ).toBe("action_ticket_expired");
  });

  it("binds context, policy revision and the immutable envelope snapshot", async () => {
    const { run, ticket } = fixture();
    expect(
      await codeOf(
        new ExecutionGateService(
          repositories({
            run,
            ticket: { ...ticket, contextType: "meeting" },
          }),
        ).assertRunAction({ runId: run.id, action: "agent.execute" }),
      ),
    ).toBe("ticket_context_mismatch");

    expect(
      await codeOf(
        new ExecutionGateService(
          repositories({
            run,
            ticket: { ...ticket, policyRevision: 1 },
          }),
        ).assertRunAction({ runId: run.id, action: "agent.execute" }),
      ),
    ).toBe("ticket_policy_revision_mismatch");

    expect(
      await codeOf(
        new ExecutionGateService(
          repositories({
            run,
            ticket: {
              ...ticket,
              executionEnvelope: {
                ...ticket.executionEnvelope,
                createdAt: new Date().toISOString(),
              },
            },
          }),
        ).assertRunAction({ runId: run.id, action: "agent.execute" }),
      ),
    ).toBe("ticket_envelope_snapshot_mismatch");
  });

  it("applies deny-wins, active Principal and blocking Gate decisions", async () => {
    const { run, ticket, now } = fixture();
    expect(
      await codeOf(
        new ExecutionGateService(
          repositories({
            run,
            ticket: { ...ticket, deniedActions: ["task.writeback"] },
          }),
        ).assertRunAction({ runId: run.id, action: "task.writeback" }),
      ),
    ).toBe("action_ticket_denied");

    expect(
      await codeOf(
        new ExecutionGateService(
          repositories({
            run,
            ticket,
            principalStatus: "suspended",
          }),
          { now: () => now },
        ).assertRunAction({ runId: run.id, action: "agent.execute" }),
      ),
    ).toBe("principal_not_active");

    const gate: ExecutionGateRecord = {
      gateId: randomUUID(),
      ticketId: ticket.ticketId,
      runId: run.id,
      taskId: ticket.taskId,
      projectId: null,
      gateKey: "blocking-fixture",
      kind: "preflight",
      enforcement: "blocking",
      reason: "Blocking gate fixture",
      requestedToolCategory: null,
      requestedSourceClass: null,
      resourceScopes: [...ticket.resourceScopes],
      policyId: null,
      policyRevision: 0,
      envelopeId: ticket.envelopeId,
      envelopeDigest: ticket.envelopeDigest,
      requestedByPrincipalId: ticket.principalId,
      requestedAt: ticket.issuedAt,
      expiresAt: ticket.expiresAt,
      status: "pending",
      decision: null,
    };
    expect(
      await codeOf(
        new ExecutionGateService(
          repositories({ run, ticket, gates: [gate] }),
          { now: () => now },
        ).assertRunAction({ runId: run.id, action: "agent.execute" }),
      ),
    ).toBe("execution_gate_waiting");
    expect(
      await codeOf(
        new ExecutionGateService(
          repositories({
            run,
            ticket,
            gates: [{ ...gate, status: "denied" }],
          }),
          { now: () => now },
        ).assertRunAction({ runId: run.id, action: "agent.execute" }),
      ),
    ).toBe("execution_gate_denied");
    expect(
      await codeOf(
        new ExecutionGateService(
          repositories({
            run,
            ticket,
            gates: [
              {
                ...gate,
                enforcement: "non-blocking",
                status: "denied",
              },
            ],
          }),
          { now: () => now },
        ).assertRunAction({ runId: run.id, action: "agent.execute" }),
      ),
    ).toBe("execution_gate_denied");
  });
});
