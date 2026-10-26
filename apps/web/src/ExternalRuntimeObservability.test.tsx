import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  agentRuntimeBindingDetailSchema,
  emptyExternalRuntimeCapabilitySet,
  runSchema,
  type ExternalRuntime,
} from "@pluginmax/contracts";
import {
  PreflightFeedback,
  RunExternalRuntimePanel,
  RuntimeAvailabilityNotice,
  RuntimeBindingSummary,
  runtimeAvailability,
} from "./ExternalRuntimeObservability.js";

const runtimeId = "13000000-0000-4000-8000-000000000001";
const agentId = "13000000-0000-4000-8000-000000000002";
const bindingId = "13000000-0000-4000-8000-000000000003";
const runId = "13000000-0000-4000-8000-000000000004";
const now = "2026-10-26T08:00:00.000Z";
const digest = "a".repeat(64);

const runtime: ExternalRuntime = {
  id: runtimeId,
  name: "Fixture plain runtime",
  provider: "command",
  protocol: "plain-text",
  command: "/usr/local/bin/node",
  managedArgs: ["fixture.mjs"],
  customArgs: ["plain", "success"],
  supportedModels: [],
  defaultModel: null,
  contextWindowTokens: null,
  supportedTools: [],
  networkMode: "restricted",
  sandboxMode: "read-only",
  status: "active",
  visibility: "owner",
  ownerId: "local-admin",
  revision: 2,
  commandDigest: digest,
  argsDigest: digest,
  lastProbe: {
    id: "13000000-0000-4000-8000-000000000005",
    runtimeRevision: 2,
    status: "passed",
    ok: true,
    message: "v24.0.0",
    exitCode: 0,
    timedOut: false,
    requestedAt: now,
    startedAt: now,
    completedAt: now,
  },
  bindingCount: 1,
  activeBindingCount: 1,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
};

const binding = {
  id: bindingId,
  agentId,
  runtimeId,
  executionMode: "external",
  status: "active",
  revision: 1,
  boundBy: "local-admin",
  disabledBy: null,
  disabledReason: null,
  createdAt: now,
  updatedAt: now,
  disabledAt: null,
} as const;

const capability = emptyExternalRuntimeCapabilitySet("unknown");

