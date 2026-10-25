import { randomUUID } from "node:crypto";
import { z } from "zod";

const idSchema = z.string().trim().min(1).max(180);
const displayNameSchema = z.string().trim().min(1).max(120);
const isoTimeSchema = z.string().datetime({ precision: 3 });

export const PRINCIPAL_KINDS = ["human", "ai"] as const;
export const PRINCIPAL_STATUSES = ["active", "suspended", "archived"] as const;
export const PRINCIPAL_STATUS_AUTHORITIES = [
  "account",
  "employee",
  "hrm",
  "system",
] as const;
export const PRINCIPAL_SOURCES = [
  "local",
  "account",
  "ai-companion",
  "hrm",
] as const;
export const PRINCIPAL_SUBJECT_TYPES = [
  "auth-user",
  "employee",
  "teammate",
  "hrm",
] as const;
export const GRANT_SCOPE_TYPES = ["platform", "workspace", "project"] as const;
export const GRANT_STATUSES = ["active", "revoked", "expired"] as const;
export const PRINCIPAL_REFERENCE_PREFIXES = [
  "principal",
  "employee",
  "teammate",
  "auth-user",
  "user",
  "hrm",
] as const;

export const principalKindSchema = z.enum(PRINCIPAL_KINDS);
export const principalStatusSchema = z.enum(PRINCIPAL_STATUSES);
export const principalStatusAuthoritySchema = z.enum(
  PRINCIPAL_STATUS_AUTHORITIES,
);
export const principalSourceSchema = z.enum(PRINCIPAL_SOURCES);
export const principalSubjectTypeSchema = z.enum(PRINCIPAL_SUBJECT_TYPES);
export const grantScopeTypeSchema = z.enum(GRANT_SCOPE_TYPES);
export const grantStatusSchema = z.enum(GRANT_STATUSES);

export const principalRecordSchema = z.object({
  id: idSchema,
  kind: principalKindSchema,
  displayName: displayNameSchema,
  status: principalStatusSchema,
  statusAuthority: principalStatusAuthoritySchema.default("system"),
  source: principalSourceSchema,
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});

export const principalLinkRecordSchema = z.object({
  id: idSchema,
  principalId: idSchema,
  subjectType: principalSubjectTypeSchema,
  subjectId: idSchema,
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});

export const principalGrantSchema = z.object({
  id: idSchema,
  principalId: idSchema,
  scopeType: grantScopeTypeSchema,
  scopeId: idSchema,
  role: z.string().trim().min(1).max(120),
  permissions: z.array(z.string().trim().min(1).max(160)).max(100).default([]),
  status: grantStatusSchema.default("active"),
  expiresAt: isoTimeSchema.optional(),
  grantedByPrincipalId: idSchema.optional(),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});

export type PrincipalKind = z.infer<typeof principalKindSchema>;
export type PrincipalStatus = z.infer<typeof principalStatusSchema>;
export type PrincipalStatusAuthority = z.infer<
  typeof principalStatusAuthoritySchema
>;
export type PrincipalSource = z.infer<typeof principalSourceSchema>;
export type PrincipalSubjectType = z.infer<typeof principalSubjectTypeSchema>;
export type PrincipalRecord = z.infer<typeof principalRecordSchema>;
export type PrincipalLinkRecord = z.infer<typeof principalLinkRecordSchema>;
export type PrincipalGrant = z.infer<typeof principalGrantSchema>;
export type GrantScopeType = z.infer<typeof grantScopeTypeSchema>;
export type PrincipalBinding = PrincipalLinkRecord;

export interface SyncGrantInput {
  readonly principalId: string;
  readonly scopeType: GrantScopeType;
  readonly scopeId: string;
  readonly role: string;
  readonly permissions?: readonly string[] | undefined;
  readonly expiresAt?: string | undefined;
  readonly grantedByPrincipalId?: string | undefined;
}

export interface PrincipalTableLike<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  put(key: string, value: V): Promise<void>;
}

export interface PrincipalTables {
  readonly principals: PrincipalTableLike<PrincipalRecord>;
  readonly links: PrincipalTableLike<PrincipalLinkRecord>;
  readonly grants: PrincipalTableLike<PrincipalGrant>;
}

export interface PrincipalServiceOptions {
  readonly now?: () => Date;
  readonly randomId?: () => string;
}

