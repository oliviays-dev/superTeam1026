import { describe, expect, it } from "vitest";
import {
  actionTicketSchema,
  createDelegationInputSchema,
  delegationActionCheckResultSchema,
} from "./index.js";

describe("delegation contracts", () => {
  it("defaults to a bounded suggest-only representative", () => {
    const delegation = createDelegationInputSchema.parse({
      displayName: "Alice task representative",
      representativeKind: "ai",
      representativeAgentId: "00000000-0000-4000-8000-000000000020",
      contextType: "task",
      contextId: "00000000-0000-4000-8000-000000000021",
      objective: "Review the task and report risks to Alice.",
      expiresAt: "2026-11-01T10:00:00.000Z",
    });

    expect(delegation.approvalPolicy).toBe("suggest-only");
    expect(delegation.autoParticipation).toBe("mentions");
    expect(delegation.allowedActions).toContain("read_context");
    expect(delegation.allowedActions).not.toContain("approve");
    expect(delegation.deniedActions).toContain("approve");
    expect(delegation.deniedActions).toContain("delete");
  });

  it("rejects approval actions unless rules may execute automatically", () => {
    const result = createDelegationInputSchema.safeParse({
      displayName: "Unsafe approval avatar",
      representativeKind: "human",
      representativePrincipalId: "principal-human-representative",
      contextType: "workflow_node",
      contextId: "00000000-0000-4000-8000-000000000021:review",
      objective: "Approve the workflow node.",
      allowedActions: ["read_context", "approve"],
      deniedActions: [],
      approvalPolicy: "require-confirmation",
      expiresAt: "2026-11-01T10:00:00.000Z",
    });

    expect(result.success).toBe(false);
  });

  it("keeps legacy Action Tickets valid while allowing Delegation binding", () => {
    expect(actionTicketSchema.shape.delegation.isOptional()).toBe(true);
  });

  it("models owner-confirmation results explicitly", () => {
    expect(
      delegationActionCheckResultSchema.parse({
        allowed: true,
        action: "approve",
        effectiveRevision: 3,
        approvalPolicy: "require-confirmation",
        requiresConfirmation: true,
        reason: "delegation_approval_required",
        ownerPermissions: ["read", "write", "approve"],
      }),
    ).toMatchObject({ requiresConfirmation: true });
  });
});
