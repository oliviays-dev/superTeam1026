import { z } from "zod";

const timestampSchema = z.string().datetime({ offset: true });
const relativePathSchema = z.string().trim().min(1).max(500);
const pathPatternSchema = z.string().trim().min(1).max(500);
const principalReferenceSchema = z.string().trim().min(1).max(180);

export const SHARED_SPACE_MAX_CONTENT_BYTES = 5 * 1024 * 1024;

const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export class SharedSpacePathError extends Error {
  constructor(
    readonly code: "shared_space_path_invalid" | "shared_space_path_escape",
    message: string,
  ) {
    super(message);
    this.name = "SharedSpacePathError";
  }
}

function invalidPath(message: string): never {
  throw new SharedSpacePathError("shared_space_path_invalid", message);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validateSegment(
  segment: string,
  input: string,
  allowPattern: boolean,
): void {
  if (allowPattern && (segment === "*" || segment === "**")) return;
  if (segment === "" || segment === "." || segment === "..") {
    throw new SharedSpacePathError(
      "shared_space_path_escape",
      "Shared Space paths cannot contain empty, dot, or parent segments",
    );
  }
  if (
    new TextEncoder().encode(segment).byteLength > 180 ||
    !SEGMENT_PATTERN.test(segment)
  ) {
    invalidPath(
      "Shared Space path segments must start with an ASCII letter or digit and contain only letters, digits, dot, underscore, or hyphen",
    );
  }
  if (segment.endsWith(".") || WINDOWS_RESERVED_NAMES.has(segment.toLowerCase())) {
    invalidPath("Shared Space path contains a reserved or device name");
  }
  if (
    !allowPattern &&
    (segment.toLowerCase() === ".env" ||
      segment.toLowerCase().startsWith(".env."))
  ) {
    invalidPath("Environment files are not accepted in Shared Space");
  }
  if (
    !allowPattern &&
    /(?:credential|secret|private[-_.]?key|id_rsa|id_ed25519)/iu.test(segment)
  ) {
    invalidPath("Credential-like file names are not accepted in Shared Space");
  }
  if (input.includes("//")) {
    invalidPath("Shared Space paths cannot contain empty segments");
  }
}

export function normalizeSharedSpacePath(input: unknown): string {
  if (typeof input !== "string") {
    invalidPath("Shared Space path must be a string");
  }
  if (
    input.includes("\0") ||
    input.includes("\\") ||
    hasControlCharacter(input)
  ) {
    throw new SharedSpacePathError(
      "shared_space_path_invalid",
      "Shared Space path contains a forbidden character",
    );
  }
  const normalized = input.normalize("NFC");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    throw new SharedSpacePathError(
      "shared_space_path_escape",
      "Absolute paths are not accepted",
    );
  }
  if (normalized !== normalized.trim()) {
    invalidPath("Shared Space path cannot have leading or trailing whitespace");
  }
  const segments = normalized.split("/");
  if (segments.length > 32) {
    invalidPath("Shared Space path exceeds the maximum depth");
  }
  for (const segment of segments) validateSegment(segment, normalized, false);
  return segments.join("/");
}

export function normalizeSharedSpaceDirectoryPath(input: unknown): string {
  if (input === "" || input === undefined || input === null) return "";
  return normalizeSharedSpacePath(input);
}

export function normalizeSharedSpacePathPattern(input: unknown): string {
  if (typeof input !== "string") {
    return invalidPath("Shared Space path pattern must be a string");
  }
  if (
    input.includes("\0") ||
    input.includes("\\") ||
    hasControlCharacter(input)
  ) {
    throw new SharedSpacePathError(
      "shared_space_path_invalid",
      "Shared Space path pattern contains a forbidden character",
    );
  }
  const normalized = input.normalize("NFC");
  if (normalized.startsWith("/") || /^[A-Za-z]:/u.test(normalized)) {
    throw new SharedSpacePathError(
      "shared_space_path_escape",
      "Absolute policy patterns are not accepted",
    );
  }
  if (normalized !== normalized.trim()) {
    invalidPath("Shared Space policy pattern cannot have outer whitespace");
  }
  const segments = normalized.split("/");
  if (segments.length > 32) {
    invalidPath("Shared Space policy pattern exceeds the maximum depth");
  }
  segments.forEach((segment, index) => {
    if (segment === "**" && index !== segments.length - 1) {
      invalidPath("The ** pattern is only allowed as the final segment");
    }
    if (
      segment.includes("*") &&
      segment !== "*" &&
      segment !== "**"
    ) {
      invalidPath("Wildcards must occupy an entire path segment");
    }
    validateSegment(segment, normalized, true);
  });
  return segments.join("/");
}