export interface SyncPrincipalInput {
  readonly kind: PrincipalKind;
  readonly subjectType: PrincipalSubjectType;
  readonly subjectId: string;
  readonly displayName: string;
  readonly status?: PrincipalStatus;
  readonly statusAuthority?: PrincipalStatusAuthority;
  readonly source?: PrincipalSource;
  readonly authUserId?: string | undefined;
}

export interface SyncEmployeePrincipalInput {
  readonly employeeId: string;
  readonly kind: "human" | "digital";
  readonly displayName: string;
  readonly status: "draft" | "active" | "suspended" | "archived";
  readonly authUserId?: string | undefined;
  readonly authStatus?: "active" | "disabled" | undefined;
}

export interface SyncCompanionPrincipalInput {
  readonly teammateId: string;
  readonly employeeId: string;
  readonly displayName?: string | undefined;
}

export class PrincipalError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "unauthorized" | "forbidden" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "PrincipalError";
  }
}

function subjectKey(
  subjectType: PrincipalSubjectType,
  subjectId: string,
): string {
  return `${subjectType}:${subjectId}`;
}

export function principalIdFor(kind: PrincipalKind, subjectId: string): string {
  return `principal-${kind}-${subjectId}`;
}

function principalStatusForEmployee(
  status: SyncEmployeePrincipalInput["status"],
  authStatus: SyncEmployeePrincipalInput["authStatus"],
): PrincipalStatus {
  if (status === "archived") return "archived";
  if (status === "active" && authStatus !== "disabled") return "active";
  return "suspended";
}

function mergePrincipalStatus(input: {
  readonly current?: PrincipalRecord | undefined;
  readonly status: PrincipalStatus;
  readonly authority: PrincipalStatusAuthority;
}): {
  readonly status: PrincipalStatus;
  readonly statusAuthority: PrincipalStatusAuthority;
} {
  const current = input.current;
  if (current === undefined) {
    return { status: input.status, statusAuthority: input.authority };
  }
  const currentAuthority = current.statusAuthority ?? "system";
  if (current.status === "archived" || currentAuthority === "hrm") {
    return {
      status: current.status,
      statusAuthority: currentAuthority,
    };
  }
  if (input.authority === "hrm") {
    return { status: input.status, statusAuthority: "hrm" };
  }
  if (
    input.authority === "account" &&
    currentAuthority === "employee" &&
    current.status !== "active"
  ) {
    return {
      status: current.status,
      statusAuthority: currentAuthority,
    };
  }
  if (input.authority === "employee" && input.status === "suspended") {
    return {
      status: input.status,
      statusAuthority: "employee",
    };
  }
  return {
    status: input.status,
    statusAuthority: input.authority,
  };
}

function parseOrInvalid<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data === undefined) {
    throw new PrincipalError("invalid_input", "principal input is invalid");
  }
  return parsed.data;
}

export const principalDomainSpec = {
  name: "collab_principal",
  version: 1,
  tables: {
    principals: {
      valueSchema: principalRecordSchema,
    },
    principal_links: {
      valueSchema: principalLinkRecordSchema,
    },
    role_grants: {
      valueSchema: principalGrantSchema,
    },
  },
} as const;

export class PrincipalService {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly tables: PrincipalTables,
    options: PrincipalServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private link(
    subjectType: PrincipalSubjectType,
    subjectId: string,
  ): PrincipalLinkRecord | undefined {
    return this.tables.links.get(subjectKey(subjectType, subjectId));
  }

  private principal(principalId: string): PrincipalRecord {
    const principal = this.tables.principals.get(principalId);
    if (principal === undefined) {
      throw new PrincipalError("not_found", "principal does not exist");
    }
    return principal;
  }

