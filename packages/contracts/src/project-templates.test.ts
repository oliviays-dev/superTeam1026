import { describe, expect, it } from "vitest";
import {
  createProjectInputSchema,
  createProjectTemplateInputSchema,
  updateProjectTemplateInputSchema,
  workflowTemplateDefinitionSchema,
} from "./index.js";

const roleA = "00000000-0000-4000-8000-000000000101";
const roleB = "00000000-0000-4000-8000-000000000102";
const workflowA = "00000000-0000-4000-8000-000000000201";
const workflowB = "00000000-0000-4000-8000-000000000202";

describe("project template contracts", () => {
  it("deduplicates roles, workflow refs and selected actors", () => {
    const input = createProjectTemplateInputSchema.parse({
      name: "Platform delivery",
      code: "TPL-PLATFORM",
      roleIds: [roleA, roleB, roleA],
      ownerRoleId: roleA,
      workflowTemplates: [
        { workflowTemplateId: workflowA, expectedVersion: 1 },
        { workflowTemplateId: workflowB, expectedVersion: 2 },
        { workflowTemplateId: workflowA, expectedVersion: 1 },
      ],
      accessPolicy: "selected-members",
      allowedActorIds: ["olivia", "olivia", "reviewer"],
    });
    expect(input.roleIds).toEqual([roleA, roleB]);
    expect(input.workflowTemplates).toHaveLength(2);
    expect(input.allowedActorIds).toEqual(["olivia", "reviewer"]);
  });

  it("requires the owner role to be part of the role set", () => {
    expect(() =>
      createProjectTemplateInputSchema.parse({
        name: "Invalid owner",
        code: "TPL-OWNER",
        roleIds: [roleA],
        ownerRoleId: roleB,
      }),
    ).toThrow("ownerRoleId must be included");
  });

  it("requires grants for selected-member templates", () => {
    expect(() =>
      createProjectTemplateInputSchema.parse({
        name: "Private template",
        code: "TPL-PRIVATE",
        accessPolicy: "selected-members",
        allowedActorIds: [],
      }),
    ).toThrow("require at least one actor");
  });

  it("allows an empty template and a revision-checked update", () => {
    const input = createProjectTemplateInputSchema.parse({
      name: "Empty template",
      code: "TPL-EMPTY",
      roleIds: [],
      workflowTemplates: [],
    });
    expect(input.roles).toBeUndefined();
    expect(input.roleIds).toEqual([]);
    expect(
      updateProjectTemplateInputSchema.parse({
        expectedRevision: 3,
        name: "Renamed",
      }).expectedRevision,
    ).toBe(3);
  });

  it("keeps legacy project creation compatible and accepts materialization keys", () => {
    expect(createProjectInputSchema.parse({ name: "Legacy" })).toMatchObject({
      name: "Legacy",
      description: "",
    });
    expect(
      createProjectInputSchema.parse({
        name: "From template",
        templateId: roleA,
        materializationKey: "request-20261026-001",
      }),
    ).toMatchObject({
      templateId: roleA,
      materializationKey: "request-20261026-001",
    });
  });

  it("validates workflow template role references", () => {
    expect(
      workflowTemplateDefinitionSchema.parse({
        steps: [
          { name: "Plan", kind: "human" },
          { name: "Deliver", kind: "agent", roleCode: "IMPLEMENTER" },
        ],
      }).steps,
    ).toHaveLength(2);
    expect(() =>
      workflowTemplateDefinitionSchema.parse({
        steps: [{ name: "Invalid", roleCode: "bad-code" }],
      }),
    ).toThrow();
  });
});
