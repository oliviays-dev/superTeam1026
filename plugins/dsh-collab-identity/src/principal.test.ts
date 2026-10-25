import { describe, expect, it } from "vitest";
import {
  PrincipalService,
  principalIdFor,
  type PrincipalGrant,
  type PrincipalLinkRecord,
  type PrincipalRecord,
  type PrincipalTableLike,
} from "./principal.js";

class Table<V> implements PrincipalTableLike<V> {
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

function service() {
  const principals = new Table<PrincipalRecord>();
  const links = new Table<PrincipalLinkRecord>();
  const grants = new Table<PrincipalGrant>();
  let sequence = 0;
  return {
    principals,
    links,
    grants,
    service: new PrincipalService(
      { principals, links, grants },
      {
        now: () => new Date("2026-10-17T08:00:00.000Z"),
        randomId: () => `grant-${String(++sequence)}`,
      },
    ),
  };
}

describe("principal foundation", () => {
  it("maps an auth user and its Human Employee to one Principal", async () => {
    const { service: principals, principals: principalTable } = service();
    await principals.syncAuthUser({ id: "olivia", name: "Olivia" });
    await principals.syncEmployee({
      employeeId: "human-olivia",
      kind: "human",
      displayName: "Olivia Yang",
      status: "active",
      authUserId: "olivia",
    });

    const byUser = principals.resolveSubject("auth-user", "olivia");
    const byEmployee = principals.resolveSubject("employee", "human-olivia");
    expect(byUser?.id).toBe(principalIdFor("human", "olivia"));
    expect(byEmployee?.id).toBe(byUser?.id);
    expect(principalTable.records.size).toBe(1);
    expect(byEmployee).toMatchObject({
      kind: "human",
      displayName: "Olivia Yang",
      status: "active",
    });
  });

  it("maps an AI Employee and its companion to one AI Principal", async () => {
    const { service: principals } = service();
    await principals.syncEmployee({
      employeeId: "ai-planner",
      kind: "digital",
      displayName: "Supply Planner",
      status: "active",
    });
    await principals.syncCompanion({
      teammateId: "tm-planner",
      employeeId: "ai-planner",
      displayName: "AI Supply Planner",
    });

    const byEmployee = principals.resolveSubject("employee", "ai-planner");
    const byCompanion = principals.resolveSubject("teammate", "tm-planner");
    expect(byEmployee?.id).toBe(principalIdFor("ai", "ai-planner"));
    expect(byCompanion?.id).toBe(byEmployee?.id);
    expect(byCompanion).toMatchObject({
      kind: "ai",
      displayName: "AI Supply Planner",
      source: "ai-companion",
    });
    expect(
      principals.resolveReference("principal:principal-ai-ai-planner")?.id,
    ).toBe(byEmployee?.id);
    expect(principals.resolveReference("employee:ai-planner")?.id).toBe(
      byEmployee?.id,
    );
    expect(principals.resolveReference("teammate:tm-planner")?.id).toBe(
      byEmployee?.id,
    );
    expect(principals.preferredSubjectId(byEmployee!.id, ["teammate"])).toBe(
      "tm-planner",
    );
  });

  it("keeps Principal grants independent from account credentials", async () => {
    const { service: principals, grants } = service();
    await principals.syncAuthUser({ id: "olivia", name: "Olivia" });
    const principal = principals.resolveSubject("auth-user", "olivia")!;
    const grant = await principals.assignGrant({
      principalId: principal.id,
      scopeType: "project",
      scopeId: "project-alpha",
      role: "Builder",
      permissions: ["read", "write"],
    });
    expect(grants.get(grant.id)).toMatchObject({
      principalId: principal.id,
      status: "active",
      permissions: ["read", "write"],
    });
    expect(principals.grants(principal.id)).toHaveLength(1);
    expect((await principals.revokeGrant(grant.id)).status).toBe("revoked");
  });

  it("maps employee lifecycle to Principal status without changing its id", async () => {
    const { service: principals } = service();
    const active = await principals.syncEmployee({
      employeeId: "ai-worker",
      kind: "digital",
      displayName: "Worker",
      status: "active",
    });
    const archived = await principals.syncEmployee({
      employeeId: "ai-worker",
      kind: "digital",
      displayName: "Worker",
      status: "archived",
    });
    expect(archived.id).toBe(active.id);
    expect(archived.status).toBe("archived");
    expect(
      principals.resolveSubject("employee", "ai-worker")?.status,
    ).toBe("archived");
  });

  it("suspends a Human Principal when its login account or employee is disabled", async () => {
    const { service: principals } = service();
    await principals.syncAuthUser({
      id: "olivia",
      name: "Olivia",
      status: "disabled",
    });
    expect(
      principals.resolveSubject("auth-user", "olivia")?.status,
    ).toBe("suspended");

    await principals.syncEmployee({
      employeeId: "human-olivia",
      kind: "human",
      displayName: "Olivia",
      status: "active",
      authUserId: "olivia",
      authStatus: "disabled",
    });
    expect(
      principals.resolveSubject("employee", "human-olivia")?.status,
    ).toBe("suspended");

    await principals.syncEmployee({
      employeeId: "human-olivia",
      kind: "human",
      displayName: "Olivia",
      status: "active",
      authUserId: "olivia",
      authStatus: "active",
    });
    expect(
      principals.resolveSubject("employee", "human-olivia")?.status,
    ).toBe("active");

    await principals.syncEmployee({
      employeeId: "human-olivia",
      kind: "human",
      displayName: "Olivia",
      status: "suspended",
      authUserId: "olivia",
      authStatus: "active",
    });
    await principals.syncAuthUser({
      id: "olivia",
      name: "Olivia",
      status: "active",
    });
    expect(
      principals.resolveSubject("auth-user", "olivia")?.status,
    ).toBe("suspended");
  });

  it("does not let credential synchronization resurrect an archived Human Principal", async () => {
    const { service: principals } = service();
    await principals.syncEmployee({
      employeeId: "human-olivia",
      kind: "human",
      displayName: "Olivia",
      status: "archived",
      authUserId: "olivia",
      authStatus: "disabled",
    });
    await principals.syncAuthUser({
      id: "olivia",
      name: "Olivia",
      status: "active",
    });
    expect(
      principals.resolveSubject("auth-user", "olivia")?.status,
    ).toBe("archived");
  });

  it("rejects new grants for archived Principals", async () => {
    const { service: principals } = service();
    const archived = await principals.syncEmployee({
      employeeId: "ai-retired",
      kind: "digital",
      displayName: "Retired Worker",
      status: "archived",
    });
    await expect(
      principals.assignGrant({
        principalId: archived.id,
        scopeType: "project",
        scopeId: "project-alpha",
        role: "Builder",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "archived principals cannot receive new grants",
    });
  });

  it("synchronizes scoped grants idempotently and revokes stale roles", async () => {
    const { service: principals, grants } = service();
    const principal = await principals.syncAuthUser({
      id: "olivia",
      name: "Olivia",
    });

    const member = await principals.syncExclusiveGrant({
      principalId: principal.id,
      scopeType: "platform",
      scopeId: "platform",
      role: "member",
      permissions: ["read", "write"],
    });
    const updated = await principals.syncExclusiveGrant({
      principalId: principal.id,
      scopeType: "platform",
      scopeId: "platform",
      role: "admin",
      permissions: ["read", "write", "manage_members"],
    });
    expect(updated.id).toBe(member.id);
    expect(updated.role).toBe("admin");
    expect(grants.records.size).toBe(1);

    const project = await principals.syncGrant({
      principalId: principal.id,
      scopeType: "project",
      scopeId: "project-alpha",
      role: "role-dev",
      permissions: ["read", "write"],
    });
    expect(grants.records.size).toBe(2);
    const revoked = await principals.revokeMatchingGrants({
      principalId: principal.id,
      scopeType: "project",
      scopeId: "project-alpha",
      role: "role-dev",
    });
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ id: project.id, status: "revoked" });
  });
});
