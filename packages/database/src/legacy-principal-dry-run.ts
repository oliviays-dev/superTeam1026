import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import type {
  LegacyEmployeeRecord,
  LegacyPrincipalLinkRecord,
  LegacyPrincipalSnapshot,
  LegacyTeammateRecord,
  LegacyUserRecord,
} from "./legacy-principal-snapshot.js";

export const PRINCIPAL_DRY_RUN_SCHEMA =
  "pluginmax.principal-dry-run.v1" as const;

export type DryRunClassification =
  | "ready"
  | "already-mapped"
  | "skipped-non-target"
  | "conflict"
  | "orphan"
  | "blocked-security-decision";

export type PrincipalAliasType =
  | "auth-user"
  | "employee"
  | "teammate"
  | "agent"
  | "runtime-profile"
  | "legacy-actor"
  | "external";

export interface PrincipalDryRunCandidate {
  readonly id: string;
  readonly kind: "human" | "ai";
  readonly displayName: string;
  readonly status: "active" | "suspended" | "archived";
  readonly source: string;
  readonly classification: "ready" | "already-mapped" | "conflict";
  readonly reusedExistingPrincipal: boolean;
}

export interface AccountDryRunCandidate {
  readonly id: string;
  readonly principalId: string;
  readonly loginId: string;
  readonly status: "active" | "pending" | "disabled";
  readonly classification: "ready" | "already-mapped" | "conflict";
  readonly sourceRef: string;
}

export interface CredentialDryRunSummary {
  readonly accountId: string;
  readonly type: "password";
  readonly algorithm: "scrypt" | "unknown";
  readonly status: "active" | "disabled";
  readonly present: boolean;
  readonly sourceRef: string;
}

export interface WorkspaceMemberDryRunCandidate {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly status: "active";
  readonly sourceRefs: readonly string[];
}

export interface AliasDryRunCandidate {
  readonly principalId: string;
  readonly type: PrincipalAliasType;
  readonly value: string;
  readonly classification: "ready" | "already-mapped";
  readonly sourceRef: string;
}

export interface ExternalIdentityLinkDryRunCandidate {
  readonly principalId: string;
  readonly provider: string;
  readonly externalSubjectId: string;
  readonly status: "active" | "retired";
  readonly sourceRef: string;
}

export interface GrantDryRunCandidate {
  readonly principalId: string;
  readonly scopeType: "platform" | "workspace" | "project";
  readonly scopeId: string;
  readonly roleKey: string;
  readonly permissions: readonly string[];
  readonly status: "active";
  readonly sourceKind:
    "platform-role" | "workspace-role" | "employee-role" | "project-role";
  readonly sourceRefs: readonly string[];
}

export type DryRunIssueValue = string | number | boolean | readonly string[];

export interface DryRunIssue {
  readonly code: string;
  readonly message: string;
  readonly sourceRefs: readonly string[];
  readonly details: Readonly<Record<string, DryRunIssueValue>>;
}

export interface PrincipalDryRunCounts {
  readonly sourceFilesPresent: number;
  readonly users: number;
  readonly workspaceMemberships: number;
  readonly employeesHuman: number;
  readonly employeesDigital: number;
  readonly teammates: number;
  readonly projectAssignments: number;
  readonly workspaceRoleSeats: number;
  readonly projects: number;
  readonly projectRoleDefinitions: number;
  readonly principalsExisting: number;
  readonly principalsCandidate: number;
  readonly principalsHumanCandidate: number;
  readonly principalsAiCandidate: number;
  readonly aliasesCandidate: number;
  readonly aliasManyToOnePrincipalGroups: number;
  readonly accountsCandidate: number;
  readonly credentialsCandidate: number;
  readonly externalIdentityLinksCandidate: number;
  readonly workspaceMembersCandidate: number;
  readonly platformGrantsCandidate: number;
  readonly workspaceGrantsCandidate: number;
  readonly projectGrantsCandidate: number;
  readonly runtimeProfiles: number;
  readonly actionTickets: number;
  readonly delegations: number;
  readonly auditActorsResolved: number;
  readonly auditActorsUnresolved: number;
  readonly sessionsSkipped: number;
}

export interface PrincipalDryRunClassificationCounts {
  readonly ready: number;
  readonly alreadyMapped: number;
  readonly skippedNonTarget: number;
  readonly conflict: number;
  readonly orphan: number;
  readonly blockedSecurityDecision: number;
}

export interface PrincipalDryRunReport {
  readonly schemaVersion: typeof PRINCIPAL_DRY_RUN_SCHEMA;
  readonly mode: "dry-run";
  readonly sourceDigest: string;
  readonly asOf: string;
  readonly sourceFiles: LegacyPrincipalSnapshot["sourceFiles"];
  readonly counts: PrincipalDryRunCounts;
  readonly classificationCounts: PrincipalDryRunClassificationCounts;
  readonly candidates: {
    readonly principals: readonly PrincipalDryRunCandidate[];
    readonly accounts: readonly AccountDryRunCandidate[];
    readonly credentials: readonly CredentialDryRunSummary[];
    readonly workspaceMembers: readonly WorkspaceMemberDryRunCandidate[];
    readonly aliases: readonly AliasDryRunCandidate[];
    readonly externalIdentityLinks: readonly ExternalIdentityLinkDryRunCandidate[];
    readonly grants: readonly GrantDryRunCandidate[];
  };
  readonly conflicts: readonly DryRunIssue[];
  readonly orphans: readonly DryRunIssue[];
  readonly blocked: readonly DryRunIssue[];
  readonly readyToBackfill: boolean;
}

interface MutablePrincipalCandidate extends Omit<
  PrincipalDryRunCandidate,
  "classification"
> {
  classification: "ready" | "already-mapped" | "conflict";
  readonly subjectRefs: string[];
  readonly aliasRefs: string[];
}

interface MutableGrantCandidate {
  readonly principalId: string;
  readonly scopeType: "platform" | "workspace" | "project";
  readonly scopeId: string;
  readonly roleKey: string;
  readonly sourceKind: GrantDryRunCandidate["sourceKind"];
  readonly sourceRefs: Set<string>;
  readonly permissionVariants: Set<string>;
}

interface ReportIssues {
  readonly conflicts: DryRunIssue[];
  readonly orphans: DryRunIssue[];
  readonly blocked: DryRunIssue[];
}

function stableIdPart(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, "_")
    .slice(0, 150);
}

function derivedPrincipalId(kind: "human" | "ai", subjectId: string): string {
  return `principal-${kind}-${stableIdPart(subjectId)}`;
}

function aliasKey(type: PrincipalAliasType, value: string): string {
  const normalized = type === "auth-user" ? value.toLowerCase() : value;
  return `${type}\u0000${normalized}`;
}

function subjectKey(type: string, value: string): string {
  return `${type}\u0000${value}`;
}

function issueDetails(
  details: Record<string, DryRunIssueValue>,
): Record<string, DryRunIssueValue> {
  return details;
}

function issueKey(issue: DryRunIssue): string {
  return JSON.stringify(issue);
}

function addIssue(
  issues: DryRunIssue[],
  code: string,
  message: string,
  sourceRefs: readonly string[],
  details: Record<string, DryRunIssueValue> = {},
): void {
  const issue: DryRunIssue = {
    code,
    message,
    sourceRefs: [...new Set(sourceRefs)].sort(),
    details: issueDetails(details),
  };
  const key = issueKey(issue);
  if (!issues.some((candidate) => issueKey(candidate) === key)) {
    issues.push(issue);
  }
}

function addConflict(
  issues: ReportIssues,
  code: string,
  message: string,
  sourceRefs: readonly string[],
  details: Record<string, DryRunIssueValue> = {},
): void {
  addIssue(issues.conflicts, code, message, sourceRefs, details);
}

function addOrphan(
  issues: ReportIssues,
  code: string,
  message: string,
  sourceRefs: readonly string[],
  details: Record<string, DryRunIssueValue> = {},
): void {
  addIssue(issues.orphans, code, message, sourceRefs, details);
}

