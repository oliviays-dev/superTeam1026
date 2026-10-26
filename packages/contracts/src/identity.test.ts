import { describe, expect, it } from "vitest";
import {
  evaluateHumanSessionAccess,
  parsePrincipalReference,
  principalKindCanOwnAccount,
  principalReference,
  roleGrantSchema,
} from "./identity.js";

describe("identity principal contracts", () => {
  it("uses one canonical principal reference format", () => {
    expect(principalReference("principal-human-local-admin")).toBe(
      "principal:principal-human-local-admin",
    );
    expect(
      parsePrincipalReference("principal:principal-human-local-admin"),
    ).toBe("principal-human-local-admin");
    expect(parsePrincipalReference("employee:emp-1")).toBeUndefined();
    expect(parsePrincipalReference("principal:")).toBeUndefined();
  });

  it("fails closed on human session and credential status", () => {
    const now = new Date("2026-10-26T00:00:00.000Z");
    const valid = {
      principalStatus: "active" as const,
      accountStatus: "active" as const,
      credentialStatus: "active" as const,
      sessionStatus: "active" as const,
      sessionExpiresAt: "2026-10-27T00:00:00.000Z",
    };
    expect(evaluateHumanSessionAccess(valid, now)).toEqual({ allowed: true });
    expect(
      evaluateHumanSessionAccess(
        { ...valid, principalStatus: "suspended" },
        now,
      ),
    ).toEqual({ allowed: false, reason: "principal_inactive" });
    expect(
      evaluateHumanSessionAccess({ ...valid, accountStatus: "pending" }, now),
    ).toEqual({ allowed: false, reason: "account_inactive" });
    expect(
      evaluateHumanSessionAccess(
        { ...valid, credentialStatus: "revoked" },
        now,
      ),
    ).toEqual({ allowed: false, reason: "credential_inactive" });
    expect(
      evaluateHumanSessionAccess(
        { ...valid, sessionExpiresAt: "2026-10-25T00:00:00.000Z" },
        now,
      ),
    ).toEqual({ allowed: false, reason: "session_inactive" });
  });

  it("allows only human principals to own login accounts", () => {
    expect(principalKindCanOwnAccount("human")).toBe(true);
    expect(principalKindCanOwnAccount("ai")).toBe(false);
  });

  it("requires scope-specific grants and revocation timestamps", () => {
    const base = {
      id: "00000000-0000-4000-8000-000000000001",
      principalId: "principal-human-alice",
      scopeType: "platform" as const,
      scopeId: "platform",
      roleKey: "ADMIN",
      permissions: ["manage_roles", "manage_members"],
      status: "active" as const,
      sourceKind: "platform-role" as const,
      sourceRef: "collab_team.users:alice",
      grantedByPrincipalId: "principal-human-root",
      revokedByPrincipalId: null,
      grantedAt: "2026-10-26T00:00:00.000Z",
      expiresAt: null,
      revokedAt: null,
      version: 1,
      createdAt: "2026-10-26T00:00:00.000Z",
      updatedAt: "2026-10-26T00:00:00.000Z",
    };
    expect(roleGrantSchema.parse(base).permissions).toEqual([
      "manage_roles",
      "manage_members",
    ]);
    expect(
      roleGrantSchema.safeParse({ ...base, scopeId: "project" }).success,
    ).toBe(false);
    expect(
      roleGrantSchema.safeParse({ ...base, status: "revoked" }).success,
    ).toBe(false);
    expect(
      roleGrantSchema.safeParse({
        ...base,
        scopeType: "project",
        scopeId: "00000000-0000-4000-8000-000000000002",
        roleKey: "PROJECT_OWNER",
        sourceKind: "project-role",
      }).success,
    ).toBe(true);
  });
});
