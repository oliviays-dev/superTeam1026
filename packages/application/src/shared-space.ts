import { createHash, randomUUID } from "node:crypto";
import {
  SHARED_SPACE_MAX_CONTENT_BYTES,
  normalizeSharedSpaceDirectoryPath,
  normalizeSharedSpacePath,
  sharedSpaceAgentDeleteInputSchema,
  sharedSpaceAgentListInputSchema,
  sharedSpaceAgentLockInputSchema,
  sharedSpaceAgentReadInputSchema,
  sharedSpaceAgentReleaseLockInputSchema,
  sharedSpaceAgentToolContextSchema,
  sharedSpaceAgentWriteInputSchema,
  sharedSpaceAgentMoveInputSchema,
  sharedSpacePolicyMatchesPath,
  type ActionTicket,
  type CreateSharedSpaceClaimInput,
  type CreateSharedSpaceDirectoryInput,
  type CreateSharedSpaceFileInput,
  type CreateSharedSpacePolicyInput,
  type CreateSharedSpaceWriteRequestInput,
  type DecideSharedSpaceWriteRequestInput,
  type ExecutionGateRequest,
  type GenerateSharedSpaceDigestInput,
  type SharedSpaceAgentToolContext,
  type SharedSpaceAgentToolName,
  type SharedSpaceAuditPage,
  type SharedSpaceAuditQuery,
  type SharedSpaceClaim,
  type SharedSpaceDigest,
  type SharedSpaceDownload,
  type SharedSpaceEntry,
  type SharedSpaceFileContent,
  type SharedSpaceFileList,
  type SharedSpaceLock,
  type SharedSpacePermissionPreview,
  type SharedSpacePermissions,
  type SharedSpacePolicy,
  type SharedSpacePolicyPermission,
  type SharedSpaceRoot,
  type SharedSpaceVersion,
  type SharedSpaceWorkspace,
  type SharedSpaceWriteRequest,
  type UpdateSharedSpaceFileInput,
  type UpdateSharedSpacePolicyInput,
  type UpdateSharedSpaceRootInput,
} from "@pluginmax/contracts";
import type { FileRef, FileStore } from "@pluginmax/files";
import type {
  PlatformRepositories,
  ScopeAuthorizationDecision,
} from "@pluginmax/database";
import { ExecutionGateError, ExecutionGateService } from "./execution-gate.js";

export class SharedSpaceApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 403,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "SharedSpaceApplicationError";
  }
}

export interface SharedSpaceActor {
  readonly principalId: string;
  readonly authSource: "bearer" | "local-development";
}

interface AccessState {
  readonly root: SharedSpaceRoot;
  readonly policies: readonly SharedSpacePolicy[];
  readonly roles: readonly string[];
  readonly read: ScopeAuthorizationDecision;
  readonly write: ScopeAuthorizationDecision;
  readonly manage: ScopeAuthorizationDecision;
  readonly policyRevision: number;
}

interface EvaluatedPermission {
  readonly permissions: SharedSpacePermissions;
  readonly matchedPolicyIds: readonly string[];
  readonly deniedPolicyIds: readonly string[];
  readonly reason: string;
}

interface ValidatedFile {
  readonly content: Uint8Array;
  readonly sha256: string;
  readonly mimeType: string;
  readonly name: string;
  readonly size: number;
}

interface CreatedRequest {
  readonly request: SharedSpaceWriteRequest;
}

const TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/css",
  "application/json",
  "application/yaml",
  "application/x-yaml",
  "application/xml",
]);