function globExpression(pattern: string): RegExp {
  const segments = pattern.split("/");
  const parts = segments.map((segment) => {
    if (segment === "**") return ".*";
    if (segment === "*") return "[^/]+";
    return segment.replace(/[\\^$.+?()[\]{}|]/gu, "\\$&");
  });
  return new RegExp(`^${parts.join("/")}$`, "u");
}

export function sharedSpacePolicyMatchesPath(
  pattern: string,
  path: string,
): boolean {
  const normalizedPattern = normalizeSharedSpacePathPattern(pattern);
  const normalizedPath = normalizeSharedSpacePath(path);
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    if (normalizedPath === prefix) return true;
    if (normalizedPath.startsWith(`${prefix}/`)) return true;
  }
  return globExpression(normalizedPattern).test(normalizedPath);
}

export const sharedSpacePolicyPermissionSchema = z.enum([
  "list",
  "read",
  "write",
  "delete",
]);
export type SharedSpacePolicyPermission = z.infer<
  typeof sharedSpacePolicyPermissionSchema
>;

export const sharedSpacePolicyEffectSchema = z.enum(["allow", "deny"]);
export type SharedSpacePolicyEffect = z.infer<
  typeof sharedSpacePolicyEffectSchema
>;

export const sharedSpaceSubjectKindSchema = z.enum([
  "principal",
  "workspace-role",
]);
export type SharedSpaceSubjectKind = z.infer<
  typeof sharedSpaceSubjectKindSchema
>;

export const sharedSpaceRootStatusSchema = z.enum(["active", "archived"]);
export type SharedSpaceRootStatus = z.infer<
  typeof sharedSpaceRootStatusSchema
>;

