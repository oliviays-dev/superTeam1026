import { describe, expect, it } from "vitest";
import type {
  AuthorizationAuditInput,
  AuthorizationRepository,
  ScopeAuthorizationDecision,
} from "@pluginmax/database";
import {
  AuthorizationService,
  type AuthorizedRequestPrincipal,
} from "./authorization.js";

const principal: AuthorizedRequestPrincipal = {
  principalId: "principal-human-application-test",
  displayName: "Application Test",
  kind: "human",
  authSource: "bearer",
  accountId: "account-application-test",
  sessionId: "00000000-0000-4000-8000-000000000123",
};

function allowedDecision(
  scopeType: ScopeAuthorizationDecision["scopeType"],
  scopeId: string,
  permission: ScopeAuthorizationDecision["permission"],
): ScopeAuthorizationDecision {
  return {
    allowed: true,
    principal: {
      id: principal.principalId,
      kind: "human",
      displayName: principal.displayName,
      status: "active",
      statusAuthority: "account",
      source: "account",
      accountId: principal.accountId!,
      accountStatus: "active",
    },
    scopeType,
    scopeId,
    permission,
    grantIds: [`grant-${scopeType}`],
    effectivePermissions: [permission],
    grantSource: "grant",
  };
}

describe("authorization route policy", () => {
  it("maps platform routes to platform.manage and fails future writes closed", async () => {
    const calls: string[] = [];
    const repository = {
      authorizePlatform: async (input: { permission?: string }) => {
        calls.push(input.permission ?? "platform.manage");
        return allowedDecision("platform", "platform", "platform.manage");
      },
      audit: async (_input: AuthorizationAuditInput) => undefined,
    } as unknown as AuthorizationRepository;
    const service = new AuthorizationService(repository);

    const result = await service.authorizeRoute({
      requestId: "request-platform",
      method: "POST",
      route: "/api/v1/future-sensitive-action",
      principal,
      params: {},
      body: {},
    });
    expect(result).toMatchObject({ required: true, allowed: true });
    expect(calls).toEqual(["platform.manage"]);
  });

  it("maps project role and member writes to their management permissions", async () => {
    const permissions: string[] = [];
    const repository = {
      authorizeProject: async (input: { permission: string }) => {
        permissions.push(input.permission);
        return allowedDecision(
          "project",
          "project-1",
          input.permission as ScopeAuthorizationDecision["permission"],
        );
      },
      audit: async (_input: AuthorizationAuditInput) => undefined,
    } as unknown as AuthorizationRepository;
    const service = new AuthorizationService(repository);

    await service.authorizeRoute({
      requestId: "request-role",
      method: "POST",
      route: "/api/v1/projects/:projectId/roles",
      principal,
      params: { projectId: "project-1" },
      body: {},
    });
    await service.authorizeRoute({
      requestId: "request-member",
      method: "PATCH",
      route: "/api/v1/projects/:projectId/members/:memberId",
      principal,
      params: { projectId: "project-1", memberId: "member-1" },
      body: {},
    });
    expect(permissions).toEqual(["manage_roles", "manage_members"]);
  });

  it("resolves resource ownership before authorizing a write", async () => {
    const calls: string[] = [];
    const repository = {
      projectIdForResource: async (
        resourceType: string,
        resourceId: string,
      ) => {
        calls.push(`${resourceType}:${resourceId}`);
        return "project-from-task";
      },
      authorizeProject: async (input: { projectId: string }) => {
        calls.push(`project:${input.projectId}`);
        return allowedDecision("project", input.projectId, "write");
      },
      audit: async (_input: AuthorizationAuditInput) => undefined,
    } as unknown as AuthorizationRepository;
    const service = new AuthorizationService(repository);

    const result = await service.authorizeRoute({
      requestId: "request-task",
      method: "PATCH",
      route: "/api/v1/tasks/:id",
      principal,
      params: { id: "task-1" },
      body: { title: "Updated" },
    });
    expect(result).toMatchObject({ required: true, allowed: true });
    expect(calls).toEqual(["task:task-1", "project:project-from-task"]);
  });

  it("keeps explicit self scope and direct-chat runs outside project Grants", async () => {
    const calls: string[] = [];
    const repository = {
      projectIdForResource: async () => {
        calls.push("resource");
        return null;
      },
      audit: async (_input: AuthorizationAuditInput) => undefined,
    } as unknown as AuthorizationRepository;
    const service = new AuthorizationService(repository);

    await expect(
      service.authorizeRoute({
        requestId: "request-chat",
        method: "POST",
        route: "/api/v1/direct-chats",
        principal,
        params: {},
        body: {},
      }),
    ).resolves.toEqual({ required: false });
    await expect(
      service.authorizeRoute({
        requestId: "request-run",
        method: "POST",
        route: "/api/v1/runs/:runId/cancel",
        principal,
        params: { runId: "direct-chat-run" },
        body: {},
      }),
    ).resolves.toEqual({ required: false });
    expect(calls).toEqual(["resource"]);
  });
});