function addBlocked(
  issues: ReportIssues,
  code: string,
  message: string,
  sourceRefs: readonly string[],
  details: Record<string, DryRunIssueValue> = {},
): void {
  addIssue(issues.blocked, code, message, sourceRefs, details);
}

function isExpired(expiresAt: string | undefined, asOfMs: number): boolean {
  if (expiresAt === undefined) return false;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed <= asOfMs;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function compareIssue(left: DryRunIssue, right: DryRunIssue): number {
  return (
    left.code.localeCompare(right.code) ||
    left.sourceRefs
      .join("\u0000")
      .localeCompare(right.sourceRefs.join("\u0000"))
  );
}

function compareByJson(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function classifyLink(existing: boolean): "ready" | "already-mapped" {
  return existing ? "already-mapped" : "ready";
}

function ensurePrincipal(
  principals: Map<string, MutablePrincipalCandidate>,
  input: {
    readonly id: string;
    readonly kind: "human" | "ai";
    readonly displayName: string;
    readonly status?: "active" | "suspended" | "archived";
    readonly source: string;
    readonly reusedExistingPrincipal: boolean;
    readonly classification: "ready" | "already-mapped" | "conflict";
    readonly subjectRef: string;
  },
  issues: ReportIssues,
): MutablePrincipalCandidate {
  const current = principals.get(input.id);
  if (current !== undefined) {
    if (current.kind !== input.kind) {
      addConflict(
        issues,
        "principal_kind_conflict",
        "One Principal candidate ID was derived for both human and AI identities.",
        [...current.subjectRefs, input.subjectRef],
        { principalId: input.id, humanOrAi: input.kind },
      );
      current.classification = "conflict";
      if (!current.subjectRefs.includes(input.subjectRef)) {
        current.subjectRefs.push(input.subjectRef);
      }
      return current;
    }
    if (!current.subjectRefs.includes(input.subjectRef)) {
      current.subjectRefs.push(input.subjectRef);
    }
    return current;
  }
  const next: MutablePrincipalCandidate = {
    id: input.id,
    kind: input.kind,
    displayName: input.displayName,
    status: input.status ?? "active",
    source: input.source,
    classification: input.classification,
    reusedExistingPrincipal: input.reusedExistingPrincipal,
    subjectRefs: [input.subjectRef],
    aliasRefs: [],
  };
  principals.set(next.id, next);
  return next;
}

function chooseCandidate(
  input: {
    readonly values: readonly (string | undefined)[];
    readonly fallback: string;
    readonly code: string;
    readonly message: string;
    readonly sourceRefs: readonly string[];
    readonly details: Record<string, DryRunIssueValue>;
  },
  issues: ReportIssues,
): { readonly id: string; readonly conflicted: boolean } {
  const values = sortedUnique(
    input.values.filter((value): value is string => value !== undefined),
  );
  if (values.length > 1) {
    addConflict(issues, input.code, input.message, input.sourceRefs, {
      ...input.details,
      candidates: values,
    });
    return { id: input.fallback, conflicted: true };
  }
  return { id: values[0] ?? input.fallback, conflicted: false };
}

function linkSets(
  links: readonly LegacyPrincipalLinkRecord[],
  principals: ReadonlyMap<string, MutablePrincipalCandidate>,
  issues: ReportIssues,
): Map<string, Set<string>> {
  const sets = new Map<string, Set<string>>();
  for (const link of links) {
    const key = subjectKey(link.subjectType, link.subjectId);
    const targets = sets.get(key) ?? new Set<string>();
    targets.add(link.principalId);
    sets.set(key, targets);
    if (!principals.has(link.principalId)) {
      addOrphan(
        issues,
        "principal_link_target_missing",
        "A Principal link points to a Principal record that is not in the snapshot.",
        [`collab_principal.principal_links:${link.recordKey}`],
        {
          principalId: link.principalId,
          subjectType: link.subjectType,
          subjectId: link.subjectId,
        },
      );
    }
  }
  for (const [key, targets] of sets) {
    if (targets.size > 1) {
      const [subjectType = "unknown", subjectId = "unknown"] =
        key.split("\u0000");
      addConflict(
        issues,
        "subject_multiple_principals",
        "One legacy subject is linked to multiple Principal records.",
        ["collab_principal.principal_links"],
        {
          subjectType,
          subjectId,
          principals: sortedUnique(targets),
        },
      );
    }
  }
  return sets;
}

function uniqueLink(
  links: ReadonlyMap<string, Set<string>>,
  type: string,
  value: string,
): string | undefined {
  const targets = links.get(subjectKey(type, value));
  return targets?.size === 1 ? [...targets][0] : undefined;
}

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const current = grouped.get(key(value)) ?? [];
    current.push(value);
    grouped.set(key(value), current);
  }
  return grouped;
}

function addAlias(
  aliases: AliasDryRunCandidate[],
  input: {
    readonly principalId: string;
    readonly type: PrincipalAliasType;
    readonly value: string;
    readonly classification: "ready" | "already-mapped";
    readonly sourceRef: string;
  },
): void {
  const key = aliasKey(input.type, input.value);
  const existing = aliases.find(
    (alias) =>
      aliasKey(alias.type, alias.value) === key &&
      alias.principalId === input.principalId,
  );
  if (existing !== undefined) {
    if (input.classification === "already-mapped") {
      const index = aliases.indexOf(existing);
      aliases[index] = {
        ...existing,
        classification: "already-mapped",
        sourceRef: input.sourceRef,
      };
    }
    return;
  }
  aliases.push({
    principalId: input.principalId,
    type: input.type,
    value: input.value,
    classification: input.classification,
    sourceRef: input.sourceRef,
  });
}

function aliasMaps(
  aliases: readonly AliasDryRunCandidate[],
  principals: ReadonlyMap<string, MutablePrincipalCandidate>,
  issues: ReportIssues,
): {
  readonly byKey: Map<string, Set<string>>;
  readonly byRawValue: Map<string, Set<string>>;
  readonly manyToOneGroups: number;
} {
  const byKey = new Map<string, Set<string>>();
  const byRawValue = new Map<string, Set<string>>();
  const byPrincipal = new Map<string, number>();
  for (const alias of aliases) {
    if (!principals.has(alias.principalId)) {
      addOrphan(
        issues,
        "alias_principal_missing",
        "An Alias candidate points to a Principal candidate that does not exist.",
        [alias.sourceRef],
        {
          principalId: alias.principalId,
          aliasType: alias.type,
          aliasValue: alias.value,
        },
      );
      continue;
    }
    const key = aliasKey(alias.type, alias.value);
    const keyTargets = byKey.get(key) ?? new Set<string>();
    keyTargets.add(alias.principalId);
    byKey.set(key, keyTargets);
    const rawTargets = byRawValue.get(alias.value) ?? new Set<string>();
    rawTargets.add(alias.principalId);
    byRawValue.set(alias.value, rawTargets);
    byPrincipal.set(
      alias.principalId,
      (byPrincipal.get(alias.principalId) ?? 0) + 1,
    );
  }
  for (const [key, targetIds] of byKey) {
    if (targetIds.size <= 1) continue;
    const [type = "unknown", value = "unknown"] = key.split("\u0000");
    addConflict(
      issues,
      "alias_multiple_principals",
      "One Alias key resolves to multiple Principal candidates.",
      aliases
        .filter((alias) => aliasKey(alias.type, alias.value) === key)
        .map((alias) => alias.sourceRef),
      {
        aliasType: type,
        aliasValue: value,
        principals: sortedUnique(targetIds),
      },
    );
  }
  return {
    byKey,
    byRawValue,
    manyToOneGroups: [...byPrincipal.values()].filter((count) => count > 1)
      .length,
  };
}

