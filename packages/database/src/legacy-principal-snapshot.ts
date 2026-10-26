import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const LEGACY_PRINCIPAL_DOMAINS = [
  "collab_team",
  "collab_principal",
  "collab_employee",
  "collab_teammate",
  "collab_assignment",
  "collab_project",
  "collab_agent",
  "collab_principal_runtime",
] as const;

export type LegacyPrincipalDomain = (typeof LEGACY_PRINCIPAL_DOMAINS)[number];

export interface LegacyAdapterIssue {
  readonly code: string;
  readonly message: string;
  readonly domain: LegacyPrincipalDomain;
  readonly sourceRef?: string;
}

export interface LegacySourceFile {
  readonly domain: LegacyPrincipalDomain;
  readonly fileName: string;
  readonly present: boolean;
  readonly bytes: number;
  /** Raw source bytes are hashed but never returned. */
  readonly sha256: string | null;
}

export interface LegacyCredentialSummary {
  readonly present: boolean;
  readonly algorithm: "scrypt" | "unknown";
  readonly status: "active" | "disabled";
}

export interface LegacyUserRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly status: "active" | "disabled";
  readonly credential: LegacyCredentialSummary;
  readonly createdAt?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export interface LegacyWorkspaceMemberRecord {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: string;
  readonly addedAt?: string | undefined;
  readonly addedBy?: string | undefined;
}

export interface LegacySessionSummary {
  readonly recordKey: string;
  readonly userId: string;
  readonly createdAt?: string | undefined;
  readonly expiresAt?: string | undefined;
}

export interface LegacyAuditActorRecord {
  readonly id: string;
  readonly actorId: string;
  readonly action: string;
  readonly at?: string | undefined;
  readonly workspaceId?: string | undefined;
}

export interface LegacyPrincipalRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly kind: "human" | "ai";
  readonly displayName: string;
  readonly status: "active" | "suspended" | "archived";
  readonly source: string;
}

export interface LegacyPrincipalLinkRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly principalId: string;
  readonly subjectType: string;
  readonly subjectId: string;
}

export interface LegacyPrincipalGrantRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly principalId: string;
  readonly scopeType: "platform" | "workspace" | "project";
  readonly scopeId: string;
  readonly role: string;
  readonly permissions: readonly string[];
  readonly status: "active" | "revoked" | "expired";
  readonly expiresAt?: string | undefined;
}

export interface LegacyExternalIdentityLinkRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly principalId: string;
  readonly provider: string;
  readonly externalSubjectId: string;
  readonly status: "active" | "retired";
}

export interface LegacyEmployeeRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly kind: "human" | "digital";
  readonly displayName: string;
  readonly status: "draft" | "active" | "suspended" | "archived";
  readonly authUserId?: string | undefined;
  readonly authStatus?: "active" | "disabled" | undefined;
  readonly principalId?: string | undefined;
}

export interface LegacyRoleAssignmentRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly employeeId: string;
  readonly principalId?: string | undefined;
  readonly workspaceId: string;
  readonly role: string;
  readonly permissions: readonly string[];
  readonly status: "active" | "revoked";
  readonly expiresAt?: string | undefined;
}

export interface LegacyRuntimeProfileRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly employeeId: string;
  readonly principalId?: string | undefined;
  readonly workspaceId: string;
  readonly status: "active" | "disabled";
}

export interface LegacyActionTicketRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly employeeId: string;
  readonly principalId?: string | undefined;
  readonly ownerId?: string | undefined;
  readonly workspaceId: string;
  readonly status: "active" | "revoked" | "expired";
}

export interface LegacyDelegationRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly ownerId: string;
  readonly ownerPrincipalId?: string | undefined;
  readonly ownerAuthUserId: string;
  readonly teammateId?: string | undefined;
  readonly workspaceId: string;
  readonly status: "active" | "paused" | "revoked" | "expired" | "completed";
}

export interface LegacyTeammateRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly name: string;
  readonly employeeId?: string | undefined;
  readonly principalId?: string | undefined;
  readonly ownerUserId: string;
  readonly state: string;
}

export interface LegacyWorkspaceRoleConfigRecord {
  readonly recordKey: string;
  readonly workspaceId: string;
  readonly seats: readonly {
    readonly id: string;
    readonly label: string;
    readonly permissions: readonly string[];
  }[];
}

