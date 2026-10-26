import { describe, expect, it } from "vitest";
import { buildTaskContext } from "./index.js";

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
    });
    expect(result.receipt.contextPackId).toBe(result.pack.id);
  });
});