export const sharedSpaceRootSchema = z.object({
  workspaceId: z.string().trim().min(1).max(180),
  status: sharedSpaceRootStatusSchema,
  defaultRead: z.boolean(),
  defaultWrite: z.literal(false),
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type SharedSpaceRoot = z.infer<typeof sharedSpaceRootSchema>;

export const sharedSpacePolicySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(180),
  subjectKind: sharedSpaceSubjectKindSchema,
  subjectId: principalReferenceSchema,
  pathPattern: z.string().trim().min(1).max(500),
  permissions: z
    .array(sharedSpacePolicyPermissionSchema)
    .min(1)
    .max(4)
    .transform((values) => [...new Set(values)]),
  effect: sharedSpacePolicyEffectSchema,
  status: z.enum(["active", "revoked"]),
  expiresAt: timestampSchema.nullable(),
  createdBy: principalReferenceSchema,
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type SharedSpacePolicy = z.infer<typeof sharedSpacePolicySchema>;

export const sharedSpaceEntryKindSchema = z.enum(["file", "directory"]);
export type SharedSpaceEntryKind = z.infer<
  typeof sharedSpaceEntryKindSchema
>;

export const sharedSpaceEntryStatusSchema = z.enum(["active", "archived"]);
export type SharedSpaceEntryStatus = z.infer<
  typeof sharedSpaceEntryStatusSchema
>;

export const sharedSpacePermissionsSchema = z.object({
  list: z.boolean(),
  read: z.boolean(),
  write: z.boolean(),
  delete: z.boolean(),
});
export type SharedSpacePermissions = z.infer<
  typeof sharedSpacePermissionsSchema
>;

export const sharedSpacePermissionPreviewSchema = z.object({
  principalId: principalReferenceSchema,
  path: z.string().max(500),
  permissions: sharedSpacePermissionsSchema,
  matchedPolicyIds: z.array(z.string().uuid()).max(100),
  deniedPolicyIds: z.array(z.string().uuid()).max(100),
  reason: z.string().trim().min(1).max(500),
  workspaceGrantIds: z.array(z.string().uuid()).max(100),
  membershipId: z.string().uuid().nullable(),
  sceneValidated: z.boolean(),
  ticketValidated: z.boolean(),
  gateRequiredForWrite: z.boolean(),
});
export type SharedSpacePermissionPreview = z.infer<
  typeof sharedSpacePermissionPreviewSchema
>;

export const sharedSpaceEntrySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(180),
  path: z.string().trim().min(1).max(500),
  name: z.string().trim().min(1).max(180),
  kind: sharedSpaceEntryKindSchema,
  status: sharedSpaceEntryStatusSchema,
  currentVersion: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  size: z.number().int().nonnegative(),
  mimeType: z.string().trim().min(1).max(180).nullable(),
  createdBy: principalReferenceSchema,
  updatedBy: principalReferenceSchema,
  effectivePermissions: sharedSpacePermissionsSchema,
  currentLock: z.lazy(() => sharedSpaceLockSchema).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type SharedSpaceEntry = z.infer<typeof sharedSpaceEntrySchema>;

export const sharedSpaceVersionSchema = z.object({
  id: z.string().uuid(),
  entryId: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(180),
  path: z.string().trim().min(1).max(500),
  version: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  mimeType: z.string().trim().min(1).max(180),
  createdBy: principalReferenceSchema,
  sourceRunId: z.string().uuid().nullable(),
  ticketId: z.string().uuid().nullable(),
  gateId: z.string().uuid().nullable(),
  createdAt: timestampSchema,
});
export type SharedSpaceVersion = z.infer<typeof sharedSpaceVersionSchema>;

export const sharedSpaceLockModeSchema = z.enum(["exclusive", "shared"]);
export type SharedSpaceLockMode = z.infer<typeof sharedSpaceLockModeSchema>;

export const sharedSpaceLockStatusSchema = z.enum([
  "active",
  "released",
  "expired",
]);
export type SharedSpaceLockStatus = z.infer<
  typeof sharedSpaceLockStatusSchema
>;

export const sharedSpaceLockSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(180),
  path: z.string().trim().min(1).max(500),
  ownerPrincipalId: principalReferenceSchema,
  ownerSessionId: z.string().trim().min(1).max(240).nullable(),
  runId: z.string().uuid().nullable(),
  mode: sharedSpaceLockModeSchema,
  status: sharedSpaceLockStatusSchema,
  leaseExpiresAt: timestampSchema,
  version: z.number().int().positive(),
  acquiredAt: timestampSchema,
  releasedAt: timestampSchema.nullable(),
});
export type SharedSpaceLock = z.infer<typeof sharedSpaceLockSchema>;

export const sharedSpaceClaimSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(180),
  path: z.string().trim().min(1).max(500),
  ownerPrincipalId: principalReferenceSchema,
  ownerSessionId: z.string().trim().min(1).max(240),
  runId: z.string().uuid().nullable(),
  note: z.string().trim().max(500),
  status: z.enum(["active", "released", "expired"]),
  leaseExpiresAt: timestampSchema,
  version: z.number().int().positive(),
  claimedAt: timestampSchema,
  releasedAt: timestampSchema.nullable(),
});
export type SharedSpaceClaim = z.infer<typeof sharedSpaceClaimSchema>;

export const sharedSpaceWriteRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "consumed",
]);
export type SharedSpaceWriteRequestStatus = z.infer<
  typeof sharedSpaceWriteRequestStatusSchema
>;

export const sharedSpaceWriteRequestScopeSchema = z.enum([
  "workspace",
  "global",
]);
export type SharedSpaceWriteRequestScope = z.infer<
  typeof sharedSpaceWriteRequestScopeSchema
>;