function resolveAlias(
  maps: ReturnType<typeof aliasMaps>,
  type: PrincipalAliasType,
  value: string,
): string | undefined {
  const targets = maps.byKey.get(aliasKey(type, value));
  return targets?.size === 1 ? [...targets][0] : undefined;
}

function resolveAgentActor(
  maps: ReturnType<typeof aliasMaps>,
  value: string,
): { readonly principalId: string | undefined; readonly ambiguous: boolean } {
  const targetSets = ["teammate", "employee", "agent"].flatMap((type) => {
    const targets = maps.byKey.get(aliasKey(type as PrincipalAliasType, value));
    return targets === undefined ? [] : [[...targets]];
  });
  const targets = sortedUnique(targetSets.flat());
  return targets.length === 1
    ? { principalId: targets[0], ambiguous: false }
    : { principalId: undefined, ambiguous: targets.length > 1 };
}

function resolveBareActor(
  maps: ReturnType<typeof aliasMaps>,
  value: string,
): string[] {
  return sortedUnique(maps.byRawValue.get(value) ?? []);
}

function addGrant(
  grants: Map<string, MutableGrantCandidate>,
  input: {
    readonly principalId: string;
    readonly scopeType: "platform" | "workspace" | "project";
    readonly scopeId: string;
    readonly roleKey: string;
    readonly permissions: readonly string[];
    readonly sourceKind: GrantDryRunCandidate["sourceKind"];
    readonly sourceRef: string;
  },
  issues: ReportIssues,
): void {
  const key = [
    input.principalId,
    input.scopeType,
    input.scopeId,
    input.roleKey,
  ].join("\u0000");
  const current = grants.get(key);
  const permissionVariant = sortedUnique(input.permissions).join("\u0000");
  if (current === undefined) {
    grants.set(key, {
      principalId: input.principalId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      roleKey: input.roleKey,
      sourceKind: input.sourceKind,
      sourceRefs: new Set([input.sourceRef]),
      permissionVariants:
        permissionVariant === ""
          ? new Set<string>()
          : new Set([permissionVariant]),
    });
    return;
  }
  current.sourceRefs.add(input.sourceRef);
  if (permissionVariant !== "") {
    current.permissionVariants.add(permissionVariant);
  }
  if (current.permissionVariants.size > 1) {
    addConflict(
      issues,
      "grant_source_conflict",
      "The same active Grant has different permission snapshots from legacy sources.",
      sortedUnique(current.sourceRefs),
      {
        principalId: current.principalId,
        scopeType: current.scopeType,
        scopeId: current.scopeId,
        roleKey: current.roleKey,
      },
    );
  }
}

function accountCandidate(
  user: LegacyUserRecord,
  principal: MutablePrincipalCandidate,
  existing: boolean,
): AccountDryRunCandidate {
  return {
    id: user.id,
    principalId: principal.id,
    loginId: user.id,
    status:
      user.status === "active"
        ? principal.status === "active"
          ? "active"
          : "pending"
        : "disabled",
    classification: existing ? "already-mapped" : "ready",
    sourceRef: `collab_team.users:${user.recordKey}`,
  };
}

function toGrantCandidates(
  grants: ReadonlyMap<string, MutableGrantCandidate>,
): GrantDryRunCandidate[] {
  return [...grants.values()]
    .map((grant) => {
      const permissions = [...grant.permissionVariants].sort()[0] ?? "";
      return {
        principalId: grant.principalId,
        scopeType: grant.scopeType,
        scopeId: grant.scopeId,
        roleKey: grant.roleKey,
        permissions: permissions === "" ? [] : permissions.split("\u0000"),
        status: "active" as const,
        sourceKind: grant.sourceKind,
        sourceRefs: sortedUnique(grant.sourceRefs),
      };
    })
    .sort(compareByJson);
}

function detectWorkspaceGrantSourceConflicts(
  grants: readonly GrantDryRunCandidate[],
  issues: ReportIssues,
): void {
  const byPrincipalWorkspace = uniqueBy(
    grants.filter(
      (grant) =>
        grant.scopeType === "workspace" &&
        (grant.sourceKind === "workspace-role" ||
          grant.sourceKind === "employee-role"),
    ),
    (grant) => `${grant.principalId}\u0000${grant.scopeId}`,
  );
  for (const [key, candidates] of byPrincipalWorkspace) {
    const roles = sortedUnique(
      candidates.map((candidate) => candidate.roleKey),
    );
    if (roles.length <= 1) continue;
    const [principalId = "unknown", workspaceId = "unknown"] =
      key.split("\u0000");
    addConflict(
      issues,
      "workspace_grant_source_conflict",
      "Workspace membership role and Employee workspace role disagree on the active role.",
      candidates.flatMap((candidate) => candidate.sourceRefs),
      { principalId, workspaceId, roles },
    );
  }
}

function addSnapshotIssues(
  snapshot: LegacyPrincipalSnapshot,
  issues: ReportIssues,
): void {
  for (const issue of snapshot.issues) {
    addBlocked(
      issues,
      `snapshot_${issue.code}`,
      issue.message,
      [issue.sourceRef ?? `${issue.domain}.json`],
      { domain: issue.domain },
    );
  }
}

function buildAliases(
  snapshot: LegacyPrincipalSnapshot,
  principals: ReadonlyMap<string, MutablePrincipalCandidate>,
  links: ReadonlyMap<string, Set<string>>,
  users: readonly LegacyUserRecord[],
  userPrincipals: ReadonlyMap<string, MutablePrincipalCandidate>,
  employees: readonly LegacyEmployeeRecord[],
  employeePrincipals: ReadonlyMap<string, MutablePrincipalCandidate>,
  teammates: readonly LegacyTeammateRecord[],
  teammatePrincipals: ReadonlyMap<string, MutablePrincipalCandidate>,
  issues: ReportIssues,
): AliasDryRunCandidate[] {
  const aliases: AliasDryRunCandidate[] = [];
  for (const link of snapshot.tables.principalLinks) {
    if (
      link.subjectType === "auth-user" ||
      link.subjectType === "employee" ||
      link.subjectType === "teammate"
    ) {
      const matches =
        link.subjectType === "auth-user"
          ? users.find((user) => user.id === link.subjectId) !== undefined
          : link.subjectType === "employee"
            ? employees.find((employee) => employee.id === link.subjectId) !==
              undefined
            : teammates.find((teammate) => teammate.id === link.subjectId) !==
              undefined;
      if (matches) {
        addAlias(aliases, {
          principalId: link.principalId,
          type: link.subjectType,
          value: link.subjectId,
          classification: "already-mapped",
          sourceRef: `collab_principal.principal_links:${link.recordKey}`,
        });
      }
    }
  }
  for (const user of users) {
    const principal = userPrincipals.get(user.id);
    if (principal === undefined) continue;
    addAlias(aliases, {
      principalId: principal.id,
      type: "auth-user",
      value: user.id,
      classification: classifyLink(
        uniqueLink(links, "auth-user", user.id) !== undefined,
      ),
      sourceRef: `collab_team.users:${user.recordKey}`,
    });
  }
  for (const employee of employees) {
    const principal = employeePrincipals.get(employee.id);
    if (principal === undefined) continue;
    addAlias(aliases, {
      principalId: principal.id,
      type: "employee",
      value: employee.id,
      classification: classifyLink(
        uniqueLink(links, "employee", employee.id) !== undefined,
      ),
      sourceRef: `collab_employee.employees:${employee.recordKey}`,
    });
  }
  for (const teammate of teammates) {
    const principal = teammatePrincipals.get(teammate.id);
    if (principal === undefined) continue;
    addAlias(aliases, {
      principalId: principal.id,
      type: "teammate",
      value: teammate.id,
      classification: classifyLink(
        uniqueLink(links, "teammate", teammate.id) !== undefined,
      ),
      sourceRef: `collab_teammate.teammates:${teammate.recordKey}`,
    });
  }

  for (const profile of snapshot.tables.agentProfiles) {
    const targets = new Set<string>();
    for (const run of snapshot.tables.agentRuns) {
      if (run.agentProfileId !== profile.id) continue;
      if (run.principalId !== undefined) targets.add(run.principalId);
      if (run.employeeId !== undefined) {
        const employeePrincipal = employeePrincipals.get(run.employeeId);
        if (employeePrincipal !== undefined) targets.add(employeePrincipal.id);
      }
    }
    if (targets.size === 1) {
      addAlias(aliases, {
        principalId: [...targets][0]!,
        type: "agent",
        value: profile.id,
        classification: "ready",
        sourceRef: `collab_agent.profiles:${profile.recordKey}`,
      });
    } else if (targets.size > 1) {
      addConflict(
        issues,
        "agent_principal_multiple",
        "One Agent profile resolves to multiple Principal candidates.",
        [
          `collab_agent.profiles:${profile.recordKey}`,
          ...snapshot.tables.agentRuns
            .filter((run) => run.agentProfileId === profile.id)
            .map((run) => `collab_agent.runs:${run.recordKey}`),
        ],
        { agentProfileId: profile.id, principals: sortedUnique(targets) },
      );
    } else {
      addBlocked(
        issues,
        "system_agent_principal_decision_required",
        "The Agent profile has no unique Principal mapping; system Agent mapping requires an explicit decision.",
        [`collab_agent.profiles:${profile.recordKey}`],
        {
          agentProfileId: profile.id,
          visibility: profile.visibility ?? "unknown",
        },
      );
    }
  }

  for (const profile of snapshot.tables.runtimeProfiles) {
    const principal = employeePrincipals.get(profile.employeeId);
    if (principal === undefined) continue;
    addAlias(aliases, {
      principalId: profile.principalId ?? principal.id,
      type: "runtime-profile",
      value: profile.id,
      classification:
        profile.principalId === principal.id ? "already-mapped" : "ready",
      sourceRef: `collab_employee.runtime_profiles:${profile.recordKey}`,
    });
  }

  return aliases.sort(compareByJson);
}