export interface LegacyAssignmentRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly workspaceId: string;
  readonly seatId: string;
  readonly seatLabel: string;
  readonly participantKind: "human" | "agent";
  readonly assigneeKind: "user" | "agent";
  readonly assigneeId: string;
  readonly principalId?: string | undefined;
  readonly permissions: readonly string[];
  readonly leader: boolean;
  readonly status: "claimed" | "assigned" | "released";
}

export interface LegacyProjectRoleDefinition {
  readonly id: string;
  readonly code: string;
  readonly permissions: readonly string[];
}

export interface LegacyProjectRecord {
  readonly recordKey: string;
  readonly workspaceId: string;
  readonly ownerId?: string | undefined;
  readonly status: string;
  readonly projectRoles: readonly LegacyProjectRoleDefinition[];
}

export interface LegacyAgentProfileRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly workspaceId: string;
  readonly visibility?: string | undefined;
  readonly status: string;
}

export interface LegacyAgentRunRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly agentProfileId: string;
  readonly employeeId?: string | undefined;
  readonly principalId?: string | undefined;
  readonly status: string;
}

export interface LegacyPrincipalRuntimeProfileRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly principalId: string;
  readonly workspaceId: string;
  readonly status: "active" | "disabled";
}

export interface LegacyPrincipalRuntimeTicketRecord {
  readonly recordKey: string;
  readonly id: string;
  readonly principalId: string;
  readonly runtimeProfileId: string;
  readonly workspaceId: string;
  readonly status: "active" | "revoked" | "expired";
}

export interface LegacyPrincipalSnapshotTables {
  readonly users: readonly LegacyUserRecord[];
  readonly workspaceMembers: readonly LegacyWorkspaceMemberRecord[];
  readonly sessions: readonly LegacySessionSummary[];
  readonly auditActors: readonly LegacyAuditActorRecord[];
  readonly principals: readonly LegacyPrincipalRecord[];
  readonly principalLinks: readonly LegacyPrincipalLinkRecord[];
  readonly principalGrants: readonly LegacyPrincipalGrantRecord[];
  readonly externalIdentityLinks: readonly LegacyExternalIdentityLinkRecord[];
  readonly employees: readonly LegacyEmployeeRecord[];
  readonly roleAssignments: readonly LegacyRoleAssignmentRecord[];
  readonly runtimeProfiles: readonly LegacyRuntimeProfileRecord[];
  readonly actionTickets: readonly LegacyActionTicketRecord[];
  readonly delegations: readonly LegacyDelegationRecord[];
  readonly teammates: readonly LegacyTeammateRecord[];
  readonly workspaceRoleConfigs: readonly LegacyWorkspaceRoleConfigRecord[];
  readonly assignments: readonly LegacyAssignmentRecord[];
  readonly projects: readonly LegacyProjectRecord[];
  readonly agentProfiles: readonly LegacyAgentProfileRecord[];
  readonly agentRuns: readonly LegacyAgentRunRecord[];
  readonly principalRuntimeProfiles: readonly LegacyPrincipalRuntimeProfileRecord[];
  readonly principalRuntimeTickets: readonly LegacyPrincipalRuntimeTicketRecord[];
}

export interface LegacyPrincipalSnapshot {
  readonly sourceDigest: string;
  readonly sourceFiles: readonly LegacySourceFile[];
  readonly tables: LegacyPrincipalSnapshotTables;
  readonly issues: readonly LegacyAdapterIssue[];
}

export interface ReadLegacyPrincipalSnapshotInput {
  /** Required. The adapter never consults DSH_HOME or any process default. */
  readonly sourceHome: string;
}

export class LegacySnapshotError extends Error {
  constructor(
    readonly code: "invalid_source" | "source_not_found" | "source_unreadable",
    message: string,
  ) {
    super(message);
    this.name = "LegacySnapshotError";
  }
}

type JsonRecord = Record<string, unknown>;
type DomainTables = Record<string, JsonRecord>;

interface DomainReadResult {
  readonly domain: LegacyPrincipalDomain;
  readonly fileName: string;
  readonly present: boolean;
  readonly bytes: number;
  readonly sha256: string | null;
  readonly tables: DomainTables;
}

const DOMAIN_SPECS = LEGACY_PRINCIPAL_DOMAINS.map((domain) => ({
  domain,
  fileName: `${domain}.json`,
}));

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = stringValue(item);
    return parsed === undefined ? [] : [parsed];
  });
}

