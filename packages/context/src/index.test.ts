import { describe, expect, it } from "vitest";
import type {
  SceneContextContribution,
  SceneContextReceipt,
  SceneSessionBinding,
} from "@pluginmax/contracts";
import { buildTaskContext, type SceneContextBuildInput } from "./index.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const agentId = "00000000-0000-4000-8000-000000000003";
const runId = "00000000-0000-4000-8000-000000000010";

function binding(
  overrides: Partial<SceneSessionBinding> = {},
): SceneSessionBinding {
  return {
    id: "00000000-0000-4000-8000-000000000020",
    sceneType: "task",
    sceneId: taskId,
    projectId,
    agentId,
    agentPrincipalId: agentId,
    ownerPrincipalId: null,
    channelId: null,
    sessionHandle: `de-task-${taskId}-test`,
    generation: 0,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function contribution(
  sequence: number,
  id: string,
  text: string,
): SceneContextContribution {
  return {
    id,
    sceneSessionId: binding().id,
    sceneType: "task",
    sceneId: taskId,
    projectId,
    agentId,
    agentPrincipalId: agentId,
    ownerPrincipalId: null,
    sourceKey: `comment:${id}`,
    kind: "task-comment-consensus",
    version: "1",
    authority: "evidence",
    visibility: "project",
    text,
    sourceRefs: [
      {
        type: "task-comment",
        id,
        projectId,
        sceneType: "task",
        sceneId: taskId,
      },
    ],
    sequence,
    createdBy: "local-admin",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function sceneInput(
  contributions: SceneContextContribution[],
  options: {
    readonly runtimeStateful?: boolean;
    readonly previousReceipt?: SceneContextReceipt;
    readonly binding?: SceneSessionBinding;
  } = {},
): SceneContextBuildInput {
  return {
    binding: options.binding ?? binding(),
    actorPrincipalId: "local-admin",
    contributions,
    runtimeStateful: options.runtimeStateful ?? false,
    cursorBefore: options.previousReceipt?.cursorAfter ?? 0,
    ...(options.previousReceipt === undefined
      ? {}
      : { previousReceipt: options.previousReceipt }),
  };
}

function receiptFor(
  result: ReturnType<typeof buildTaskContext>,
): SceneContextReceipt {
  return {
    id: result.receipt.id!,
    runId,
    contextPackId: result.pack.id,
    sceneSessionId: binding().id,
    sceneType: "task",
    sceneId: taskId,
    projectId,
    agentId,
    principalId: "local-admin",
    agentPrincipalId: agentId,
    logicalDigest: result.receipt.logicalDigest!,
    contentHash: result.pack.contentHash,
    rendererVersion: result.receipt.rendererVersion!,
    runtimeStateful: true,
    cursorBefore: 0,
    cursorAfter: result.receipt.cursorAfter!,
    delivered: result.receipt.deliveredContributions,
    reused: result.receipt.reusedContributions,
    sourceRefs: result.receipt.sourceRefs!,
    excluded: result.receipt.sceneExcludedSources ?? [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("buildTaskContext", () => {
  it("builds a deterministic task context pack", () => {
    const result = buildTaskContext({
      runId: "00000000-0000-4000-8000-000000000010",
      project: {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Supply Project",
        code: "SUPPLY-0001",
        description: "Supply chain project",
        status: "active",
        sourceTemplateId: null,
        sourceTemplateRevision: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      task: {
        id: "00000000-0000-4000-8000-000000000002",
        projectId: "00000000-0000-4000-8000-000000000001",
        title: "Review supplier",
        description: "Review the supplier risk.",
        acceptance: ["Provide evidence"],
        status: "queued",
        agentId: "00000000-0000-4000-8000-000000000003",
        dependsOn: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      agent: {
        id: "00000000-0000-4000-8000-000000000003",
        name: "Research Agent",
        description: "Find evidence.",
        soul: "",
        scenarios: [],
        goals: [],
        tools: [],
        runtimeKind: "fake",
        status: "active",
        source: "personal",
        ownerId: "local-admin",
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      episodes: [
        {
          id: "00000000-0000-4000-8000-000000000004",
          projectId: "00000000-0000-4000-8000-000000000001",
          agentId: "00000000-0000-4000-8000-000000000003",
          visibility: "private",
          kind: "reflection",
          summary: "Supplier evidence was reviewed",
          content: "Use the signed evidence package.",
          sourceRefs: [],
          createdBy: "00000000-0000-4000-8000-000000000003",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(result.pack.contentHash).toHaveLength(64);
    expect(result.pack.sources).toHaveLength(4);
    expect(result.pack.renderedPrompt).toContain("Review supplier");
    expect(result.pack.renderedPrompt).toContain(
      "Supplier evidence was reviewed",
    );
    expect(result.pack.sources).toContainEqual({
      type: "memory",
      id: "00000000-0000-4000-8000-000000000004",
      label: "Agent Episode: Supplier evidence was reviewed",
      projectId,
    });
    expect(result.receipt.contextPackId).toBe(result.pack.id);
  });

  it("replays the same Scene input deterministically", () => {
    const input = {
      runId,
      project: {
        id: projectId,
        name: "Supply Project",
        code: "SUPPLY-0001",
        description: "Supply chain project",
        status: "active" as const,
        sourceTemplateId: null,
        sourceTemplateRevision: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      task: {
        id: taskId,
        projectId,
        title: "Review supplier",
        description: "Review the supplier risk.",
        acceptance: ["Provide evidence"],
        status: "queued" as const,
        agentId,
        dependsOn: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      agent: {
        id: agentId,
        name: "Research Agent",
        description: "Find evidence.",
        soul: "",
        scenarios: [],
        goals: [],
        tools: [],
        runtimeKind: "fake" as const,
        status: "active" as const,
        source: "personal" as const,
        ownerId: "local-admin",
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      scene: sceneInput([
        contribution(
          1,
          "00000000-0000-4000-8000-000000000031",
          "Keep the report under 1000 words.",
        ),
      ]),
      now: new Date("2026-01-01T00:00:00.000Z"),
    };
    const first = buildTaskContext(input);
    const replay = buildTaskContext(input);

    expect(replay.pack).toEqual(first.pack);
    expect(replay.receipt).toEqual(first.receipt);
    expect(replay.pack.id).toBe(first.pack.id);
    expect(replay.pack.logicalDigest).toBe(first.pack.logicalDigest);
  });

  it("delivers only new contributions to persistent sessions", () => {
    const firstContribution = contribution(
      1,
      "00000000-0000-4000-8000-000000000041",
      "Use the approved supplier.",
    );
    const secondContribution = contribution(
      2,
      "00000000-0000-4000-8000-000000000042",
      "Exclude the withdrawn claim.",
    );
    const base = {
      project: {
        id: projectId,
        name: "Supply Project",
        code: "SUPPLY-0001",
        description: "",
        status: "active" as const,
        sourceTemplateId: null,
        sourceTemplateRevision: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      task: {
        id: taskId,
        projectId,
        title: "Review supplier",
        description: "",
        acceptance: [],
        status: "queued" as const,
        agentId,
        dependsOn: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      agent: {
        id: agentId,
        name: "Research Agent",
        description: "",
        soul: "",
        scenarios: [],
        goals: [],
        tools: [],
        runtimeKind: "fake" as const,
        status: "active" as const,
        source: "personal" as const,
        ownerId: "local-admin",
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      now: new Date("2026-01-01T00:00:00.000Z"),
    };
    const first = buildTaskContext({
      ...base,
      runId,
      scene: sceneInput([firstContribution], { runtimeStateful: true }),
    });
    const second = buildTaskContext({
      ...base,
      runId: "00000000-0000-4000-8000-000000000011",
      scene: sceneInput([firstContribution, secondContribution], {
        runtimeStateful: true,
        previousReceipt: receiptFor(first),
      }),
    });

    expect(
      second.receipt.deliveredContributions.map((item) => item.id),
    ).toEqual([secondContribution.id]);
    expect(second.receipt.reusedContributions.map((item) => item.id)).toEqual([
      firstContribution.id,
    ]);
    expect(second.pack.renderedPrompt).not.toContain(
      "Use the approved supplier.",
    );
    expect(second.pack.renderedPrompt).toContain(
      "Exclude the withdrawn claim.",
    );
  });

  it("replays all active contributions for stateless runtimes", () => {
    const firstContribution = contribution(
      1,
      "00000000-0000-4000-8000-000000000051",
      "Stable decision.",
    );
    const secondContribution = contribution(
      2,
      "00000000-0000-4000-8000-000000000052",
      "New decision.",
    );
    const result = buildTaskContext({
      runId,
      project: {
        id: projectId,
        name: "Supply Project",
        code: "SUPPLY-0001",
        description: "",
        status: "active",
        sourceTemplateId: null,
        sourceTemplateRevision: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      task: {
        id: taskId,
        projectId,
        title: "Review supplier",
        description: "",
        acceptance: [],
        status: "queued",
        agentId,
        dependsOn: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      agent: {
        id: agentId,
        name: "Research Agent",
        description: "",
        soul: "",
        scenarios: [],
        goals: [],
        tools: [],
        runtimeKind: "fake",
        status: "active",
        source: "personal",
        ownerId: "local-admin",
        version: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      scene: sceneInput([firstContribution, secondContribution], {
        runtimeStateful: false,
        previousReceipt: receiptFor(
          buildTaskContext({
            runId,
            project: {
              id: projectId,
              name: "Supply Project",
              code: "SUPPLY-0001",
              description: "",
              status: "active",
              sourceTemplateId: null,
              sourceTemplateRevision: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            task: {
              id: taskId,
              projectId,
              title: "Review supplier",
              description: "",
              acceptance: [],
              status: "queued",
              agentId,
              dependsOn: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            agent: {
              id: agentId,
              name: "Research Agent",
              description: "",
              soul: "",
              scenarios: [],
              goals: [],
              tools: [],
              runtimeKind: "fake",
              status: "active",
              source: "personal",
              ownerId: "local-admin",
              version: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            scene: sceneInput([firstContribution], {
              runtimeStateful: false,
            }),
          }),
        ),
      }),
    });

    expect(result.receipt.deliveredContributions).toHaveLength(2);
    expect(result.pack.renderedPrompt).toContain("Stable decision.");
    expect(result.pack.renderedPrompt).toContain("New decision.");
  });
});