function buildReportBase(input: {
  readonly snapshot: LegacyPrincipalSnapshot;
  readonly asOf: string;
}): {
  readonly report: Omit<
    PrincipalDryRunReport,
    "counts" | "classificationCounts" | "readyToBackfill"
  >;
  readonly counts: PrincipalDryRunCounts;
  readonly factsPrepared: number;
  readonly existingMapped: number;
  readonly skipped: number;
} {
  const issues: ReportIssues = { conflicts: [], orphans: [], blocked: [] };
  const asOfMs = Date.parse(input.asOf);
  const users = input.snapshot.tables.users;
  const employees = input.snapshot.tables.employees;
  const teammates = input.snapshot.tables.teammates;
  const principals = new Map<string, MutablePrincipalCandidate>();

  addSnapshotIssues(input.snapshot, issues);
  if (
    !input.snapshot.sourceFiles.some(
      (file) => file.domain === "collab_team" && file.present,
    )
  ) {
    addBlocked(
      issues,
      "source_collab_team_missing",
      "The reviewed source snapshot has no collab_team domain file.",
      ["collab_team.json"],
    );
  }

  for (const principal of input.snapshot.tables.principals) {
    const next = ensurePrincipal(
      principals,
      {
        id: principal.id,
        kind: principal.kind,
        displayName: principal.displayName,
        status: principal.status,
        source: principal.source,
        reusedExistingPrincipal: true,
        classification: "already-mapped",
        subjectRef: `collab_principal.principals:${principal.recordKey}`,
      },
      issues,
    );
    if (next.kind !== principal.kind) {
      addConflict(
        issues,
        "principal_record_kind_conflict",
        "Duplicate Principal records use the same ID with different kinds.",
        [`collab_principal.principals:${principal.recordKey}`],
        { principalId: principal.id, kind: principal.kind },
      );
    }
  }

  const links = linkSets(
    input.snapshot.tables.principalLinks,
    principals,
    issues,
  );
  const duplicateUserIds = uniqueBy(users, (user) => user.id);
  for (const [id, records] of duplicateUserIds) {
    const uniqueKeys = sortedUnique(records.map((record) => record.recordKey));
    if (uniqueKeys.length <= 1) {
      continue;
    }
    addConflict(
      issues,
      "duplicate_account_id",
      "The same account ID occurs in multiple legacy user records.",
      records.map((record) => `collab_team.users:${record.recordKey}`),
      { accountId: id, recordKeys: uniqueKeys },
    );
  }
  const loginGroups = uniqueBy(users, (user) => user.id.toLowerCase());
  for (const [loginId, records] of loginGroups) {
    if (sortedUnique(records.map((record) => record.id)).length <= 1) continue;
    addConflict(
      issues,
      "duplicate_account_login",
      "Legacy account IDs collide after case-insensitive login normalization.",
      records.map((record) => `collab_team.users:${record.recordKey}`),
      { loginId, accountIds: records.map((record) => record.id) },
    );
  }

  const humanEmployeesByAuthUser = uniqueBy(
    employees.filter(
      (employee) =>
        employee.kind === "human" && employee.authUserId !== undefined,
    ),
    (employee) => employee.authUserId!,
  );
  for (const [authUserId, records] of humanEmployeesByAuthUser) {
    if (records.length > 1) {
      addConflict(
        issues,
        "human_employee_many_to_one_account",
        "Multiple Human Employee records reference the same login account.",
        records.map(
          (record) => `collab_employee.employees:${record.recordKey}`,
        ),
        {
          authUserId,
          employeeIds: records.map((record) => record.id),
        },
      );
    }
  }

  const userPrincipals = new Map<string, MutablePrincipalCandidate>();
  for (const user of users) {
    const linked = uniqueLink(links, "auth-user", user.id);
    const employeesForUser = humanEmployeesByAuthUser.get(user.id) ?? [];
    const employeeLinks = employeesForUser
      .map((employee) => uniqueLink(links, "employee", employee.id))
      .filter((value): value is string => value !== undefined);
    const employeeDeclared = employeesForUser
      .map((employee) => employee.principalId)
      .filter((value): value is string => value !== undefined);
    const chosen = chooseCandidate(
      {
        values: [linked, ...employeeLinks, ...employeeDeclared],
        fallback: derivedPrincipalId("human", user.id),
        code: "account_principal_ambiguous",
        message:
          "Account, Human Employee, and existing Principal links do not agree on one Principal.",
        sourceRefs: [
          `collab_team.users:${user.recordKey}`,
          ...employeesForUser.map(
            (employee) => `collab_employee.employees:${employee.recordKey}`,
          ),
        ],
        details: { accountId: user.id },
      },
      issues,
    );
    const principal = ensurePrincipal(
      principals,
      {
        id: chosen.id,
        kind: "human",
        displayName: user.name,
        status: user.status === "active" ? "active" : "suspended",
        source: "account",
        reusedExistingPrincipal: principals.has(chosen.id),
        classification: chosen.conflicted
          ? "conflict"
          : classifyLink(principals.has(chosen.id)),
        subjectRef: `collab_team.users:${user.recordKey}`,
      },
      issues,
    );
    if (principal.kind !== "human") {
      addConflict(
        issues,
        "account_requires_human_principal",
        "A login account resolved to an AI Principal.",
        [`collab_team.users:${user.recordKey}`],
        { accountId: user.id, principalId: principal.id },
      );
      principal.classification = "conflict";
    }
    userPrincipals.set(user.id, principal);
  }

  const employeePrincipals = new Map<string, MutablePrincipalCandidate>();
  for (const employee of employees) {
    const link = uniqueLink(links, "employee", employee.id);
    const owner =
      employee.kind === "human" && employee.authUserId !== undefined
        ? userPrincipals.get(employee.authUserId)
        : undefined;
    const chosen = chooseCandidate(
      {
        values: [link, employee.principalId, owner?.id],
        fallback: derivedPrincipalId(
          employee.kind === "human" ? "human" : "ai",
          employee.id,
        ),
        code: "employee_principal_ambiguous",
        message:
          "An Employee has conflicting existing Principal, account, or employee mappings.",
        sourceRefs: [`collab_employee.employees:${employee.recordKey}`],
        details: { employeeId: employee.id, employeeKind: employee.kind },
      },
      issues,
    );
    const principal = ensurePrincipal(
      principals,
      {
        id: chosen.id,
        kind: employee.kind === "human" ? "human" : "ai",
        displayName: employee.displayName,
        status:
          employee.status === "archived"
            ? "archived"
            : employee.status === "active" && employee.authStatus !== "disabled"
              ? "active"
              : "suspended",
        source: employee.kind === "human" ? "account" : "ai-companion",
        reusedExistingPrincipal: principals.has(chosen.id),
        classification: chosen.conflicted
          ? "conflict"
          : classifyLink(principals.has(chosen.id)),
        subjectRef: `collab_employee.employees:${employee.recordKey}`,
      },
      issues,
    );
    employeePrincipals.set(employee.id, principal);
  }

  const teammatePrincipals = new Map<string, MutablePrincipalCandidate>();
  for (const teammate of teammates) {
    const link = uniqueLink(links, "teammate", teammate.id);
    const employee =
      teammate.employeeId === undefined
        ? undefined
        : employeePrincipals.get(teammate.employeeId);
    if (teammate.employeeId !== undefined && employee === undefined) {
      addOrphan(
        issues,
        "teammate_employee_missing",
        "A Teammate references an Employee that is absent from the snapshot.",
        [`collab_teammate.teammates:${teammate.recordKey}`],
        { teammateId: teammate.id, employeeId: teammate.employeeId },
      );
    }
    const chosen = chooseCandidate(
      {
        values: [link, teammate.principalId, employee?.id],
        fallback: derivedPrincipalId("ai", teammate.id),
        code: "teammate_principal_ambiguous",
        message:
          "A Teammate has conflicting existing Principal or Employee mappings.",
        sourceRefs: [`collab_teammate.teammates:${teammate.recordKey}`],
        details: { teammateId: teammate.id },
      },
      issues,
    );
    const principal = ensurePrincipal(
      principals,
      {
        id: chosen.id,
        kind: "ai",
        displayName: teammate.name,
        status:
          teammate.state === "archived"
            ? "archived"
            : teammate.state === "active"
              ? "active"
              : "suspended",
        source: "ai-companion",
        reusedExistingPrincipal: principals.has(chosen.id),
        classification: chosen.conflicted
          ? "conflict"
          : classifyLink(principals.has(chosen.id)),
        subjectRef: `collab_teammate.teammates:${teammate.recordKey}`,
      },
      issues,
    );
    teammatePrincipals.set(teammate.id, principal);
  }

  const supportedLinks = new Set<string>();
  for (const [key, targets] of links) {
    if (targets.size === 1) supportedLinks.add(key);
  }
  const accounts: AccountDryRunCandidate[] = [];
  const credentials: CredentialDryRunSummary[] = [];
  for (const user of users) {
    const principal = userPrincipals.get(user.id);
    if (principal === undefined) continue;
    const classification = supportedLinks.has(subjectKey("auth-user", user.id))
      ? "already-mapped"
      : principal.classification === "conflict"
        ? "conflict"
        : "ready";
    const account = accountCandidate(
      user,
      principal,
      classification === "already-mapped",
    );
    accounts.push({
      ...account,
      classification,
    });
    credentials.push({
      accountId: account.id,
      type: "password",
      algorithm: user.credential.algorithm,
      status: user.credential.status,
      present: user.credential.present,
      sourceRef: `collab_team.users:${user.recordKey}`,
    });
  }
  for (const [principalId, principalAccounts] of uniqueBy(
    accounts,
    (account) => account.principalId,
  )) {
    if (principalAccounts.length <= 1) continue;
    addConflict(
      issues,
      "account_principal_multiple",
      "Multiple legacy accounts resolve to one Human Principal.",
      principalAccounts.map((account) => account.sourceRef),
      {
        principalId,
        accountIds: principalAccounts.map((account) => account.id),
      },
    );
  }

  const aliases = buildAliases(
    input.snapshot,
    principals,
    links,
    users,
    userPrincipals,
    employees,
    employeePrincipals,
    teammates,
    teammatePrincipals,
    issues,
  );
  const aliasMap = aliasMaps(aliases, principals, issues);

  const externalIdentityLinks: ExternalIdentityLinkDryRunCandidate[] = [];
  for (const [key, records] of uniqueBy(
    input.snapshot.tables.externalIdentityLinks,
    (link) => `${link.provider}\u0000${link.externalSubjectId}`,
  )) {
    const principalIds = sortedUnique(
      records.map((record) => record.principalId),
    );
    if (principalIds.length > 1) {
      const [provider = "unknown", externalSubjectId = "unknown"] =
        key.split("\u0000");
      addConflict(
        issues,
        "external_identity_link_conflict",
        "One external identity subject maps to multiple Principal candidates.",
        records.map(
          (record) =>
            `collab_principal.external_identity_links:${record.recordKey}`,
        ),
        {
          provider,
          externalSubjectId,
          principals: principalIds,
        },
      );
      continue;
    }
    const link = records[0]!;
    if (!principals.has(link.principalId)) {
      addOrphan(
        issues,
        "external_identity_link_principal_missing",
        "An External Identity Link references an unknown Principal.",
        [`collab_principal.external_identity_links:${link.recordKey}`],
        {
          provider: link.provider,
          externalSubjectId: link.externalSubjectId,
          principalId: link.principalId,
        },
      );
      continue;
    }
    externalIdentityLinks.push({
      principalId: link.principalId,
      provider: link.provider,
      externalSubjectId: link.externalSubjectId,
      status: link.status,
      sourceRef: `collab_principal.external_identity_links:${link.recordKey}`,
    });
  }

  const workspaceMembers: WorkspaceMemberDryRunCandidate[] = [];
  for (const member of input.snapshot.tables.workspaceMembers) {
    const principal = userPrincipals.get(member.userId);
    if (principal === undefined) {
      addOrphan(
        issues,
        "workspace_member_user_missing",
        "A legacy workspace member references a user absent from the snapshot.",
        [
          `collab_team.workspace_members:${member.workspaceId}:${member.userId}`,
        ],
        { workspaceId: member.workspaceId, userId: member.userId },
      );
      continue;
    }
    workspaceMembers.push({
      workspaceId: member.workspaceId,
      principalId: principal.id,
      status: "active",
      sourceRefs: [
        `collab_team.workspace_members:${member.workspaceId}:${member.userId}`,
      ],
    });
  }
  const uniqueWorkspaceMembers = [
    ...uniqueBy(
      workspaceMembers,
      (member) => `${member.workspaceId}\u0000${member.principalId}`,
    ).entries(),
  ].map(([, values]) => ({
    workspaceId: values[0]!.workspaceId,
    principalId: values[0]!.principalId,
    status: "active" as const,
    sourceRefs: sortedUnique(values.flatMap((value) => value.sourceRefs)),
  }));

  const grants = new Map<string, MutableGrantCandidate>();
  for (const user of users) {
    const principal = userPrincipals.get(user.id);
    if (principal === undefined) continue;
    addGrant(
      grants,
      {
        principalId: principal.id,
        scopeType: "platform",
        scopeId: "platform",
        roleKey: user.role.toUpperCase(),
        permissions: [],
        sourceKind: "platform-role",
        sourceRef: `collab_team.users:${user.recordKey}`,
      },
      issues,
    );
  }
  for (const member of input.snapshot.tables.workspaceMembers) {
    const principal = userPrincipals.get(member.userId);
    if (principal === undefined) continue;
    addGrant(
      grants,
      {
        principalId: principal.id,
        scopeType: "workspace",
        scopeId: member.workspaceId,
        roleKey: member.role,
        permissions: [],
        sourceKind: "workspace-role",
        sourceRef: `collab_team.workspace_members:${member.workspaceId}:${member.userId}`,
      },
      issues,
    );
  }
  for (const assignment of input.snapshot.tables.roleAssignments) {
    if (
      assignment.status !== "active" ||
      isExpired(assignment.expiresAt, asOfMs)
    ) {
      continue;
    }
    const principal = employeePrincipals.get(assignment.employeeId);
    if (principal === undefined) {
      addOrphan(
        issues,
        "employee_role_assignment_employee_missing",
        "An active Employee workspace role references an Employee absent from the snapshot.",
        [`collab_employee.role_assignments:${assignment.recordKey}`],
        {
          assignmentId: assignment.id,
          employeeId: assignment.employeeId,
        },
      );
      continue;
    }
    if (
      assignment.principalId !== undefined &&
      assignment.principalId !== principal.id
    ) {
      addConflict(
        issues,
        "employee_role_assignment_principal_mismatch",
        "An Employee workspace role has a Principal ID that disagrees with the Employee mapping.",
        [`collab_employee.role_assignments:${assignment.recordKey}`],
        {
          assignmentId: assignment.id,
          expectedPrincipalId: principal.id,
          recordedPrincipalId: assignment.principalId,
        },
      );
    }
    addGrant(
      grants,
      {
        principalId: principal.id,
        scopeType: "workspace",
        scopeId: assignment.workspaceId,
        roleKey: assignment.role,
        permissions: assignment.permissions,
        sourceKind: "employee-role",
        sourceRef: `collab_employee.role_assignments:${assignment.recordKey}`,
      },
      issues,
    );
  }

  const leaderPrincipalIds = new Map<string, Set<string>>();
  const workspaceSeats = new Map(
    input.snapshot.tables.workspaceRoleConfigs.map((config) => [
      config.workspaceId,
      new Set(config.seats.map((seat) => seat.id)),
    ]),
  );
  for (const assignment of input.snapshot.tables.assignments) {
    if (assignment.status === "released") continue;
    const configuredSeats = workspaceSeats.get(assignment.workspaceId);
    if (
      configuredSeats !== undefined &&
      !configuredSeats.has(assignment.seatId)
    ) {
      addOrphan(
        issues,
        "project_assignment_seat_missing",
        "A project assignment references a role seat absent from the workspace role config.",
        [`collab_assignment.assignments:${assignment.recordKey}`],
        {
          workspaceId: assignment.workspaceId,
          seatId: assignment.seatId,
        },
      );
    }
    let principalId: string | undefined;
    if (assignment.assigneeKind === "user") {
      principalId = resolveAlias(aliasMap, "auth-user", assignment.assigneeId);
      if (principalId === undefined) {
        addOrphan(
          issues,
          "project_assignment_user_missing",
          "A project role assignment references an unknown login user.",
          [`collab_assignment.assignments:${assignment.recordKey}`],
          {
            workspaceId: assignment.workspaceId,
            seatId: assignment.seatId,
            assigneeId: assignment.assigneeId,
          },
        );
      }
    } else {
      const resolved = resolveAgentActor(aliasMap, assignment.assigneeId);
      principalId = resolved.principalId;
      if (resolved.ambiguous) {
        addConflict(
          issues,
          "project_assignment_actor_ambiguous",
          "A project Agent assignee resolves to multiple Principal candidates.",
          [`collab_assignment.assignments:${assignment.recordKey}`],
          {
            workspaceId: assignment.workspaceId,
            seatId: assignment.seatId,
            assigneeId: assignment.assigneeId,
          },
        );
      } else if (principalId === undefined) {
        addOrphan(
          issues,
          "project_assignment_actor_missing",
          "A project Agent assignee cannot be resolved to a Principal.",
          [`collab_assignment.assignments:${assignment.recordKey}`],
          {
            workspaceId: assignment.workspaceId,
            seatId: assignment.seatId,
            assigneeId: assignment.assigneeId,
          },
        );
      }
    }
    if (principalId === undefined) continue;
    if (
      assignment.principalId !== undefined &&
      assignment.principalId !== principalId
    ) {
      addConflict(
        issues,
        "project_assignment_principal_mismatch",
        "A project role assignment has a Principal ID that disagrees with its legacy actor.",
        [`collab_assignment.assignments:${assignment.recordKey}`],
        {
          assignmentId: assignment.id,
          expectedPrincipalId: principalId,
          recordedPrincipalId: assignment.principalId,
        },
      );
    }
    addGrant(
      grants,
      {
        principalId,
        scopeType: "project",
        scopeId: assignment.workspaceId,
        roleKey: `project-role:${assignment.seatId}`,
        permissions: assignment.permissions,
        sourceKind: "project-role",
        sourceRef: `collab_assignment.assignments:${assignment.recordKey}`,
      },
      issues,
    );
    if (assignment.leader) {
      const leaders =
        leaderPrincipalIds.get(assignment.workspaceId) ?? new Set<string>();
      leaders.add(principalId);
      leaderPrincipalIds.set(assignment.workspaceId, leaders);
    }
  }

  for (const project of input.snapshot.tables.projects) {
    const ownerIds = new Set<string>();
    const sourceRefs = [`collab_project.projects:${project.recordKey}`];
    if (project.ownerId !== undefined) {
      const resolved = resolveBareActor(aliasMap, project.ownerId);
      if (resolved.length === 1) {
        ownerIds.add(resolved[0]!);
      } else if (resolved.length > 1) {
        addConflict(
          issues,
          "project_owner_actor_ambiguous",
          "A project owner ID resolves to multiple Principal candidates.",
          sourceRefs,
          {
            workspaceId: project.workspaceId,
            ownerId: project.ownerId,
            principals: resolved,
          },
        );
      } else {
        addOrphan(
          issues,
          "project_owner_actor_missing",
          "A project owner ID cannot be resolved to a Principal.",
          sourceRefs,
          { workspaceId: project.workspaceId, ownerId: project.ownerId },
        );
      }
    }
    for (const leader of leaderPrincipalIds.get(project.workspaceId) ?? []) {
      ownerIds.add(leader);
    }
    if (ownerIds.size > 1) {
      addConflict(
        issues,
        "project_multiple_owners",
        "A project resolves to more than one owner Principal.",
        sourceRefs,
        {
          workspaceId: project.workspaceId,
          principals: sortedUnique(ownerIds),
        },
      );
    } else if (ownerIds.size === 0) {
      addOrphan(
        issues,
        "project_owner_missing",
        "A project has neither a resolvable owner nor an active leader assignment.",
        sourceRefs,
        { workspaceId: project.workspaceId },
      );
    }
    for (const principalId of ownerIds) {
      const principal = principals.get(principalId);
      if (principal?.kind !== "human") {
        addBlocked(
          issues,
          "project_owner_not_human",
          "A project owner does not resolve to a Human Principal.",
          sourceRefs,
          { workspaceId: project.workspaceId, principalId },
        );
      }
      addGrant(
        grants,
        {
          principalId,
          scopeType: "project",
          scopeId: project.workspaceId,
          roleKey: "PROJECT_OWNER",
          permissions: [],
          sourceKind: "project-role",
          sourceRef: `collab_project.projects:${project.recordKey}`,
        },
        issues,
      );
    }
  }

  for (const profile of input.snapshot.tables.runtimeProfiles) {
    const employeePrincipal = employeePrincipals.get(profile.employeeId);
    const sourceRef = `collab_employee.runtime_profiles:${profile.recordKey}`;
    if (employeePrincipal === undefined) {
      addOrphan(
        issues,
        "runtime_profile_employee_missing",
        "A Runtime Profile references an Employee absent from the snapshot.",
        [sourceRef],
        { runtimeProfileId: profile.id, employeeId: profile.employeeId },
      );
      continue;
    }
    if (profile.principalId === undefined) {
      addBlocked(
        issues,
        "runtime_profile_principal_missing",
        "A Runtime Profile is missing its Principal ID.",
        [sourceRef],
        {
          runtimeProfileId: profile.id,
          employeeId: profile.employeeId,
          expectedPrincipalId: employeePrincipal.id,
        },
      );
    } else if (profile.principalId !== employeePrincipal.id) {
      addConflict(
        issues,
        "runtime_profile_principal_mismatch",
        "A Runtime Profile Principal ID disagrees with its Employee mapping.",
        [sourceRef],
        {
          runtimeProfileId: profile.id,
          expectedPrincipalId: employeePrincipal.id,
          recordedPrincipalId: profile.principalId,
        },
      );
    }
  }

  for (const ticket of input.snapshot.tables.actionTickets) {
    const employeePrincipal = employeePrincipals.get(ticket.employeeId);
    const sourceRef = `collab_employee.action_tickets:${ticket.recordKey}`;
    if (employeePrincipal === undefined) {
      addOrphan(
        issues,
        "action_ticket_employee_missing",
        "An Action Ticket references an Employee absent from the snapshot.",
        [sourceRef],
        { actionTicketId: ticket.id, employeeId: ticket.employeeId },
      );
      continue;
    }
    if (ticket.principalId === undefined) {
      addBlocked(
        issues,
        "action_ticket_principal_missing",
        "An Action Ticket is missing its Principal ID.",
        [sourceRef],
        {
          actionTicketId: ticket.id,
          employeeId: ticket.employeeId,
          expectedPrincipalId: employeePrincipal.id,
        },
      );
    } else if (ticket.principalId !== employeePrincipal.id) {
      addConflict(
        issues,
        "action_ticket_principal_mismatch",
        "An Action Ticket Principal ID disagrees with its Employee mapping.",
        [sourceRef],
        {
          actionTicketId: ticket.id,
          expectedPrincipalId: employeePrincipal.id,
          recordedPrincipalId: ticket.principalId,
        },
      );
    }
  }

  for (const delegation of input.snapshot.tables.delegations) {
    const sourceRef = `collab_employee.delegations:${delegation.recordKey}`;
    const ownerEmployee = employeePrincipals.get(delegation.ownerId);
    const ownerAccount = resolveAlias(
      aliasMap,
      "auth-user",
      delegation.ownerAuthUserId,
    );
    const chosen = chooseCandidate(
      {
        values: [ownerEmployee?.id, ownerAccount],
        fallback: derivedPrincipalId("human", delegation.ownerId),
        code: "delegation_owner_ambiguous",
        message:
          "A Delegation owner account and Employee resolve to different Principals.",
        sourceRefs: [sourceRef],
        details: { delegationId: delegation.id },
      },
      issues,
    );
    if (ownerEmployee === undefined && ownerAccount === undefined) {
      addOrphan(
        issues,
        "delegation_owner_missing",
        "A Delegation owner cannot be resolved from Employee or account aliases.",
        [sourceRef],
        {
          delegationId: delegation.id,
          ownerId: delegation.ownerId,
          ownerAuthUserId: delegation.ownerAuthUserId,
        },
      );
    }
    if (delegation.ownerPrincipalId === undefined) {
      addBlocked(
        issues,
        "delegation_principal_missing",
        "A Delegation is missing its owner Principal ID.",
        [sourceRef],
        {
          delegationId: delegation.id,
          ownerId: delegation.ownerId,
          expectedPrincipalId: chosen.id,
        },
      );
    } else if (delegation.ownerPrincipalId !== chosen.id) {
      addConflict(
        issues,
        "delegation_principal_mismatch",
        "A Delegation owner Principal ID disagrees with the legacy owner mapping.",
        [sourceRef],
        {
          delegationId: delegation.id,
          expectedPrincipalId: chosen.id,
          recordedPrincipalId: delegation.ownerPrincipalId,
        },
      );
    }
  }

  for (const profile of input.snapshot.tables.principalRuntimeProfiles) {
    if (!principals.has(profile.principalId)) {
      addOrphan(
        issues,
        "principal_runtime_profile_principal_missing",
        "A Principal Runtime Profile references an unknown Principal.",
        [`collab_principal_runtime.profiles:${profile.recordKey}`],
        {
          runtimeProfileId: profile.id,
          principalId: profile.principalId,
        },
      );
    }
  }
  for (const ticket of input.snapshot.tables.principalRuntimeTickets) {
    if (!principals.has(ticket.principalId)) {
      addOrphan(
        issues,
        "principal_action_ticket_principal_missing",
        "A Principal Action Ticket references an unknown Principal.",
        [`collab_principal_runtime.action_tickets:${ticket.recordKey}`],
        { actionTicketId: ticket.id, principalId: ticket.principalId },
      );
    }
  }

  let auditActorsResolved = 0;
  let auditActorsUnresolved = 0;
  const unresolvedAuditActors = new Set<string>();
  for (const audit of input.snapshot.tables.auditActors) {
    const resolved = resolveBareActor(aliasMap, audit.actorId);
    if (resolved.length === 1) {
      auditActorsResolved += 1;
    } else {
      auditActorsUnresolved += 1;
      unresolvedAuditActors.add(audit.actorId);
    }
  }
  for (const actorId of unresolvedAuditActors) {
    addOrphan(
      issues,
      "audit_actor_unresolved",
      "A legacy audit actor cannot be uniquely resolved and will not be replaced with system.",
      ["collab_team.audit_log"],
      { actorId },
    );
  }

  const grantCandidates = toGrantCandidates(grants);
  detectWorkspaceGrantSourceConflicts(grantCandidates, issues);

  const principalCandidates = [...principals.values()]
    .map((principal) => ({
      id: principal.id,
      kind: principal.kind,
      displayName: principal.displayName,
      status: principal.status,
      source: principal.source,
      classification: principal.classification,
      reusedExistingPrincipal: principal.reusedExistingPrincipal,
    }))
    .sort(compareByJson);
  const sortedAccounts = accounts.sort(compareByJson);
  const sortedAliases = aliases.sort(compareByJson);
  const sortedGrants = grantCandidates;
  const sourceFilesPresent = input.snapshot.sourceFiles.filter(
    (file) => file.present,
  ).length;
  const platformGrants = sortedGrants.filter(
    (grant) => grant.scopeType === "platform",
  ).length;
  const workspaceGrants = sortedGrants.filter(
    (grant) => grant.scopeType === "workspace",
  ).length;
  const projectGrants = sortedGrants.filter(
    (grant) => grant.scopeType === "project",
  ).length;
  const counts: PrincipalDryRunCounts = {
    sourceFilesPresent,
    users: users.length,
    workspaceMemberships: input.snapshot.tables.workspaceMembers.length,
    employeesHuman: employees.filter((employee) => employee.kind === "human")
      .length,
    employeesDigital: employees.filter(
      (employee) => employee.kind === "digital",
    ).length,
    teammates: teammates.length,
    projectAssignments: input.snapshot.tables.assignments.length,
    workspaceRoleSeats: input.snapshot.tables.workspaceRoleConfigs.reduce(
      (total, config) => total + config.seats.length,
      0,
    ),
    projects: input.snapshot.tables.projects.length,
    projectRoleDefinitions: input.snapshot.tables.projects.reduce(
      (total, project) => total + project.projectRoles.length,
      0,
    ),
    principalsExisting: input.snapshot.tables.principals.length,
    principalsCandidate: principalCandidates.length,
    principalsHumanCandidate: principalCandidates.filter(
      (principal) => principal.kind === "human",
    ).length,
    principalsAiCandidate: principalCandidates.filter(
      (principal) => principal.kind === "ai",
    ).length,
    aliasesCandidate: sortedAliases.length,
    aliasManyToOnePrincipalGroups: aliasMap.manyToOneGroups,
    accountsCandidate: sortedAccounts.length,
    credentialsCandidate: credentials.length,
    externalIdentityLinksCandidate: externalIdentityLinks.length,
    workspaceMembersCandidate: uniqueWorkspaceMembers.length,
    platformGrantsCandidate: platformGrants,
    workspaceGrantsCandidate: workspaceGrants,
    projectGrantsCandidate: projectGrants,
    runtimeProfiles: input.snapshot.tables.runtimeProfiles.length,
    actionTickets: input.snapshot.tables.actionTickets.length,
    delegations: input.snapshot.tables.delegations.length,
    auditActorsResolved,
    auditActorsUnresolved,
    sessionsSkipped: input.snapshot.tables.sessions.length,
  };
  const factsPrepared =
    principalCandidates.length +
    sortedAccounts.length +
    credentials.length +
    uniqueWorkspaceMembers.length +
    sortedAliases.length +
    externalIdentityLinks.length +
    sortedGrants.length;
  const existingMapped = sortedAliases.filter(
    (alias) => alias.classification === "already-mapped",
  ).length;
  const skipped =
    input.snapshot.tables.sessions.length +
    input.snapshot.tables.auditActors.length +
    input.snapshot.tables.agentRuns.length;

  return {
    report: {
      schemaVersion: PRINCIPAL_DRY_RUN_SCHEMA,
      mode: "dry-run",
      sourceDigest: input.snapshot.sourceDigest,
      asOf: input.asOf,
      sourceFiles: input.snapshot.sourceFiles,
      candidates: {
        principals: principalCandidates,
        accounts: sortedAccounts,
        credentials: credentials.sort(compareByJson),
        workspaceMembers: uniqueWorkspaceMembers.sort(compareByJson),
        aliases: sortedAliases,
        externalIdentityLinks: externalIdentityLinks.sort(compareByJson),
        grants: sortedGrants,
      },
      conflicts: issues.conflicts.sort(compareIssue),
      orphans: issues.orphans.sort(compareIssue),
      blocked: issues.blocked.sort(compareIssue),
    },
    counts,
    factsPrepared,
    existingMapped,
    skipped,
  };
}

