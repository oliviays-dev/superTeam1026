import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { z } from "zod";
import {
  bearerToken,
  isWithin,
  readJsonBody,
  resolveWithin,
  sameOrigin,
  sendJson,
} from "@pluginmax/shared";

export const name = "dsh-collab-space";
export const inject = [
  "storageDomain",
  "commands",
  "tools",
  "webServer",
  "workspaceRegistry",
];

export const SHARE_SCOPES = ["session", "workspace", "global"] as const;
export const SHARE_PERMISSIONS = ["read", "write"] as const;
export const SHARE_EFFECTS = ["allow", "deny"] as const;
export type ShareScope = (typeof SHARE_SCOPES)[number];
export type SharePermission = (typeof SHARE_PERMISSIONS)[number];
export type ShareEffect = (typeof SHARE_EFFECTS)[number];

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const pathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      normalizeRelative(value) === value &&
      !value
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === "..",
        ),
    {
      message: "path must use normalized forward-slash segments",
    },
  );
const patternSchema = pathSchema;
const isoTimeSchema = z.string().datetime({ precision: 3 });
const actorSchema = z.object({
  kind: z.enum(["user", "agent"]),
  id: idSchema,
  sessionId: idSchema.optional(),
  globalRole: z.enum(["admin", "owner", "member", "guest"]).optional(),
  workspaceRole: z.enum(["owner", "member", "guest"]).optional(),
});
const permissionListSchema = z
  .array(z.enum(SHARE_PERMISSIONS))
  .min(1)
  .max(SHARE_PERMISSIONS.length);

export function normalizeRelative(input: string): string {
  const trimmed = input.trim().replace(/\\/g, "/");
  if (trimmed.includes("\0")) return trimmed;
  const parts = trimmed.split("/").filter((part) => part !== "");
  if (parts.some((part) => part === "." || part === ".." || part === "")) {
    return trimmed;
  }
  return parts.join("/");
}

const policyRecordSchema = z.object({
  id: z.string().min(1).max(80),
  workspaceId: idSchema,
  pattern: patternSchema,
  scope: z.enum(SHARE_SCOPES),
  permissions: permissionListSchema,
  effect: z.enum(SHARE_EFFECTS),
  subjectUser: idSchema.optional(),
  sessionIds: z.array(idSchema).max(100).default([]),
  createdBy: idSchema,
  createdAt: isoTimeSchema,
  expiresAt: isoTimeSchema.optional(),
});

const auditRecordSchema = z.object({
  id: z.string().min(1).max(100),
  at: isoTimeSchema,
  actorId: idSchema,
  actorKind: z.enum(["user", "agent"]),
  action: z
    .enum([
      "policy_add",
      "policy_remove",
      "file_write",
      "file_read",
      "global_submit",
      "global_approve",
      "global_reject",
      "global_write",
      "claim",
    ])
    .or(z.string().regex(/^[a-z0-9_.:-]{1,64}$/)),
  workspaceId: idSchema.optional(),
  path: z.string().max(512).optional(),
  detail: z.record(z.string(), z.string().max(200)).default({}),
});

const globalRequestSchema = z.object({
  id: z.string().min(1).max(80),
  path: pathSchema,
  pendingPath: z.string().min(1).max(1024),
  submittedBy: idSchema,
  submittedAt: isoTimeSchema,
  size: z
    .number()
    .int()
    .nonnegative()
    .max(100 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["pending", "approved", "rejected"]),
  decidedBy: idSchema.optional(),
  decidedAt: isoTimeSchema.optional(),
});

const workspaceConfigSchema = z.object({
  workspaceId: idSchema,
  enabled: z.boolean().default(true),
  defaultScope: z.enum(SHARE_SCOPES).default("workspace"),
  lockTtlMs: z
    .number()
    .int()
    .min(30_000)
    .max(24 * 60 * 60 * 1000)
    .default(10 * 60 * 1000),
  updatedAt: isoTimeSchema,
  updatedBy: idSchema,
});

const lockRecordSchema = z.object({
  key: z.string().min(1).max(256),
  workspaceId: idSchema,
  path: pathSchema,
  ownerId: idSchema,
  ownerSessionId: idSchema,
  acquiredAt: isoTimeSchema,
  expiresAt: isoTimeSchema,
});

const claimRecordSchema = z.object({
  path: pathSchema,
  ownerId: idSchema,
  ownerSessionId: idSchema,
  claimedAt: isoTimeSchema,
});

const digestEventSchema = z.object({
  type: z.enum(["user", "assistant", "tool", "file"]),
  title: z.string().trim().max(160).optional(),
  text: z.string().max(20_000).default(""),
  path: pathSchema.optional(),
  at: isoTimeSchema.optional(),
});

export type PolicyRecord = z.infer<typeof policyRecordSchema>;
export type SpaceAuditRecord = z.infer<typeof auditRecordSchema>;
export type GlobalRequestRecord = z.infer<typeof globalRequestSchema>;
export type WorkspaceConfigRecord = z.infer<typeof workspaceConfigSchema>;
export type LockRecord = z.infer<typeof lockRecordSchema>;
export type ClaimRecord = z.infer<typeof claimRecordSchema>;
export type DigestEvent = z.input<typeof digestEventSchema>;
export type SpaceActor = z.infer<typeof actorSchema>;

export interface PrincipalLike {
  readonly userId: string;
  readonly role: "admin" | "owner" | "member" | "guest";
}

export interface WorkspaceMemberLike {
  readonly userId: string;
  readonly memberRole: "owner" | "member" | "guest";
}

export interface TeamServiceLike {
  resolveToken(token: string): PrincipalLike | undefined;
  members(workspaceId: string): readonly WorkspaceMemberLike[];
}

export interface WorkspaceLike {
  readonly id: string;
  readonly path: string;
  readonly title?: string;
}

export interface WorkspaceRegistryLike {
  get(id: string): WorkspaceLike | undefined;
  list(): readonly WorkspaceLike[];
}

export class SpaceError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "unauthorized" | "forbidden" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "SpaceError";
  }
}

interface SchemaLike<V> {
  safeParse(value: unknown): SafeParseLike<V>;
}

interface SafeParseLike<V> {
  success: boolean;
  data?: V;
  error?: {
    issues?: ReadonlyArray<{
      readonly message: string;
      readonly path?: readonly PropertyKey[];
    }>;
  };
}

interface KvTableLike<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  keys(): IterableIterator<string>;
  readonly size: number;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
}

function tableValues<V>(table: KvTableLike<V>): V[] {
  return Array.from(table.entries(), ([, value]) => value);
}

export interface SharingDomainLike {
  table(name: "policies"): KvTableLike<PolicyRecord>;
  table(name: "audit"): KvTableLike<SpaceAuditRecord>;
  table(name: "global_requests"): KvTableLike<GlobalRequestRecord>;
  close(): Promise<void>;
}

export interface ConfigDomainLike {
  table(name: "workspaces"): KvTableLike<WorkspaceConfigRecord>;
  close(): Promise<void>;
}

export interface LockDomainLike {
  table(name: "locks"): KvTableLike<LockRecord>;
  close(): Promise<void>;
}

interface DomainSpecLike {
  readonly name: string;
  readonly version: number;
  readonly tables: Record<
    string,
    { readonly valueSchema: SchemaLike<unknown> }
  >;
}

export const sharingDomainSpec: DomainSpecLike = {
  name: "collab_sharing",
  version: 1,
  tables: {
    policies: {
      valueSchema: policyRecordSchema as unknown as SchemaLike<unknown>,
    },
    audit: {
      valueSchema: auditRecordSchema as unknown as SchemaLike<unknown>,
    },
    global_requests: {
      valueSchema: globalRequestSchema as unknown as SchemaLike<unknown>,
    },
  },
};

export const configDomainSpec: DomainSpecLike = {
  name: "collab_config",
  version: 1,
  tables: {
    workspaces: {
      valueSchema: workspaceConfigSchema as unknown as SchemaLike<unknown>,
    },
  },
};

export const lockDomainSpec: DomainSpecLike = {
  name: "collab_locks",
  version: 1,
  tables: {
    locks: {
      valueSchema: lockRecordSchema as unknown as SchemaLike<unknown>,
    },
  },
};

function parseOrInvalid<T>(
  schema: { safeParse(value: unknown): SafeParseLike<T> },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success || result.data === undefined) {
    const issue = result.error?.issues?.[0];
    const field = issue?.path?.length === undefined || issue.path.length === 0
      ? ""
      : `${issue.path.join(".")}: `;
    throw new SpaceError(
      "invalid_input",
      issue === undefined ? "request input is invalid" : `${field}${issue.message}`,
    );
  }
  return result.data;
}