const ALLOWED_MIME_TYPES = new Set([
  ...TEXT_MIME_TYPES,
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/octet-stream",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

const BLOCKED_EXTENSIONS = new Set([
  ".app",
  ".bat",
  ".cmd",
  ".com",
  ".dll",
  ".exe",
  ".htm",
  ".html",
  ".js",
  ".mjs",
  ".ps1",
  ".sh",
  ".svg",
]);

const SECRET_PATTERNS = [
  {
    category: "pem_private_key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u,
  },
  { category: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  {
    category: "api_key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  },
  {
    category: "github_token",
    pattern: /\b(?:ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/u,
  },
  {
    category: "bearer_token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/iu,
  },
  {
    category: "credential_field",
    pattern:
      /(?:password|passwd|client_secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[^\s"']{8,}/iu,
  },
] as const;

function fileRef(
  id: string,
  storageKey: string,
  name: string,
  mimeType: string,
  size: number,
  sha256: string,
): FileRef {
  return { id, storageKey, name, mimeType, size, sha256 };
}

function safeOperationName(name: string): string {
  const hasControl = [...name].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (
    name.trim() !== name ||
    name === "" ||
    name.length > 240 ||
    name.includes("\\") ||
    name.includes("/") ||
    hasControl ||
    name === "." ||
    name === ".."
  ) {
    throw new SharedSpaceApplicationError(
      "shared_space_path_invalid",
      "Shared Space display name is invalid",
      400,
    );
  }
  return name;
}

function redactReason(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/gu, "[REDACTED:api-key]")
    .replace(/(?:\/[A-Za-z0-9._ -]+){2,}/gu, "[REDACTED:absolute-path]")
    .slice(0, 1000);
}

function safeStorageNamespace(workspaceId: string): string {
  return `space-${createHash("sha256")
    .update(workspaceId)
    .digest("hex")
    .slice(0, 32)}`;
}

function shanghaiDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export class SharedSpaceApplication {
  private readonly executionGates: ExecutionGateService;

  constructor(
    private readonly repositories: PlatformRepositories,
    private readonly files: FileStore,
    private readonly options: { readonly now?: () => Date } = {},
  ) {
    this.executionGates = new ExecutionGateService(repositories, options);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private async loadAccess(
    actor: SharedSpaceActor,
    workspaceId: string,
  ): Promise<AccessState> {
    const root =
      (await this.repositories.sharedSpace.getRoot(workspaceId)) ??
      (await this.repositories.sharedSpace.ensureRoot(workspaceId));
    const [read, write, manage, roles, policies, policyRevision] =
      await Promise.all([
        this.repositories.authorization.authorizeWorkspace({
          principalId: actor.principalId,
          authSource: actor.authSource,
          workspaceId,
          permission: "read",
        }),
        this.repositories.authorization.authorizeWorkspace({
          principalId: actor.principalId,
          authSource: actor.authSource,
          workspaceId,
          permission: "write",
        }),
        this.repositories.authorization.authorizeWorkspace({
          principalId: actor.principalId,
          authSource: actor.authSource,
          workspaceId,
          permission: "manage_roles",
        }),
        this.repositories.sharedSpace.workspaceRoles(workspaceId, actor.principalId),
        this.repositories.sharedSpace.listPolicies(workspaceId),
        this.repositories.sharedSpace.policyRevision(workspaceId),
      ]);
    return {
      root,
      policies,
      roles: roles.map((role) => role.role_key),
      read,
      write,
      manage,
      policyRevision,
    };
  }

  private policyMatchesSubject(
    policy: SharedSpacePolicy,
    state: AccessState,
    principalId: string,
  ): boolean {
    return policy.subjectKind === "principal"
      ? policy.subjectId === principalId
      : state.roles.includes(policy.subjectId);
  }

  private evaluate(
    state: AccessState,
    principalId: string,
    path: string,
  ): EvaluatedPermission {
    const matchingSubject = state.policies.filter(
      (policy) =>
        sharedSpacePolicyMatchesPath(policy.pathPattern, path) &&
        this.policyMatchesSubject(policy, state, principalId),
    );
    const allows = (permission: SharedSpacePolicyPermission) =>
      matchingSubject.filter(
        (policy) =>
          policy.effect === "allow" && policy.permissions.includes(permission),
      );
    const denies = (permission: SharedSpacePolicyPermission) =>
      matchingSubject.filter(
        (policy) =>
          policy.effect === "deny" && policy.permissions.includes(permission),
      );
    const readBoundary = state.read.allowed;
    const writeBoundary = state.write.allowed || state.manage.allowed;
    const readAllow = allows("read");
    const readDeny = denies("read");
    const listAllow = allows("list");
    const listDeny = denies("list");
    const writeAllow = allows("write");
    const writeDeny = denies("write");
    const deleteAllow = allows("delete");
    const deleteDeny = denies("delete");
    const readAllowed =
      readBoundary &&
      (state.root.defaultRead || readAllow.length > 0) &&
      readDeny.length === 0;
    const listAllowed =
      readAllowed &&
      listDeny.length === 0 &&
      (state.root.defaultRead || listAllow.length > 0);
    const writeAllowed =
      writeBoundary && writeAllow.length > 0 && writeDeny.length === 0;
    const deleteAllowed =
      writeBoundary && deleteAllow.length > 0 && deleteDeny.length === 0;
    const relevantAllow = [
      ...readAllow,
      ...listAllow,
      ...writeAllow,
      ...deleteAllow,
    ];
    const relevantDeny = [
      ...readDeny,
      ...listDeny,
      ...writeDeny,
      ...deleteDeny,
    ];
    const reason = !readBoundary
      ? "workspace read Grant is required"
      : relevantDeny.length > 0
        ? "matched deny policy"
        : !readAllowed
          ? "no matching read policy or default read disabled"
          : writeAllowed || deleteAllowed
            ? "allow policy and Workspace write boundary"
            : "read-only: no matching write policy";
    return {
      permissions: {
        list: listAllowed,
        read: readAllowed,
        write: writeAllowed,
        delete: deleteAllowed,
      },
      matchedPolicyIds: [
        ...new Set(relevantAllow.map((policy) => policy.id)),
      ],
      deniedPolicyIds: [
        ...new Set(relevantDeny.map((policy) => policy.id)),
      ],
      reason,
    };
  }

  private async auditDenied(input: {
    readonly workspaceId: string;
    readonly actorPrincipalId: string | null;
    readonly action:
      | "list"
      | "read"
      | "download"
      | "directory.create"
      | "file.write"
      | "file.archive"
      | "policy.create"
      | "policy.update"
      | "policy.revoke"
      | "lock.acquire"
      | "lock.release"
      | "claim.create"
      | "claim.release"
      | "write.request"
      | "write.approve"
      | "write.reject"
      | "global.request"
      | "global.approve"
      | "global.reject"
      | "digest.create";
    readonly path?: string;
    readonly reason: string;
    readonly runId?: string | null;
    readonly sceneSessionId?: string | null;
    readonly ticketId?: string | null;
    readonly gateId?: string | null;
  }): Promise<void> {
    try {
      await this.repositories.sharedSpace.appendAudit({
        workspaceId: input.workspaceId,
        actorPrincipalId: input.actorPrincipalId,
        action: input.action,
        path: input.path ?? null,
        decision: "denied",
        reason: redactReason(input.reason),
        runId: input.runId ?? null,
        sceneSessionId: input.sceneSessionId ?? null,
        ticketId: input.ticketId ?? null,
        gateId: input.gateId ?? null,
      });
    } catch {
      // Unknown Workspaces cannot own audit rows. The operation still fails closed.
    }
  }

  private async authorizeManager(
    actor: SharedSpaceActor,
    workspaceId: string,
    action:
      | "policy.create"
      | "policy.update"
      | "policy.revoke"
      | "write.request"
      | "write.approve"
      | "write.reject"
      | "digest.create",
  ): Promise<AccessState> {
    const state = await this.loadAccess(actor, workspaceId);
    if (!state.manage.allowed) {
      await this.auditDenied({
        workspaceId,
        actorPrincipalId: actor.principalId,
        action,
        reason: "Workspace role management permission is required",
      });
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        "Workspace role management permission is required",
      );
    }
    return state;
  }

  async getWorkspace(
    actor: SharedSpaceActor,
    workspaceId: string,
  ): Promise<SharedSpaceWorkspace> {
    const state = await this.loadAccess(actor, workspaceId);
    if (!state.read.allowed) {
      await this.auditDenied({
        workspaceId,
        actorPrincipalId: actor.principalId,
        action: "list",
        reason: "Workspace membership and read Grant are required",
      });
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        "Workspace membership and read Grant are required",
      );
    }
    return {
      root: state.root,
      policies: state.manage.allowed ? [...state.policies] : [],
      canManage: state.manage.allowed,
      canWrite:
        (state.write.allowed || state.manage.allowed) &&
        state.policies.some(
          (policy) =>
            policy.effect === "allow" && policy.permissions.includes("write"),
        ),
    };
  }

  async updateRoot(
    actor: SharedSpaceActor,
    workspaceId: string,
    input: UpdateSharedSpaceRootInput,
  ): Promise<SharedSpaceRoot> {
    await this.authorizeManager(actor, workspaceId, "policy.update");
    return this.repositories.sharedSpace.updateRoot({
      workspaceId,
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.defaultRead === undefined
        ? {}
        : { defaultRead: input.defaultRead }),
      expectedVersion: input.expectedVersion,
      actorPrincipalId: actor.principalId,
    });
  }

  async listPolicies(
    actor: SharedSpaceActor,
    workspaceId: string,
  ): Promise<readonly SharedSpacePolicy[]> {
    const state = await this.authorizeManager(
      actor,
      workspaceId,
      "policy.update",
    );
    return state.policies;
  }

  async createPolicy(
    actor: SharedSpaceActor,
    workspaceId: string,
    input: CreateSharedSpacePolicyInput,
  ): Promise<SharedSpacePolicy> {
    await this.authorizeManager(actor, workspaceId, "policy.create");
    if (
      input.subjectKind === "workspace-role" &&
      !["ADMIN", "MEMBER"].includes(input.subjectId)
    ) {
      throw new SharedSpaceApplicationError(
        "shared_space_path_invalid",
        "Workspace role policies must target ADMIN or MEMBER",
        400,
      );
    }
    if (input.subjectKind === "principal") {
      const principal = await this.repositories.authorization.getPrincipal(
        input.subjectId,
      );
      if (principal === undefined || principal.status !== "active") {
        throw new SharedSpaceApplicationError(
          "shared_space_forbidden",
          "Policy subject Principal is not active",
          404,
        );
      }
    }
    if (
      input.expiresAt !== null &&
      Date.parse(input.expiresAt) <= this.now().getTime()
    ) {
      throw new SharedSpaceApplicationError(
        "shared_space_path_invalid",
        "Policy expiry must be in the future",
        400,
      );
    }
    return this.repositories.sharedSpace.createPolicy({
      workspaceId,
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      pathPattern: input.pathPattern,
      permissions: input.permissions,
      effect: input.effect,
      expiresAt:
        input.expiresAt === null ? null : new Date(input.expiresAt),
      actorPrincipalId: actor.principalId,
    });
  }

  async updatePolicy(
    actor: SharedSpaceActor,
    workspaceId: string,
    policyId: string,
    input: UpdateSharedSpacePolicyInput,
  ): Promise<SharedSpacePolicy> {
    await this.authorizeManager(actor, workspaceId, "policy.update");
    return this.repositories.sharedSpace.updatePolicy({
      workspaceId,
      policyId,
      ...(input.permissions === undefined
        ? {}
        : { permissions: input.permissions }),
      ...(input.effect === undefined ? {} : { effect: input.effect }),
      ...(input.expiresAt === undefined
        ? {}
        : {
            expiresAt:
              input.expiresAt === null ? null : new Date(input.expiresAt),
          }),
      expectedVersion: input.expectedVersion,
      actorPrincipalId: actor.principalId,
    });
  }

  async revokePolicy(
    actor: SharedSpaceActor,
    workspaceId: string,
    policyId: string,
    expectedVersion: number,
  ): Promise<SharedSpacePolicy> {
    await this.authorizeManager(actor, workspaceId, "policy.revoke");
    return this.repositories.sharedSpace.revokePolicy({
      workspaceId,
      policyId,
      expectedVersion,
      actorPrincipalId: actor.principalId,
    });
  }

  async previewPolicy(input: {
    readonly actor: SharedSpaceActor;
    readonly workspaceId: string;
    readonly principalId: string;
    readonly path: string;
  }): Promise<SharedSpacePermissionPreview> {
    await this.authorizeManager(input.actor, input.workspaceId, "policy.update");
    const principal = await this.repositories.authorization.getPrincipal(
      input.principalId,
    );
    if (principal === undefined) {
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        "Preview Principal not found",
        404,
      );
    }
    const state = await this.loadAccess(
      {
        principalId: principal.id,
        authSource:
          principal.source === "local" ? "local-development" : "bearer",
      },
      input.workspaceId,
    );
    const path = normalizeSharedSpacePath(input.path);
    const evaluated = this.evaluate(state, principal.id, path);
    return {
      principalId: principal.id,
      path,
      permissions: evaluated.permissions,
      matchedPolicyIds: [...evaluated.matchedPolicyIds],
      deniedPolicyIds: [...evaluated.deniedPolicyIds],
      reason: evaluated.reason,
      workspaceGrantIds: [
        ...new Set([
          ...state.read.grantIds,
          ...state.write.grantIds,
          ...state.manage.grantIds,
        ]),
      ],
      membershipId: state.read.membershipId ?? null,
      sceneValidated: false,
      ticketValidated: false,
      gateRequiredForWrite: principal.kind === "ai",
    };
  }

  private async assertActiveRoot(state: AccessState): Promise<void> {
    if (state.root.status !== "active") {
      throw new SharedSpaceApplicationError(
        "shared_space_archived",
        "Shared Space root is archived",
        409,
      );
    }
  }

  private async requirePathPermission(input: {
    readonly actor: SharedSpaceActor;
    readonly workspaceId: string;
    readonly path: string;
    readonly permission: "list" | "read" | "write" | "delete";
    readonly action:
      | "list"
      | "read"
      | "download"
      | "directory.create"
      | "file.write"
      | "file.archive"
      | "lock.acquire"
      | "claim.create"
      | "write.request";
    readonly runId?: string | null;
    readonly sceneSessionId?: string | null;
    readonly ticketId?: string | null;
    readonly gateId?: string | null;
  }): Promise<{ readonly state: AccessState; readonly evaluated: EvaluatedPermission }> {
    const state = await this.loadAccess(input.actor, input.workspaceId);
    await this.assertActiveRoot(state);
    const evaluated = this.evaluate(state, input.actor.principalId, input.path);
    if (!evaluated.permissions[input.permission]) {
      await this.auditDenied({
        workspaceId: input.workspaceId,
        actorPrincipalId: input.actor.principalId,
        action: input.action === "write.request" ? "write.request" : input.action,
        path: input.path,
        reason: evaluated.reason,
        runId: input.runId ?? null,
        sceneSessionId: input.sceneSessionId ?? null,
        ticketId: input.ticketId ?? null,
        gateId: input.gateId ?? null,
      });
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        evaluated.reason,
      );
    }
    return { state, evaluated };
  }

  async listFiles(input: {
    readonly actor: SharedSpaceActor;
    readonly workspaceId: string;
    readonly path: string;
    readonly includeArchived?: boolean;
  }): Promise<SharedSpaceFileList> {
    const path = normalizeSharedSpaceDirectoryPath(input.path);
    const permissionPath = path === "" ? "shared-root" : path;
    const { state, evaluated } = await this.requirePathPermission({
      actor: input.actor,
      workspaceId: input.workspaceId,
      path: permissionPath,
      permission: "list",
      action: "list",
    });
    if (path !== "") {
      const directory = await this.repositories.sharedSpace.getEntryByPath(
        input.workspaceId,
        path,
      );
      if (directory?.kind !== "directory") {
        throw new SharedSpaceApplicationError(
          "shared_space_not_found",
          "Shared Space directory not found",
          404,
        );
      }
    }
    const entries = await this.repositories.sharedSpace.listEntries(
      input.workspaceId,
      path,
      input.includeArchived ?? false,
    );
    const visible = entries.flatMap((entry) => {
      const access = this.evaluate(state, input.actor.principalId, entry.path);
      return access.permissions.read
        ? [{ ...entry, effectivePermissions: access.permissions }]
        : [];
    });
    await this.repositories.sharedSpace.appendAudit({
      workspaceId: input.workspaceId,
      actorPrincipalId: input.actor.principalId,
      action: "list",
      path: path === "" ? null : path,
      decision: "allowed",
      reason: evaluated.reason,
      metadata: { count: visible.length },
    });
    return {
      path,
      entries: visible,
      effectivePermissions: evaluated.permissions,
    };
  }

  private async entryWithPermission(
    actor: SharedSpaceActor,
    workspaceId: string,
    entryId: string,
    permission: "read" | "write" | "delete",
    action: "read" | "download" | "file.write" | "file.archive",
  ): Promise<{
    readonly entry: SharedSpaceEntry;
    readonly state: AccessState;
    readonly access: EvaluatedPermission;
  }> {
    const entry = await this.repositories.sharedSpace.getEntry(
      workspaceId,
      entryId,
    );
    if (entry === undefined) {
      await this.auditDenied({
        workspaceId,
        actorPrincipalId: actor.principalId,
        action,
        reason: "Shared Space entry not found",
      });
      throw new SharedSpaceApplicationError(
        "shared_space_not_found",
        "Shared Space entry not found",
        404,
      );
    }
    const { state, evaluated } = await this.requirePathPermission({
      actor,
      workspaceId,
      path: entry.path,
      permission,
      action,
    });
    return { entry, state, access: evaluated };
  }

  async getEntry(
    actor: SharedSpaceActor,
    workspaceId: string,
    entryId: string,
  ): Promise<SharedSpaceEntry> {
    const { entry, access } = await this.entryWithPermission(
      actor,
      workspaceId,
      entryId,
      "read",
      "read",
    );
    return { ...entry, effectivePermissions: access.permissions };
  }

  private async readFileBytes(
    workspaceId: string,
    entry: SharedSpaceEntry,
  ): Promise<Uint8Array> {
    if (
      entry.kind !== "file" ||
      entry.sha256 === null ||
      entry.mimeType === null
    ) {
      throw new SharedSpaceApplicationError(
        "shared_space_not_found",
        "Shared Space file not found",
        404,
      );
    }
    const storageKey = await this.repositories.sharedSpace.getEntryStorageKey(
      workspaceId,
      entry.id,
    );
    if (storageKey === undefined) {
      throw new SharedSpaceApplicationError(
        "shared_space_not_found",
        "Shared Space file content not found",
        404,
      );
    }
    return this.files.read(
      fileRef(
        entry.id,
        storageKey,
        entry.name,
        entry.mimeType,
        entry.size,
        entry.sha256,
      ),
    );
  }

  async readContent(
    actor: SharedSpaceActor,
    workspaceId: string,
    entryId: string,
    previewLimit = 512 * 1024,
  ): Promise<SharedSpaceFileContent> {
    const { entry, access } = await this.entryWithPermission(
      actor,
      workspaceId,
      entryId,
      "read",
      "read",
    );
    const content = await this.readFileBytes(workspaceId, entry);
    const truncated = content.byteLength > previewLimit;
    const visible = content.subarray(
      0,
      Math.min(content.byteLength, previewLimit),
    );
    await this.repositories.sharedSpace.appendAudit({
      workspaceId,
      actorPrincipalId: actor.principalId,
      action: "read",
      path: entry.path,
      entryId: entry.id,
      version: entry.currentVersion,
      decision: "allowed",
      metadata: { sha256: entry.sha256, truncated },
    });
    return {
      entry: { ...entry, effectivePermissions: access.permissions },
      contentBase64: Buffer.from(visible).toString("base64"),
      truncated,
    };
  }

  async download(
    actor: SharedSpaceActor,
    workspaceId: string,
    entryId: string,
  ): Promise<SharedSpaceDownload> {
    const { entry, access } = await this.entryWithPermission(
      actor,
      workspaceId,
      entryId,
      "read",
      "download",
    );
    const content = await this.readFileBytes(workspaceId, entry);
    await this.repositories.sharedSpace.appendAudit({
      workspaceId,
      actorPrincipalId: actor.principalId,
      action: "download",
      path: entry.path,
      entryId: entry.id,
      version: entry.currentVersion,
      decision: "allowed",
      metadata: { sha256: entry.sha256, size: entry.size },
    });
    return {
      entry: { ...entry, effectivePermissions: access.permissions },
      contentBase64: Buffer.from(content).toString("base64"),
    };
  }

  async listVersions(
    actor: SharedSpaceActor,
    workspaceId: string,
    entryId: string,
  ): Promise<readonly SharedSpaceVersion[]> {
    const { entry } = await this.entryWithPermission(
      actor,
      workspaceId,
      entryId,
      "read",
      "read",
    );
    if (entry.kind !== "file") {
      throw new SharedSpaceApplicationError(
        "shared_space_not_found",
        "Shared Space file versions not found",
        404,
      );
    }
    return this.repositories.sharedSpace.listVersions(workspaceId, entryId);
  }

  private validateFile(input: {
    readonly path: string;
    readonly name: string;
    readonly mimeType: string;
    readonly contentBase64: string;
  }): ValidatedFile {
    const path = normalizeSharedSpacePath(input.path);
    const name = safeOperationName(input.name);
    const extensionIndex = path.lastIndexOf(".");
    const extension =
      extensionIndex < 0 ? "" : path.slice(extensionIndex).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(extension)) {
      throw new SharedSpaceApplicationError(
        "shared_space_mime_rejected",
        "Active or executable file types are not accepted",
        415,
        { extension },
      );
    }
    const mimeType = input.mimeType.trim().toLowerCase();
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new SharedSpaceApplicationError(
        "shared_space_mime_rejected",
        "The declared MIME type is not accepted",
        415,
        { mimeType },
      );
    }
    if (
      input.contentBase64 === "" ||
      input.contentBase64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(input.contentBase64)
    ) {
      throw new SharedSpaceApplicationError(
        "shared_space_content_invalid",
        "File content must be canonical base64",
        400,
      );
    }
    const content = Buffer.from(input.contentBase64, "base64");
    if (content.byteLength === 0) {
      throw new SharedSpaceApplicationError(
        "shared_space_content_invalid",
        "Shared Space files cannot be empty",
        400,
      );
    }
    if (content.byteLength > SHARED_SPACE_MAX_CONTENT_BYTES) {
      throw new SharedSpaceApplicationError(
        "shared_space_file_too_large",
        "Shared Space files exceed the size limit",
        413,
        { maxBytes: SHARED_SPACE_MAX_CONTENT_BYTES },
      );
    }
    const binary = content.includes(0);
    const textLike = TEXT_MIME_TYPES.has(mimeType);
    if (textLike && binary) {
      throw new SharedSpaceApplicationError(
        "shared_space_mime_rejected",
        "Text files cannot contain binary NUL bytes",
        415,
      );
    }
    this.validateMagicBytes(mimeType, content);
    if (!binary || textLike) {
      const text = content.toString("utf8");
      if (text.includes("\uFFFD") && textLike) {
        throw new SharedSpaceApplicationError(
          "shared_space_mime_rejected",
          "Text file content is not valid UTF-8",
          415,
        );
      }
      const findings = SECRET_PATTERNS.filter((rule) =>
        rule.pattern.test(text),
      ).map((rule) => rule.category);
      if (findings.length > 0) {
        throw new SharedSpaceApplicationError(
          "shared_space_secret_detected",
          "File content contains a detected secret and was rejected",
          422,
          { categories: [...new Set(findings)] },
        );
      }
    }
    return {
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
      mimeType,
      name,
      size: content.byteLength,
    };
  }

  private validateMagicBytes(mimeType: string, content: Uint8Array): void {
    const startsWith = (bytes: readonly number[]) =>
      bytes.every((value, index) => content[index] === value);
    if (
      mimeType === "image/png" &&
      !startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    ) {
      throw new SharedSpaceApplicationError(
        "shared_space_mime_rejected",
        "PNG content does not match its declared MIME type",
        415,
      );
    }
    if (mimeType === "image/jpeg" && !startsWith([0xff, 0xd8, 0xff])) {
      throw new SharedSpaceApplicationError(
        "shared_space_mime_rejected",
        "JPEG content does not match its declared MIME type",
        415,
      );
    }
    if (
      mimeType === "application/pdf" &&
      Buffer.from(content.subarray(0, 5)).toString("ascii") !== "%PDF-"
    ) {
      throw new SharedSpaceApplicationError(
        "shared_space_mime_rejected",
        "PDF content does not match its declared MIME type",
        415,
      );
    }
  }

  private async stageContent(
    workspaceId: string,
    file: ValidatedFile,
  ): Promise<FileRef> {
    return this.files.put({
      workspaceId: safeStorageNamespace(workspaceId),
      name: file.name,
      mimeType: file.mimeType,
      content: file.content,
    });
  }

  private async discardStaged(ref: FileRef | undefined): Promise<void> {
    if (ref === undefined || this.files.delete === undefined) return;
    try {
      await this.files.delete(ref);
    } catch {
      // Maintenance can reconcile staged files that could not be removed here.
    }
  }

  async createDirectory(
    actor: SharedSpaceActor,
    workspaceId: string,
    input: CreateSharedSpaceDirectoryInput,
  ): Promise<SharedSpaceEntry> {
    const principal = await this.repositories.authorization.getPrincipal(
      actor.principalId,
    );
    if (principal?.kind !== "human") {
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        "Agent directory creation must use the controlled Agent tool",
      );
    }
    const path = normalizeSharedSpacePath(input.path);
    const { evaluated: access } = await this.requirePathPermission({
      actor,
      workspaceId,
      path,
      permission: "write",
      action: "directory.create",
    });
    const entry = await this.repositories.sharedSpace.createDirectory({
      workspaceId,
      path,
      actorPrincipalId: actor.principalId,
    });
    return { ...entry, effectivePermissions: access.permissions };
  }

  async createFile(
    actor: SharedSpaceActor,
    workspaceId: string,
    input: CreateSharedSpaceFileInput,
  ): Promise<SharedSpaceEntry> {
    const principal = await this.repositories.authorization.getPrincipal(
      actor.principalId,
    );
    if (principal?.kind !== "human") {
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        "Agent writes must use an approved Shared Space write request",
      );
    }
    const path = normalizeSharedSpacePath(input.path);
    const { evaluated: access } = await this.requirePathPermission({
      actor,
      workspaceId,
      path,
      permission: "write",
      action: "file.write",
    });
    const file = this.validateFile({
      path,
      name: input.name,
      mimeType: input.mimeType,
      contentBase64: input.contentBase64,
    });
    let staged: FileRef | undefined;
    try {
      staged = await this.stageContent(workspaceId, file);
      const entry = await this.repositories.sharedSpace.commitFile({
        workspaceId,
        path,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        sha256: file.sha256,
        storageKey: staged.storageKey,
        actorPrincipalId: actor.principalId,
        expectedVersion: input.expectedVersion,
        lockId: null,
      });
      return { ...entry, effectivePermissions: access.permissions };
    } catch (error) {
      await this.discardStaged(staged);
      throw error;
    }
  }

  async updateFile(
    actor: SharedSpaceActor,
    workspaceId: string,
    entryId: string,
    input: UpdateSharedSpaceFileInput,
  ): Promise<SharedSpaceEntry> {
    const principal = await this.repositories.authorization.getPrincipal(
      actor.principalId,
    );
    if (principal?.kind !== "human") {
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        "Agent writes must use an approved Shared Space write request",
      );
    }
    const existing = await this.repositories.sharedSpace.getEntry(
      workspaceId,
      entryId,
    );
    if (existing === undefined) {
      throw new SharedSpaceApplicationError(
        "shared_space_not_found",
        "Shared Space file not found",
        404,
      );
    }
    const { evaluated: access } = await this.requirePathPermission({
      actor,
      workspaceId,
      path: existing.path,
      permission: "write",
      action: "file.write",
    });
    const file = this.validateFile({
      path: existing.path,
      name: input.name ?? existing.name,
      mimeType: input.mimeType ?? existing.mimeType ?? "application/octet-stream",
      contentBase64: input.contentBase64,
    });
    let staged: FileRef | undefined;
    try {
      staged = await this.stageContent(workspaceId, file);
      const entry = await this.repositories.sharedSpace.commitFile({
        workspaceId,
        path: existing.path,
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        sha256: file.sha256,
        storageKey: staged.storageKey,
        actorPrincipalId: actor.principalId,
        expectedVersion: input.expectedVersion,
        lockId: input.lockId,
      });
      return { ...entry, effectivePermissions: access.permissions };
    } catch (error) {
      await this.discardStaged(staged);
      throw error;
    }
  }

  async archiveFile(
    actor: SharedSpaceActor,
    workspaceId: string,
    entryId: string,
    expectedVersion: number,
  ): Promise<SharedSpaceEntry> {
    const principal = await this.repositories.authorization.getPrincipal(
      actor.principalId,
    );
    if (principal?.kind !== "human") {
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        "Agent deletion must use an approved Shared Space write request",
      );
    }
    const { entry, access } = await this.entryWithPermission(
      actor,
      workspaceId,
      entryId,
      "delete",
      "file.archive",
    );
    const archived = await this.repositories.sharedSpace.archiveFile({
      workspaceId,
      entryId: entry.id,
      expectedVersion,
      actorPrincipalId: actor.principalId,
    });
    return { ...archived, effectivePermissions: access.permissions };
  }

  async acquireLock(
    actor: SharedSpaceActor,
    workspaceId: string,
    input: {
      readonly path: string;
      readonly mode: "exclusive" | "shared";
      readonly leaseSeconds: number;
      readonly sessionId?: string;
    },
    runId: string | null = null,
  ): Promise<SharedSpaceLock> {
    const path = normalizeSharedSpacePath(input.path);
    await this.requirePathPermission({
      actor,
      workspaceId,
      path,
      permission: "write",
      action: "lock.acquire",
      runId,
    });
    return this.repositories.sharedSpace.acquireLock({
      workspaceId,
      path,
      ownerPrincipalId: actor.principalId,
      ownerSessionId: input.sessionId ?? `principal:${actor.principalId}`,
      runId,
      mode: input.mode,
      leaseSeconds: input.leaseSeconds,
    });
  }

  async releaseLock(
    actor: SharedSpaceActor,
    workspaceId: string,
    lockId: string,
  ): Promise<boolean> {
    const state = await this.loadAccess(actor, workspaceId);
    if (!state.read.allowed) {
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        "Workspace read Grant is required",
      );
    }
    return this.repositories.sharedSpace.releaseLock({
      workspaceId,
      lockId,
      actorPrincipalId: actor.principalId,
      allowWorkspaceManager: state.manage.allowed,
    });
  }

  async listLocks(
    actor: SharedSpaceActor,
    workspaceId: string,
  ): Promise<readonly SharedSpaceLock[]> {
    const state = await this.loadAccess(actor, workspaceId);
    if (!state.read.allowed) {
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        "Workspace read Grant is required",
      );
    }
    return this.repositories.sharedSpace.listActiveLocks(workspaceId);
  }

  async createClaim(
    actor: SharedSpaceActor,
    workspaceId: string,
    input: CreateSharedSpaceClaimInput,
  ): Promise<SharedSpaceClaim> {
    const path = normalizeSharedSpacePath(input.path);
    await this.requirePathPermission({
      actor,
      workspaceId,
      path,
      permission: "write",
      action: "claim.create",
    });
    return this.repositories.sharedSpace.createClaim({
      workspaceId,
      path,
      ownerPrincipalId: actor.principalId,
      ownerSessionId: input.sessionId,
      runId: null,
      note: input.note,
      leaseSeconds: input.leaseSeconds,
    });
  }

  async listClaims(
    actor: SharedSpaceActor,
    workspaceId: string,
  ): Promise<readonly SharedSpaceClaim[]> {
    const state = await this.loadAccess(actor, workspaceId);
    if (!state.read.allowed) {
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        "Workspace read Grant is required",
      );
    }
    return this.repositories.sharedSpace.listActiveClaims(workspaceId);
  }

  async releaseClaim(
    actor: SharedSpaceActor,
    workspaceId: string,
    claimId: string,
  ): Promise<boolean> {
    const state = await this.loadAccess(actor, workspaceId);
    if (!state.read.allowed) {
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        "Workspace read Grant is required",
      );
    }
    return this.repositories.sharedSpace.releaseClaim({
      workspaceId,
      claimId,
      actorPrincipalId: actor.principalId,
    });
  }

  private async assertAgentExecution(input: {
    readonly context: SharedSpaceAgentToolContext;
    readonly workspaceId: string;
  }): Promise<ActionTicket> {
    let ticket: ActionTicket;
    try {
      ticket = await this.executionGates.assertRunAction({
        runId: input.context.runId,
        action: "agent.execute",
      });
    } catch (error) {
      if (error instanceof ExecutionGateError) {
        throw new SharedSpaceApplicationError(
          error.code,
          error.message,
          error.statusCode,
          error.details,
        );
      }
      throw error;
    }
    const agentPrincipalId = ticket.executionEnvelope.agentPrincipalId;
    if (
      agentPrincipalId === null ||
      agentPrincipalId !== input.context.principalId ||
      ticket.workspaceId !== input.workspaceId ||
      (input.context.ticketId !== undefined &&
        ticket.ticketId !== input.context.ticketId)
    ) {
      throw new SharedSpaceApplicationError(
        "shared_space_ticket_invalid",
        "Action Ticket does not match the Agent Shared Space context",
      );
    }
    const scene = await this.repositories.sharedSpace.getSceneBinding(
      input.context.sceneSessionId,
    );
    const expectedSceneType =
      ticket.contextType === "workflow-task"
        ? "workflow-node"
        : ticket.contextType;
    if (
      scene === undefined ||
      scene.status !== "active" ||
      scene.sceneType !== expectedSceneType ||
      scene.sceneId !== ticket.contextId ||
      scene.agentPrincipalId !== input.context.principalId ||
      (ticket.executionEnvelope.projectId !== null &&
        scene.projectId !== ticket.executionEnvelope.projectId)
    ) {
      throw new SharedSpaceApplicationError(
        "shared_space_scene_invalid",
        "Scene Session does not match the Action Ticket and Run",
      );
    }
    return ticket;
  }

  private gateForWrite(input: {
    readonly requestId: string;
    readonly ticket: ActionTicket;
    readonly workspaceId: string;
    readonly scope: "workspace" | "global";
    readonly path: string;
    readonly operation: "write" | "move" | "delete";
    readonly purpose: string;
    readonly requestedByPrincipalId: string;
  }): ExecutionGateRequest {
    const now = this.now();
    const expiresAt = new Date(
      Math.min(
        Date.parse(input.ticket.expiresAt),
        now.getTime() + 30 * 60 * 1_000,
      ),
    );
    return {
      gateId: randomUUID(),
      ticketId: input.ticket.ticketId,
      runId: input.ticket.runId,
      taskId: input.ticket.taskId,
      projectId: input.ticket.executionEnvelope.projectId,
      gateKey: `shared-space:${input.scope}:${input.requestId}`.slice(0, 180),
      kind: "tool-approval",
      enforcement: "blocking",
      reason: `${input.operation} ${input.scope} Shared Space file within ${input.purpose}`.slice(
        0,
        2000,
      ),
      requestedToolCategory: "shared-space.write",
      requestedSourceClass: "workspace-file",
      resourceScopes: [
        ...new Set([
          ...input.ticket.resourceScopes,
          `workspace:${input.workspaceId}`,
          `shared-space:${input.workspaceId}:${input.path}`,
        ]),
      ].slice(0, 100),
      policyId: input.ticket.policyId,
      policyRevision: input.ticket.policyRevision,
      envelopeId: input.ticket.envelopeId,
      envelopeDigest: input.ticket.envelopeDigest,
      requestedByPrincipalId: input.requestedByPrincipalId,
      requestedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async createAgentWriteRequest(input: {
    readonly context: SharedSpaceAgentToolContext;
    readonly workspaceId: string;
    readonly idempotencyKey: string;
    readonly path: string;
    readonly name: string;
    readonly mimeType: string;
    readonly contentBase64: string;
    readonly expectedVersion: number;
    readonly purpose: string;
    readonly lockId: string | null;
  }): Promise<CreatedRequest> {
    const ticket = await this.assertAgentExecution({
      context: input.context,
      workspaceId: input.workspaceId,
    });
    const path = normalizeSharedSpacePath(input.path);
    const actor: SharedSpaceActor = {
      principalId: input.context.principalId,
      authSource: "bearer",
    };
    const { state } = await this.requirePathPermission({
      actor,
      workspaceId: input.workspaceId,
      path,
      permission: "write",
      action: "write.request",
      runId: input.context.runId,
      sceneSessionId: input.context.sceneSessionId,
      ticketId: ticket.ticketId,
    });
    const file = this.validateFile({
      path,
      name: input.name,
      mimeType: input.mimeType,
      contentBase64: input.contentBase64,
    });
    const requestId = randomUUID();
    const gate = this.gateForWrite({
      requestId,
      ticket,
      workspaceId: input.workspaceId,
      scope: "workspace",
      path,
      operation: "write",
      purpose: input.purpose,
      requestedByPrincipalId: input.context.principalId,
    });
    let staged: FileRef | undefined;
    try {
      staged = await this.stageContent(input.workspaceId, file);
      return {
        request: await this.repositories.sharedSpace.createWriteRequest({
          id: requestId,
          scope: "workspace",
          operation: "write",
          sourceWorkspaceId: input.workspaceId,
          sourceEntryId: null,
          actorPrincipalId: input.context.principalId,
          targetPath: path,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          sha256: file.sha256,
          storageKey: staged.storageKey,
          purpose: input.purpose,
          expectedVersion: input.expectedVersion,
          policyRevision: state.policyRevision,
          runId: input.context.runId,
          sceneSessionId: input.context.sceneSessionId,
          ticketId: ticket.ticketId,
          gateId: gate.gateId,
          gate,
          idempotencyKey: input.idempotencyKey,
          expiresAt: new Date(gate.expiresAt),
        }),
      };
    } catch (error) {
      await this.discardStaged(staged);
      throw error;
    }
  }

  async createAgentMoveRequest(input: {
    readonly context: SharedSpaceAgentToolContext;
    readonly workspaceId: string;
    readonly entryId: string;
    readonly targetPath: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly purpose?: string;
  }): Promise<CreatedRequest> {
    const ticket = await this.assertAgentExecution({
      context: input.context,
      workspaceId: input.workspaceId,
    });
    const entry = await this.repositories.sharedSpace.getEntry(
      input.workspaceId,
      input.entryId,
    );
    if (entry === undefined || entry.kind !== "file") {
      throw new SharedSpaceApplicationError(
        "shared_space_not_found",
        "Shared Space file not found",
        404,
      );
    }
    const targetPath = normalizeSharedSpacePath(input.targetPath);
    const actor: SharedSpaceActor = {
      principalId: input.context.principalId,
      authSource: "bearer",
    };
    const [source, target] = await Promise.all([
      this.requirePathPermission({
        actor,
        workspaceId: input.workspaceId,
        path: entry.path,
        permission: "write",
        action: "write.request",
        runId: input.context.runId,
        sceneSessionId: input.context.sceneSessionId,
        ticketId: ticket.ticketId,
      }),
      this.requirePathPermission({
        actor,
        workspaceId: input.workspaceId,
        path: targetPath,
        permission: "write",
        action: "write.request",
        runId: input.context.runId,
        sceneSessionId: input.context.sceneSessionId,
        ticketId: ticket.ticketId,
      }),
    ]);
    const storageKey = await this.repositories.sharedSpace.getEntryStorageKey(
      input.workspaceId,
      entry.id,
    );
    if (storageKey === undefined || entry.sha256 === null || entry.mimeType === null) {
      throw new SharedSpaceApplicationError(
        "shared_space_not_found",
        "Shared Space file content not found",
        404,
      );
    }
    const requestId = randomUUID();
    const purpose = input.purpose ?? "Move Shared Space file";
    const gate = this.gateForWrite({
      requestId,
      ticket,
      workspaceId: input.workspaceId,
      scope: "workspace",
      path: targetPath,
      operation: "move",
      purpose,
      requestedByPrincipalId: input.context.principalId,
    });
    return {
      request: await this.repositories.sharedSpace.createWriteRequest({
        id: requestId,
        scope: "workspace",
        operation: "move",
        sourceWorkspaceId: input.workspaceId,
        sourceEntryId: entry.id,
        actorPrincipalId: input.context.principalId,
        targetPath,
        name: entry.name,
        mimeType: entry.mimeType,
        size: entry.size,
        sha256: entry.sha256,
        storageKey,
        purpose,
        expectedVersion: input.expectedVersion,
        policyRevision: Math.max(
          source.state.policyRevision,
          target.state.policyRevision,
        ),
        runId: input.context.runId,
        sceneSessionId: input.context.sceneSessionId,
        ticketId: ticket.ticketId,
        gateId: gate.gateId,
        gate,
        idempotencyKey: input.idempotencyKey,
        expiresAt: new Date(gate.expiresAt),
      }),
    };
  }

  async createAgentDeleteRequest(input: {
    readonly context: SharedSpaceAgentToolContext;
    readonly workspaceId: string;
    readonly entryId: string;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
    readonly purpose?: string;
  }): Promise<CreatedRequest> {
    const ticket = await this.assertAgentExecution({
      context: input.context,
      workspaceId: input.workspaceId,
    });
    const entry = await this.repositories.sharedSpace.getEntry(
      input.workspaceId,
      input.entryId,
    );
    if (entry === undefined || entry.kind !== "file") {
      throw new SharedSpaceApplicationError(
        "shared_space_not_found",
        "Shared Space file not found",
        404,
      );
    }
    const actor: SharedSpaceActor = {
      principalId: input.context.principalId,
      authSource: "bearer",
    };
    const { state } = await this.requirePathPermission({
      actor,
      workspaceId: input.workspaceId,
      path: entry.path,
      permission: "delete",
      action: "file.archive",
      runId: input.context.runId,
      sceneSessionId: input.context.sceneSessionId,
      ticketId: ticket.ticketId,
    });
    const storageKey = await this.repositories.sharedSpace.getEntryStorageKey(
      input.workspaceId,
      entry.id,
    );
    if (storageKey === undefined || entry.sha256 === null || entry.mimeType === null) {
      throw new SharedSpaceApplicationError(
        "shared_space_not_found",
        "Shared Space file content not found",
        404,
      );
    }
    const requestId = randomUUID();
    const purpose = input.purpose ?? "Delete Shared Space file";
    const gate = this.gateForWrite({
      requestId,
      ticket,
      workspaceId: input.workspaceId,
      scope: "workspace",
      path: entry.path,
      operation: "delete",
      purpose,
      requestedByPrincipalId: input.context.principalId,
    });
    return {
      request: await this.repositories.sharedSpace.createWriteRequest({
        id: requestId,
        scope: "workspace",
        operation: "delete",
        sourceWorkspaceId: input.workspaceId,
        sourceEntryId: entry.id,
        actorPrincipalId: input.context.principalId,
        targetPath: entry.path,
        name: entry.name,
        mimeType: entry.mimeType,
        size: entry.size,
        sha256: entry.sha256,
        storageKey,
        purpose,
        expectedVersion: input.expectedVersion,
        policyRevision: state.policyRevision,
        runId: input.context.runId,
        sceneSessionId: input.context.sceneSessionId,
        ticketId: ticket.ticketId,
        gateId: gate.gateId,
        gate,
        idempotencyKey: input.idempotencyKey,
        expiresAt: new Date(gate.expiresAt),
      }),
    };
  }

  async createAgentGlobalWriteRequest(input: {
    readonly context: SharedSpaceAgentToolContext;
    readonly workspaceId: string;
    readonly idempotencyKey: string;
    readonly path: string;
    readonly name: string;
    readonly mimeType: string;
    readonly contentBase64: string;
    readonly expectedVersion: number;
    readonly purpose: string;
  }): Promise<CreatedRequest> {
    const ticket = await this.assertAgentExecution({
      context: input.context,
      workspaceId: input.workspaceId,
    });
    const path = normalizeSharedSpacePath(input.path);
    const actor: SharedSpaceActor = {
      principalId: input.context.principalId,
      authSource: "bearer",
    };
    const state = await this.loadAccess(actor, input.workspaceId);
    if (!(state.write.allowed || state.manage.allowed)) {
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        "Workspace write boundary is required for Global Write",
      );
    }
    const file = this.validateFile({
      path,
      name: input.name,
      mimeType: input.mimeType,
      contentBase64: input.contentBase64,
    });
    const requestId = randomUUID();
    const gate = this.gateForWrite({
      requestId,
      ticket,
      workspaceId: input.workspaceId,
      scope: "global",
      path,
      operation: "write",
      purpose: input.purpose,
      requestedByPrincipalId: input.context.principalId,
    });
    let staged: FileRef | undefined;
    try {
      staged = await this.stageContent(input.workspaceId, file);
      return {
        request: await this.repositories.sharedSpace.createWriteRequest({
          id: requestId,
          scope: "global",
          operation: "write",
          sourceWorkspaceId: input.workspaceId,
          sourceEntryId: null,
          actorPrincipalId: input.context.principalId,
          targetPath: path,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          sha256: file.sha256,
          storageKey: staged.storageKey,
          purpose: input.purpose,
          expectedVersion: input.expectedVersion,
          policyRevision: state.policyRevision,
          runId: input.context.runId,
          sceneSessionId: input.context.sceneSessionId,
          ticketId: ticket.ticketId,
          gateId: gate.gateId,
          gate,
          idempotencyKey: input.idempotencyKey,
          expiresAt: new Date(gate.expiresAt),
        }),
      };
    } catch (error) {
      await this.discardStaged(staged);
      throw error;
    }
  }

  async createHumanGlobalWriteRequest(
    actor: SharedSpaceActor,
    workspaceId: string,
    input: CreateSharedSpaceWriteRequestInput,
    idempotencyKey: string,
  ): Promise<CreatedRequest> {
    await this.authorizeManager(actor, workspaceId, "write.request");
    if (input.scope !== "global") {
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        "Workspace writes are direct; only Global Write requests are accepted here",
        400,
      );
    }
    const path = normalizeSharedSpacePath(input.path);
    const file = this.validateFile({
      path,
      name: input.name,
      mimeType: input.mimeType,
      contentBase64: input.contentBase64,
    });
    const staged = await this.stageContent(workspaceId, file);
    try {
      return {
        request: await this.repositories.sharedSpace.createWriteRequest({
          id: randomUUID(),
          scope: "global",
          operation: "write",
          sourceWorkspaceId: workspaceId,
          sourceEntryId: null,
          actorPrincipalId: actor.principalId,
          targetPath: path,
          name: file.name,
          mimeType: file.mimeType,
          size: file.size,
          sha256: file.sha256,
          storageKey: staged.storageKey,
          purpose: input.purpose,
          expectedVersion: input.expectedVersion,
          policyRevision: await this.repositories.sharedSpace.policyRevision(
            workspaceId,
          ),
          runId: null,
          sceneSessionId: null,
          ticketId: null,
          gateId: null,
          gate: null,
          idempotencyKey,
          expiresAt: new Date(this.now().getTime() + 30 * 60 * 1_000),
        }),
      };
    } catch (error) {
      await this.discardStaged(staged);
      throw error;
    }
  }

  async listWriteRequests(
    actor: SharedSpaceActor,
    workspaceId: string,
    scope?: "workspace" | "global",
  ): Promise<readonly SharedSpaceWriteRequest[]> {
    const state = await this.loadAccess(actor, workspaceId);
    if (!state.manage.allowed) {
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        "Workspace role management permission is required",
      );
    }
    return this.repositories.sharedSpace.listWriteRequests({
      workspaceId,
      ...(scope === undefined ? {} : { scope }),
    });
  }

  async decideWriteRequest(
    actor: SharedSpaceActor,
    workspaceId: string,
    requestId: string,
    input: DecideSharedSpaceWriteRequestInput,
  ): Promise<SharedSpaceWriteRequest> {
    const request = await this.repositories.sharedSpace.getWriteRequest(requestId);
    if (request === undefined || request.sourceWorkspaceId !== workspaceId) {
      throw new SharedSpaceApplicationError(
        "shared_space_not_found",
        "Shared Space write request not found",
        404,
      );
    }
    if (request.status !== "pending") return request;
    if (request.scope === "global") {
      const decision = await this.repositories.authorization.authorizePlatform({
        principalId: actor.principalId,
        authSource: actor.authSource,
      });
      if (!decision.allowed) {
        await this.auditDenied({
          workspaceId,
          actorPrincipalId: actor.principalId,
          action: "global.approve",
          path: request.targetPath,
          reason: "Platform administrator approval is required for Global Write",
          runId: request.runId,
          sceneSessionId: request.sceneSessionId,
          ticketId: request.ticketId,
          gateId: request.gateId,
        });
        throw new SharedSpaceApplicationError(
          "shared_space_forbidden",
          "Platform administrator approval is required for Global Write",
        );
      }
    } else {
      await this.authorizeManager(
        actor,
        workspaceId,
        input.decision === "approve" ? "write.approve" : "write.reject",
      );
    }
    if (request.gateId !== null) {
      const result = await this.repositories.actionTickets.decide({
        gateId: request.gateId,
        decision: input.decision === "approve" ? "approve" : "reject",
        decidedByPrincipalId: actor.principalId,
        basis: input.basis,
      });
      if (result.kind === "not_found") {
        throw new SharedSpaceApplicationError(
          "shared_space_gate_rejected",
          "Shared Space approval Gate not found",
          409,
        );
      }
      if (result.kind === "expired") {
        return this.repositories.sharedSpace.recordWriteDecision({
          requestId,
          status: "expired",
          decidedByPrincipalId: actor.principalId,
          reason: "approval_gate_expired",
        });
      }
    }
    return this.repositories.sharedSpace.recordWriteDecision({
      requestId,
      status: input.decision === "approve" ? "approved" : "rejected",
      decidedByPrincipalId: actor.principalId,
      reason: input.basis,
    });
  }

  private async executeApprovedRequest(
    request: SharedSpaceWriteRequest,
  ): Promise<SharedSpaceEntry | null> {
    const principal = await this.repositories.authorization.getPrincipal(
      request.actorPrincipalId,
    );
    if (
      principal === undefined ||
      principal.status !== "active" ||
      principal.accountStatus === "disabled"
    ) {
      throw new SharedSpaceApplicationError(
        "principal_not_active",
        "Shared Space write request Principal is not active",
      );
    }
    const actor: SharedSpaceActor = {
      principalId: principal.id,
      authSource: principal.source === "local" ? "local-development" : "bearer",
    };
    const state = await this.loadAccess(actor, request.sourceWorkspaceId);
    await this.assertActiveRoot(state);
    if (state.policyRevision !== request.policyRevision) {
      throw new SharedSpaceApplicationError(
        "shared_space_policy_changed",
        "Shared Space policy changed after the write request was created",
        409,
      );
    }
    if (!(state.write.allowed || state.manage.allowed)) {
      throw new SharedSpaceApplicationError(
        "shared_space_forbidden",
        "Workspace write boundary is no longer valid",
      );
    }
    if (request.scope === "workspace") {
      const access = this.evaluate(
        state,
        request.actorPrincipalId,
        request.targetPath,
      );
      if (
        request.operation === "delete"
          ? !access.permissions.delete
          : !access.permissions.write
      ) {
        throw new SharedSpaceApplicationError(
          "shared_space_forbidden",
          access.reason,
        );
      }
    }
    if (request.runId !== null) {
      const ticket = await this.assertAgentExecution({
        context: {
          principalId: request.actorPrincipalId,
          runId: request.runId,
          sceneSessionId: request.sceneSessionId!,
          ...(request.ticketId === null
            ? {}
            : { ticketId: request.ticketId }),
        },
        workspaceId: request.sourceWorkspaceId,
      });
      if (request.gateId === null || ticket.ticketId !== request.ticketId) {
        throw new SharedSpaceApplicationError(
          "shared_space_ticket_invalid",
          "Shared Space request is not bound to its Action Ticket",
        );
      }
      const gate = await this.repositories.actionTickets.getGate(request.gateId);
      if (gate?.status !== "approved") {
        throw new SharedSpaceApplicationError(
          "shared_space_gate_rejected",
          "Shared Space write Gate is not approved",
        );
      }
    }
    const consumed = await this.repositories.sharedSpace.consumeWriteRequest({
      requestId: request.id,
      actorPrincipalId: request.actorPrincipalId,
      lockId: null,
    });
    return consumed.entry;
  }

  async recoverApprovedWrites(limit = 20): Promise<{
    readonly expiredLocks: number;
    readonly expiredClaims: number;
    readonly expiredRequests: number;
    readonly written: number;
    readonly failed: number;
  }> {
    const [locks, claims, expired] = await Promise.all([
      this.repositories.sharedSpace.expireLocks(limit),
      this.repositories.sharedSpace.expireClaims(limit),
      this.repositories.sharedSpace.expireWriteRequests(limit),
    ]);
    const approved = (
      await this.repositories.sharedSpace.listWriteRequests({
        status: "approved",
        limit,
      })
    ).filter((request) => Date.parse(request.expiresAt) > this.now().getTime());
    let written = 0;
    let failed = 0;
    for (const request of approved) {
      try {
        await this.executeApprovedRequest(request);
        written += 1;
      } catch (error) {
        failed += 1;
        const knownFailure =
          error instanceof SharedSpaceApplicationError ||
          (error instanceof Error &&
            "code" in error &&
            typeof error.code === "string" &&
            error.code.startsWith("shared_space_"));
        await this.repositories.sharedSpace.appendAudit({
          workspaceId: request.sourceWorkspaceId,
          actorPrincipalId: request.actorPrincipalId,
          action:
            request.scope === "global" ? "global.reject" : "write.reject",
          path: request.targetPath,
          decision: "denied",
          reason: redactReason(error),
          runId: request.runId,
          sceneSessionId: request.sceneSessionId,
          ticketId: request.ticketId,
          gateId: request.gateId,
          metadata: { requestId: request.id, workerRecovery: true },
        });
        if (knownFailure) {
          await this.repositories.sharedSpace.failWriteRequest({
            requestId: request.id,
            actorPrincipalId: request.actorPrincipalId,
            reason: redactReason(error),
          });
        }
      }
    }
    return {
      expiredLocks: locks.length,
      expiredClaims: claims.length,
      expiredRequests: expired.length,
      written,
      failed,
    };
  }

  async listAudit(
    actor: SharedSpaceActor,
    workspaceId: string,
    query: SharedSpaceAuditQuery,
  ): Promise<SharedSpaceAuditPage> {
    await this.authorizeManager(actor, workspaceId, "policy.update");
    return this.repositories.sharedSpace.listAudit(workspaceId, query);
  }

  async generateDigest(
    actor: SharedSpaceActor,
    workspaceId: string,
    input: GenerateSharedSpaceDigestInput,
  ): Promise<SharedSpaceDigest> {
    await this.authorizeManager(actor, workspaceId, "digest.create");
    if (input.sceneSessionId !== null) {
      const scene = await this.repositories.sharedSpace.getSceneBinding(
        input.sceneSessionId,
      );
      if (scene === undefined) {
        throw new SharedSpaceApplicationError(
          "shared_space_scene_invalid",
          "Scene Session not found",
          404,
        );
      }
    }
    return this.repositories.sharedSpace.createDigest({
      workspaceId,
      sceneSessionId: input.sceneSessionId,
      generatedBy: actor.principalId,
      digestDate: shanghaiDate(this.now()),
    });
  }

  async listDigests(
    actor: SharedSpaceActor,
    workspaceId: string,
  ): Promise<readonly SharedSpaceDigest[]> {
    await this.authorizeManager(actor, workspaceId, "policy.update");
    return this.repositories.sharedSpace.listDigests(workspaceId);
  }

  async invokeAgentTool(input: {
    readonly tool: SharedSpaceAgentToolName;
    readonly context: SharedSpaceAgentToolContext;
    readonly payload: Record<string, unknown>;
    readonly idempotencyKey: string;
  }): Promise<unknown> {
    const context = sharedSpaceAgentToolContextSchema.parse(input.context);
    const actor: SharedSpaceActor = {
      principalId: context.principalId,
      authSource: "bearer",
    };
    switch (input.tool) {
      case "shared_space_list": {
        const payload = sharedSpaceAgentListInputSchema.parse(input.payload);
        await this.assertAgentExecution({
          context,
          workspaceId: payload.workspaceId,
        });
        return this.listFiles({
          actor,
          workspaceId: payload.workspaceId,
          path: payload.path,
        });
      }
      case "shared_space_read": {
        const payload = sharedSpaceAgentReadInputSchema.parse(input.payload);
        await this.assertAgentExecution({
          context,
          workspaceId: payload.workspaceId,
        });
        return this.readContent(actor, payload.workspaceId, payload.entryId);
      }
      case "shared_space_write": {
        const payload = sharedSpaceAgentWriteInputSchema.parse(input.payload);
        return this.createAgentWriteRequest({
          context,
          workspaceId: payload.workspaceId,
          idempotencyKey: input.idempotencyKey,
          path: payload.path,
          name: payload.name,
          mimeType: payload.mimeType,
          contentBase64: payload.contentBase64,
          expectedVersion: payload.expectedVersion,
          purpose: payload.purpose,
          lockId: payload.lockId,
        });
      }
      case "shared_space_move": {
        const payload = sharedSpaceAgentMoveInputSchema.parse(input.payload);
        return this.createAgentMoveRequest({
          context,
          workspaceId: payload.workspaceId,
          entryId: payload.entryId,
          targetPath: payload.targetPath,
          expectedVersion: payload.expectedVersion,
          idempotencyKey: input.idempotencyKey,
        });
      }
      case "shared_space_delete": {
        const payload = sharedSpaceAgentDeleteInputSchema.parse(input.payload);
        return this.createAgentDeleteRequest({
          context,
          workspaceId: payload.workspaceId,
          entryId: payload.entryId,
          expectedVersion: payload.expectedVersion,
          idempotencyKey: input.idempotencyKey,
        });
      }
      case "shared_space_lock": {
        const payload = sharedSpaceAgentLockInputSchema.parse(input.payload);
        await this.assertAgentExecution({
          context,
          workspaceId: payload.workspaceId,
        });
        return this.acquireLock(
          actor,
          payload.workspaceId,
          {
            path: payload.path,
            mode: payload.mode,
            leaseSeconds: payload.leaseSeconds,
            sessionId: context.sceneSessionId,
          },
          context.runId,
        );
      }
      case "shared_space_release_lock": {
        const payload = sharedSpaceAgentReleaseLockInputSchema.parse(
          input.payload,
        );
        await this.assertAgentExecution({
          context,
          workspaceId: payload.workspaceId,
        });
        return this.releaseLock(
          actor,
          payload.workspaceId,
          payload.lockId,
        );
      }
    }
  }
}
