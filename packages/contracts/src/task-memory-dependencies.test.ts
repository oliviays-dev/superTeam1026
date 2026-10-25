import { describe, expect, it } from "vitest";
import {
  archiveTaskAttachmentInputSchema,
  createMemoryClaimInputSchema,
  createTaskInputSchema,
  createWorkflowInputSchema,
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
    expect(
      archiveTaskAttachmentInputSchema.parse({ archived: true }),
    ).toEqual({ archived: true });
  });
});