function globToRegExp(pattern: string): RegExp {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === undefined) break;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else {
        expression += "[^/]*";
      }
      continue;
    }
    expression += char.replace(/[\\^$.+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`, "u");
}

function patternSpecificity(pattern: string): number {
  if (!pattern.includes("*")) return 3;
  if (pattern.includes("**")) return 1;
  return 2;
}

function policyMatchesPath(policy: PolicyRecord, path: string): boolean {
  return globToRegExp(policy.pattern).test(path);
}

function policyMatchesSubject(
  policy: PolicyRecord,
  actor: SpaceActor,
): boolean {
  if (policy.subjectUser !== undefined) return policy.subjectUser === actor.id;
  return true;
}

function scopeAllows(
  policy: PolicyRecord,
  actor: SpaceActor,
  sessionId: string | undefined,
): boolean {
  if (policy.scope === "session") {
    return sessionId !== undefined && policy.sessionIds.includes(sessionId);
  }
  if (policy.scope === "workspace") {
    if (actor.kind === "agent") return true;
    return (
      actor.globalRole === "admin" ||
      actor.workspaceRole === "owner" ||
      actor.workspaceRole === "member"
    );
  }
  if (actor.kind === "agent") return true;
  return (
    actor.globalRole === "admin" ||
    actor.globalRole === "owner" ||
    actor.globalRole === "member"
  );
}

export function canManageWorkspace(actor: SpaceActor): boolean {
  if (actor.globalRole === "admin") return true;
  if (actor.kind === "agent") return true;
  return actor.workspaceRole === "owner" || actor.workspaceRole === "member";
}

function requireManageWorkspace(actor: SpaceActor): void {
  if (!canManageWorkspace(actor)) {
    throw new SpaceError(
      "forbidden",
      "workspace sharing permission is required",
    );
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

const SECRET_RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  {
    rule: "pem_private_key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u,
  },
  { rule: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { rule: "openai_api_key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u },
  { rule: "deepseek_api_key", pattern: /\bsk-[a-f0-9]{32}\b/u },
  {
    rule: "github_token",
    pattern: /\b(?:ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/u,
  },
  { rule: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
];

export interface SecretFinding {
  readonly rule: string;
  readonly line: number;
}

export function scanSecrets(content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const candidate of SECRET_RULES) {
      if (candidate.pattern.test(line)) {
        findings.push({ rule: candidate.rule, line: index + 1 });
        break;
      }
    }
  }
  return findings;
}

export function redactSecrets(content: string): string {
  return SECRET_RULES.reduce(
    (current, rule) => current.replace(rule.pattern, `[REDACTED:${rule.rule}]`),
    content,
  );
}

async function safeTarget(
  root: string,
  untrustedPath: string,
): Promise<string> {
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  const lexical = resolveWithin(realRoot, untrustedPath);
  let existing = lexical;
  while (true) {
    if (isWithin(realRoot, existing)) {
      const exists = await stat(existing).then(
        () => true,
        () => false,
      );
      if (exists) {
        const real = await realpath(existing);
        if (!isWithin(realRoot, real)) {
          throw new SpaceError(
            "forbidden",
            "path escapes the shared root through a symlink",
          );
        }
        return existing === lexical
          ? real
          : resolve(real, relative(existing, lexical));
      }
    }
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  throw new SpaceError("not_found", "shared root cannot be resolved");
}

async function atomicWrite(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.pluginmax-${randomUUID()}`);
  await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, target);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
}