export const sharedSpaceWriteRequestSchema = z.object({
  id: z.string().uuid(),
  scope: sharedSpaceWriteRequestScopeSchema,
  operation: z.enum(["write", "move", "delete"]),
  sourceWorkspaceId: z.string().trim().min(1).max(180),
  sourceEntryId: z.string().uuid().nullable(),
  actorPrincipalId: principalReferenceSchema,
  targetPath: z.string().trim().min(1).max(500),
  name: z.string().trim().min(1).max(240),
  mimeType: z.string().trim().min(1).max(180),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  purpose: z.string().trim().min(3).max(1000),
  expectedVersion: z.number().int().nonnegative(),
  policyRevision: z.number().int().nonnegative(),
  status: sharedSpaceWriteRequestStatusSchema,
  runId: z.string().uuid().nullable(),
  sceneSessionId: z.string().uuid().nullable(),
  ticketId: z.string().uuid().nullable(),
  gateId: z.string().uuid().nullable(),
  requestedAt: timestampSchema,
  expiresAt: timestampSchema,
  decidedByPrincipalId: principalReferenceSchema.nullable(),
  decisionReason: z.string().trim().max(2000).nullable(),
  decidedAt: timestampSchema.nullable(),
  consumedAt: timestampSchema.nullable(),
  resultEntryId: z.string().uuid().nullable(),
  resultVersion: z.number().int().nonnegative().nullable(),
});
export type SharedSpaceWriteRequest = z.infer<
  typeof sharedSpaceWriteRequestSchema
>;

export const sharedSpaceAuditActionSchema = z.enum([
  "list",
  "read",
  "download",
  "directory.create",
  "file.write",
  "file.archive",
  "policy.create",
  "policy.update",
  "policy.revoke",
  "lock.acquire",
  "lock.release",
  "lock.expire",
  "claim.create",
  "claim.release",
  "claim.expire",
  "write.request",
  "write.approve",
  "write.reject",
  "write.consume",
  "global.request",
  "global.approve",
  "global.reject",
  "global.consume",
  "digest.create",
]);
export type SharedSpaceAuditAction = z.infer<
  typeof sharedSpaceAuditActionSchema
>;

export const sharedSpaceAuditEventSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(180),
  actorPrincipalId: principalReferenceSchema.nullable(),
  action: sharedSpaceAuditActionSchema,
  path: z.string().max(500).nullable(),
  entryId: z.string().uuid().nullable(),
  version: z.number().int().nonnegative().nullable(),
  decision: z.enum(["allowed", "denied"]),
  reason: z.string().trim().max(1000),
  runId: z.string().uuid().nullable(),
  sceneSessionId: z.string().uuid().nullable(),
  ticketId: z.string().uuid().nullable(),
  gateId: z.string().uuid().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: timestampSchema,
});
export type SharedSpaceAuditEvent = z.infer<
  typeof sharedSpaceAuditEventSchema
>;

export const sharedSpaceDigestSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().trim().min(1).max(180),
  sceneSessionId: z.string().uuid().nullable(),
  digestDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  content: z.string().trim().min(1).max(40_000),
  eventFrom: z.string().uuid().nullable(),
  eventTo: z.string().uuid().nullable(),
  generatedBy: principalReferenceSchema,
  generatedAt: timestampSchema,
});
export type SharedSpaceDigest = z.infer<typeof sharedSpaceDigestSchema>;

