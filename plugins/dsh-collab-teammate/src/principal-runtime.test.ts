import { describe, expect, it } from "vitest";
import {
  PrincipalRuntimeService,
  principalRuntimeDomainSpec,
  type PrincipalActionTicket,
  type PrincipalRuntimeProfile,
  type PrincipalRuntimeTable,
} from "./principal-runtime.js";

class Table<V> implements PrincipalRuntimeTable<V> {
  readonly records = new Map<string, V>();

  get(key: string): V | undefined {
    return this.records.get(key);
  }

  entries(): IterableIterator<[string, V]> {
    return this.records.entries();
  }

  async put(key: string, value: V): Promise<void> {
    this.records.set(key, value);
  }
}

function setup() {
  const principals = new Map<
    string,
    {
      id: string;
      kind: "human" | "ai";
      status: "active" | "suspended" | "archived";
    }
  >();
  const grants: Array<{
    principalId: string;
    scopeType: "workspace";
    scopeId: string;
    role: string;
    permissions: readonly string[];
    status: "active" | "revoked" | "expired";
  }> = [];
  let sequence = 0;
  const service = new PrincipalRuntimeService(
    {
      profiles: new Table<PrincipalRuntimeProfile>(),
      tickets: new Table<PrincipalActionTicket>(),
    },
    () => ({
      get: (principalId) => {
        const principal = principals.get(principalId);
        if (principal === undefined) throw new Error("principal not found");
        return principal;
      },
      syncPrincipal: async (input) => {
        const principal = {
          id: `principal-ai-${input.subjectId}`,
          kind: "ai" as const,
          status: "active" as const,
        };
        principals.set(principal.id, principal);
        return principal;
      },
      syncExclusiveGrant: async (input) => {
        const grant = {
          principalId: input.principalId,
          scopeType: "workspace" as const,
          scopeId: input.scopeId,
          role: input.role,
          permissions: input.permissions,
          status: "active" as const,
        };
        grants.push(grant);
        return grant;
      },
      grants: (principalId?: string) =>
        grants.filter(
          (grant) =>
            principalId === undefined || grant.principalId === principalId,
        ),
    }),
    {
      now: () => new Date("2026-10-17T08:00:00.000Z"),
      randomId: () => `id-${String(++sequence)}`,
    },
  );
  return { service, principals, grants };
}

describe("Principal Runtime", () => {
  it("owns a runtime profile without an Employee record", async () => {
    const { service } = setup();
    const principal = await service.ensureTeammatePrincipal({
      teammateId: "tm-1",
      displayName: "Research AI",
    });
    const profile = await service.ensureProfile({
      principalId: principal.id,
      workspaceId: "workspace-1",
      name: "Research AI",
      personaId: "persona-tm-1",
      agentProfileId: "agent-1",
      execution: "builtin",
      allowedTools: ["read"],
      createdByUserId: "olivia",
    });

    expect(profile).toMatchObject({
      principalId: "principal-ai-tm-1",
      workspaceId: "workspace-1",
      agentProfileId: "agent-1",
      status: "active",
    });
    expect(service.profile(principal.id, "workspace-1")?.id).toBe(profile.id);
  });

  it("issues and authorizes Principal Action Tickets against runtime grants", async () => {
    const { service } = setup();
    const principal = await service.ensureTeammatePrincipal({
      teammateId: "tm-2",
      displayName: "Builder AI",
    });
    await service.ensureProfile({
      principalId: principal.id,
      workspaceId: "workspace-1",
      name: "Builder AI",
      agentProfileId: "agent-2",
      execution: "builtin",
      allowedTools: [],
      createdByUserId: "olivia",
    });
    const ticket = await service.issueTicket({
      principalId: principal.id,
      workspaceId: "workspace-1",
      contextType: "workflow",
      contextId: "workflow-1",
      requestedActions: ["read", "write", "approve"],
      resourceScopes: ["workflow/workflow-1/node-1"],
      issuedByUserId: "olivia",
    });

    expect(ticket).toMatchObject({
      principalId: principal.id,
      allowedActions: ["read", "write"],
      deniedActions: ["approve"],
      status: "active",
    });
    await expect(
      service.authorizeTicket({
        ticketId: ticket.id,
        action: "write",
        resource: "workflow/workflow-1/node-1/output",
        workspaceId: "workspace-1",
        contextType: "workflow",
        contextId: "workflow-1",
      }),
    ).resolves.toEqual({ principalId: principal.id });
    await expect(
      service.authorizeTicket({
        ticketId: ticket.id,
        action: "write",
        resource: "workflow/other/output",
        workspaceId: "workspace-1",
        contextType: "workflow",
        contextId: "workflow-1",
      }),
    ).rejects.toThrow("resource is outside the ticket scope");
  });

  it("declares its storage domain", () => {
    expect(principalRuntimeDomainSpec).toMatchObject({
      name: "collab_principal_runtime",
      version: 1,
    });
  });
});