async function listFiles(
  root: string,
  prefix = "",
): Promise<Array<{ path: string; size: number; updatedAt: string }>> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: Array<{ path: string; size: number; updatedAt: string }> = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const child = join(root, entry.name);
    const childPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(child, childPath)));
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(child);
    files.push({
      path: childPath,
      size: info.size,
      updatedAt: info.mtime.toISOString(),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export interface SharedFileInfo {
  readonly path: string;
  readonly scope: ShareScope;
  readonly size: number;
  readonly updatedAt: string;
  readonly source: "user" | "agent";
}

export interface ApprovalRequestLike {
  readonly agent: unknown;
  readonly toolName: string;
  readonly callId?: unknown;
  readonly reason?: string;
  readonly signal?: AbortSignal;
}

export type ApprovalOutcomeLike =
  "allowed-once" | "rejected" | "cancelled" | "unavailable";

export interface SharingServiceOptions {
  readonly now?: () => Date;
  readonly randomId?: () => string;
  readonly sharedDirectoryName?: string;
}

export class SharingService {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly sharedDirectoryName: string;
  private chain: Promise<void> = Promise.resolve();
  private auditSequence = 0;

  constructor(
    private readonly tables: {
      readonly policies: KvTableLike<PolicyRecord>;
      readonly audit: KvTableLike<SpaceAuditRecord>;
      readonly globalRequests: KvTableLike<GlobalRequestRecord>;
      readonly configs: KvTableLike<WorkspaceConfigRecord>;
    },
    private readonly workspaces: WorkspaceRegistryLike,
    private readonly globalRoot: string,
    options: SharingServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => randomUUID());
    this.sharedDirectoryName = options.sharedDirectoryName ?? ".dsh-shared";
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private time(): string {
    return this.now().toISOString();
  }

  private workspace(workspaceId: string): WorkspaceLike {
    const parsed = parseOrInvalid(idSchema, workspaceId);
    const workspace = this.workspaces.get(parsed);
    if (workspace === undefined) {
      throw new SpaceError("not_found", `unknown workspace: ${parsed}`);
    }
    return workspace;
  }

  private sharedRoot(workspaceId: string): string {
    return join(this.workspace(workspaceId).path, this.sharedDirectoryName);
  }

  private async appendAudit(
    actor: SpaceActor,
    action: SpaceAuditRecord["action"],
    fields: {
      workspaceId?: string;
      path?: string;
      detail?: Record<string, string>;
    } = {},
  ): Promise<void> {
    const at = this.time();
    const id = `${at}:${String(++this.auditSequence).padStart(6, "0")}`;
    await this.tables.audit.put(id, {
      id,
      at,
      actorId: actor.id,
      actorKind: actor.kind,
      action,
      ...(fields.workspaceId === undefined
        ? {}
        : { workspaceId: fields.workspaceId }),
      ...(fields.path === undefined ? {} : { path: fields.path }),
      detail: fields.detail ?? {},
    });
  }

  private configRecord(
    workspaceId: string,
    actor: SpaceActor,
  ): WorkspaceConfigRecord {
    const current = this.tables.configs.get(workspaceId);
    if (current !== undefined) return current;
    const record = workspaceConfigSchema.parse({
      workspaceId,
      updatedAt: this.time(),
      updatedBy: actor.id,
    });
    void this.tables.configs.put(workspaceId, record);
    return record;
  }

  config(
    actor: SpaceActor,
    workspaceId: string,
  ): Promise<WorkspaceConfigRecord> {
    requireManageWorkspace(actor);
    const parsed = parseOrInvalid(idSchema, workspaceId);
    return this.enqueue(async () => this.configRecord(parsed, actor));
  }

  updateConfig(
    actor: SpaceActor,
    workspaceId: string,
    changes: {
      enabled?: boolean | undefined;
      defaultScope?: ShareScope | undefined;
      lockTtlMs?: number | undefined;
    },
  ): Promise<WorkspaceConfigRecord> {
    requireManageWorkspace(actor);
    const parsedWorkspace = parseOrInvalid(idSchema, workspaceId);
    const parsedChanges = parseOrInvalid(
      z.object({
        enabled: z.boolean().optional(),
        defaultScope: z.enum(SHARE_SCOPES).optional(),
        lockTtlMs: z
          .number()
          .int()
          .min(30_000)
          .max(24 * 60 * 60 * 1000)
          .optional(),
      }),
      changes,
    );
    return this.enqueue(async () => {
      const current = this.configRecord(parsedWorkspace, actor);
      const updated = workspaceConfigSchema.parse({
        ...current,
        ...parsedChanges,
        workspaceId: parsedWorkspace,
        updatedAt: this.time(),
        updatedBy: actor.id,
      });
      await this.tables.configs.put(parsedWorkspace, updated);
      return updated;
    });
  }

  declarePolicy(
    actor: SpaceActor,
    input: {
      workspaceId: string;
      pattern: string;
      scope: ShareScope;
      permissions: readonly SharePermission[];
      effect?: ShareEffect;
      subjectUser?: string | undefined;
      sessionId?: string | undefined;
      expiresAt?: string;
    },
  ): Promise<PolicyRecord> {
    requireManageWorkspace(actor);
    const parsed = parseOrInvalid(
      z
        .object({
          workspaceId: idSchema,
          pattern: patternSchema,
          scope: z.enum(SHARE_SCOPES),
          permissions: permissionListSchema,
          effect: z.enum(SHARE_EFFECTS).default("allow"),
          subjectUser: idSchema.optional(),
          sessionId: idSchema.optional(),
          expiresAt: isoTimeSchema.optional(),
        })
        .refine(
          (value) => value.scope !== "session" || value.sessionId !== undefined,
          {
            message: "session scope requires sessionId",
          },
        ),
      input,
    );
    return this.enqueue(async () => {
      if (parsed.workspaceId !== "global") this.workspace(parsed.workspaceId);
      const at = this.time();
      if (
        parsed.expiresAt !== undefined &&
        Date.parse(parsed.expiresAt) <= Date.parse(at)
      ) {
        throw new SpaceError(
          "invalid_input",
          "expiresAt must be in the future",
        );
      }
      const record = policyRecordSchema.parse({
        id: `pol_${this.randomId()}`,
        workspaceId: parsed.workspaceId,
        pattern: parsed.pattern,
        scope: parsed.scope,
        permissions: parsed.permissions,
        effect: parsed.effect,
        ...(parsed.subjectUser === undefined
          ? {}
          : { subjectUser: parsed.subjectUser }),
        sessionIds:
          parsed.scope === "session" && parsed.sessionId !== undefined
            ? [parsed.sessionId]
            : [],
        createdBy: actor.id,
        createdAt: at,
        ...(parsed.expiresAt === undefined
          ? {}
          : { expiresAt: parsed.expiresAt }),
      });
      await this.tables.policies.put(record.id, record);
      await this.appendAudit(actor, "policy_add", {
        workspaceId: parsed.workspaceId,
        path: parsed.pattern,
        detail: { scope: parsed.scope, effect: parsed.effect },
      });
      return record;
    });
  }

  globalRequests(): GlobalRequestRecord[] {
    return tableValues(this.tables.globalRequests)
      .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt))
      .map((record) => ({ ...record, pendingPath: "[pending]" }));
  }

  async decideGlobal(
    actor: SpaceActor,
    requestId: string,
    approve: boolean,
  ): Promise<GlobalRequestRecord> {
    if (actor.globalRole !== "admin") {
      throw new SpaceError("forbidden", "admin role is required");
    }
    const parsedId = parseOrInvalid(z.string().min(1).max(80), requestId);
    return this.enqueue(async () => {
      const current = this.tables.globalRequests.get(parsedId);
      if (current === undefined) {
        throw new SpaceError("not_found", "unknown global request");
      }
      if (current.status !== "pending") {
        throw new SpaceError("conflict", "global request is already decided");
      }
      if (!approve) {
        await rm(current.pendingPath, { force: true });
        const rejected = globalRequestSchema.parse({
          ...current,
          status: "rejected",
          decidedBy: actor.id,
          decidedAt: this.time(),
        });
        await this.tables.globalRequests.put(rejected.id, rejected);
        await this.appendAudit(actor, "global_reject", {
          path: current.path,
          detail: { requestId: current.id },
        });
        return rejected;
      }
      const target = await safeTarget(this.globalRoot, current.path);
      const content = await readFile(current.pendingPath, "utf8");
      if (
        sha256(content) !== current.sha256 ||
        scanSecrets(content).length > 0
      ) {
        await rm(current.pendingPath, { force: true });
        throw new SpaceError("conflict", "global content failed verification");
      }
      await atomicWrite(target, content);
      await rm(current.pendingPath, { force: true });
      const approved = globalRequestSchema.parse({
        ...current,
        status: "approved",
        decidedBy: actor.id,
        decidedAt: this.time(),
      });
      await this.tables.globalRequests.put(approved.id, approved);
      await this.putPolicy(actor, {
        workspaceId: "global",
        pattern: current.path,
        scope: "global",
        permissions: ["read", "write"],
      });
      await this.appendAudit(actor, "global_approve", {
        path: current.path,
        detail: { requestId: current.id },
      });
      return approved;
    });
  }

  async globalFiles(): Promise<SharedFileInfo[]> {
    const files = await listFiles(this.globalRoot);
    return files.map((file) => ({ ...file, scope: "global", source: "user" }));
  }

  private policiesForGlobal(
    path: string,
    permission: SharePermission,
  ): boolean {
    return tableValues(this.tables.policies).some(
      (policy) =>
        policy.scope === "global" &&
        policy.effect === "allow" &&
        policy.permissions.includes(permission) &&
        policyMatchesPath(policy, path),
    );
  }

  async globalRead(actor: SpaceActor, path: string): Promise<string> {
    const parsed = parseOrInvalid(pathSchema, path);
    const allowed =
      actor.globalRole === "admin" ||
      ((actor.kind === "agent" ||
        (actor.globalRole !== undefined && actor.globalRole !== "guest")) &&
        this.policiesForGlobal(parsed, "read"));
    if (!allowed) {
      throw new SpaceError("forbidden", "global read permission is required");
    }
    const target = await safeTarget(this.globalRoot, parsed);
    try {
      const content = await readFile(target, "utf8");
      await this.appendAudit(actor, "file_read", {
        path: parsed,
        detail: { scope: "global" },
      });
      return content;
    } catch {
      throw new SpaceError("not_found", "global file not found");
    }
  }

  async globalWrite(
    actor: SpaceActor,
    input: { path: string; content: string },
    approval: (request: ApprovalRequestLike) => Promise<ApprovalOutcomeLike>,
  ): Promise<SharedFileInfo> {
    const parsed = parseOrInvalid(
      z.object({ path: pathSchema, content: z.string().max(10 * 1024 * 1024) }),
      input,
    );
    if (scanSecrets(parsed.content).length > 0) {
      throw new SpaceError("forbidden", "content contains a detected secret");
    }
    const permitted =
      actor.globalRole === "admin" ||
      (actor.kind === "agent" && this.policiesForGlobal(parsed.path, "write"));
    if (!permitted) {
      throw new SpaceError("forbidden", "global write permission is required");
    }
    const outcome = await approval({
      agent: actor.id,
      toolName: "collab_global_write",
      reason: `Write global shared file ${parsed.path}`,
    });
    if (outcome !== "allowed-once") {
      throw new SpaceError("forbidden", `global write was ${outcome}`);
    }
    const target = await safeTarget(this.globalRoot, parsed.path);
    await atomicWrite(target, parsed.content);
    await this.appendAudit(actor, "global_write", {
      path: parsed.path,
      detail: { approval: "allowed-once" },
    });
    const info = await stat(target);
    return {
      path: parsed.path,
      scope: "global",
      size: info.size,
      updatedAt: info.mtime.toISOString(),
      source: "agent",
    };
  }

  revokePolicy(actor: SpaceActor, policyId: string): Promise<PolicyRecord> {
    const parsedId = parseOrInvalid(z.string().min(1).max(80), policyId);
    return this.enqueue(async () => {
      const policy = this.tables.policies.get(parsedId);
      if (policy === undefined)
        throw new SpaceError("not_found", "unknown policy");
      const actorIsAdmin = actor.globalRole === "admin";
      const actorIsCreator = policy.createdBy === actor.id;
      const actorOwnsWorkspace = actor.workspaceRole === "owner";
      if (
        !actorIsAdmin &&
        !actorIsCreator &&
        !(actor.kind === "agent" && actorOwnsWorkspace)
      ) {
        throw new SpaceError(
          "forbidden",
          "policy owner or admin role is required",
        );
      }
      await this.tables.policies.delete(parsedId);
      await this.appendAudit(actor, "policy_remove", {
        workspaceId: policy.workspaceId,
        path: policy.pattern,
        detail: { policyId: policy.id },
      });
      return policy;
    });
  }

  policies(workspaceId: string): PolicyRecord[] {
    const parsed = parseOrInvalid(idSchema, workspaceId);
    const at = this.now().getTime();
    return tableValues(this.tables.policies)
      .filter(
        (policy) =>
          policy.workspaceId === parsed &&
          (policy.expiresAt === undefined || Date.parse(policy.expiresAt) > at),
      )
      .sort(
        (left, right) =>
          patternSpecificity(right.pattern) -
            patternSpecificity(left.pattern) ||
          left.createdAt.localeCompare(right.createdAt),
      );
  }

  resolve(input: {
    workspaceId: string;
    path: string;
    permission: SharePermission;
    actor: SpaceActor;
    sessionId?: string | undefined;
  }): { effect: "allow" | "deny"; policyId?: string; reason: string } {
    const parsed = parseOrInvalid(
      z.object({
        workspaceId: idSchema,
        path: pathSchema,
        permission: z.enum(SHARE_PERMISSIONS),
        actor: actorSchema,
        sessionId: idSchema.optional(),
      }),
      input,
    );
    this.workspace(parsed.workspaceId);
    const matches = this.policies(parsed.workspaceId).filter(
      (policy) =>
        policyMatchesPath(policy, parsed.path) &&
        policy.permissions.includes(parsed.permission) &&
        policyMatchesSubject(policy, parsed.actor),
    );
    const deny = matches.find((policy) => policy.effect === "deny");
    if (deny !== undefined) {
      return {
        effect: "deny",
        policyId: deny.id,
        reason: "matched deny policy",
      };
    }
    const allow = matches.find(
      (policy) =>
        policy.effect === "allow" &&
        scopeAllows(policy, parsed.actor, parsed.sessionId),
    );
    return allow === undefined
      ? { effect: "deny", reason: "no matching sharing policy" }
      : {
          effect: "allow",
          policyId: allow.id,
          reason: "matched sharing policy",
        };
  }

  private storagePath(
    scope: ShareScope,
    path: string,
    sessionId?: string | undefined,
  ): string {
    const parsed = parseOrInvalid(pathSchema, path);
    if (scope === "session") {
      if (sessionId === undefined) {
        throw new SpaceError(
          "invalid_input",
          "session scope requires sessionId",
        );
      }
      return `session/${sessionId}/${parsed}`;
    }
    return `${scope}/${parsed}`;
  }

  private async putPolicy(
    actor: SpaceActor,
    parsed: {
      workspaceId: string;
      pattern: string;
      scope: ShareScope;
      permissions: readonly SharePermission[];
      effect?: ShareEffect;
      subjectUser?: string | undefined;
      sessionId?: string | undefined;
      expiresAt?: string;
    },
  ): Promise<PolicyRecord> {
    const record = policyRecordSchema.parse({
      id: `pol_${this.randomId()}`,
      workspaceId: parsed.workspaceId,
      pattern: parsed.pattern,
      scope: parsed.scope,
      permissions: parsed.permissions,
      effect: parsed.effect ?? "allow",
      ...(parsed.subjectUser === undefined
        ? {}
        : { subjectUser: parsed.subjectUser }),
      sessionIds:
        parsed.scope === "session" && parsed.sessionId !== undefined
          ? [parsed.sessionId]
          : [],
      createdBy: actor.id,
      createdAt: this.time(),
      ...(parsed.expiresAt === undefined
        ? {}
        : { expiresAt: parsed.expiresAt }),
    });
    await this.tables.policies.put(record.id, record);
    await this.appendAudit(actor, "policy_add", {
      workspaceId: parsed.workspaceId,
      path: parsed.pattern,
      detail: { scope: parsed.scope, effect: record.effect },
    });
    return record;
  }

  async upload(
    actor: SpaceActor,
    input: {
      workspaceId: string;
      path: string;
      content: string;
      scope?: ShareScope | undefined;
      sessionId?: string | undefined;
    },
  ): Promise<
    { file: SharedFileInfo; policy: PolicyRecord } | GlobalRequestRecord
  > {
    requireManageWorkspace(actor);
    const configRecord = this.configRecord(input.workspaceId, actor);
    const parsed = parseOrInvalid(
      z.object({
        workspaceId: idSchema,
        path: pathSchema,
        content: z.string().max(10 * 1024 * 1024),
        scope: z.enum(SHARE_SCOPES).default(configRecord.defaultScope),
        sessionId: idSchema.optional(),
      }),
      input,
    );
    if (parsed.scope === "global") {
      return await this.submitGlobal(actor, parsed);
    }
    return this.enqueue(async () => {
      if (!configRecord.enabled) {
        throw new SpaceError("forbidden", "workspace sharing is disabled");
      }
      const storagePath = this.storagePath(
        parsed.scope,
        parsed.path,
        parsed.sessionId ?? actor.sessionId,
      );
      if (scanSecrets(parsed.content).length > 0) {
        throw new SpaceError("forbidden", "content contains a detected secret");
      }
      const target = await safeTarget(
        this.sharedRoot(parsed.workspaceId),
        storagePath,
      );
      await atomicWrite(target, parsed.content);
      await this.appendAudit(actor, "file_write", {
        workspaceId: parsed.workspaceId,
        path: storagePath,
        detail: { scope: parsed.scope, source: actor.kind },
      });
      const policy = await this.putPolicy(actor, {
        workspaceId: parsed.workspaceId,
        pattern: storagePath,
        scope: parsed.scope,
        permissions: ["read", "write"],
        sessionId: parsed.sessionId ?? actor.sessionId,
      });
      const info = await stat(target);
      return {
        file: {
          path: storagePath,
          scope: parsed.scope,
          size: info.size,
          updatedAt: info.mtime.toISOString(),
          source: actor.kind === "user" ? "user" : "agent",
        },
        policy,
      };
    });
  }

  async files(workspaceId: string): Promise<SharedFileInfo[]> {
    const parsed = parseOrInvalid(idSchema, workspaceId);
    const files = await listFiles(this.sharedRoot(parsed));
    return files.map((file) => ({
      ...file,
      scope: file.path.startsWith("session/") ? "session" : "workspace",
      source: "user",
    }));
  }

  async read(
    actor: SpaceActor,
    input: {
      workspaceId: string;
      path: string;
      sessionId?: string | undefined;
    },
  ): Promise<{ path: string; content: string }> {
    const parsed = parseOrInvalid(
      z.object({
        workspaceId: idSchema,
        path: pathSchema,
        sessionId: idSchema.optional(),
      }),
      input,
    );
    const decision = this.resolve({
      ...parsed,
      permission: "read",
      actor,
      sessionId: parsed.sessionId ?? actor.sessionId,
    });
    if (decision.effect !== "allow") {
      throw new SpaceError("forbidden", decision.reason);
    }
    const target = await safeTarget(
      this.sharedRoot(parsed.workspaceId),
      parsed.path,
    );
    try {
      const content = await readFile(target, "utf8");
      await this.appendAudit(actor, "file_read", {
        workspaceId: parsed.workspaceId,
        path: parsed.path,
        detail: { policyId: decision.policyId ?? "" },
      });
      return { path: parsed.path, content };
    } catch {
      throw new SpaceError("not_found", "shared file not found");
    }
  }

  audit(
    filter: {
      workspaceId?: string | undefined;
      action?: string | undefined;
      limit?: number | undefined;
    } = {},
  ): SpaceAuditRecord[] {
    const parsed = parseOrInvalid(
      z.object({
        workspaceId: idSchema.optional(),
        action: z.string().min(1).max(64).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      filter,
    );
    const records = tableValues(this.tables.audit)
      .filter(
        (record) =>
          (parsed.workspaceId === undefined ||
            record.workspaceId === parsed.workspaceId) &&
          (parsed.action === undefined || record.action === parsed.action),
      )
      .sort(
        (left, right) =>
          right.at.localeCompare(left.at) || right.id.localeCompare(left.id),
      );
    return parsed.limit === undefined
      ? records
      : records.slice(0, parsed.limit);
  }

  async claim(
    actor: SpaceActor,
    input: {
      workspaceId: string;
      path: string;
      sessionId?: string | undefined;
    },
  ): Promise<ClaimRecord> {
    requireManageWorkspace(actor);
    const parsed = parseOrInvalid(
      z.object({
        workspaceId: idSchema,
        path: pathSchema,
        sessionId: idSchema.optional(),
      }),
      input,
    );
    return this.enqueue(async () => {
      const sessionId =
        parsed.sessionId ??
        (actor.sessionId !== undefined ? actor.sessionId : undefined);
      if (sessionId === undefined) {
        throw new SpaceError("invalid_input", "claim requires a session id");
      }
      const target = await safeTarget(
        this.workspace(parsed.workspaceId).path,
        parsed.path,
      );
      const record = claimRecordSchema.parse({
        path: parsed.path,
        ownerId: actor.id,
        ownerSessionId: sessionId,
        claimedAt: this.time(),
      });
      await atomicWrite(
        `${target}.dsh-claim`,
        `${JSON.stringify(record, null, 2)}\n`,
      );
      await this.appendAudit(actor, "claim", {
        workspaceId: parsed.workspaceId,
        path: parsed.path,
      });
      return record;
    });
  }

  async claimFor(
    workspaceId: string,
    path: string,
  ): Promise<ClaimRecord | undefined> {
    const parsed = parseOrInvalid(
      z.object({ workspaceId: idSchema, path: pathSchema }),
      { workspaceId, path },
    );
    try {
      const target = await safeTarget(
        this.workspace(parsed.workspaceId).path,
        parsed.path,
      );
      const raw = await readFile(`${target}.dsh-claim`, "utf8");
      return claimRecordSchema.parse(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  async submitGlobal(
    actor: SpaceActor,
    input: { path: string; content: string },
  ): Promise<GlobalRequestRecord> {
    const parsed = parseOrInvalid(
      z.object({ path: pathSchema, content: z.string().max(10 * 1024 * 1024) }),
      input,
    );
    return this.enqueue(async () => {
      if (scanSecrets(parsed.content).length > 0) {
        throw new SpaceError("forbidden", "content contains a detected secret");
      }
      const duplicate = tableValues(this.tables.globalRequests).find(
        (record) =>
          record.path === parsed.path && record.status === "pending",
      );
      if (duplicate !== undefined) {
        throw new SpaceError(
          "conflict",
          `global request is already pending: ${parsed.path}`,
        );
      }
      const pendingRoot = join(this.globalRoot, ".pending");
      const pendingPath = await safeTarget(
        pendingRoot,
        `${this.randomId()}/${parsed.path}`,
      );
      await atomicWrite(pendingPath, parsed.content);
      const record = globalRequestSchema.parse({
        id: `req_${this.randomId()}`,
        path: parsed.path,
        pendingPath,
        submittedBy: actor.id,
        submittedAt: this.time(),
        size: Buffer.byteLength(parsed.content, "utf8"),
        sha256: sha256(parsed.content),
        status: "pending",
      });
      await this.tables.globalRequests.put(record.id, record);
      await this.appendAudit(actor, "global_submit", {
        path: parsed.path,
        detail: { requestId: record.id },
      });
      return record;
    });
  }
}

export interface LockServiceOptions {
  readonly now?: () => Date;
  readonly defaultTtlMs?: number;
}

export class LockService {
  private readonly now: () => Date;
  private readonly defaultTtlMs: number;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly table: KvTableLike<LockRecord>,
    options: LockServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.defaultTtlMs = options.defaultTtlMs ?? 10 * 60 * 1000;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isActive(lock: LockRecord): boolean {
    return Date.parse(lock.expiresAt) > this.now().getTime();
  }

  private key(workspaceId: string, path: string): string {
    const parsed = parseOrInvalid(
      z.object({ workspaceId: idSchema, path: pathSchema }),
      { workspaceId, path },
    );
    return `${parsed.workspaceId}:${parsed.path}`;
  }

  acquire(
    actor: SpaceActor,
    input: {
      workspaceId: string;
      path: string;
      sessionId?: string | undefined;
      ttlMs?: number | undefined;
    },
  ): Promise<LockRecord> {
    const parsed = parseOrInvalid(
      z.object({
        workspaceId: idSchema,
        path: pathSchema,
        sessionId: idSchema.optional(),
        ttlMs: z
          .number()
          .int()
          .min(30_000)
          .max(24 * 60 * 60 * 1000)
          .optional(),
      }),
      input,
    );
    const sessionId = parsed.sessionId ?? actor.sessionId;
    if (sessionId === undefined) {
      throw new SpaceError("invalid_input", "lock requires a session id");
    }
    const key = this.key(parsed.workspaceId, parsed.path);
    return this.enqueue(async () => {
      const current = this.table.get(key);
      const currentIsActive = current !== undefined && this.isActive(current);
      const sameOwner =
        current !== undefined &&
        current.ownerId === actor.id &&
        current.ownerSessionId === sessionId;
      if (currentIsActive && !sameOwner) {
        throw new SpaceError(
          "conflict",
          `locked by ${current.ownerId} until ${current.expiresAt}`,
        );
      }
      const now = this.now();
      const ttlMs = parsed.ttlMs ?? this.defaultTtlMs;
      const lock = lockRecordSchema.parse({
        key,
        workspaceId: parsed.workspaceId,
        path: parsed.path,
        ownerId: actor.id,
        ownerSessionId: sessionId,
        acquiredAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      });
      await this.table.put(key, lock);
      return lock;
    });
  }

  release(
    actor: SpaceActor,
    input: {
      workspaceId: string;
      path: string;
      sessionId?: string | undefined;
    },
  ): Promise<boolean> {
    const parsed = parseOrInvalid(
      z.object({
        workspaceId: idSchema,
        path: pathSchema,
        sessionId: idSchema.optional(),
      }),
      input,
    );
    const sessionId = parsed.sessionId ?? actor.sessionId;
    const key = this.key(parsed.workspaceId, parsed.path);
    return this.enqueue(async () => {
      const current = this.table.get(key);
      if (current === undefined) return false;
      const owns =
        current.ownerId === actor.id &&
        (sessionId === undefined || current.ownerSessionId === sessionId);
      const admin = actor.globalRole === "admin";
      if (!owns && !admin) {
        throw new SpaceError(
          "forbidden",
          "lock owner or admin role is required",
        );
      }
      return this.table.delete(key);
    });
  }

  status(workspaceId: string): LockRecord[] {
    const parsed = parseOrInvalid(idSchema, workspaceId);
    return tableValues(this.table)
      .filter((lock) => lock.workspaceId === parsed && this.isActive(lock))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  conflict(
    workspaceId: string,
    path: string,
    actor: SpaceActor,
  ): LockRecord | undefined {
    const lock = this.table.get(this.key(workspaceId, path));
    if (lock === undefined || !this.isActive(lock)) return undefined;
    const sameSession =
      actor.sessionId !== undefined &&
      lock.ownerSessionId === actor.sessionId &&
      lock.ownerId === actor.id;
    return sameSession ? undefined : lock;
  }
}

export interface DigestServiceOptions {
  readonly now?: () => Date;
  readonly sharedDirectoryName?: string;
}

export class DigestService {
  private readonly now: () => Date;
  private readonly sharedDirectoryName: string;

  constructor(
    private readonly workspaces: WorkspaceRegistryLike,
    options: DigestServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.sharedDirectoryName = options.sharedDirectoryName ?? ".dsh-shared";
  }

  render(sessionId: string, events: readonly DigestEvent[]): string {
    const parsedSession = parseOrInvalid(idSchema, sessionId);
    const parsedEvents = parseOrInvalid(
      z.array(digestEventSchema).max(1000),
      events,
    );
    const sections = new Map<string, string[]>();
    for (const event of parsedEvents) {
      const title = event.title ?? event.type;
      const text = redactSecrets(event.text).slice(0, 1000);
      const at = event.at ?? "unknown time";
      const suffix = event.path === undefined ? "" : ` (${event.path})`;
      const line = `- ${at}: ${title}${suffix}${text === "" ? "" : ` — ${text}`}`;
      const bucket =
        event.type === "user" || event.type === "assistant"
          ? "Conversation"
          : event.type === "tool"
            ? "Tool activity"
            : "Files";
      const lines = sections.get(bucket) ?? [];
      lines.push(line);
      sections.set(bucket, lines);
    }
    const body = [...sections.entries()]
      .map(([heading, lines]) => `## ${heading}\n${lines.join("\n")}`)
      .join("\n\n");
    return [
      `# Session digest: ${parsedSession}`,
      "",
      `Generated: ${this.now().toISOString()}`,
      "",
      body === "" ? "No activity supplied." : body,
      "",
    ].join("\n");
  }

  async digestFor(
    workspaceId: string,
    sessionId: string,
    events: readonly DigestEvent[],
  ): Promise<{ path: string; content: string }> {
    const parsedWorkspace = parseOrInvalid(idSchema, workspaceId);
    const parsedSession = parseOrInvalid(idSchema, sessionId);
    const workspace = this.workspaces.get(parsedWorkspace);
    if (workspace === undefined) {
      throw new SpaceError(
        "not_found",
        `unknown workspace: ${parsedWorkspace}`,
      );
    }
    const content = this.render(parsedSession, events);
    const root = join(workspace.path, this.sharedDirectoryName, "logs");
    const target = await safeTarget(root, `${parsedSession}.md`);
    await atomicWrite(target, content);
    return {
      path: `logs/${parsedSession}.md`,
      content,
    };
  }

  async list(workspaceId: string): Promise<SharedFileInfo[]> {
    const parsed = parseOrInvalid(idSchema, workspaceId);
    const workspace = this.workspaces.get(parsed);
    if (workspace === undefined) {
      throw new SpaceError("not_found", `unknown workspace: ${parsed}`);
    }
    const files = await listFiles(
      join(workspace.path, this.sharedDirectoryName),
      "",
    );
    return files
      .filter((file) => file.path.startsWith("logs/"))
      .map((file) => ({ ...file, scope: "workspace", source: "user" }));
  }
}

interface CommandResultLike {
  readonly kind: "success" | "error";
  readonly text: string;
}

interface ToolOutputLike {
  readonly schema: { readonly type: "string" };
  render(args: unknown, value: string): Array<{ type: "text"; text: string }>;
}

export interface WebRouteLike {
  readonly kind: "exact";
  readonly path: string;
  handler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> | void;
}

interface ToolExecLike {
  readonly signal: AbortSignal;
  readonly callId?: unknown;
  readonly agent?: {
    readonly session?: {
      readonly id?: string;
      readonly meta?: { readonly cwd?: string };
    };
  };
}

interface ToolDefinitionLike {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly output: ToolOutputLike;
  execute(args: unknown, exec: ToolExecLike): Promise<string>;
}

interface ApprovalServiceLike {
  request(request: ApprovalRequestLike): Promise<ApprovalOutcomeLike>;
}

interface ToolPreExecutionLike {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly callId?: unknown;
  readonly agent?: {
    readonly session?: {
      readonly id?: string;
      readonly meta?: { readonly cwd?: string };
    };
  };
}

type PreToolDecisionLike =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly reason: string };

export interface SpaceContext {
  effect(register: () => () => void): void;
  provide(key: "collabSharing", value: SharingService): unknown;
  provide(key: "collabLock", value: LockService): unknown;
  provide(key: "collabDigest", value: DigestService): unknown;
  commands: {
    register(definition: {
      name: string;
      description: string;
      input: { hint: string; attachments: boolean };
      handler(invocation: { readonly rawInput: string }): CommandResultLike;
    }): unknown;
  };
  tools: { register(definition: ToolDefinitionLike): unknown };
  webServer: { register(route: WebRouteLike): unknown };
  storageDomain: {
    open(
      spec: DomainSpecLike,
    ): Promise<SharingDomainLike & ConfigDomainLike & LockDomainLike>;
  };
  workspaceRegistry: WorkspaceRegistryLike;
  collabTeam?: TeamServiceLike;
  inject(
    keys: readonly ["collabTeam"],
    callback: (
      child: SpaceContext & { readonly collabTeam: TeamServiceLike },
    ) => void,
  ): { dispose(): void };
  approval?: ApprovalServiceLike;
  on(
    event: "tools/pre-execute",
    listener: (
      exec: ToolPreExecutionLike,
      next: () => Promise<PreToolDecisionLike>,
    ) => Promise<PreToolDecisionLike>,
  ): () => void;
}

function agentActor(sessionId: string | undefined): SpaceActor {
  const id = sessionId === undefined ? "agent" : sessionId;
  return {
    kind: "agent",
    id,
    ...(sessionId === undefined ? {} : { sessionId }),
    workspaceRole: "member",
  };
}

function browserActor(
  team: TeamServiceLike,
  request: IncomingMessage,
  workspaceId: string,
): SpaceActor {
  const headers = request.headers;
  if (
    headers.origin !== undefined &&
    !sameOrigin(headers.origin, headers.host)
  ) {
    throw new SpaceError("forbidden", "same-origin requests are required");
  }
  const token = bearerToken({
    get: (name: string) =>
      name === "authorization" ? (headers.authorization ?? null) : null,
  });
  if (token === undefined)
    throw new SpaceError("unauthorized", "bearer token is required");
  const principal = team.resolveToken(token);
  if (principal === undefined)
    throw new SpaceError("unauthorized", "invalid bearer token");
  const sessionId = `browser:${createHash("sha256").update(token).digest("hex")}`;
  const member =
    workspaceId === "global"
      ? undefined
      : team
          .members(workspaceId)
          .find((candidate) => candidate.userId === principal.userId);
  return {
    kind: "user",
    id: principal.userId,
    sessionId,
    globalRole: principal.role,
    ...(member === undefined ? {} : { workspaceRole: member.memberRole }),
  };
}

function queryParam(url: string | undefined, name: string): string | undefined {
  if (url === undefined) return undefined;
  const parsed = new URL(url, "http://localhost");
  const value = parsed.searchParams.get(name);
  return value === null || value === "" ? undefined : value;
}

function errorStatus(code: SpaceError["code"]): number {
  if (code === "invalid_input") return 400;
  if (code === "unauthorized") return 401;
  if (code === "forbidden") return 403;
  if (code === "not_found") return 404;
  return 409;
}

async function runHandler(
  operation: () => Promise<void>,
  response: ServerResponse,
): Promise<void> {
  try {
    await operation();
  } catch (cause) {
    if (cause instanceof SpaceError) {
      sendJson(response, errorStatus(cause.code), {
        ok: false,
        error: { code: cause.code, message: cause.message },
      });
      return;
    }
    sendJson(response, 500, {
      ok: false,
      error: { code: "internal_error", message: "space operation failed" },
    });
  }
}

export function createSpaceRoutes(
  sharing: SharingService,
  locks: LockService,
  digest: DigestService,
  team: TeamServiceLike,
  workspaces: WorkspaceRegistryLike,
): WebRouteLike[] {
  interface RouteDefinition {
    readonly method: "GET" | "POST" | "PUT";
    readonly path: string;
    handler(request: IncomingMessage, response: ServerResponse): Promise<void>;
  }
  const routes: RouteDefinition[] = [
    {
      method: "GET",
      path: "/api/collab/space/workspaces",
      handler: async (request, response) => {
        const actor = browserActor(team, request, "global");
        void actor;
        sendJson(response, 200, {
          ok: true,
          workspaces: workspaces.list().map((workspace) => ({
            id: workspace.id,
            title: workspace.title,
            path: workspace.path,
          })),
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/space/config",
      handler: async (request, response) => {
        const workspaceId = queryParam(request.url, "workspaceId");
        if (workspaceId === undefined)
          throw new SpaceError("invalid_input", "workspaceId is required");
        const actor = browserActor(team, request, workspaceId);
        sendJson(response, 200, {
          ok: true,
          config: await sharing.config(actor, workspaceId),
        });
      },
    },
    {
      method: "PUT",
      path: "/api/collab/space/config",
      handler: async (request, response) => {
        const body = parseOrInvalid(
          z.object({
            workspaceId: idSchema,
            enabled: z.boolean().optional(),
            defaultScope: z.enum(SHARE_SCOPES).optional(),
            lockTtlMs: z
              .number()
              .int()
              .min(30_000)
              .max(24 * 60 * 60 * 1000)
              .optional(),
          }),
          await readJsonBody(request),
        );
        const actor = browserActor(team, request, body.workspaceId);
        sendJson(response, 200, {
          ok: true,
          config: await sharing.updateConfig(actor, body.workspaceId, body),
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/space/policies",
      handler: async (request, response) => {
        const workspaceId = queryParam(request.url, "workspaceId");
        if (workspaceId === undefined)
          throw new SpaceError("invalid_input", "workspaceId is required");
        browserActor(team, request, workspaceId);
        sendJson(response, 200, {
          ok: true,
          policies: sharing.policies(workspaceId),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/space/policies",
      handler: async (request, response) => {
        const body = parseOrInvalid(
          z.object({
            workspaceId: idSchema,
            pattern: pathSchema,
            scope: z.enum(SHARE_SCOPES),
            permissions: permissionListSchema,
            effect: z.enum(SHARE_EFFECTS).default("allow"),
            subjectUser: idSchema.optional(),
            sessionId: idSchema.optional(),
          }),
          await readJsonBody(request),
        );
        const actor = browserActor(team, request, body.workspaceId);
        if (body.scope === "global" && actor.globalRole !== "admin") {
          throw new SpaceError(
            "forbidden",
            "admin role is required for global policies",
          );
        }
        const policy = await sharing.declarePolicy(actor, body);
        sendJson(response, 201, { ok: true, policy });
      },
    },
    {
      method: "POST",
      path: "/api/collab/space/policies/remove",
      handler: async (request, response) => {
        const body = parseOrInvalid(
          z.object({ policyId: z.string().min(1).max(80) }),
          await readJsonBody(request),
        );
        const actor = browserActor(team, request, "global");
        sendJson(response, 200, {
          ok: true,
          policy: await sharing.revokePolicy(actor, body.policyId),
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/space/files",
      handler: async (request, response) => {
        const workspaceId = queryParam(request.url, "workspaceId");
        if (workspaceId === undefined)
          throw new SpaceError("invalid_input", "workspaceId is required");
        browserActor(team, request, workspaceId);
        sendJson(response, 200, {
          ok: true,
          files: await sharing.files(workspaceId),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/space/files",
      handler: async (request, response) => {
        const body = parseOrInvalid(
          z.object({
            workspaceId: idSchema,
            path: pathSchema,
            content: z.string().max(10 * 1024 * 1024),
            scope: z.enum(SHARE_SCOPES).optional(),
            sessionId: idSchema.optional(),
          }),
          await readJsonBody(request),
        );
        const actor = browserActor(team, request, body.workspaceId);
        const result = await sharing.upload(actor, body);
        if ("id" in result && "status" in result) {
          sendJson(response, 202, { ok: true, request: result });
          return;
        }
        sendJson(response, 201, { ok: true, ...result });
      },
    },
    {
      method: "POST",
      path: "/api/collab/space/file/read",
      handler: async (request, response) => {
        const body = parseOrInvalid(
          z.object({
            workspaceId: idSchema,
            path: pathSchema,
            sessionId: idSchema.optional(),
          }),
          await readJsonBody(request),
        );
        const actor = browserActor(team, request, body.workspaceId);
        sendJson(response, 200, {
          ok: true,
          ...(await sharing.read(actor, body)),
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/space/global/files",
      handler: async (request, response) => {
        browserActor(team, request, "global");
        sendJson(response, 200, {
          ok: true,
          files: await sharing.globalFiles(),
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/space/global/requests",
      handler: async (request, response) => {
        const actor = browserActor(team, request, "global");
        if (actor.globalRole !== "admin") {
          throw new SpaceError("forbidden", "admin role is required");
        }
        sendJson(response, 200, {
          ok: true,
          requests: sharing.globalRequests(),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/space/global/requests/decision",
      handler: async (request, response) => {
        const body = parseOrInvalid(
          z.object({
            requestId: z.string().min(1).max(80),
            approve: z.boolean(),
          }),
          await readJsonBody(request),
        );
        const actor = browserActor(team, request, "global");
        sendJson(response, 200, {
          ok: true,
          request: await sharing.decideGlobal(
            actor,
            body.requestId,
            body.approve,
          ),
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/space/locks",
      handler: async (request, response) => {
        const workspaceId = queryParam(request.url, "workspaceId");
        if (workspaceId === undefined)
          throw new SpaceError("invalid_input", "workspaceId is required");
        browserActor(team, request, workspaceId);
        sendJson(response, 200, { ok: true, locks: locks.status(workspaceId) });
      },
    },
    {
      method: "POST",
      path: "/api/collab/space/locks/acquire",
      handler: async (request, response) => {
        const body = parseOrInvalid(
          z.object({
            workspaceId: idSchema,
            path: pathSchema,
            sessionId: idSchema.optional(),
            ttlMs: z
              .number()
              .int()
              .min(30_000)
              .max(24 * 60 * 60 * 1000)
              .optional(),
          }),
          await readJsonBody(request),
        );
        const actor = browserActor(team, request, body.workspaceId);
        sendJson(response, 201, {
          ok: true,
          lock: await locks.acquire(actor, body),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/space/locks/release",
      handler: async (request, response) => {
        const body = parseOrInvalid(
          z.object({
            workspaceId: idSchema,
            path: pathSchema,
            sessionId: idSchema.optional(),
          }),
          await readJsonBody(request),
        );
        const actor = browserActor(team, request, body.workspaceId);
        sendJson(response, 200, {
          ok: true,
          released: await locks.release(actor, body),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/space/claims",
      handler: async (request, response) => {
        const body = parseOrInvalid(
          z.object({ workspaceId: idSchema, path: pathSchema }),
          await readJsonBody(request),
        );
        const actor = browserActor(team, request, body.workspaceId);
        sendJson(response, 201, {
          ok: true,
          claim: await sharing.claim(actor, body),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/space/digests",
      handler: async (request, response) => {
        const body = parseOrInvalid(
          z.object({
            workspaceId: idSchema,
            sessionId: idSchema,
            events: z.array(digestEventSchema).max(1000),
          }),
          await readJsonBody(request),
        );
        const actor = browserActor(team, request, body.workspaceId);
        void actor;
        sendJson(response, 201, {
          ok: true,
          digest: await digest.digestFor(
            body.workspaceId,
            body.sessionId,
            body.events,
          ),
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/space/digests",
      handler: async (request, response) => {
        const workspaceId = queryParam(request.url, "workspaceId");
        if (workspaceId === undefined)
          throw new SpaceError("invalid_input", "workspaceId is required");
        browserActor(team, request, workspaceId);
        sendJson(response, 200, {
          ok: true,
          digests: await digest.list(workspaceId),
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/space/audit",
      handler: async (request, response) => {
        const workspaceId = queryParam(request.url, "workspaceId");
        const limit = queryParam(request.url, "limit");
        if (workspaceId === undefined) {
          throw new SpaceError("invalid_input", "workspaceId is required");
        }
        browserActor(team, request, workspaceId);
        sendJson(response, 200, {
          ok: true,
          events: sharing.audit({
            workspaceId,
            ...(limit === undefined
              ? {}
              : {
                  limit: parseOrInvalid(
                    z.coerce.number().int().min(1).max(500),
                    limit,
                  ),
                }),
          }),
        });
      },
    },
  ];
  return [...new Set(routes.map((route) => route.path))].map((path) => ({
    kind: "exact" as const,
    path,
    handler: (request: IncomingMessage, response: ServerResponse) =>
      runHandler(async () => {
        const route = routes.find(
          (candidate) =>
            candidate.path === path && candidate.method === request.method,
        );
        if (route === undefined) {
          sendJson(response, 405, {
            ok: false,
            error: {
              code: "method_not_allowed",
              message: "method not allowed",
            },
          });
          return;
        }
        await route.handler(request, response);
      }, response),
  }));
}

function commandSummary(
  sharing: SharingService,
  locks: LockService,
  workspaceId: string,
): string {
  const policies = sharing
    .policies(workspaceId)
    .map(
      (policy) =>
        `${policy.id}\t${policy.pattern}\t${policy.effect}/${policy.scope}\t${policy.permissions.join(",")}`,
    )
    .join("\n");
  const activeLocks = locks
    .status(workspaceId)
    .map((lock) => `${lock.path}\t${lock.ownerId}\t${lock.expiresAt}`)
    .join("\n");
  return [
    `workspace: ${workspaceId}`,
    policies === "" ? "policies: none" : `policies:\n${policies}`,
    activeLocks === "" ? "locks: none" : `locks:\n${activeLocks}`,
  ].join("\n");
}

function registerSpaceCommand(
  ctx: SpaceContext,
  sharing: SharingService,
  locks: LockService,
): void {
  ctx.commands.register({
    name: "share",
    description: "manage DSH Pluginmax workspace sharing",
    input: {
      hint: "list [workspace] | add <workspace> <pattern> <scope> <permissions> | remove <policyId> | audit [workspace] | claim <workspace> <path>",
      attachments: false,
    },
    handler: (invocation) => {
      const parts = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
      const defaultWorkspace = ctx.workspaceRegistry.list()[0]?.id ?? "main";
      const [operation, second, third, fourth, fifth] = parts;
      const sessionId = "agent-command";
      const actor = agentActor(sessionId);
      try {
        if (operation === undefined || operation === "list") {
          return {
            kind: "success",
            text: commandSummary(sharing, locks, second ?? defaultWorkspace),
          };
        }
        if (
          operation === "add" &&
          second !== undefined &&
          third !== undefined &&
          fourth !== undefined
        ) {
          const permissions = (fifth ?? "read")
            .split(",")
            .map((permission) => permission.trim())
            .filter((permission) => permission !== "");
          const promise = sharing.declarePolicy(actor, {
            workspaceId: second,
            pattern: third,
            scope: parseOrInvalid(z.enum(SHARE_SCOPES), fourth),
            permissions: parseOrInvalid(permissionListSchema, permissions),
            sessionId,
          });
          void promise.catch(() => undefined);
          return {
            kind: "success",
            text: `policy declaration accepted for ${third}`,
          };
        }
        if (operation === "remove" && second !== undefined) {
          const promise = sharing.revokePolicy(actor, second);
          void promise.catch(() => undefined);
          return {
            kind: "success",
            text: `policy removal accepted: ${second}`,
          };
        }
        if (operation === "audit") {
          const events = sharing.audit({
            workspaceId: second,
            limit: 100,
          });
          return {
            kind: "success",
            text:
              events
                .map(
                  (event) =>
                    `${event.at}\t${event.actorId}\t${event.action}\t${event.path ?? ""}`,
                )
                .join("\n") || "no sharing audit records",
          };
        }
        if (
          operation === "claim" &&
          second !== undefined &&
          third !== undefined
        ) {
          const promise = sharing.claim(actor, {
            workspaceId: second,
            path: third,
          });
          void promise.catch(() => undefined);
          return { kind: "success", text: `claim accepted: ${third}` };
        }
      } catch (cause) {
        return {
          kind: "error",
          text: cause instanceof Error ? cause.message : String(cause),
        };
      }
      return {
        kind: "error",
        text: "usage: /share list [workspace] | add <workspace> <pattern> <scope> <permissions> | remove <policyId> | audit [workspace] | claim <workspace> <path>",
      };
    },
  });
}

const stringToolOutput: ToolOutputLike = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: value }],
};

function agentSessionId(exec: ToolExecLike): string | undefined {
  const id = exec.agent?.session?.id;
  return id === undefined ? undefined : id;
}

function registerSpaceTools(
  ctx: SpaceContext,
  sharing: SharingService,
  locks: LockService,
): void {
  ctx.tools.register({
    name: "collab_share",
    description:
      "Inspect sharing policies, audit records, locks, or place a workspace claim.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["list", "audit", "claim"],
        },
        workspaceId: { type: "string" },
        path: { type: "string" },
      },
      required: ["operation", "workspaceId"],
    },
    output: stringToolOutput,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted();
      const parsed = parseOrInvalid(
        z.object({
          operation: z.enum(["list", "audit", "claim"]),
          workspaceId: idSchema,
          path: pathSchema.optional(),
        }),
        args,
      );
      const actor = agentActor(agentSessionId(exec));
      if (parsed.operation === "list") {
        return commandSummary(sharing, locks, parsed.workspaceId);
      }
      if (parsed.operation === "audit") {
        const events = sharing.audit({
          workspaceId: parsed.workspaceId,
          limit: 100,
        });
        return events
          .map((event) => `${event.at}\t${event.actorId}\t${event.action}`)
          .join("\n");
      }
      if (parsed.path === undefined) {
        throw new SpaceError("invalid_input", "path is required for claim");
      }
      const claim = await sharing.claim(actor, {
        workspaceId: parsed.workspaceId,
        path: parsed.path,
      });
      return `claimed ${claim.path} by ${claim.ownerSessionId} at ${claim.claimedAt}`;
    },
  });

  ctx.tools.register({
    name: "collab_global_read",
    description: "Read one file from the approved DSH Pluginmax global share.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    output: stringToolOutput,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted();
      const parsed = parseOrInvalid(z.object({ path: pathSchema }), args);
      return await sharing.globalRead(
        agentActor(agentSessionId(exec)),
        parsed.path,
      );
    },
  });

  ctx.tools.register({
    name: "collab_global_write",
    description:
      "Request an approved atomic write to the DSH Pluginmax global share.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    output: stringToolOutput,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted();
      const parsed = parseOrInvalid(
        z.object({
          path: pathSchema,
          content: z.string().max(10 * 1024 * 1024),
        }),
        args,
      );
      const approval = ctx.approval;
      if (approval === undefined) {
        throw new SpaceError("forbidden", "approval service is unavailable");
      }
      const agent = exec.agent;
      const file = await sharing.globalWrite(
        agentActor(agentSessionId(exec)),
        parsed,
        async (request) =>
          approval.request({
            ...request,
            agent,
            ...(exec.callId === undefined ? {} : { callId: exec.callId }),
            signal: exec.signal,
          }),
      );
      return `wrote ${file.path} (${file.size} bytes)`;
    },
  });
}

function toolPath(exec: ToolPreExecutionLike): string | undefined {
  const args = exec.arguments;
  const candidate =
    typeof args.file_path === "string"
      ? args.file_path
      : typeof args.path === "string"
        ? args.path
        : undefined;
  if (candidate === undefined) return undefined;
  const cwd = exec.agent?.session?.meta?.cwd;
  if (isAbsolute(candidate) || cwd === undefined) return resolve(candidate);
  return resolve(cwd, candidate);
}

function toolContent(exec: ToolPreExecutionLike): string | undefined {
  const args = exec.arguments;
  if (typeof args.content === "string") return args.content;
  if (typeof args.file_text === "string") return args.file_text;
  if (typeof args.new_str === "string") return args.new_str;
  return undefined;
}

function registerWriteGuards(
  ctx: SpaceContext,
  sharing: SharingService,
  locks: LockService,
): void {
  ctx.on("tools/pre-execute", async (exec, next) => {
    if (
      exec.name !== "write" &&
      exec.name !== "edit" &&
      exec.name !== "str_replace_editor"
    ) {
      return next();
    }
    const content = toolContent(exec);
    if (content !== undefined && scanSecrets(content).length > 0) {
      return {
        kind: "deny",
        reason: "collab space: content contains a detected secret",
      };
    }
    const target = toolPath(exec);
    if (target === undefined) return next();
    const workspace = ctx.workspaceRegistry
      .list()
      .find((candidate) => isWithin(candidate.path, target));
    if (workspace === undefined) return next();
    const workspacePath = normalizeRelative(
      relative(workspace.path, target).replace(/\\/g, "/"),
    );
    const actor = agentAgentForGuard(exec);
    const lock = locks.conflict(workspace.id, workspacePath, actor);
    if (lock !== undefined) {
      return {
        kind: "deny",
        reason: `collab lock: ${workspacePath} is held by ${lock.ownerId} until ${lock.expiresAt}`,
      };
    }
    const claim = await sharing.claimFor(workspace.id, workspacePath);
    if (
      claim !== undefined &&
      (claim.ownerSessionId !== actor.sessionId || claim.ownerId !== actor.id)
    ) {
      return {
        kind: "deny",
        reason: `collab claim: ${workspacePath} is claimed by ${claim.ownerId} (${claim.ownerSessionId})`,
      };
    }
    return next();
  });
}

function agentAgentForGuard(exec: ToolPreExecutionLike): SpaceActor {
  return agentActor(exec.agent?.session?.id);
}

export async function apply(ctx: SpaceContext): Promise<void | (() => void)> {
  const sharingDomain = await ctx.storageDomain.open(sharingDomainSpec);
  const configDomain = await ctx.storageDomain.open(configDomainSpec);
  const lockDomain = await ctx.storageDomain.open(lockDomainSpec);
  const home = process.env.DSH_HOME;
  if (home === undefined || !isAbsolute(home)) {
    await Promise.all([
      sharingDomain.close(),
      configDomain.close(),
      lockDomain.close(),
    ]);
    throw new Error("DSH_HOME must be set to an absolute directory");
  }
  const globalRoot = join(home, "pluginmax", "shared");
  const sharing = new SharingService(
    {
      policies: sharingDomain.table("policies"),
      audit: sharingDomain.table("audit"),
      globalRequests: sharingDomain.table("global_requests"),
      configs: configDomain.table("workspaces"),
    },
    ctx.workspaceRegistry,
    globalRoot,
  );
  const locks = new LockService(lockDomain.table("locks"));
  const digest = new DigestService(ctx.workspaceRegistry);
  ctx.provide("collabSharing", sharing);
  ctx.provide("collabLock", locks);
  ctx.provide("collabDigest", digest);
  ctx.effect(() => () => {
    void sharingDomain.close();
    void configDomain.close();
    void lockDomain.close();
  });
  registerSpaceCommand(ctx, sharing, locks);
  registerSpaceTools(ctx, sharing, locks);
  registerWriteGuards(ctx, sharing, locks);
  let identityDisposers: Array<() => void> = [];
  const identityFiber = ctx.inject(["collabTeam"], (child) => {
    identityDisposers = createSpaceRoutes(
      sharing,
      locks,
      digest,
      child.collabTeam,
      child.workspaceRegistry,
    ).map((route) => child.webServer.register(route)) as Array<() => void>;
  });
  return () => {
    identityFiber.dispose();
    for (const dispose of identityDisposers) dispose();
  };
}