function recordsIn(
  tables: DomainTables,
  tableName: string,
): [string, JsonRecord][] {
  const table = tables[tableName];
  if (table === undefined) return [];
  return Object.entries(table).flatMap(([key, raw]) =>
    isRecord(raw) ? [[key, raw] as const] : [],
  );
}

function invalidRecordIssue(
  issues: LegacyAdapterIssue[],
  domain: LegacyPrincipalDomain,
  sourceRef: string,
): void {
  issues.push({
    code: "invalid_legacy_record",
    domain,
    sourceRef,
    message: "Legacy table entry is not an object and was skipped.",
  });
}

async function readDomain(
  sourceHome: string,
  domain: LegacyPrincipalDomain,
  fileName: string,
  issues: LegacyAdapterIssue[],
): Promise<DomainReadResult> {
  const path = join(sourceHome, "storages", fileName);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        domain,
        fileName,
        present: false,
        bytes: 0,
        sha256: null,
        tables: {},
      };
    }
    throw new LegacySnapshotError(
      "source_unreadable",
      `Unable to read ${fileName} from the explicit source directory.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    issues.push({
      code: "invalid_source_json",
      domain,
      sourceRef: fileName,
      message: "Legacy domain file is not valid JSON.",
    });
    return {
      domain,
      fileName,
      present: true,
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
      tables: {},
    };
  }

  if (!isRecord(parsed) || !isRecord(parsed["tables"])) {
    issues.push({
      code: "malformed_source_domain",
      domain,
      sourceRef: fileName,
      message: "Legacy domain file does not contain a tables object.",
    });
    return {
      domain,
      fileName,
      present: true,
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
      tables: {},
    };
  }

  const unit = isRecord(parsed["unit"]) ? parsed["unit"] : undefined;
  const unitName = stringValue(unit?.["name"]);
  const unitVersion = unit?.["version"];
  if (unitName !== undefined && unitName !== domain) {
    issues.push({
      code: "source_domain_mismatch",
      domain,
      sourceRef: fileName,
      message: `Legacy domain identifies as ${unitName}, not ${domain}.`,
    });
  }
  if (unitVersion !== undefined && unitVersion !== 1) {
    issues.push({
      code: "source_domain_version",
      domain,
      sourceRef: fileName,
      message: `Legacy domain version ${String(unitVersion)} is not the reviewed version 1.`,
    });
  }

  const tables: DomainTables = {};
  for (const [tableName, rawTable] of Object.entries(parsed["tables"])) {
    if (!isRecord(rawTable)) {
      issues.push({
        code: "malformed_source_table",
        domain,
        sourceRef: `${fileName}:${tableName}`,
        message: "Legacy table is not an object keyed by record ID.",
      });
      tables[tableName] = {};
      continue;
    }
    const records: JsonRecord = {};
    for (const [key, value] of Object.entries(rawTable)) {
      if (!isRecord(value)) {
        invalidRecordIssue(issues, domain, `${fileName}:${tableName}:${key}`);
        continue;
      }
      records[key] = value;
    }
    tables[tableName] = records;
  }

  return {
    domain,
    fileName,
    present: true,
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
    tables,
  };
}

function parseUsers(
  tables: DomainTables,
  issues: LegacyAdapterIssue[],
): LegacyUserRecord[] {
  return recordsIn(tables, "users").flatMap(([recordKey, record]) => {
    const id = stringValue(record["id"]) ?? recordKey;
    const name = stringValue(record["name"]) ?? id;
    const role = stringValue(record["role"]) ?? "member";
    const status = record["status"] === "disabled" ? "disabled" : "active";
    const passwordHash = stringValue(record["passwordHash"]);
    if (passwordHash === undefined) {
      issues.push({
        code: "legacy_credential_missing",
        domain: "collab_team",
        sourceRef: `users:${recordKey}`,
        message:
          "User has no readable password credential; no credential value is reported.",
      });
    }
    return [
      {
        recordKey,
        id,
        name,
        role,
        status,
        credential: {
          present: passwordHash !== undefined,
          algorithm: passwordHash?.startsWith("scrypt$") ? "scrypt" : "unknown",
          status: status === "active" ? "active" : "disabled",
        },
        ...(stringValue(record["createdAt"]) === undefined
          ? {}
          : { createdAt: stringValue(record["createdAt"]) }),
        ...(stringValue(record["updatedAt"]) === undefined
          ? {}
          : { updatedAt: stringValue(record["updatedAt"]) }),
      },
    ];
  });
}

function parseWorkspaceMembers(
  tables: DomainTables,
): LegacyWorkspaceMemberRecord[] {
  return recordsIn(tables, "workspace_members").flatMap(
    ([recordKey, record]) => {
      const workspaceId =
        stringValue(record["workspaceId"]) ??
        recordKey.split(":")[0] ??
        recordKey;
      if (!Array.isArray(record["members"])) return [];
      return record["members"].flatMap((member) => {
        if (!isRecord(member)) return [];
        const userId = stringValue(member["userId"]);
        if (userId === undefined) return [];
        return [
          {
            workspaceId,
            userId,
            role: stringValue(member["role"]) ?? "member",
            ...(stringValue(member["addedAt"]) === undefined
              ? {}
              : { addedAt: stringValue(member["addedAt"]) }),
            ...(stringValue(member["addedBy"]) === undefined
              ? {}
              : { addedBy: stringValue(member["addedBy"]) }),
          },
        ];
      });
    },
  );
}

function parseSessions(tables: DomainTables): LegacySessionSummary[] {
  return recordsIn(tables, "auth_sessions").flatMap(([recordKey, record]) => {
    const userId = stringValue(record["userId"]);
    if (userId === undefined) return [];
    return [
      {
        recordKey,
        userId,
        ...(stringValue(record["createdAt"]) === undefined
          ? {}
          : { createdAt: stringValue(record["createdAt"]) }),
        ...(stringValue(record["expiresAt"]) === undefined
          ? {}
          : { expiresAt: stringValue(record["expiresAt"]) }),
      },
    ];
  });
}

function parseAuditActors(tables: DomainTables): LegacyAuditActorRecord[] {
  return recordsIn(tables, "audit_log").flatMap(([recordKey, record]) => {
    const actorId = stringValue(record["actorId"]);
    if (actorId === undefined) return [];
    return [
      {
        id: stringValue(record["id"]) ?? recordKey,
        actorId,
        action: stringValue(record["action"]) ?? "unknown",
        ...(stringValue(record["at"]) === undefined
          ? {}
          : { at: stringValue(record["at"]) }),
        ...(stringValue(record["workspaceId"]) === undefined
          ? {}
          : { workspaceId: stringValue(record["workspaceId"]) }),
      },
    ];
  });
}

function parsePrincipals(tables: DomainTables): LegacyPrincipalRecord[] {
  return recordsIn(tables, "principals").flatMap(([recordKey, record]) => {
    const id = stringValue(record["id"]) ?? recordKey;
    const kind = record["kind"] === "ai" ? "ai" : "human";
    const status =
      record["status"] === "archived"
        ? "archived"
        : record["status"] === "suspended"
          ? "suspended"
          : "active";
    return [
      {
        recordKey,
        id,
        kind,
        displayName: stringValue(record["displayName"]) ?? id,
        status,
        source: stringValue(record["source"]) ?? "legacy",
      },
    ];
  });
}

function parsePrincipalLinks(
  tables: DomainTables,
): LegacyPrincipalLinkRecord[] {
  return recordsIn(tables, "principal_links").flatMap(([recordKey, record]) => {
    const principalId = stringValue(record["principalId"]);
    const subjectType = stringValue(record["subjectType"]);
    const subjectId = stringValue(record["subjectId"]);
    if (
      principalId === undefined ||
      subjectType === undefined ||
      subjectId === undefined
    ) {
      return [];
    }
    return [
      {
        recordKey,
        id: stringValue(record["id"]) ?? recordKey,
        principalId,
        subjectType,
        subjectId,
      },
    ];
  });
}

function parsePrincipalGrants(
  tables: DomainTables,
): LegacyPrincipalGrantRecord[] {
  return recordsIn(tables, "role_grants").flatMap(([recordKey, record]) => {
    const principalId = stringValue(record["principalId"]);
    const scopeType = record["scopeType"];
    const scopeId = stringValue(record["scopeId"]);
    const role = stringValue(record["role"]);
    if (
      principalId === undefined ||
      scopeId === undefined ||
      role === undefined ||
      (scopeType !== "platform" &&
        scopeType !== "workspace" &&
        scopeType !== "project")
    ) {
      return [];
    }
    return [
      {
        recordKey,
        id: stringValue(record["id"]) ?? recordKey,
        principalId,
        scopeType,
        scopeId,
        role,
        permissions: stringArray(record["permissions"]),
        status:
          record["status"] === "revoked"
            ? "revoked"
            : record["status"] === "expired"
              ? "expired"
              : "active",
        ...(stringValue(record["expiresAt"]) === undefined
          ? {}
          : { expiresAt: stringValue(record["expiresAt"]) }),
      },
    ];
  });
}

function parseExternalIdentityLinks(
  tables: DomainTables,
): LegacyExternalIdentityLinkRecord[] {
  return recordsIn(tables, "external_identity_links").flatMap(
    ([recordKey, record]) => {
      const principalId = stringValue(record["principalId"]);
      const provider = stringValue(record["provider"]);
      const externalSubjectId = stringValue(record["externalSubjectId"]);
      if (
        principalId === undefined ||
        provider === undefined ||
        externalSubjectId === undefined
      ) {
        return [];
      }
      return [
        {
          recordKey,
          id: stringValue(record["id"]) ?? recordKey,
          principalId,
          provider,
          externalSubjectId,
          status: record["status"] === "retired" ? "retired" : "active",
        },
      ];
    },
  );
}

function parseEmployees(tables: DomainTables): LegacyEmployeeRecord[] {
  return recordsIn(tables, "employees").flatMap(([recordKey, record]) => {
    const id = stringValue(record["id"]) ?? recordKey;
    const status =
      record["status"] === "draft" ||
      record["status"] === "suspended" ||
      record["status"] === "archived"
        ? record["status"]
        : "active";
    return [
      {
        recordKey,
        id,
        kind: record["kind"] === "digital" ? "digital" : "human",
        displayName: stringValue(record["displayName"]) ?? id,
        status,
        ...(stringValue(record["authUserId"]) === undefined
          ? {}
          : { authUserId: stringValue(record["authUserId"]) }),
        ...(record["authStatus"] === "disabled"
          ? { authStatus: "disabled" as const }
          : record["authStatus"] === "active"
            ? { authStatus: "active" as const }
            : {}),
        ...(stringValue(record["principalId"]) === undefined
          ? {}
          : { principalId: stringValue(record["principalId"]) }),
      },
    ];
  });
}

function parseRoleAssignments(
  tables: DomainTables,
): LegacyRoleAssignmentRecord[] {
  return recordsIn(tables, "role_assignments").flatMap(
    ([recordKey, record]) => {
      const employeeId = stringValue(record["employeeId"]);
      const workspaceId = stringValue(record["workspaceId"]);
      const role = stringValue(record["role"]);
      if (
        employeeId === undefined ||
        workspaceId === undefined ||
        role === undefined
      ) {
        return [];
      }
      return [
        {
          recordKey,
          id: stringValue(record["id"]) ?? recordKey,
          employeeId,
          ...(stringValue(record["principalId"]) === undefined
            ? {}
            : { principalId: stringValue(record["principalId"]) }),
          workspaceId,
          role,
          permissions: stringArray(record["permissions"]),
          status: record["status"] === "revoked" ? "revoked" : "active",
          ...(stringValue(record["expiresAt"]) === undefined
            ? {}
            : { expiresAt: stringValue(record["expiresAt"]) }),
        },
      ];
    },
  );
}

function parseRuntimeProfiles(
  tables: DomainTables,
): LegacyRuntimeProfileRecord[] {
  return recordsIn(tables, "runtime_profiles").flatMap(
    ([recordKey, record]) => {
      const employeeId = stringValue(record["employeeId"]);
      const workspaceId = stringValue(record["workspaceId"]);
      if (employeeId === undefined || workspaceId === undefined) return [];
      return [
        {
          recordKey,
          id: stringValue(record["id"]) ?? recordKey,
          employeeId,
          ...(stringValue(record["principalId"]) === undefined
            ? {}
            : { principalId: stringValue(record["principalId"]) }),
          workspaceId,
          status: record["status"] === "disabled" ? "disabled" : "active",
        },
      ];
    },
  );
}

function parseActionTickets(tables: DomainTables): LegacyActionTicketRecord[] {
  return recordsIn(tables, "action_tickets").flatMap(([recordKey, record]) => {
    const principal = isRecord(record["principal"]) ? record["principal"] : {};
    const employeeId = stringValue(principal["employeeId"]);
    const workspaceId = stringValue(record["workspaceId"]);
    if (employeeId === undefined || workspaceId === undefined) return [];
    return [
      {
        recordKey,
        id: stringValue(record["id"]) ?? recordKey,
        employeeId,
        ...(stringValue(principal["principalId"]) === undefined
          ? {}
          : { principalId: stringValue(principal["principalId"]) }),
        ...(stringValue(record["ownerId"]) === undefined
          ? {}
          : { ownerId: stringValue(record["ownerId"]) }),
        workspaceId,
        status:
          record["status"] === "revoked"
            ? "revoked"
            : record["status"] === "expired"
              ? "expired"
              : "active",
      },
    ];
  });
}

function parseDelegations(tables: DomainTables): LegacyDelegationRecord[] {
  return recordsIn(tables, "delegations").flatMap(([recordKey, record]) => {
    const ownerId = stringValue(record["ownerId"]);
    const ownerAuthUserId = stringValue(record["ownerAuthUserId"]);
    const workspaceId = stringValue(record["workspaceId"]);
    if (
      ownerId === undefined ||
      ownerAuthUserId === undefined ||
      workspaceId === undefined
    ) {
      return [];
    }
    const status =
      record["status"] === "paused" ||
      record["status"] === "revoked" ||
      record["status"] === "expired" ||
      record["status"] === "completed"
        ? record["status"]
        : "active";
    return [
      {
        recordKey,
        id: stringValue(record["id"]) ?? recordKey,
        ownerId,
        ...(stringValue(record["ownerPrincipalId"]) === undefined
          ? {}
          : { ownerPrincipalId: stringValue(record["ownerPrincipalId"]) }),
        ownerAuthUserId,
        ...(stringValue(record["teammateId"]) === undefined
          ? {}
          : { teammateId: stringValue(record["teammateId"]) }),
        workspaceId,
        status,
      },
    ];
  });
}

function parseTeammates(tables: DomainTables): LegacyTeammateRecord[] {
  return recordsIn(tables, "teammates").flatMap(([recordKey, record]) => {
    const id = stringValue(record["id"]) ?? recordKey;
    return [
      {
        recordKey,
        id,
        name: stringValue(record["name"]) ?? id,
        ...(stringValue(record["employeeId"]) === undefined
          ? {}
          : { employeeId: stringValue(record["employeeId"]) }),
        ...(stringValue(record["principalId"]) === undefined
          ? {}
          : { principalId: stringValue(record["principalId"]) }),
        ownerUserId: stringValue(record["ownerUserId"]) ?? "unknown",
        state: stringValue(record["state"]) ?? "active",
      },
    ];
  });
}

function parseWorkspaceRoleConfigs(
  tables: DomainTables,
): LegacyWorkspaceRoleConfigRecord[] {
  return recordsIn(tables, "workspaces").flatMap(([recordKey, record]) => {
    const workspaceId = stringValue(record["workspaceId"]) ?? recordKey;
    const seats = Array.isArray(record["seats"])
      ? record["seats"].flatMap((seat) => {
          if (!isRecord(seat)) return [];
          const id = stringValue(seat["id"]);
          if (id === undefined) return [];
          return [
            {
              id,
              label: stringValue(seat["label"]) ?? id,
              permissions: stringArray(seat["permissions"]),
            },
          ];
        })
      : [];
    return [{ recordKey, workspaceId, seats }];
  });
}

function parseAssignments(tables: DomainTables): LegacyAssignmentRecord[] {
  return recordsIn(tables, "assignments").flatMap(([recordKey, record]) => {
    const workspaceId = stringValue(record["workspaceId"]);
    const seatId = stringValue(record["seatId"]);
    const assigneeId = stringValue(record["assigneeId"]);
    const assigneeKind = record["assigneeKind"];
    if (
      workspaceId === undefined ||
      seatId === undefined ||
      assigneeId === undefined ||
      (assigneeKind !== "user" && assigneeKind !== "agent")
    ) {
      return [];
    }
    return [
      {
        recordKey,
        id: stringValue(record["id"]) ?? recordKey,
        workspaceId,
        seatId,
        seatLabel: stringValue(record["seatLabel"]) ?? seatId,
        participantKind: assigneeKind === "user" ? "human" : "agent",
        assigneeKind,
        assigneeId,
        ...(stringValue(record["principalId"]) === undefined
          ? {}
          : { principalId: stringValue(record["principalId"]) }),
        permissions: stringArray(record["permissions"]),
        leader: booleanValue(record["leader"]) ?? false,
        status:
          record["status"] === "released"
            ? "released"
            : record["status"] === "claimed"
              ? "claimed"
              : "assigned",
      },
    ];
  });
}

function parseProjects(tables: DomainTables): LegacyProjectRecord[] {
  return recordsIn(tables, "projects").flatMap(([recordKey, record]) => {
    const workspaceId = stringValue(record["workspaceId"]) ?? recordKey;
    const projectRoles = Array.isArray(record["projectRoles"])
      ? record["projectRoles"].flatMap((role) => {
          if (!isRecord(role)) return [];
          const id = stringValue(role["id"]);
          if (id === undefined) return [];
          return [
            {
              id,
              code: stringValue(role["code"]) ?? id,
              permissions: stringArray(role["permissions"]),
            },
          ];
        })
      : [];
    return [
      {
        recordKey,
        workspaceId,
        ...(stringValue(record["ownerId"]) === undefined
          ? {}
          : { ownerId: stringValue(record["ownerId"]) }),
        status: stringValue(record["status"]) ?? "unknown",
        projectRoles,
      },
    ];
  });
}

function parseAgentProfiles(tables: DomainTables): LegacyAgentProfileRecord[] {
  return recordsIn(tables, "profiles").flatMap(([recordKey, record]) => {
    const id = stringValue(record["id"]) ?? recordKey;
    return [
      {
        recordKey,
        id,
        workspaceId: stringValue(record["workspaceId"]) ?? "unknown",
        ...(stringValue(record["visibility"]) === undefined
          ? {}
          : { visibility: stringValue(record["visibility"]) }),
        status: stringValue(record["status"]) ?? "active",
      },
    ];
  });
}

function parseAgentRuns(tables: DomainTables): LegacyAgentRunRecord[] {
  return recordsIn(tables, "runs").flatMap(([recordKey, record]) => {
    const agentProfileId = stringValue(record["agentProfileId"]);
    if (agentProfileId === undefined) return [];
    return [
      {
        recordKey,
        id: stringValue(record["id"]) ?? recordKey,
        agentProfileId,
        ...(stringValue(record["employeeId"]) === undefined
          ? {}
          : { employeeId: stringValue(record["employeeId"]) }),
        ...(stringValue(record["principalId"]) === undefined
          ? {}
          : { principalId: stringValue(record["principalId"]) }),
        status: stringValue(record["status"]) ?? "unknown",
      },
    ];
  });
}

function parsePrincipalRuntimeProfiles(
  tables: DomainTables,
): LegacyPrincipalRuntimeProfileRecord[] {
  return recordsIn(tables, "profiles").flatMap(([recordKey, record]) => {
    const id = stringValue(record["id"]) ?? recordKey;
    const principalId = stringValue(record["principalId"]);
    const workspaceId = stringValue(record["workspaceId"]);
    if (principalId === undefined || workspaceId === undefined) return [];
    return [
      {
        recordKey,
        id,
        principalId,
        workspaceId,
        status: record["status"] === "disabled" ? "disabled" : "active",
      },
    ];
  });
}

function parsePrincipalRuntimeTickets(
  tables: DomainTables,
): LegacyPrincipalRuntimeTicketRecord[] {
  return recordsIn(tables, "action_tickets").flatMap(([recordKey, record]) => {
    const id = stringValue(record["id"]) ?? recordKey;
    const principalId = stringValue(record["principalId"]);
    const runtimeProfileId = stringValue(record["runtimeProfileId"]);
    const workspaceId = stringValue(record["workspaceId"]);
    if (
      principalId === undefined ||
      runtimeProfileId === undefined ||
      workspaceId === undefined
    ) {
      return [];
    }
    return [
      {
        recordKey,
        id,
        principalId,
        runtimeProfileId,
        workspaceId,
        status:
          record["status"] === "revoked"
            ? "revoked"
            : record["status"] === "expired"
              ? "expired"
              : "active",
      },
    ];
  });
}

function tablesForDomain(
  domain: LegacyPrincipalDomain,
  tables: DomainTables,
  issues: LegacyAdapterIssue[],
): Partial<LegacyPrincipalSnapshotTables> {
  switch (domain) {
    case "collab_team":
      return {
        users: parseUsers(tables, issues),
        workspaceMembers: parseWorkspaceMembers(tables),
        sessions: parseSessions(tables),
        auditActors: parseAuditActors(tables),
      };
    case "collab_principal":
      return {
        principals: parsePrincipals(tables),
        principalLinks: parsePrincipalLinks(tables),
        principalGrants: parsePrincipalGrants(tables),
        externalIdentityLinks: parseExternalIdentityLinks(tables),
      };
    case "collab_employee":
      return {
        employees: parseEmployees(tables),
        roleAssignments: parseRoleAssignments(tables),
        runtimeProfiles: parseRuntimeProfiles(tables),
        actionTickets: parseActionTickets(tables),
        delegations: parseDelegations(tables),
      };
    case "collab_teammate":
      return { teammates: parseTeammates(tables) };
    case "collab_assignment":
      return {
        workspaceRoleConfigs: parseWorkspaceRoleConfigs(tables),
        assignments: parseAssignments(tables),
      };
    case "collab_project":
      return { projects: parseProjects(tables) };
    case "collab_agent":
      return {
        agentProfiles: parseAgentProfiles(tables),
        agentRuns: parseAgentRuns(tables),
      };
    case "collab_principal_runtime":
      return {
        principalRuntimeProfiles: parsePrincipalRuntimeProfiles(tables),
        principalRuntimeTickets: parsePrincipalRuntimeTickets(tables),
      };
  }
}

export async function readLegacyPrincipalSnapshot(
  input: ReadLegacyPrincipalSnapshotInput,
): Promise<LegacyPrincipalSnapshot> {
  if (!isAbsolute(input.sourceHome) || input.sourceHome.trim() === "") {
    throw new LegacySnapshotError(
      "invalid_source",
      "sourceHome must be an explicit absolute snapshot directory.",
    );
  }

  try {
    const source = await stat(input.sourceHome);
    if (!source.isDirectory()) {
      throw new LegacySnapshotError(
        "invalid_source",
        "sourceHome must point to a directory.",
      );
    }
  } catch (error) {
    if (error instanceof LegacySnapshotError) throw error;
    throw new LegacySnapshotError(
      "source_not_found",
      "The explicit sourceHome directory does not exist.",
    );
  }

  const issues: LegacyAdapterIssue[] = [];
  const results: DomainReadResult[] = [];
  for (const spec of DOMAIN_SPECS) {
    results.push(
      await readDomain(input.sourceHome, spec.domain, spec.fileName, issues),
    );
  }

  if (!results.some((result) => result.present)) {
    issues.push({
      code: "legacy_source_empty",
      domain: "collab_team",
      message:
        "No reviewed legacy domain file exists under the explicit source storages directory.",
    });
  }

  const merged: {
    -readonly [
      Key in keyof LegacyPrincipalSnapshotTables
    ]: LegacyPrincipalSnapshotTables[Key];
  } = {
    users: [],
    workspaceMembers: [],
    sessions: [],
    auditActors: [],
    principals: [],
    principalLinks: [],
    principalGrants: [],
    externalIdentityLinks: [],
    employees: [],
    roleAssignments: [],
    runtimeProfiles: [],
    actionTickets: [],
    delegations: [],
    teammates: [],
    workspaceRoleConfigs: [],
    assignments: [],
    projects: [],
    agentProfiles: [],
    agentRuns: [],
    principalRuntimeProfiles: [],
    principalRuntimeTickets: [],
  };

  for (const result of results) {
    const parsed = tablesForDomain(result.domain, result.tables, issues);
    for (const key of Object.keys(
      parsed,
    ) as (keyof LegacyPrincipalSnapshotTables)[]) {
      const values = parsed[key];
      if (values === undefined) continue;
      (merged[key] as unknown[]).push(...values);
    }
  }

  const sourceFiles: LegacySourceFile[] = results.map((result) => ({
    domain: result.domain,
    fileName: result.fileName,
    present: result.present,
    bytes: result.bytes,
    sha256: result.sha256,
  }));
  const sourceDigest = `sha256:${sha256(JSON.stringify(sourceFiles))}`;

  return {
    sourceDigest,
    sourceFiles,
    tables: merged,
    issues,
  };
}
