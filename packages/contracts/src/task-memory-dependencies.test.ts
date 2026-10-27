import { describe, expect, it } from "vitest";
import {
  archiveTaskAttachmentInputSchema,
  compareTaskQueuePriority,
  createMemoryClaimInputSchema,
  createTaskInputSchema,
  createWorkflowInputSchema,
  inferDeliveryTarget,
  publishMemoryTruthInputSchema,
  uploadTaskAttachmentInputSchema,
} from "./index.js";

const projectId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const roleId = "00000000-0000-4000-8000-000000000003";
const dependencyId = "00000000-0000-4000-8000-000000000004";

describe("task dependency contracts", () => {
  it("deduplicates prerequisite ids and allows a role assignment", () => {
    expect(
      createTaskInputSchema.parse({
        projectId,
        title: "Role task",
        description: "Use a project role",
        roleId,
        dependsOn: [dependencyId, dependencyId],
      }),
    ).toMatchObject({
      roleId,
      dependsOn: [dependencyId],
    });
  });

  it("rejects selecting an agent and role together", () => {
    expect(() =>
      createTaskInputSchema.parse({
        projectId,
        title: "Conflicting assignee",
        description: "Invalid assignment",
        agentId,
        roleId,
      }),
    ).toThrow();
  });
});

describe("task execution depth contracts", () => {
  it("orders queue candidates by priority then stable creation order", () => {
    const task = (
      id: string,
      priority: "low" | "medium" | "high" | "urgent",
      createdAt: string,
    ) => ({ id, priority, createdAt });
    const tasks = [
      task("00000000-0000-4000-8000-000000000011", "low", "2026-01-01"),
      task("00000000-0000-4000-8000-000000000012", "urgent", "2026-01-02"),
      task("00000000-0000-4000-8000-000000000013", "high", "2026-01-03"),
    ].sort(compareTaskQueuePriority);
    expect(tasks.map((item) => item.priority)).toEqual([
      "urgent",
      "high",
      "low",
    ]);
  });

  it("infers receiver, collaborator, and broadcast delivery targets", () => {
    const receiver = "00000000-0000-4000-8000-000000000021";
    const collaborator = "00000000-0000-4000-8000-000000000022";
    expect(
      inferDeliveryTarget({ assigneeAgentId: receiver, mentions: [] }),
    ).toBe("receiver");
    expect(
      inferDeliveryTarget({
        assigneeAgentId: receiver,
        mentions: [collaborator],
      }),
    ).toBe("collaborators");
    expect(
      inferDeliveryTarget({
        assigneeAgentId: receiver,
        mentions: [receiver, collaborator],
      }),
    ).toBe("broadcast");
    expect(
      inferDeliveryTarget({
        assigneeAgentId: receiver,
        mentions: [collaborator],
        explicit: "receiver",
      }),
    ).toBe("receiver");
  });
});

describe("structured memory contracts", () => {
  it("applies claim source defaults and requires truth content", () => {
    expect(
      createMemoryClaimInputSchema.parse({ content: "Evidence-backed claim" }),
    ).toMatchObject({ sourceType: "manual", sourceId: "local-admin" });
    expect(() =>
      publishMemoryTruthInputSchema.parse({ claimIds: [] }),
    ).toThrow();
  });
});

describe("workflow role contracts", () => {
  it("requires role ids to align with steps", () => {
    expect(() =>
      createWorkflowInputSchema.parse({
        projectId,
        name: "Role workflow",
        stepNames: ["one", "two"],
        stepRoleIds: [roleId],
      }),
    ).toThrow();
  });
});

describe("task collaboration contracts", () => {
  it("defaults attachment mime type and validates archive state", () => {
    expect(
      uploadTaskAttachmentInputSchema.parse({
        name: "evidence.txt",
        contentBase64: "ZXZpZGVuY2U=",
      }),
    ).toMatchObject({ mimeType: "application/octet-stream" });
    expect(archiveTaskAttachmentInputSchema.parse({ archived: true })).toEqual({
      archived: true,
    });
  });
});