export function buildPrincipalDryRunReport(input: {
  readonly snapshot: LegacyPrincipalSnapshot;
  readonly asOf: string;
}): PrincipalDryRunReport {
  const parsedAsOf = Date.parse(input.asOf);
  if (!Number.isFinite(parsedAsOf) || !input.asOf.endsWith("Z")) {
    throw new Error("asOf must be an RFC 3339 UTC timestamp ending in Z.");
  }
  const base = buildReportBase(input);
  const hasBlockingIssues =
    base.report.conflicts.length > 0 ||
    base.report.orphans.length > 0 ||
    base.report.blocked.length > 0;
  const hasMinimumFacts =
    base.counts.users > 0 ||
    base.counts.employeesHuman > 0 ||
    base.counts.employeesDigital > 0;
  return {
    ...base.report,
    counts: base.counts,
    classificationCounts: {
      ready: hasBlockingIssues ? 0 : base.factsPrepared,
      alreadyMapped: base.existingMapped,
      skippedNonTarget: base.skipped,
      conflict: base.report.conflicts.length,
      orphan: base.report.orphans.length,
      blockedSecurityDecision: base.report.blocked.length,
    },
    readyToBackfill: hasMinimumFacts && !hasBlockingIssues,
  };
}

function markdownIssues(
  title: string,
  issues: readonly DryRunIssue[],
  limit = 40,
): string[] {
  const lines = [`## ${title}`, ""];
  if (issues.length === 0) {
    lines.push("- None");
    return lines;
  }
  for (const issue of issues.slice(0, limit)) {
    const refs =
      issue.sourceRefs.length === 0 ? "" : ` (${issue.sourceRefs.join(", ")})`;
    lines.push(`- \`${issue.code}\`: ${issue.message}${refs}`);
  }
  if (issues.length > limit) {
    lines.push(`- ${issues.length - limit} additional issues are in JSON.`);
  }
  return lines;
}