export const updateSharedSpaceRootInputSchema = z
  .object({
    status: sharedSpaceRootStatusSchema.optional(),
    defaultRead: z.boolean().optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type UpdateSharedSpaceRootInput = z.infer<
  typeof updateSharedSpaceRootInputSchema
>;

export const createSharedSpacePolicyInputSchema = z
  .object({
    subjectKind: sharedSpaceSubjectKindSchema,
    subjectId: principalReferenceSchema,
    pathPattern: pathPatternSchema,
    permissions: z.array(sharedSpacePolicyPermissionSchema).min(1).max(4),
    effect: sharedSpacePolicyEffectSchema,
    expiresAt: timestampSchema.nullable().default(null),
  })
  .strict();
export type CreateSharedSpacePolicyInput = z.infer<
  typeof createSharedSpacePolicyInputSchema
>;

export const updateSharedSpacePolicyInputSchema = z
  .object({
    permissions: z.array(sharedSpacePolicyPermissionSchema).min(1).max(4).optional(),
    effect: sharedSpacePolicyEffectSchema.optional(),
    expiresAt: timestampSchema.nullable().optional(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type UpdateSharedSpacePolicyInput = z.infer<
  typeof updateSharedSpacePolicyInputSchema
>;

export const sharedSpacePolicyPreviewInputSchema = z
  .object({
    principalId: principalReferenceSchema,
    path: relativePathSchema,
    permission: sharedSpacePolicyPermissionSchema.optional(),
  })
  .strict();
export type SharedSpacePolicyPreviewInput = z.infer<
  typeof sharedSpacePolicyPreviewInputSchema
>;

export const createSharedSpaceDirectoryInputSchema = z
  .object({
    path: relativePathSchema,
  })
  .strict();
export type CreateSharedSpaceDirectoryInput = z.infer<
  typeof createSharedSpaceDirectoryInputSchema
>;

export const sharedSpaceFileContentSchema = z
  .string()
  .min(1)
  .max(Math.ceil((SHARED_SPACE_MAX_CONTENT_BYTES * 4) / 3) + 8);

export const createSharedSpaceFileInputSchema = z
  .object({
    path: relativePathSchema,
    name: z.string().trim().min(1).max(240),
    mimeType: z.string().trim().min(1).max(180),
    contentBase64: sharedSpaceFileContentSchema,
    expectedVersion: z.number().int().nonnegative().default(0),
  })
  .strict();
export type CreateSharedSpaceFileInput = z.infer<
  typeof createSharedSpaceFileInputSchema
>;

export const updateSharedSpaceFileInputSchema = z
  .object({
    name: z.string().trim().min(1).max(240).optional(),
    mimeType: z.string().trim().min(1).max(180).optional(),
    contentBase64: sharedSpaceFileContentSchema,
    expectedVersion: z.number().int().positive(),
    lockId: z.string().uuid().nullable().default(null),
  })
  .strict();
export type UpdateSharedSpaceFileInput = z.infer<
  typeof updateSharedSpaceFileInputSchema
>;

export const archiveSharedSpaceFileInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type ArchiveSharedSpaceFileInput = z.infer<
  typeof archiveSharedSpaceFileInputSchema
>;

export const acquireSharedSpaceLockInputSchema = z
  .object({
    path: relativePathSchema,
    mode: sharedSpaceLockModeSchema.default("exclusive"),
    leaseSeconds: z.number().int().min(30).max(86_400).default(900),
    sessionId: z.string().trim().min(1).max(240).optional(),
  })
  .strict();
export type AcquireSharedSpaceLockInput = z.infer<
  typeof acquireSharedSpaceLockInputSchema
>;

export const sharedSpaceLockParamsSchema = z.object({
  workspaceId: z.string().trim().min(1).max(180),
  lockId: z.string().uuid(),
});

export const createSharedSpaceClaimInputSchema = z
  .object({
    path: relativePathSchema,
    sessionId: z.string().trim().min(1).max(240),
    note: z.string().trim().max(500).default(""),
    leaseSeconds: z.number().int().min(30).max(86_400).default(900),
  })
  .strict();
export type CreateSharedSpaceClaimInput = z.infer<
  typeof createSharedSpaceClaimInputSchema
>;

export const createSharedSpaceWriteRequestInputSchema = z
  .object({
    path: relativePathSchema,
    name: z.string().trim().min(1).max(240),
    mimeType: z.string().trim().min(1).max(180),
    contentBase64: sharedSpaceFileContentSchema,
    expectedVersion: z.number().int().nonnegative(),
    purpose: z.string().trim().min(3).max(1000),
    scope: sharedSpaceWriteRequestScopeSchema.default("workspace"),
    lockId: z.string().uuid().nullable().default(null),
  })
  .strict();
export type CreateSharedSpaceWriteRequestInput = z.infer<
  typeof createSharedSpaceWriteRequestInputSchema
>;

export const decideSharedSpaceWriteRequestInputSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    basis: z.string().trim().min(3).max(4000),
  })
  .strict();
export type DecideSharedSpaceWriteRequestInput = z.infer<
  typeof decideSharedSpaceWriteRequestInputSchema
>;

export const sharedSpaceAgentToolNameSchema = z.enum([
  "shared_space_list",
  "shared_space_read",
  "shared_space_write",
  "shared_space_move",
  "shared_space_delete",
  "shared_space_lock",
  "shared_space_release_lock",
]);
export type SharedSpaceAgentToolName = z.infer<
  typeof sharedSpaceAgentToolNameSchema
>;

export const sharedSpaceAgentToolContextSchema = z
  .object({
    principalId: principalReferenceSchema,
    runId: z.string().uuid(),
    sceneSessionId: z.string().uuid(),
    ticketId: z.string().uuid().optional(),
  })
  .strict();
export type SharedSpaceAgentToolContext = z.infer<
  typeof sharedSpaceAgentToolContextSchema
>;

export const sharedSpaceAgentListInputSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(180),
    path: z.string().max(500).default(""),
  })
  .strict();

export const sharedSpaceAgentReadInputSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(180),
    entryId: z.string().uuid(),
  })
  .strict();

export const sharedSpaceAgentWriteInputSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(180),
    path: relativePathSchema,
    name: z.string().trim().min(1).max(240),
    mimeType: z.string().trim().min(1).max(180),
    contentBase64: sharedSpaceFileContentSchema,
    expectedVersion: z.number().int().nonnegative(),
    purpose: z.string().trim().min(3).max(1000),
    lockId: z.string().uuid().nullable().default(null),
  })
  .strict();

export const sharedSpaceAgentDeleteInputSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(180),
    entryId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const sharedSpaceAgentMoveInputSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(180),
    entryId: z.string().uuid(),
    targetPath: relativePathSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const sharedSpaceAgentLockInputSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(180),
    path: relativePathSchema,
    mode: sharedSpaceLockModeSchema.default("exclusive"),
    leaseSeconds: z.number().int().min(30).max(86400).default(900),
  })
  .strict();

export const sharedSpaceAgentReleaseLockInputSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(180),
    lockId: z.string().uuid(),
  })
  .strict();

export const sharedSpaceAuditQuerySchema = z.object({
  action: sharedSpaceAuditActionSchema.optional(),
  decision: z.enum(["allowed", "denied"]).optional(),
  cursor: z.string().trim().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SharedSpaceAuditQuery = z.infer<
  typeof sharedSpaceAuditQuerySchema
>;

export const sharedSpaceAuditPageSchema = z.object({
  items: z.array(sharedSpaceAuditEventSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
});
export type SharedSpaceAuditPage = z.infer<
  typeof sharedSpaceAuditPageSchema
>;

export const generateSharedSpaceDigestInputSchema = z
  .object({
    sceneSessionId: z.string().uuid().nullable().default(null),
  })
  .strict();
export type GenerateSharedSpaceDigestInput = z.infer<
  typeof generateSharedSpaceDigestInputSchema
>;

export const sharedSpaceWorkspaceSchema = z.object({
  root: sharedSpaceRootSchema,
  policies: z.array(sharedSpacePolicySchema),
  canManage: z.boolean(),
  canWrite: z.boolean(),
});
export type SharedSpaceWorkspace = z.infer<
  typeof sharedSpaceWorkspaceSchema
>;

export const sharedSpaceFileListSchema = z.object({
  path: z.string().max(500),
  entries: z.array(sharedSpaceEntrySchema),
  effectivePermissions: sharedSpacePermissionsSchema,
});
export type SharedSpaceFileList = z.infer<typeof sharedSpaceFileListSchema>;

export const sharedSpaceFileContentSchemaResult = z.object({
  entry: sharedSpaceEntrySchema,
  contentBase64: z.string(),
  truncated: z.boolean(),
});
export type SharedSpaceFileContent = z.infer<
  typeof sharedSpaceFileContentSchemaResult
>;

export const sharedSpaceDownloadSchema = z.object({
  entry: sharedSpaceEntrySchema,
  contentBase64: z.string(),
});
export type SharedSpaceDownload = z.infer<
  typeof sharedSpaceDownloadSchema
>;

export const sharedSpaceGlobalWriteRequestPageSchema = z.object({
  items: z.array(sharedSpaceWriteRequestSchema),
  total: z.number().int().nonnegative(),
});
export type SharedSpaceGlobalWriteRequestPage = z.infer<
  typeof sharedSpaceGlobalWriteRequestPageSchema
>;
