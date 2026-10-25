import { describe, expect, it } from "vitest";
import {
  createProjectMemberInputSchema,
  updateProjectMemberInputSchema,
} from "./collaboration.js";

const agentId = "00000000-0000-4000-8000-000000000001";
const roleId = "00000000-0000-4000-8000-000000000101";

describe("project member contracts", () => {
  it("requires an agent id for agent members", () => {
    expect(() =>
      createProjectMemberInputSchema.parse({ kind: "agent" }),
    ).toThrow("agentId is required");
  });

  it("does not accept an agent id for human members", () => {
    expect(() =>
      createProjectMemberInputSchema.parse({
        kind: "human",
        agentId,
      }),
    ).toThrow("agentId is only valid");
  });

  it("deduplicates role assignments", () => {
    const input = createProjectMemberInputSchema.parse({
      kind: "agent",
      agentId,
      roleIds: [roleId, roleId],
    });
    expect(input.roleIds).toEqual([roleId]);
  });

  it("allows clearing every role from an existing member", () => {
    expect(
      updateProjectMemberInputSchema.parse({ roleIds: [] }).roleIds,
    ).toEqual([]);
  });
});