export function principalDryRunMarkdown(report: PrincipalDryRunReport): string {
  const counts = report.counts;
  const lines = [
    "# Identity / Principal Legacy Dry-run",
    "",
    `- Status: ${report.readyToBackfill ? "READY" : "BLOCKED"} (dry-run only)`,
    `- Source digest: \`${report.sourceDigest}\``,
    `- As of: \`${report.asOf}\``,
    "- Credential values and session token hashes are intentionally absent.",
    "",
    "## Source Summary",
    "",
    "| Metric | Count |",
    "| --- | ---: |",
    `| Source files present | ${counts.sourceFilesPresent} |`,
    `| Users | ${counts.users} |`,
    `| Human Employees | ${counts.employeesHuman} |`,
    `| AI Employees | ${counts.employeesDigital} |`,
    `| Teammates | ${counts.teammates} |`,
    `| Project assignments | ${counts.projectAssignments} |`,
    `| Workspace role seats | ${counts.workspaceRoleSeats} |`,
    `| Projects | ${counts.projects} |`,
    `| Project role definitions | ${counts.projectRoleDefinitions} |`,
    `| Sessions skipped | ${counts.sessionsSkipped} |`,
    "",
    "## Candidate Summary",
    "",
    "| Candidate | Count |",
    "| --- | ---: |",
    `| Principals | ${counts.principalsCandidate} |`,
    `| Human Principals | ${counts.principalsHumanCandidate} |`,
    `| AI Principals | ${counts.principalsAiCandidate} |`,
    `| Aliases | ${counts.aliasesCandidate} |`,
    `| Alias many-to-one Principal groups | ${counts.aliasManyToOnePrincipalGroups} |`,
    `| Accounts | ${counts.accountsCandidate} |`,
    `| Credential summaries | ${counts.credentialsCandidate} |`,
    `| Workspace members | ${counts.workspaceMembersCandidate} |`,
    `| External identity links | ${counts.externalIdentityLinksCandidate} |`,
    `| Platform grants | ${counts.platformGrantsCandidate} |`,
    `| Workspace grants | ${counts.workspaceGrantsCandidate} |`,
    `| Project grants | ${counts.projectGrantsCandidate} |`,
    "",
    "## Classification",
    "",
    "| Classification | Count |",
    "| --- | ---: |",
    `| Ready | ${report.classificationCounts.ready} |`,
    `| Already mapped | ${report.classificationCounts.alreadyMapped} |`,
    `| Skipped non-target | ${report.classificationCounts.skippedNonTarget} |`,
    `| Conflict | ${report.classificationCounts.conflict} |`,
    `| Orphan | ${report.classificationCounts.orphan} |`,
    `| Blocked security decision | ${report.classificationCounts.blockedSecurityDecision} |`,
    "",
    ...markdownIssues("Conflicts", report.conflicts),
    "",
    ...markdownIssues("Orphans", report.orphans),
    "",
    ...markdownIssues("Blocked", report.blocked),
    "",
    "## Notes",
    "",
    "- This report is generated from a synthetic or explicitly supplied read-only snapshot.",
    "- External identity links are not inferred without an authoritative HRM/OIDC/SCIM source.",
    "- A ready result is a prerequisite for a later backfill batch, not authorization to execute it.",
    "",
  ];
  return lines.join("\n");
}

export function stablePrincipalDryRunJson(
  report: PrincipalDryRunReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function writePrincipalDryRunReports(input: {
  readonly report: PrincipalDryRunReport;
  readonly jsonPath: string;
  readonly markdownPath?: string;
}): Promise<{ readonly jsonPath: string; readonly markdownPath: string }> {
  const markdownPath =
    input.markdownPath ??
    (extname(input.jsonPath) === ".json"
      ? input.jsonPath.slice(0, -5) + ".md"
      : `${input.jsonPath}.md`);
  await mkdir(dirname(input.jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(
    input.jsonPath,
    stablePrincipalDryRunJson(input.report),
    "utf8",
  );
  await writeFile(markdownPath, principalDryRunMarkdown(input.report), "utf8");
  return { jsonPath: input.jsonPath, markdownPath };
}