  private async putLink(
    principalId: string,
    subjectType: PrincipalSubjectType,
    subjectId: string,
    timestamp: string,
  ): Promise<PrincipalLinkRecord> {
    const key = subjectKey(subjectType, subjectId);
    const current = this.tables.links.get(key);
    if (current !== undefined) {
      if (current.principalId !== principalId) {
        throw new PrincipalError(
          "conflict",
          `subject ${key} is already linked to ${current.principalId}`,
        );
      }
      if (current.updatedAt === timestamp) return current;
      const next = principalLinkRecordSchema.parse({
        ...current,
        updatedAt: timestamp,
      });
      await this.tables.links.put(key, next);
      return next;
    }
    const record = principalLinkRecordSchema.parse({
      id: key,
      principalId,
      subjectType,
      subjectId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.tables.links.put(key, record);
    return record;
  }

  private async upsertRecord(input: {
    principalId: string;
    kind: PrincipalKind;
    displayName: string;
    status: PrincipalStatus;
    statusAuthority: PrincipalStatusAuthority;
    source: PrincipalSource;
  }): Promise<PrincipalRecord> {
    const timestamp = this.timestamp();
    const current = this.tables.principals.get(input.principalId);
    if (current !== undefined && current.kind !== input.kind) {
      throw new PrincipalError(
        "conflict",
        `principal ${input.principalId} kind cannot be changed`,
      );
    }
    const record = principalRecordSchema.parse({
      id: input.principalId,
      kind: input.kind,
      displayName: input.displayName,
      status: input.status,
      statusAuthority: input.statusAuthority,
      source: input.source,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    await this.tables.principals.put(record.id, record);
    return record;
  }

  syncPrincipal(input: SyncPrincipalInput): Promise<PrincipalRecord> {
    return this.enqueue(async () => {
      const kind = parseOrInvalid(principalKindSchema, input.kind);
      const subjectType = parseOrInvalid(
        principalSubjectTypeSchema,
        input.subjectType,
      );
      const subjectId = parseOrInvalid(idSchema, input.subjectId);
      const displayName = parseOrInvalid(displayNameSchema, input.displayName);
      const status = parseOrInvalid(
        principalStatusSchema,
        input.status ?? "active",
      );
      const source = parseOrInvalid(
        principalSourceSchema,
        input.source ?? (kind === "ai" ? "ai-companion" : "local"),
      );
      const statusAuthority = parseOrInvalid(
        principalStatusAuthoritySchema,
        input.statusAuthority ??
          (subjectType === "auth-user"
            ? "account"
            : subjectType === "hrm"
              ? "hrm"
              : "employee"),
      );
      if (
        kind === "ai" &&
        (input.authUserId !== undefined || subjectType === "auth-user")
      ) {
        throw new PrincipalError(
          "invalid_input",
          "AI principals cannot be linked to login accounts",
        );
      }
      const authUserId =
        input.authUserId === undefined
          ? undefined
          : parseOrInvalid(idSchema, input.authUserId);
      const existingSubject = this.link(subjectType, subjectId);
      const authUserLink =
        authUserId === undefined
          ? undefined
          : this.link("auth-user", authUserId);
      const principalId =
        existingSubject?.principalId ??
        authUserLink?.principalId ??
        principalIdFor(kind, subjectId);
      const current = this.tables.principals.get(principalId);
      const mergedStatus = mergePrincipalStatus({
        current,
        status,
        authority: statusAuthority,
      });
      const record = await this.upsertRecord({
        principalId,
        kind,
        displayName,
        status: mergedStatus.status,
        statusAuthority: mergedStatus.statusAuthority,
        source,
      });
      const timestamp = this.timestamp();
      if (authUserId !== undefined) {
        await this.putLink(principalId, "auth-user", authUserId, timestamp);
      }
      await this.putLink(principalId, subjectType, subjectId, timestamp);
      return record;
    });
  }

  syncAuthUser(input: {
    readonly id: string;
    readonly name: string;
    readonly status?: "active" | "disabled" | undefined;
  }): Promise<PrincipalRecord> {
    return this.syncPrincipal({
      kind: "human",
      subjectType: "auth-user",
      subjectId: input.id,
      displayName: input.name,
      status: input.status === "disabled" ? "suspended" : "active",
      statusAuthority: "account",
      source: "account",
    });
  }

  syncEmployee(input: SyncEmployeePrincipalInput): Promise<PrincipalRecord> {
    const status = principalStatusForEmployee(input.status, input.authStatus);
    return this.syncPrincipal({
      kind: input.kind === "human" ? "human" : "ai",
      subjectType: "employee",
      subjectId: input.employeeId,
      displayName: input.displayName,
      status,
      statusAuthority:
        input.status === "active" && input.authStatus === "disabled"
          ? "account"
          : "employee",
      source:
        input.kind === "human"
          ? input.authUserId === undefined
            ? "local"
            : "account"
          : "ai-companion",
      ...(input.authUserId === undefined
        ? {}
        : { authUserId: input.authUserId }),
    });
  }

  syncCompanion(input: SyncCompanionPrincipalInput): Promise<PrincipalRecord> {
    return this.enqueue(async () => {
      const employeeLink = this.link("employee", input.employeeId);
      if (employeeLink === undefined) {
        throw new PrincipalError(
          "not_found",
          "AI employee has no principal mapping",
        );
      }
      const current = this.principal(employeeLink.principalId);
      const record =
        input.displayName === undefined ||
        input.displayName === current.displayName
          ? current
          : await this.upsertRecord({
              principalId: current.id,
              kind: current.kind,
              displayName: input.displayName,
              status: current.status,
              statusAuthority: current.statusAuthority,
              source: current.source,
            });
      await this.putLink(
        record.id,
        "teammate",
        input.teammateId,
        this.timestamp(),
      );
      return record;
    });
  }

  resolveSubject(
    subjectType: PrincipalSubjectType,
    subjectId: string,
  ): PrincipalRecord | undefined {
    const link = this.link(subjectType, subjectId);
    return link === undefined
      ? undefined
      : this.tables.principals.get(link.principalId);
  }

  /**
   * Resolve the Phase 3 canonical reference and its migration aliases.
   * Bare IDs intentionally prefer Principal IDs before legacy subject IDs.
   */
  resolveReference(reference: string): PrincipalRecord | undefined {
    const value = reference.trim();
    if (value === "") return undefined;
    const separator = value.indexOf(":");
    if (separator > 0) {
      const prefix = value.slice(0, separator);
      const subjectId = value.slice(separator + 1).trim();
      if (subjectId === "") return undefined;
      if (prefix === "principal") {
        return this.tables.principals.get(subjectId);
      }
      if (prefix === "auth-user" || prefix === "user") {
        return this.resolveSubject("auth-user", subjectId);
      }
      if (prefix === "employee" || prefix === "teammate" || prefix === "hrm") {
        return this.resolveSubject(prefix, subjectId);
      }
    }
    return (
      this.tables.principals.get(value) ??
      this.resolveSubject("auth-user", value) ??
      this.resolveSubject("employee", value) ??
      this.resolveSubject("teammate", value)
    );
  }

  canonicalReference(principalId: string): string {
    return `principal:${this.principal(principalId).id}`;
  }

  bindings(principalId: string): PrincipalBinding[] {
    const parsed = parseOrInvalid(idSchema, principalId);
    return [...this.tables.links.entries()]
      .map(([, value]) => value)
      .filter((link) => link.principalId === parsed)
      .sort(
        (left, right) =>
          left.subjectType.localeCompare(right.subjectType) ||
          left.subjectId.localeCompare(right.subjectId),
      );
  }

  preferredSubjectId(
    principalId: string,
    subjectTypes: readonly PrincipalSubjectType[],
  ): string | undefined {
    const bindings = this.bindings(principalId);
    for (const subjectType of subjectTypes) {
      const binding = bindings.find(
        (candidate) => candidate.subjectType === subjectType,
      );
      if (binding !== undefined) return binding.subjectId;
    }
    return undefined;
  }

  get(principalId: string): PrincipalRecord {
    return this.principal(principalId);
  }

  list(): PrincipalRecord[] {
    return [...this.tables.principals.entries()]
      .map(([, value]) => value)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  private activeGrant(
    principalId: string,
    scopeType: GrantScopeType,
    scopeId: string,
    role: string,
  ): PrincipalGrant | undefined {
    return this.grants(principalId).find(
      (grant) =>
        grant.status === "active" &&
        grant.scopeType === scopeType &&
        grant.scopeId === scopeId &&
        grant.role === role,
    );
  }

  private assertGrantable(input: SyncGrantInput): void {
    const principal = this.principal(
      parseOrInvalid(idSchema, input.principalId),
    );
    if (principal.status === "archived") {
      throw new PrincipalError(
        "conflict",
        "archived principals cannot receive new grants",
      );
    }
    if (
      input.grantedByPrincipalId !== undefined &&
      this.tables.principals.get(input.grantedByPrincipalId) === undefined
    ) {
      throw new PrincipalError(
        "not_found",
        "granting principal does not exist",
      );
    }
  }

  private async createGrant(input: SyncGrantInput): Promise<PrincipalGrant> {
    this.assertGrantable(input);
    const timestamp = this.timestamp();
    const record = principalGrantSchema.parse({
      id: this.randomId(),
      principalId: input.principalId,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      role: input.role,
      permissions: input.permissions ?? [],
      status: "active",
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.grantedByPrincipalId === undefined
        ? {}
        : { grantedByPrincipalId: input.grantedByPrincipalId }),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.tables.grants.put(record.id, record);
    return record;
  }

  private async syncGrantRecord(
    input: SyncGrantInput,
  ): Promise<PrincipalGrant> {
    this.assertGrantable(input);
    const current = this.activeGrant(
      input.principalId,
      input.scopeType,
      input.scopeId,
      input.role,
    );
    if (current === undefined) return this.createGrant(input);
    const record = principalGrantSchema.parse({
      id: current.id,
      principalId: current.principalId,
      scopeType: current.scopeType,
      scopeId: current.scopeId,
      role: current.role,
      permissions: input.permissions ?? [],
      status: "active",
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      ...(input.grantedByPrincipalId === undefined
        ? {}
        : { grantedByPrincipalId: input.grantedByPrincipalId }),
      createdAt: current.createdAt,
      updatedAt: this.timestamp(),
    });
    await this.tables.grants.put(record.id, record);
    return record;
  }

  private async revokeGrantRecord(
    current: PrincipalGrant,
  ): Promise<PrincipalGrant> {
    const next = principalGrantSchema.parse({
      ...current,
      status: "revoked",
      updatedAt: this.timestamp(),
    });
    await this.tables.grants.put(next.id, next);
    return next;
  }

  assignGrant(input: SyncGrantInput): Promise<PrincipalGrant> {
    return this.enqueue(async () => {
      return this.createGrant(input);
    });
  }

  syncGrant(input: SyncGrantInput): Promise<PrincipalGrant> {
    return this.enqueue(async () => this.syncGrantRecord(input));
  }

  syncExclusiveGrant(input: SyncGrantInput): Promise<PrincipalGrant> {
    return this.enqueue(async () => {
      const existing = this.grants(input.principalId).filter(
        (grant) =>
          grant.status === "active" &&
          grant.scopeType === input.scopeType &&
          grant.scopeId === input.scopeId,
      );
      const matching = existing.find((grant) => grant.role === input.role);
      if (matching !== undefined) {
        for (const grant of existing) {
          if (grant.id !== matching.id) await this.revokeGrantRecord(grant);
        }
        return this.syncGrantRecord(input);
      }
      const [current, ...stale] = existing;
      for (const grant of stale) {
        await this.revokeGrantRecord(grant);
      }
      if (current === undefined) return this.syncGrantRecord(input);
      this.assertGrantable(input);
      const record = principalGrantSchema.parse({
        id: current.id,
        principalId: current.principalId,
        scopeType: current.scopeType,
        scopeId: current.scopeId,
        role: input.role,
        permissions: input.permissions ?? [],
        status: "active",
        ...(input.expiresAt === undefined
          ? {}
          : { expiresAt: input.expiresAt }),
        ...(input.grantedByPrincipalId === undefined
          ? {}
          : { grantedByPrincipalId: input.grantedByPrincipalId }),
        createdAt: current.createdAt,
        updatedAt: this.timestamp(),
      });
      await this.tables.grants.put(record.id, record);
      return record;
    });
  }

  grants(principalId?: string): PrincipalGrant[] {
    return [...this.tables.grants.entries()]
      .map(([, value]) => value)
      .filter(
        (grant) =>
          principalId === undefined || grant.principalId === principalId,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  revokeGrant(grantId: string): Promise<PrincipalGrant> {
    return this.enqueue(async () => {
      const current = this.tables.grants.get(grantId);
      if (current === undefined) {
        throw new PrincipalError("not_found", "grant does not exist");
      }
      return this.revokeGrantRecord(current);
    });
  }

  revokeMatchingGrants(input: {
    readonly principalId: string;
    readonly scopeType: GrantScopeType;
    readonly scopeId: string;
    readonly role: string;
  }): Promise<PrincipalGrant[]> {
    return this.enqueue(async () => {
      const matches = this.grants(input.principalId).filter(
        (grant) =>
          grant.status === "active" &&
          grant.scopeType === input.scopeType &&
          grant.scopeId === input.scopeId &&
          grant.role === input.role,
      );
      const revoked: PrincipalGrant[] = [];
      for (const grant of matches) {
        revoked.push(await this.revokeGrantRecord(grant));
      }
      return revoked;
    });
  }
}