describe("external runtime GUI components", () => {
  it("renders stable unavailable reasons for failed probes and archived bindings", () => {
    const baseProbe = runtime.lastProbe!;
    const failedRuntime: ExternalRuntime = {
      ...runtime,
      status: "disabled",
      lastProbe: {
        ...baseProbe,
        status: "failed",
        ok: false,
        message: "fixture probe failed",
      },
    };
    expect(runtimeAvailability(failedRuntime).reason).toContain("Probe");

    const disabledBinding = agentRuntimeBindingDetailSchema.parse({
      agentId,
      binding: {
        ...binding,
        status: "disabled",
        revision: 2,
        disabledBy: "local-admin",
        disabledReason: "runtime archived",
        disabledAt: now,
      },
      runtime: {
        ...runtime,
        status: "archived",
        archivedAt: now,
        revision: 3,
      },
    });
    const markup = renderToStaticMarkup(
      <RuntimeBindingSummary
        detail={disabledBinding}
        runtimeKind="plain-text"
      />,
    );
    expect(markup).toContain("Disabled");
    expect(markup).toContain("Runtime 已归档");
    expect(markup).toContain("Agent.runtime_kind=plain-text");
  });

  it("renders Preflight failure code and actionable remediation", () => {
    const markup = renderToStaticMarkup(
      <PreflightFeedback
        result={null}
        failure={{
          code: "runtime_capability_missing",
          message: "The runtime does not satisfy required capabilities",
          remediation: "Select a runtime with structured plan support.",
        }}
      />,
    );
    expect(markup).toContain("runtime_capability_missing");
    expect(markup).toContain("Select a runtime with structured plan support.");
  });

  it("renders plain-text Run observability as final-only without reasoning", () => {
    const run = runSchema.parse({
      id: runId,
      projectId: null,
      taskId: "13000000-0000-4000-8000-000000000006",
      meetingTurnId: null,
      directChatTurnId: null,
      agentId,
      status: "completed",
      contextPackId: null,
      inputSnapshot: {
        taskTitle: "Plain fixture",
        taskDescription: "Verify final-only rendering",
        acceptance: [],
        instruction: "Return final text",
        agentName: "Fixture agent",
        runtimeKind: "plain-text",
      },
      executionSnapshot: {
        schemaVersion: 1,
        runtime: {
          id: runtimeId,
          name: runtime.name,
          revision: 2,
          provider: "command",
          protocol: "plain-text",
          command: runtime.command,
          managedArgs: runtime.managedArgs,
          customArgs: runtime.customArgs,
          supportedModels: [],
          defaultModel: null,
          sandboxMode: "read-only",
          networkMode: "restricted",
          commandDigest: digest,
          argsDigest: digest,
        },
        binding: { id: bindingId, revision: 1 },
        capabilitySnapshotId: "13000000-0000-4000-8000-000000000007",
        capability: {
          schemaVersion: 1,
          runtimeId,
          runtimeRevision: "2",
          adapterId: "plain-text",
          provider: "command",
          protocol: "plain-text",
          capabilities: {
            ...capability,
            structuredPlan: "unsupported",
            structuredToolEvents: "unsupported",
          },
          toolCategories: [],
          networkModes: ["restricted"],
          gateEnforcement: "blocking",
          limits: {},
          provenance: {
            adapter: true,
            probe: true,
            config: true,
            observedInRuns: false,
          },
          capturedAt: now,
        },
        envelope: {
          schemaVersion: 1,
          id: "preflight-fixture",
          taskId: "fixture-task",
          workspaceId: "agent/preflight",
          principalId: "local-admin",
          runtimeId,
          adapterId: "plain-text",
          runtimeRevision: "2",
          policyVersion: "external-runtime-preflight-v1",
          resolved: {
            searchEnabled: false,
            networkAccess: "restricted",
            allowedToolCategories: [],
            approvalToolCategories: [],
            deniedToolCategories: [],
            sandbox: "read-only",
            gateEnforcement: "blocking",
            planVisibility: "opaque",
          },
          launch: {
            provider: "command",
            authMode: "cli",
          },
          unresolved: [],
          createdAt: now,
        },
        capturedAt: now,
      },
      externalRuntimeId: runtimeId,
      externalRuntimeRevision: 2,
      externalRuntimeProvider: "command-fixture",
      externalRuntimeProtocol: "plain-text",
      externalSessionId: "plain-session-fixture",
      externalRuntimeVersion: "1.0.0-fixture",
      externalStartedAt: now,
      output: "PLAIN: final output",
      error: null,
      attempt: 1,
      timeoutAt: null,
      workflowInstanceId: null,
      workflowNodeId: null,
      traceId: null,
      traceRootSpanId: null,
      observability: {
        planVisibility: "opaque",
        toolEventCompleteness: "none",
        textStreaming: "final-only",
        subagentVisibility: "none",
      },
      createdAt: now,
      startedAt: now,
      endedAt: now,
      updatedAt: now,
    });
    const markup = renderToStaticMarkup(
      <RunExternalRuntimePanel
        run={run}
        events={[
          {
            id: "13000000-0000-4000-8000-000000000008",
            runId,
            seq: 1,
            type: "progress.summary",
            visibility: "public",
            summary: "Provider progress summary",
            data: { reasoning: "PRIVATE_REASONING_MUST_NOT_LEAK" },
            traceId: null,
            spanId: null,
            parentSpanId: null,
            createdAt: now,
          },
        ]}
      />,
    );
    expect(markup).toContain("final-only");
    expect(markup).toContain("plain-session-fixture");
    expect(markup).toContain("Binding r1");
    expect(markup).not.toContain("PRIVATE_REASONING_MUST_NOT_LEAK");
  });

  it("renders a capability snapshot and its revision in the Runtime notice", () => {
    const markup = renderToStaticMarkup(
      <RuntimeAvailabilityNotice
        runtime={runtime}
        capability={{
          id: "13000000-0000-4000-8000-000000000009",
          runtimeId,
          runtimeRevision: 2,
          probeId: runtime.lastProbe!.id,
          adapterProfile: capability,
          declaredProfile: capability,
          probeProfile: capability,
          effectiveProfile: capability,
          capturedAt: now,
        }}
      />,
    );
    expect(markup).toContain("可参与 Preflight");
    expect(markup).toContain("Cap r2");
  });
});
