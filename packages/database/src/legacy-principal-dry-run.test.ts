import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPrincipalDryRunReport,
  principalDryRunMarkdown,
  stablePrincipalDryRunJson,
  writePrincipalDryRunReports,
} from "./legacy-principal-dry-run.js";
import {
  LEGACY_PRINCIPAL_DOMAINS,
  readLegacyPrincipalSnapshot,
  type LegacyPrincipalDomain,
} from "./legacy-principal-snapshot.js";

const TMP_ROOT = resolve(process.cwd(), ".tmp", "batch14b-principal-dry-run");
const AS_OF = "2026-10-26T00:00:00.000Z";
const PASSWORD_HASH =
  "scrypt$16384$8$1$c3ludGhldGljLXNhbHQ$c3ludGhldGljLWhhc2g";
const TOKEN_HASH = "a".repeat(64);
const temporaryDirectories: string[] = [];

interface StorageDomainInput {
  readonly tables: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly version?: number;
  readonly unitName?: string;
}

async function temporaryDirectory(prefix: string): Promise<string> {
  await mkdir(TMP_ROOT, { recursive: true });
  const directory = await mkdtemp(join(TMP_ROOT, `${prefix}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeStorageDomain(
  sourceHome: string,
  domain: LegacyPrincipalDomain,
  input: StorageDomainInput,
): Promise<void> {
  const storageRoot = join(sourceHome, "storages");
  await mkdir(storageRoot, { recursive: true });
  await writeFile(
    join(storageRoot, `${domain}.json`),
    `${JSON.stringify(
      {
        unit: {
          name: input.unitName ?? domain,
          version: input.version ?? 1,
        },
        global: null,
        tables: input.tables,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function writeEmptyDomains(sourceHome: string): Promise<void> {
  for (const domain of LEGACY_PRINCIPAL_DOMAINS) {
    await writeStorageDomain(sourceHome, domain, { tables: {} });
  }
}

async function writeCleanFixture(sourceHome: string): Promise<void> {
  await writeEmptyDomains(sourceHome);
  await writeStorageDomain(sourceHome, "collab_team", {
    tables: {
      users: {
        "owner-record": {
          id: "owner-user",
          name: "Owner",
          role: "admin",
          status: "active",
          passwordHash: PASSWORD_HASH,
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
      },
      workspace_members: {
        "ws-1": {
          workspaceId: "ws-1",
          members: [
            {
              userId: "owner-user",
              role: "owner",
              addedAt: AS_OF,
              addedBy: "owner-user",
            },
          ],
          updatedAt: AS_OF,
        },
      },
      auth_sessions: {
        "session-1": {
          tokenHash: TOKEN_HASH,
          userId: "owner-user",
          createdAt: AS_OF,
          expiresAt: "2026-11-26T00:00:00.000Z",
        },
      },
      audit_log: {},
    },
  });
  await writeStorageDomain(sourceHome, "collab_principal", {
    tables: {
      principals: {
        "p-human": {
          id: "p-human",
          kind: "human",
          displayName: "Owner",
          status: "active",
          statusAuthority: "account",
          source: "account",
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
        "p-ai": {
          id: "p-ai",
          kind: "ai",
          displayName: "AI Agent",
          status: "active",
          statusAuthority: "employee",
          source: "ai-companion",
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
      },
      principal_links: {
        "auth-user:owner-user": {
          id: "auth-user:owner-user",
          principalId: "p-human",
          subjectType: "auth-user",
          subjectId: "owner-user",
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
        "employee:emp-human": {
          id: "employee:emp-human",
          principalId: "p-human",
          subjectType: "employee",
          subjectId: "emp-human",
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
        "employee:emp-ai": {
          id: "employee:emp-ai",
          principalId: "p-ai",
          subjectType: "employee",
          subjectId: "emp-ai",
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
        "teammate:tm-ai": {
          id: "teammate:tm-ai",
          principalId: "p-ai",
          subjectType: "teammate",
          subjectId: "tm-ai",
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
      },
      role_grants: {},
      external_identity_links: {
        "hrm:owner-001": {
          id: "hrm:owner-001",
          principalId: "p-human",
          provider: "hrm",
          externalSubjectId: "owner-001",
          status: "active",
        },
      },
    },
  });
  await writeStorageDomain(sourceHome, "collab_employee", {
    tables: {
      employees: {
        "emp-human": {
          id: "emp-human",
          kind: "human",
          displayName: "Owner",
          status: "active",
          authUserId: "owner-user",
          authStatus: "active",
          principalId: "p-human",
          createdAt: AS_OF,
          updatedAt: AS_OF,
          createdBy: "system",
        },
        "emp-ai": {
          id: "emp-ai",
          kind: "digital",
          displayName: "AI Agent",
          status: "active",
          principalId: "p-ai",
          createdAt: AS_OF,
          updatedAt: AS_OF,
          createdBy: "system",
        },
      },
      role_assignments: {
        "role-human": {
          id: "role-human",
          employeeId: "emp-human",
          principalId: "p-human",
          workspaceId: "ws-1",
          role: "owner",
          permissions: ["read", "write", "manage_members"],
          status: "active",
          grantedBy: "system",
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
      },
      runtime_profiles: {
        "runtime-ai": {
          id: "runtime-ai",
          employeeId: "emp-ai",
          principalId: "p-ai",
          workspaceId: "ws-1",
          status: "active",
        },
      },
      action_tickets: {
        "ticket-ai": {
          id: "ticket-ai",
          principal: {
            employeeId: "emp-ai",
            principalId: "p-ai",
            employeeKind: "digital",
            source: "direct",
            workspaceId: "ws-1",
          },
          workspaceId: "ws-1",
          status: "active",
        },
      },
      delegations: {
        "delegation-1": {
          id: "delegation-1",
          ownerId: "emp-human",
          ownerPrincipalId: "p-human",
          ownerAuthUserId: "owner-user",
          workspaceId: "ws-1",
          status: "active",
        },
      },
    },
  });
  await writeStorageDomain(sourceHome, "collab_teammate", {
    tables: {
      teammates: {
        "tm-ai": {
          id: "tm-ai",
          name: "AI Agent",
          employeeId: "emp-ai",
          principalId: "p-ai",
          ownerUserId: "owner-user",
          state: "active",
        },
      },
    },
  });
  await writeStorageDomain(sourceHome, "collab_assignment", {
    tables: {
      workspaces: {
        "ws-1": {
          workspaceId: "ws-1",
          typeId: "delivery",
          typeName: "Delivery",
          seats: [
            {
              id: "owner",
              label: "Owner",
              permissions: ["read", "write", "manage_members"],
            },
            {
              id: "executor",
              label: "Executor",
              permissions: ["read", "write"],
            },
          ],
          materializedAt: AS_OF,
          materializedBy: "owner-user",
        },
      },
      assignments: {
        "ws-1:owner:user:owner-user": {
          id: "assignment-owner",
          workspaceId: "ws-1",
          seatId: "owner",
          seatLabel: "Owner",
          participantKind: "human",
          assigneeKind: "user",
          assigneeId: "owner-user",
          principalId: "p-human",
          permissions: ["read", "write", "manage_members"],
          leader: true,
          status: "assigned",
        },
        "ws-1:executor:agent:tm-ai": {
          id: "assignment-ai",
          workspaceId: "ws-1",
          seatId: "executor",
          seatLabel: "Executor",
          participantKind: "agent",
          assigneeKind: "agent",
          assigneeId: "tm-ai",
          principalId: "p-ai",
          permissions: ["read", "write"],
          leader: false,
          status: "assigned",
        },
      },
    },
  });
  await writeStorageDomain(sourceHome, "collab_project", {
    tables: {
      projects: {
        "ws-1": {
          workspaceId: "ws-1",
          ownerId: "owner-user",
          status: "进行中",
          projectRoles: [
            {
              id: "owner",
              code: "OWNER",
              permissions: ["read", "write", "manage_members"],
            },
          ],
        },
      },
    },
  });
  await writeStorageDomain(sourceHome, "collab_principal_runtime", {
    tables: {
      profiles: {
        "principal-runtime-ai": {
          id: "principal-runtime-ai",
          principalId: "p-ai",
          workspaceId: "ws-1",
          status: "active",
        },
      },
      action_tickets: {
        "principal-ticket-ai": {
          id: "principal-ticket-ai",
          principalId: "p-ai",
          runtimeProfileId: "principal-runtime-ai",
          workspaceId: "ws-1",
          status: "active",
        },
      },
    },
  });
}

async function writeConflictFixture(sourceHome: string): Promise<void> {
  await writeEmptyDomains(sourceHome);
  await writeStorageDomain(sourceHome, "collab_team", {
    tables: {
      users: {
        "user-owner": {
          id: "Owner",
          name: "Owner",
          role: "admin",
          status: "active",
          passwordHash: PASSWORD_HASH,
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
        "user-owner-lower": {
          id: "owner",
          name: "Owner Lower",
          role: "member",
          status: "active",
          passwordHash: PASSWORD_HASH,
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
        "user-account": {
          id: "dup-account",
          name: "Duplicate Account",
          role: "member",
          status: "active",
          passwordHash: PASSWORD_HASH,
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
        "user-project-owner": {
          id: "project-owner",
          name: "Project Owner",
          role: "member",
          status: "active",
          passwordHash: PASSWORD_HASH,
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
        "user-role": {
          id: "role-user",
          name: "Role User",
          role: "member",
          status: "active",
          passwordHash: PASSWORD_HASH,
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
      },
      workspace_members: {
        "ws-1": {
          workspaceId: "ws-1",
          members: [
            {
              userId: "project-owner",
              role: "owner",
              addedAt: AS_OF,
              addedBy: "project-owner",
            },
            {
              userId: "role-user",
              role: "owner",
              addedAt: AS_OF,
              addedBy: "project-owner",
            },
            {
              userId: "missing-member",
              role: "guest",
              addedAt: AS_OF,
              addedBy: "project-owner",
            },
          ],
          updatedAt: AS_OF,
        },
      },
      auth_sessions: {
        "session-1": {
          tokenHash: TOKEN_HASH,
          userId: "project-owner",
          createdAt: AS_OF,
          expiresAt: "2026-11-26T00:00:00.000Z",
        },
      },
      audit_log: {
        "audit-1": {
          id: "audit-1",
          at: AS_OF,
          actorId: "ghost-actor",
          actorRole: "member",
          action: "login",
        },
      },
    },
  });
  await writeStorageDomain(sourceHome, "collab_principal", {
    tables: {
      principals: {
        "p-a": {
          id: "p-a",
          kind: "ai",
          displayName: "Shared AI A",
          status: "active",
          source: "ai-companion",
        },
        "p-b": {
          id: "p-b",
          kind: "ai",
          displayName: "Shared AI B",
          status: "active",
          source: "ai-companion",
        },
        "p-ai": {
          id: "p-ai",
          kind: "ai",
          displayName: "AI Agent",
          status: "active",
          source: "ai-companion",
        },
      },
      principal_links: {
        "employee:emp-both:a": {
          id: "employee:emp-both:a",
          principalId: "p-a",
          subjectType: "employee",
          subjectId: "emp-both",
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
        "employee:emp-both:b": {
          id: "employee:emp-both:b",
          principalId: "p-b",
          subjectType: "employee",
          subjectId: "emp-both",
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
        "employee:emp-ai": {
          id: "employee:emp-ai",
          principalId: "p-ai",
          subjectType: "employee",
          subjectId: "emp-ai",
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
        "teammate:tm-ai": {
          id: "teammate:tm-ai",
          principalId: "p-ai",
          subjectType: "teammate",
          subjectId: "tm-ai",
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
        "employee:agent-shared": {
          id: "employee:agent-shared",
          principalId: "p-a",
          subjectType: "employee",
          subjectId: "agent-shared",
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
        "teammate:agent-shared": {
          id: "teammate:agent-shared",
          principalId: "p-b",
          subjectType: "teammate",
          subjectId: "agent-shared",
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
      },
      role_grants: {},
      external_identity_links: {
        "hrm:ai-001": {
          id: "hrm:ai-001",
          principalId: "p-ai",
          provider: "hrm",
          externalSubjectId: "ai-001",
          status: "active",
        },
      },
    },
  });
  await writeStorageDomain(sourceHome, "collab_employee", {
    tables: {
      employees: {
        "emp-both": {
          id: "emp-both",
          kind: "human",
          displayName: "Employee A",
          status: "active",
          authUserId: "dup-account",
          authStatus: "active",
          createdAt: AS_OF,
          updatedAt: AS_OF,
          createdBy: "system",
        },
        "emp-both-2": {
          id: "emp-both-2",
          kind: "human",
          displayName: "Employee B",
          status: "active",
          authUserId: "dup-account",
          authStatus: "active",
          createdAt: AS_OF,
          updatedAt: AS_OF,
          createdBy: "system",
        },
        "emp-ai": {
          id: "emp-ai",
          kind: "digital",
          displayName: "AI Agent",
          status: "active",
          createdAt: AS_OF,
          updatedAt: AS_OF,
          createdBy: "system",
        },
        "agent-shared": {
          id: "agent-shared",
          kind: "digital",
          displayName: "Shared Agent",
          status: "active",
          createdAt: AS_OF,
          updatedAt: AS_OF,
          createdBy: "system",
        },
        "emp-role": {
          id: "emp-role",
          kind: "human",
          displayName: "Role User",
          status: "active",
          authUserId: "role-user",
          authStatus: "active",
          createdAt: AS_OF,
          updatedAt: AS_OF,
          createdBy: "system",
        },
      },
      role_assignments: {
        "role-conflict": {
          id: "role-conflict",
          employeeId: "emp-role",
          workspaceId: "ws-1",
          role: "guest",
          permissions: ["read"],
          status: "active",
          grantedBy: "system",
          createdAt: AS_OF,
          updatedAt: AS_OF,
        },
      },
      runtime_profiles: {
        "runtime-ai": {
          id: "runtime-ai",
          employeeId: "emp-ai",
          workspaceId: "ws-1",
          status: "active",
        },
      },
      action_tickets: {
        "ticket-ai": {
          id: "ticket-ai",
          principal: {
            employeeId: "emp-ai",
            employeeKind: "digital",
            source: "direct",
            workspaceId: "ws-1",
          },
          workspaceId: "ws-1",
          status: "active",
        },
      },
      delegations: {
        "delegation-1": {
          id: "delegation-1",
          ownerId: "emp-both",
          ownerAuthUserId: "dup-account",
          workspaceId: "ws-1",
          status: "active",
        },
      },
    },
  });
  await writeStorageDomain(sourceHome, "collab_teammate", {
    tables: {
      teammates: {
        "tm-ai": {
          id: "tm-ai",
          name: "AI Agent",
          employeeId: "emp-ai",
          ownerUserId: "project-owner",
          state: "active",
        },
        "tm-orphan": {
          id: "tm-orphan",
          name: "Orphan Agent",
          employeeId: "missing-employee",
          ownerUserId: "project-owner",
          state: "active",
        },
        "agent-shared": {
          id: "agent-shared",
          name: "Shared Agent Teammate",
          ownerUserId: "project-owner",
          state: "active",
        },
      },
    },
  });
  await writeStorageDomain(sourceHome, "collab_assignment", {
    tables: {
      workspaces: {
        "ws-1": {
          workspaceId: "ws-1",
          typeId: "delivery",
          typeName: "Delivery",
          seats: [
            {
              id: "owner",
              label: "Owner",
              permissions: ["read", "write"],
            },
          ],
          materializedAt: AS_OF,
          materializedBy: "project-owner",
        },
      },
      assignments: {
        "assignment-owner": {
          id: "assignment-owner",
          workspaceId: "ws-1",
          seatId: "owner",
          seatLabel: "Owner",
          participantKind: "human",
          assigneeKind: "user",
          assigneeId: "project-owner",
          permissions: ["read", "write"],
          leader: true,
          status: "assigned",
        },
        "assignment-ai-leader": {
          id: "assignment-ai-leader",
          workspaceId: "ws-1",
          seatId: "executor",
          seatLabel: "Executor",
          participantKind: "agent",
          assigneeKind: "agent",
          assigneeId: "tm-ai",
          permissions: ["read", "write"],
          leader: true,
          status: "assigned",
        },
        "assignment-missing": {
          id: "assignment-missing",
          workspaceId: "ws-1",
          seatId: "reviewer",
          seatLabel: "Reviewer",
          participantKind: "agent",
          assigneeKind: "agent",
          assigneeId: "tm-missing",
          permissions: ["read"],
          leader: false,
          status: "assigned",
        },
        "assignment-ambiguous": {
          id: "assignment-ambiguous",
          workspaceId: "ws-1",
          seatId: "owner",
          seatLabel: "Owner",
          participantKind: "agent",
          assigneeKind: "agent",
          assigneeId: "agent-shared",
          permissions: ["read"],
          leader: false,
          status: "assigned",
        },
      },
    },
  });
  await writeStorageDomain(sourceHome, "collab_project", {
    tables: {
      projects: {
        "ws-1": {
          workspaceId: "ws-1",
          ownerId: "project-owner",
          status: "进行中",
          projectRoles: [],
        },
      },
    },
  });
  await writeStorageDomain(sourceHome, "collab_agent", {
    tables: {
      profiles: {
        "sys-agent": {
          id: "sys-agent",
          workspaceId: "ws-1",
          visibility: "platform",
          status: "active",
        },
      },
      runs: {},
    },
  });
  await writeStorageDomain(sourceHome, "collab_principal_runtime", {
    tables: {
      profiles: {
        "runtime-missing": {
          id: "runtime-missing",
          principalId: "p-missing",
          workspaceId: "ws-1",
          status: "active",
        },
      },
      action_tickets: {
        "ticket-missing": {
          id: "ticket-missing",
          principalId: "p-missing",
          runtimeProfileId: "runtime-missing",
          workspaceId: "ws-1",
          status: "active",
        },
      },
    },
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("legacy principal snapshot adapter", () => {
  it("reads only the explicit source and redacts credentials and sessions", async () => {
    const sourceHome = await temporaryDirectory("explicit-source");
    const decoyHome = await temporaryDirectory("env-decoy");
    await writeStorageDomain(sourceHome, "collab_team", {
      tables: {
        users: {
          explicit: {
            id: "explicit-user",
            name: "Explicit User",
            role: "member",
            status: "active",
            passwordHash: PASSWORD_HASH,
          },
        },
        auth_sessions: {
          session: {
            tokenHash: TOKEN_HASH,
            userId: "explicit-user",
          },
        },
      },
    });
    await writeStorageDomain(decoyHome, "collab_team", {
      tables: {
        users: {
          decoy: {
            id: "DSH_HOME_CANARY",
            name: "DSH_HOME_CANARY",
            role: "admin",
            status: "active",
            passwordHash: "not-read",
          },
        },
      },
    });
    const previousHome = process.env["DSH_HOME"];
    process.env["DSH_HOME"] = decoyHome;
    try {
      const first = await readLegacyPrincipalSnapshot({ sourceHome });
      const second = await readLegacyPrincipalSnapshot({ sourceHome });
      expect(first.sourceDigest).toBe(second.sourceDigest);
      expect(first.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(first.tables.users.map((user) => user.id)).toEqual([
        "explicit-user",
      ]);
      expect(first.tables.users[0]?.credential).toEqual({
        present: true,
        algorithm: "scrypt",
        status: "active",
      });
      expect(first.tables.sessions).toHaveLength(1);
      const serialized = JSON.stringify(first);
      expect(serialized).not.toContain(PASSWORD_HASH);
      expect(serialized).not.toContain(TOKEN_HASH);
      expect(serialized).not.toContain("DSH_HOME_CANARY");
    } finally {
      if (previousHome === undefined) delete process.env["DSH_HOME"];
      else process.env["DSH_HOME"] = previousHome;
    }
  });

  it("rejects a relative or implicit source directory", async () => {
    await expect(
      readLegacyPrincipalSnapshot({ sourceHome: ".tmp/dsh-home" }),
    ).rejects.toMatchObject({
      code: "invalid_source",
    });
  });
});

describe("principal dry-run report", () => {
  it("produces a ready report from a clean synthetic snapshot", async () => {
    const sourceHome = await temporaryDirectory("clean-source");
    await writeCleanFixture(sourceHome);
    const snapshot = await readLegacyPrincipalSnapshot({ sourceHome });
    const report = buildPrincipalDryRunReport({ snapshot, asOf: AS_OF });
    expect(report.conflicts).toEqual([]);
    expect(report.orphans).toEqual([]);
    expect(report.blocked).toEqual([]);
    expect(report.readyToBackfill).toBe(true);
    expect(report.counts.principalsCandidate).toBe(2);
    expect(report.counts.accountsCandidate).toBe(1);
    expect(report.counts.credentialsCandidate).toBe(1);
    expect(report.counts.workspaceMembersCandidate).toBe(1);
    expect(report.counts.externalIdentityLinksCandidate).toBe(1);
    expect(report.counts.workspaceGrantsCandidate).toBeGreaterThanOrEqual(1);
    expect(report.counts.projectGrantsCandidate).toBeGreaterThanOrEqual(2);
    expect(report.counts.aliasManyToOnePrincipalGroups).toBeGreaterThanOrEqual(
      1,
    );
    expect(stablePrincipalDryRunJson(report)).not.toContain(PASSWORD_HASH);
    expect(stablePrincipalDryRunJson(report)).not.toContain(TOKEN_HASH);
  });

  it("reports every required blocker category with stable JSON and Markdown", async () => {
    const sourceHome = await temporaryDirectory("conflict-source");
    await writeConflictFixture(sourceHome);
    const snapshot = await readLegacyPrincipalSnapshot({ sourceHome });
    const first = buildPrincipalDryRunReport({ snapshot, asOf: AS_OF });
    const second = buildPrincipalDryRunReport({ snapshot, asOf: AS_OF });
    expect(stablePrincipalDryRunJson(first)).toBe(
      stablePrincipalDryRunJson(second),
    );
    expect(first.readyToBackfill).toBe(false);
    const conflictCodes = new Set(first.conflicts.map((issue) => issue.code));
    expect(conflictCodes).toContain("duplicate_account_login");
    expect(conflictCodes).toContain("human_employee_many_to_one_account");
    expect(conflictCodes).toContain("alias_multiple_principals");
    expect(conflictCodes).toContain("project_multiple_owners");
    expect(conflictCodes).toContain("project_assignment_actor_ambiguous");
    expect(conflictCodes).toContain("workspace_grant_source_conflict");
    const orphanCodes = new Set(first.orphans.map((issue) => issue.code));
    expect(orphanCodes).toContain("project_assignment_actor_missing");
    expect(orphanCodes).toContain("workspace_member_user_missing");
    expect(orphanCodes).toContain("audit_actor_unresolved");
    const blockedCodes = new Set(first.blocked.map((issue) => issue.code));
    expect(blockedCodes).toContain("runtime_profile_principal_missing");
    expect(blockedCodes).toContain("action_ticket_principal_missing");
    expect(blockedCodes).toContain("delegation_principal_missing");
    expect(blockedCodes).toContain("system_agent_principal_decision_required");
    const json = stablePrincipalDryRunJson(first);
    const markdown = principalDryRunMarkdown(first);
    expect(json).not.toContain(PASSWORD_HASH);
    expect(json).not.toContain(TOKEN_HASH);
    expect(markdown).not.toContain(PASSWORD_HASH);
    expect(markdown).not.toContain(TOKEN_HASH);
    expect(markdown).toContain("Status: BLOCKED");
  });

  it("writes the reviewable synthetic report under the worktree .tmp directory", async () => {
    const sourceHome = join(process.cwd(), ".tmp", "dsh-home-batch14b");
    await rm(sourceHome, { recursive: true, force: true });
    await writeConflictFixture(sourceHome);
    const snapshot = await readLegacyPrincipalSnapshot({ sourceHome });
    const report = buildPrincipalDryRunReport({ snapshot, asOf: AS_OF });
    const jsonPath = join(TMP_ROOT, "run", "legacy-principal-report.json");
    const paths = await writePrincipalDryRunReports({ report, jsonPath });
    expect(paths.jsonPath).toBe(jsonPath);
    expect(paths.markdownPath).toBe(
      join(TMP_ROOT, "run", "legacy-principal-report.md"),
    );
    const json = await readFile(paths.jsonPath, "utf8");
    const markdown = await readFile(paths.markdownPath, "utf8");
    expect(JSON.parse(json)).toMatchObject({
      schemaVersion: "pluginmax.principal-dry-run.v1",
      mode: "dry-run",
      readyToBackfill: false,
    });
    expect(markdown).toContain("# Identity / Principal Legacy Dry-run");
  });
});
