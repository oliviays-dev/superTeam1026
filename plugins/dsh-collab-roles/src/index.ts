import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, join } from "node:path";
import process from "node:process";
import { z } from "zod";
import {
  bearerToken,
  readJsonBody,
  resolveWithin,
  sameOrigin,
  sendJson,
} from "@pluginmax/shared";

export const name = "dsh-collab-roles";
export const inject = ["storageDomain", "commands", "tools", "webServer"];

export const PARTICIPANT_KINDS = ["human", "agent", "any"] as const;
export const ROLE_PERMISSIONS = [
  "read",
  "write",
  "approve",
  "manage_members",
  "manage_roles",
] as const;

export type ParticipantKind = (typeof PARTICIPANT_KINDS)[number];
export type RolePermission = (typeof ROLE_PERMISSIONS)[number];

const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const nameSchema = z.string().trim().min(1).max(80);
const descriptionSchema = z.string().trim().max(2000).default("");
const isoTimeSchema = z.string().datetime({ precision: 3 });
const permissionSchema = z.array(z.enum(ROLE_PERMISSIONS)).min(1).max(5);

const personaSchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: descriptionSchema,
  tags: z.array(z.string().trim().min(1).max(32)).max(16).default([]),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});

const seatSchema = z.object({
  id: idSchema,
  label: nameSchema,
  participantKind: z.enum(PARTICIPANT_KINDS),
  personaId: idSchema.optional(),
  permissions: permissionSchema,
});

const workspaceTypeSchema = z.object({
  id: idSchema,
  name: nameSchema,
  description: descriptionSchema,
  seats: z.array(seatSchema).min(1).max(32),
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});

const workspaceConfigSchema = z.object({
  workspaceId: idSchema,
  typeId: idSchema,
  typeName: nameSchema,
  seats: z.array(seatSchema).min(1).max(32),
  materializedAt: isoTimeSchema,
  materializedBy: idSchema,
});

const assignmentSchema = z.object({
  id: z.string().min(1).max(160),
  workspaceId: idSchema,
  seatId: idSchema,
  seatLabel: nameSchema,
  participantKind: z.enum(["human", "agent"]),
  assigneeKind: z.enum(["user", "agent"]),
  assigneeId: idSchema,
  principalId: z.string().trim().min(1).max(180).optional(),
  sessionId: idSchema.optional(),
  personaId: idSchema.optional(),
  permissions: permissionSchema,
  leader: z.boolean(),
  status: z.enum(["claimed", "assigned", "released"]),
  claimedAt: isoTimeSchema.optional(),
  claimedBy: idSchema.optional(),
  updatedAt: isoTimeSchema,
});

const actorSchema = z.object({
  kind: z.enum(["user", "agent"]),
  id: idSchema,
  sessionId: idSchema.optional(),
  globalRole: z.enum(["admin", "owner", "member", "guest"]).optional(),
  workspaceRole: z.enum(["owner", "member", "guest"]).optional(),
});

export type Persona = z.infer<typeof personaSchema>;
export type RoleSeat = z.infer<typeof seatSchema>;
export type WorkspaceType = z.infer<typeof workspaceTypeSchema>;
export type WorkspaceRoleConfig = z.infer<typeof workspaceConfigSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type RoleActor = z.infer<typeof actorSchema>;

interface PrincipalRecordLike {
  readonly id: string;
  readonly status: "active" | "suspended" | "archived";
}

interface PrincipalServiceLike {
  resolveSubject(
    subjectType: "auth-user" | "employee" | "teammate",
    subjectId: string,
  ): PrincipalRecordLike | undefined;
  syncGrant(input: {
    readonly principalId: string;
    readonly scopeType: "project";
    readonly scopeId: string;
    readonly role: string;
    readonly permissions: readonly string[];
    readonly grantedByPrincipalId?: string;
  }): Promise<unknown>;
  revokeMatchingGrants(input: {
    readonly principalId: string;
    readonly scopeType: "project";
    readonly scopeId: string;
    readonly role: string;
  }): Promise<unknown>;
}

/**
 * 平台默认 facilitator 席位：会议开箱即有一个「会议 Facilitator」agent 席位。
 * personaId 与 dsh-collab-teammate 的 `persona-<teammateId>` 派生规则一致
 * （teammateId = meeting-facilitator）。
 */
const FACILITATOR_SEAT_ID = "facilitator";
const FACILITATOR_PERSONA_ID = "persona-meeting-facilitator";

function facilitatorSeat(): RoleSeat {
  return {
    id: FACILITATOR_SEAT_ID,
    label: "会议 Facilitator",
    participantKind: "agent",
    personaId: FACILITATOR_PERSONA_ID,
    permissions: ["read", "write"],
  };
}

function withFacilitatorSeat(seats: readonly RoleSeat[]): RoleSeat[] {
  if (seats.some((seat) => seat.id === FACILITATOR_SEAT_ID)) return [...seats];
  return [...seats, facilitatorSeat()];
}

/** 已物化工作区的一次性补位：把默认 facilitator 席位补进既有配置。 */
export async function ensureFacilitatorSeats(
  workspaces: KvTableLike<WorkspaceRoleConfig>,
): Promise<void> {
  for (const [key, config] of workspaces.entries()) {
    if (config.seats.some((seat) => seat.id === FACILITATOR_SEAT_ID)) continue;
    await workspaces.put(key, {
      ...config,
      seats: withFacilitatorSeat(config.seats),
    });
  }
}

export class RolesError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "unauthorized" | "forbidden" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "RolesError";
  }
}

interface SchemaLike<V> {
  safeParse(value: unknown): { success: boolean; data?: V };
}

interface KvTableLike<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  keys(): IterableIterator<string>;
  readonly size: number;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface DomainSpecLike {
  readonly name: string;
  readonly version: number;
  readonly tables: Record<
    string,
    { readonly valueSchema: SchemaLike<unknown> }
  >;
}

export interface AssignmentDomainLike {
  table(name: "workspaces"): KvTableLike<WorkspaceRoleConfig>;
  table(name: "assignments"): KvTableLike<Assignment>;
  close(): Promise<void>;
}

function parseOrInvalid<V>(schema: SchemaLike<V>, value: unknown): V {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RolesError("invalid_input", "invalid role payload");
  }
  return result.data as V;
}

function tableValues<V>(table: KvTableLike<V>): V[] {
  return Array.from(table.entries(), ([, value]) => value);
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new RolesError("not_found", "role asset is unreadable");
  }
}

function safeId(id: string): string {
  return parseOrInvalid(idSchema, id);
}

export class PersonaService {
  constructor(
    private readonly root: string,
    private readonly options: { readonly now: () => Date } = {
      now: () => new Date(),
    },
  ) {}

  async list(): Promise<Persona[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const personas: Persona[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const persona = parseOrInvalid(
        personaSchema,
        await readJsonFile(
          resolveWithin(this.root, join(entry.name, "persona.json")),
        ),
      );
      personas.push(persona);
    }
    return personas.sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<Persona & { readonly soul: string }> {
    const safe = safeId(id);
    const base = resolveWithin(this.root, safe);
    const persona = parseOrInvalid(
      personaSchema,
      await readJsonFile(join(base, "persona.json")),
    );
    try {
      return {
        ...persona,
        soul: await readFile(join(base, "SOUL.md"), "utf8"),
      };
    } catch {
      throw new RolesError("not_found", "persona SOUL is unreadable");
    }
  }

  async create(input: {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly tags?: string[];
    readonly soul?: string;
  }): Promise<Persona & { readonly soul: string }> {
    const timestamp = nowIso(this.options.now);
    const parsed = parseOrInvalid(personaSchema, {
      description: "",
      tags: [],
      ...input,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const soul = parseOrInvalid(z.string().max(200_000), input.soul ?? "");
    const base = resolveWithin(this.root, parsed.id);
    await mkdir(base, { recursive: true });
    await atomicWrite(
      join(base, "persona.json"),
      `${JSON.stringify(parsed, null, 2)}\n`,
    );
    await atomicWrite(join(base, "SOUL.md"), soul);
    return { ...parsed, soul };
  }

  async updateSoul(id: string, soul: string): Promise<string> {
    await this.get(id);
    const parsed = parseOrInvalid(z.string().max(200_000), soul);
    await atomicWrite(
      join(resolveWithin(this.root, safeId(id)), "SOUL.md"),
      parsed,
    );
    return parsed;
  }

  async preset(id: string, context = ""): Promise<string> {
    const persona = await this.get(id);
    const parsedContext = parseOrInvalid(z.string().max(4000), context);
    return [
      `# ${persona.name} SOUL`,
      persona.description === ""
        ? ""
        : `## Description\n${persona.description}`,
      `## Identity\n- Persona ID: ${persona.id}`,
      persona.tags.length === 0 ? "" : `- Tags: ${persona.tags.join(", ")}`,
      parsedContext === "" ? "" : `## Runtime context\n${parsedContext}`,
      "## Operating rules\n- Execute only the permissions granted by the current role seat.\n- Record decisions through Pluginmax collaboration tools.\n- Ask a human when required authority is missing.",
      "```markdown",
      persona.soul,
      "```",
    ]
      .filter((part) => part !== "")
      .join("\n\n");
  }
}

export class WorkspaceTypeService {
  constructor(
    private readonly root: string,
    private readonly options: { readonly now: () => Date } = {
      now: () => new Date(),
    },
  ) {}

  async list(): Promise<WorkspaceType[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const types: WorkspaceType[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      types.push(
        parseOrInvalid(
          workspaceTypeSchema,
          await readJsonFile(resolveWithin(this.root, entry.name)),
        ),
      );
    }
    return types.sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<WorkspaceType> {
    return parseOrInvalid(
      workspaceTypeSchema,
      await readJsonFile(resolveWithin(this.root, `${safeId(id)}.json`)),
    );
  }

  async create(
    input: z.input<typeof workspaceTypeSchema>,
  ): Promise<WorkspaceType> {
    const parsed = parseOrInvalid(workspaceTypeSchema, input);
    const seatIds = new Set(parsed.seats.map((seat) => seat.id));
    if (seatIds.size !== parsed.seats.length) {
      throw new RolesError("invalid_input", "seat ids must be unique");
    }
    const path = resolveWithin(this.root, `${parsed.id}.json`);
    await atomicWrite(path, `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await rm(resolveWithin(this.root, `${safeId(id)}.json`), { force: true });
  }
}

function isManager(actor: RoleActor): boolean {
  return (
    actor.kind === "user" &&
    (actor.globalRole === "admin" || actor.workspaceRole === "owner")
  );
}

/**
 * 角色成员表主键。
 *
 * 历史版本里「席位」同时只能有一名占用者，主键是 `workspaceId:seatId`；现在项目角色
 * 是多人集合（可选执行人），主键带上 assignee，历史数据在 apply 时迁移。
 */
function assignmentKey(
  workspaceId: string,
  seatId: string,
  assigneeKind: "user" | "agent",
  assigneeId: string,
): string {
  return `${workspaceId}:${seatId}:${assigneeKind}:${assigneeId}`;
}

function isLegacyAssignmentKey(key: string): boolean {
  return key.split(":").length === 2;
}

export class AssignmentService {
  constructor(
    private readonly tables: {
      readonly workspaces: KvTableLike<WorkspaceRoleConfig>;
      readonly assignments: KvTableLike<Assignment>;
    },
    private readonly options: {
      readonly now: () => Date;
      readonly principals?: () => PrincipalServiceLike | undefined;
    } = {
      now: () => new Date(),
    },
  ) {}

  private principalService(): PrincipalServiceLike | undefined {
    return this.options.principals?.();
  }

  private principalForAssignment(
    assigneeKind: "user" | "agent",
    assigneeId: string,
  ): PrincipalRecordLike | undefined {
    const principals = this.principalService();
    if (principals === undefined) return undefined;
    const principal =
      assigneeKind === "user"
        ? principals.resolveSubject("auth-user", assigneeId)
        : (principals.resolveSubject("teammate", assigneeId) ??
          principals.resolveSubject("employee", assigneeId));
    if (principal?.status === "archived") {
      throw new RolesError(
        "conflict",
        "archived principals cannot receive project roles",
      );
    }
    return principal;
  }

  private principalForActor(actor: RoleActor): PrincipalRecordLike | undefined {
    if (actor.kind !== "user") return undefined;
    return this.principalService()?.resolveSubject("auth-user", actor.id);
  }

  private async syncPrincipalGrant(
    assignment: Assignment,
    actor?: RoleActor,
  ): Promise<void> {
    const principals = this.principalService();
    if (principals === undefined || assignment.principalId === undefined) {
      return;
    }
    const grantor =
      actor === undefined ? undefined : this.principalForActor(actor);
    await principals.syncGrant({
      principalId: assignment.principalId,
      scopeType: "project",
      scopeId: assignment.workspaceId,
      role: assignment.seatId,
      permissions: assignment.permissions,
      ...(grantor === undefined ? {} : { grantedByPrincipalId: grantor.id }),
    });
  }

  private async revokePrincipalGrant(assignment: Assignment): Promise<void> {
    const principals = this.principalService();
    if (principals === undefined || assignment.principalId === undefined) {
      return;
    }
    await principals.revokeMatchingGrants({
      principalId: assignment.principalId,
      scopeType: "project",
      scopeId: assignment.workspaceId,
      role: assignment.seatId,
    });
  }

  config(workspaceId: string): WorkspaceRoleConfig {
    const config = this.tables.workspaces.get(safeId(workspaceId));
    if (config === undefined) {
      throw new RolesError("not_found", "workspace roles are not materialized");
    }
    return config;
  }

  async materialize(
    actor: RoleActor,
    workspaceId: string,
    type: WorkspaceType,
  ): Promise<WorkspaceRoleConfig> {
    if (!isManager(actor)) {
      throw new RolesError("forbidden", "workspace owner role is required");
    }
    // 平台默认 facilitator 席位随物化补齐，不要求每个类型模板手写。
    const seats = withFacilitatorSeat(type.seats);
    const seatIds = new Set(seats.map((seat) => seat.id));
    if (seatIds.size !== seats.length) {
      throw new RolesError("invalid_input", "seat ids must be unique");
    }
    const timestamp = nowIso(this.options.now);
    const config = {
      workspaceId,
      typeId: type.id,
      typeName: type.name,
      seats,
      materializedAt: timestamp,
      materializedBy: actor.id,
    };
    await this.tables.workspaces.put(workspaceId, config);
    for (const key of this.tables.assignments.keys()) {
      const assignment = this.tables.assignments.get(key);
      if (assignment?.workspaceId !== workspaceId) continue;
      if (!seatIds.has(assignment.seatId)) {
        await this.revokePrincipalGrant(assignment);
        await this.tables.assignments.delete(key);
      }
    }
    return config;
  }

  seats(workspaceId: string): Assignment[] {
    this.config(workspaceId);
    return tableValues(this.tables.assignments)
      .filter((assignment) => assignment.workspaceId === workspaceId)
      .sort(
        (left, right) =>
          left.seatId.localeCompare(right.seatId) ||
          left.assigneeId.localeCompare(right.assigneeId),
      );
  }

  /** 某个项目角色当前的可选执行人（含真人成员与 teammate 实例）。 */
  members(workspaceId: string, seatId: string): Assignment[] {
    return this.seats(workspaceId).filter(
      (assignment) =>
        assignment.seatId === seatId && assignment.status !== "released",
    );
  }

  /**
   * 把历史「单占用席位」记录迁移成成员记录：主键补上 assignee，占用状态原样保留。
   * 迁移幂等，可以在每次启动时安全执行。
   */
  async migrateLegacyAssignments(): Promise<number> {
    let migrated = 0;
    // 先取快照再改写：迁移过程中会删除旧主键、写入新主键。
    const keys: string[] = [];
    for (const key of this.tables.assignments.keys()) keys.push(key);
    for (const key of keys) {
      if (!isLegacyAssignmentKey(key)) continue;
      const assignment = this.tables.assignments.get(key);
      if (assignment === undefined) continue;
      const next = assignmentKey(
        assignment.workspaceId,
        assignment.seatId,
        assignment.assigneeKind,
        assignment.assigneeId,
      );
      await this.tables.assignments.put(next, assignment);
      await this.tables.assignments.delete(key);
      migrated += 1;
    }
    return migrated;
  }

  /**
   * 兼容历史项目角色：为已有指派补 `principalId`，并把有效席位镜像到
   * `role_grants`。Principal 服务未就绪时由后续读取或下一次写入补齐。
   */
  async hydratePrincipalAssignments(): Promise<number> {
    let hydrated = 0;
    for (const [key, assignment] of this.tables.assignments.entries()) {
      let principal: PrincipalRecordLike | undefined;
      try {
        principal = this.principalForAssignment(
          assignment.assigneeKind,
          assignment.assigneeId,
        );
      } catch {
        continue;
      }
      if (principal === undefined) continue;
      const next =
        assignment.principalId === principal.id
          ? assignment
          : {
              ...assignment,
              principalId: principal.id,
              updatedAt: nowIso(this.options.now),
            };
      if (next !== assignment) {
        await this.tables.assignments.put(key, next);
        hydrated += 1;
      }
      if (next.status !== "released") await this.syncPrincipalGrant(next);
    }
    return hydrated;
  }

  async claim(
    actor: RoleActor,
    workspaceId: string,
    seatId: string,
    personaId?: string,
  ): Promise<Assignment> {
    const config = this.config(workspaceId);
    const seat = config.seats.find((candidate) => candidate.id === seatId);
    if (seat === undefined)
      throw new RolesError("not_found", "role seat not found");
    if (
      seat.participantKind !== "any" &&
      seat.participantKind !== (actor.kind === "user" ? "human" : "agent")
    ) {
      throw new RolesError(
        "invalid_input",
        "participant kind does not match seat",
      );
    }
    // 角色是成员集合：认领即把自己登记为该角色的一个可选执行人，
    // 重复认领幂等，别的成员认领不会把先到的人挤掉。
    const assigneeKind = actor.kind === "user" ? "user" : "agent";
    const principal = this.principalForAssignment(assigneeKind, actor.id);
    const key = assignmentKey(workspaceId, seatId, assigneeKind, actor.id);
    const existing = this.tables.assignments.get(key);
    if (existing !== undefined && existing.status !== "released") {
      const hydrated =
        principal === undefined || existing.principalId === principal.id
          ? existing
          : { ...existing, principalId: principal.id };
      if (hydrated !== existing) {
        await this.tables.assignments.put(key, hydrated);
      }
      await this.syncPrincipalGrant(hydrated, actor);
      if (actor.kind !== "agent") return hydrated;
      const sessionId = actor.sessionId ?? actor.id;
      if (hydrated.sessionId === sessionId) return hydrated;
      const refreshed: Assignment = {
        ...hydrated,
        sessionId,
        updatedAt: nowIso(this.options.now),
      };
      await this.tables.assignments.put(key, refreshed);
      await this.syncPrincipalGrant(refreshed, actor);
      return refreshed;
    }
    const leader = this.seats(workspaceId).every(
      (assignment) => assignment.status === "released" || !assignment.leader,
    );
    const timestamp = nowIso(this.options.now);
    const assignment: Assignment = {
      id: randomUUID(),
      workspaceId,
      seatId,
      seatLabel: seat.label,
      participantKind: actor.kind === "user" ? "human" : "agent",
      assigneeKind,
      assigneeId: actor.id,
      ...(principal === undefined ? {} : { principalId: principal.id }),
      ...(actor.kind === "agent"
        ? { sessionId: actor.sessionId ?? actor.id }
        : {}),
      personaId: personaId ?? seat.personaId,
      permissions: seat.permissions,
      leader,
      status: "claimed",
      claimedAt: timestamp,
      claimedBy: actor.id,
      updatedAt: timestamp,
    };
    await this.tables.assignments.put(key, assignment);
    await this.syncPrincipalGrant(assignment, actor);
    return assignment;
  }

  async assign(
    actor: RoleActor,
    input: {
      readonly workspaceId: string;
      readonly seatId: string;
      readonly assigneeKind: "user" | "agent";
      readonly assigneeId: string;
      readonly personaId?: string;
    },
  ): Promise<Assignment> {
    if (!isManager(actor)) {
      throw new RolesError("forbidden", "workspace owner role is required");
    }
    const config = this.config(input.workspaceId);
    const principal = this.principalForAssignment(
      input.assigneeKind,
      input.assigneeId,
    );
    const seat = config.seats.find(
      (candidate) => candidate.id === input.seatId,
    );
    if (seat === undefined)
      throw new RolesError("not_found", "role seat not found");
    if (
      seat.participantKind !== "any" &&
      seat.participantKind !==
        (input.assigneeKind === "user" ? "human" : "agent")
    ) {
      throw new RolesError(
        "invalid_input",
        "participant kind does not match seat",
      );
    }
    const key = assignmentKey(
      input.workspaceId,
      input.seatId,
      input.assigneeKind,
      input.assigneeId,
    );
    const existing = this.tables.assignments.get(key);
    if (existing !== undefined && existing.status !== "released") {
      // 同一成员重复指派幂等，其余成员不受影响。
      const hydrated =
        principal === undefined || existing.principalId === principal.id
          ? existing
          : { ...existing, principalId: principal.id };
      if (hydrated !== existing) {
        await this.tables.assignments.put(key, hydrated);
      }
      await this.syncPrincipalGrant(hydrated, actor);
      return hydrated;
    }
    const timestamp = nowIso(this.options.now);
    const leader = this.seats(input.workspaceId).every(
      (assignment) => assignment.status === "released" || !assignment.leader,
    );
    const assignment: Assignment = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      seatId: seat.id,
      seatLabel: seat.label,
      participantKind: input.assigneeKind === "user" ? "human" : "agent",
      assigneeKind: input.assigneeKind,
      assigneeId: input.assigneeId,
      ...(principal === undefined ? {} : { principalId: principal.id }),
      personaId: input.personaId ?? seat.personaId,
      permissions: seat.permissions,
      leader,
      status: "assigned",
      updatedAt: timestamp,
    };
    await this.tables.assignments.put(key, assignment);
    await this.syncPrincipalGrant(assignment, actor);
    return assignment;
  }

  async release(
    actor: RoleActor,
    workspaceId: string,
    seatId: string,
    target?: {
      readonly assigneeKind: "user" | "agent";
      readonly assigneeId: string;
    },
  ): Promise<Assignment> {
    this.config(workspaceId);
    const assigneeKind =
      target?.assigneeKind ?? (actor.kind === "user" ? "user" : "agent");
    const assigneeId = target?.assigneeId ?? actor.id;
    const key = assignmentKey(workspaceId, seatId, assigneeKind, assigneeId);
    const assignment = this.tables.assignments.get(key);
    if (assignment === undefined || assignment.status === "released") {
      throw new RolesError("not_found", "active role seat not found");
    }
    const own =
      assignment.assigneeKind === assigneeKind &&
      assignment.assigneeId === assigneeId &&
      actor.kind === assigneeKind;
    if (!own && !isManager(actor)) {
      throw new RolesError(
        "forbidden",
        "seat owner or workspace owner role is required",
      );
    }
    const released: Assignment = {
      ...assignment,
      status: "released",
      updatedAt: nowIso(this.options.now),
    };
    await this.tables.assignments.put(key, released);
    await this.revokePrincipalGrant(released);
    return released;
  }
}

export const assignmentDomainSpec: DomainSpecLike = {
  name: "collab_assignment",
  version: 1,
  tables: {
    workspaces: {
      valueSchema: workspaceConfigSchema as unknown as SchemaLike<unknown>,
    },
    assignments: {
      valueSchema: assignmentSchema as unknown as SchemaLike<unknown>,
    },
  },
};

interface CommandResultLike {
  readonly kind: "success" | "error";
  readonly text: string;
}

interface ToolOutputLike {
  readonly schema: { readonly type: "string" };
  render(
    args: Record<string, never>,
    value: string,
  ): Array<{ type: "text"; text: string }>;
}

export interface WebRouteLike {
  readonly kind: "exact";
  readonly path: string;
  handler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> | void;
}

interface TeamServiceLike {
  resolveToken(token: string): { userId: string; role: string } | undefined;
  members(workspaceId: string): Array<{ userId: string; memberRole: string }>;
}

interface ProjectRoleStateLike {
  readonly rolesInitialized: boolean;
  readonly projectRoles: readonly unknown[];
}

interface ProjectServiceLike {
  project(workspaceId: string): ProjectRoleStateLike | undefined;
}

export interface RolesContext {
  effect(register: () => () => void): void;
  provide(key: "collabPersonas", value: PersonaService): unknown;
  provide(key: "collabWorkspaceType", value: WorkspaceTypeService): unknown;
  provide(key: "collabAssignment", value: AssignmentService): unknown;
  commands: {
    register(definition: {
      name: string;
      description: string;
      input: { hint: string; attachments: boolean };
      handler(invocation: { readonly rawInput: string }): CommandResultLike;
    }): unknown;
  };
  tools: {
    register(definition: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      output: ToolOutputLike;
      execute(
        args: unknown,
        exec: { readonly signal: AbortSignal },
      ): Promise<string>;
    }): unknown;
  };
  webServer: { register(route: WebRouteLike): unknown };
  storageDomain: { open(spec: DomainSpecLike): Promise<AssignmentDomainLike> };
  get(key: string): unknown;
  collabTeam?: TeamServiceLike;
  inject(
    keys: readonly ["collabTeam"],
    callback: (
      child: RolesContext & { readonly collabTeam: TeamServiceLike },
    ) => void,
  ): { dispose(): void };
}

function browserActor(
  team: TeamServiceLike,
  request: IncomingMessage,
  workspaceId: string,
  options: { readonly requireWorkspaceMember?: boolean } = {},
): RoleActor {
  const headers = request.headers;
  if (
    headers.origin !== undefined &&
    !sameOrigin(headers.origin, headers.host)
  ) {
    throw new RolesError("forbidden", "same-origin requests are required");
  }
  const token = bearerToken({
    get: (name) =>
      name === "authorization" ? (headers.authorization ?? null) : null,
  });
  if (token === undefined)
    throw new RolesError("unauthorized", "bearer token is required");
  const principal = team.resolveToken(token);
  if (principal === undefined)
    throw new RolesError("unauthorized", "invalid bearer token");
  const member = team
    .members(workspaceId)
    .find((candidate) => candidate.userId === principal.userId);
  if (
    options.requireWorkspaceMember === true &&
    member === undefined &&
    principal.role !== "admin"
  ) {
    throw new RolesError("forbidden", "workspace member role is required");
  }
  return {
    kind: "user",
    id: principal.userId,
    globalRole: principal.role as RoleActor["globalRole"],
    ...(member === undefined
      ? {}
      : { workspaceRole: member.memberRole as RoleActor["workspaceRole"] }),
  };
}

function errorStatus(code: RolesError["code"]): number {
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
    if (cause instanceof RolesError) {
      sendJson(response, errorStatus(cause.code), {
        ok: false,
        error: { code: cause.code, message: cause.message },
      });
      return;
    }
    sendJson(response, 500, {
      ok: false,
      error: { code: "internal_error", message: "roles operation failed" },
    });
  }
}

export function createRolesRoutes(
  personas: PersonaService,
  types: WorkspaceTypeService,
  assignments: AssignmentService,
  team: TeamServiceLike,
  projects?: () => ProjectServiceLike | undefined,
): WebRouteLike[] {
  const routes = [
    {
      method: "GET",
      path: "/api/collab/roles/personas",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        browserActor(team, request, "global");
        sendJson(response, 200, { ok: true, personas: await personas.list() });
      },
    },
    {
      method: "POST",
      path: "/api/collab/roles/personas",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        browserActor(team, request, "global");
        const body = parseOrInvalid(
          z.object({
            id: idSchema,
            name: nameSchema,
            description: descriptionSchema,
            tags: z.array(z.string().trim().min(1).max(32)).max(16).default([]),
            soul: z.string().max(200_000).default(""),
          }),
          await readJsonBody(request),
        );
        sendJson(response, 201, {
          ok: true,
          persona: await personas.create(body),
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/roles/types",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        browserActor(team, request, "global");
        sendJson(response, 200, { ok: true, types: await types.list() });
      },
    },
    {
      method: "POST",
      path: "/api/collab/roles/types",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const actor = browserActor(team, request, "global");
        if (actor.globalRole !== "admin") {
          throw new RolesError(
            "forbidden",
            "admin role is required for type creation",
          );
        }
        const body = parseOrInvalid(
          z.object({
            id: idSchema,
            name: nameSchema,
            description: descriptionSchema,
            seats: z.array(seatSchema).min(1).max(32),
          }),
          await readJsonBody(request),
        );
        const timestamp = nowIso(() => new Date());
        sendJson(response, 201, {
          ok: true,
          type: await types.create({
            ...body,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/roles/materialize",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({ workspaceId: idSchema, typeId: idSchema }),
          await readJsonBody(request),
        );
        const actor = browserActor(team, request, body.workspaceId, {
          requireWorkspaceMember: true,
        });
        const project = projects?.()?.project(body.workspaceId);
        let existingSeats: readonly RoleSeat[] = [];
        try {
          existingSeats = assignments.config(body.workspaceId).seats;
        } catch {
          existingSeats = [];
        }
        const customSeats = existingSeats.filter(
          (seat) => seat.id !== FACILITATOR_SEAT_ID,
        );
        if (
          (project !== undefined &&
            (project.rolesInitialized || project.projectRoles.length > 0)) ||
          customSeats.length > 0
        ) {
          throw new RolesError(
            "conflict",
            "该项目已有项目角色，工作区类型只能用于初始化；请到「项目设置 → 项目角色」调整。",
          );
        }
        sendJson(response, 201, {
          ok: true,
          config: await assignments.materialize(
            actor,
            body.workspaceId,
            await types.get(body.typeId),
          ),
        });
      },
    },
    {
      method: "GET",
      path: "/api/collab/roles/seats",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const workspaceId = new URL(
          request.url ?? "/",
          "http://localhost",
        ).searchParams.get("workspaceId");
        if (workspaceId === null)
          throw new RolesError("invalid_input", "workspaceId is required");
        const viewer = browserActor(team, request, workspaceId, {
          requireWorkspaceMember: true,
        });
        sendJson(response, 200, {
          ok: true,
          config: assignments.config(workspaceId),
          seats: assignments.seats(workspaceId),
          viewer: {
            id: viewer.id,
            globalRole: viewer.globalRole,
            workspaceRole: viewer.workspaceRole,
          },
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/roles/seats/claim",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            workspaceId: idSchema,
            seatId: idSchema,
            personaId: idSchema.optional(),
          }),
          await readJsonBody(request),
        );
        const actor = browserActor(team, request, body.workspaceId, {
          requireWorkspaceMember: true,
        });
        sendJson(response, 201, {
          ok: true,
          seat: await assignments.claim(
            actor,
            body.workspaceId,
            body.seatId,
            body.personaId,
          ),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/roles/seats/assign",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            workspaceId: idSchema,
            seatId: idSchema,
            assigneeKind: z.enum(["user", "agent"]),
            assigneeId: idSchema,
            personaId: idSchema.optional(),
          }),
          await readJsonBody(request),
        );
        const actor = browserActor(team, request, body.workspaceId, {
          requireWorkspaceMember: true,
        });
        sendJson(response, 201, {
          ok: true,
          seat: await assignments.assign(actor, {
            workspaceId: body.workspaceId,
            seatId: body.seatId,
            assigneeKind: body.assigneeKind,
            assigneeId: body.assigneeId,
            ...(body.personaId === undefined
              ? {}
              : { personaId: body.personaId }),
          }),
        });
      },
    },
    {
      method: "POST",
      path: "/api/collab/roles/seats/release",
      handler: async (request: IncomingMessage, response: ServerResponse) => {
        const body = parseOrInvalid(
          z.object({
            workspaceId: idSchema,
            seatId: idSchema,
            assigneeKind: z.enum(["user", "agent"]).optional(),
            assigneeId: idSchema.optional(),
          }),
          await readJsonBody(request),
        );
        const actor = browserActor(team, request, body.workspaceId, {
          requireWorkspaceMember: true,
        });
        if (
          (body.assigneeKind === undefined) !==
          (body.assigneeId === undefined)
        ) {
          throw new RolesError(
            "invalid_input",
            "assigneeKind and assigneeId must be provided together",
          );
        }
        sendJson(response, 200, {
          ok: true,
          seat: await assignments.release(
            actor,
            body.workspaceId,
            body.seatId,
            body.assigneeKind === undefined || body.assigneeId === undefined
              ? undefined
              : {
                  assigneeKind: body.assigneeKind,
                  assigneeId: body.assigneeId,
                },
          ),
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

const stringToolOutput: ToolOutputLike = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: value }],
};

export async function apply(ctx: RolesContext): Promise<void | (() => void)> {
  const domain = await ctx.storageDomain.open(assignmentDomainSpec);
  const home = process.env.DSH_HOME;
  if (home === undefined || !isAbsolute(home)) {
    await domain.close();
    throw new Error("DSH_HOME must be set to an absolute directory");
  }
  const personas = new PersonaService(join(home, "pluginmax", "personas"));
  const types = new WorkspaceTypeService(
    join(home, "pluginmax", "workspace-types"),
  );
  const assignments = new AssignmentService(
    {
      workspaces: domain.table("workspaces"),
      assignments: domain.table("assignments"),
    },
    {
      now: () => new Date(),
      principals: () =>
        ctx.get("collabPrincipal") as PrincipalServiceLike | undefined,
    },
  );
  // 项目角色从「单占用席位」升级成「成员集合」：旧主键记录在启动时补齐 assignee。
  await assignments.migrateLegacyAssignments();
  await ensureFacilitatorSeats(domain.table("workspaces"));
  ctx.provide("collabPersonas", personas);
  ctx.provide("collabWorkspaceType", types);
  ctx.provide("collabAssignment", assignments);
  ctx.effect(() => () => void domain.close());
  ctx.commands.register({
    name: "assignment",
    description: "inspect DSH Pluginmax role seats",
    input: {
      hint: "list <workspace>",
      attachments: false,
    },
    handler: (invocation) => {
      const [operation, workspaceId] = invocation.rawInput.trim().split(/\s+/);
      try {
        if (operation === "list" && workspaceId !== undefined) {
          const seats = assignments.seats(workspaceId);
          return {
            kind: "success",
            text:
              seats
                .map(
                  (seat) =>
                    `${seat.seatId}\t${seat.status}\t${seat.assigneeKind}/${seat.assigneeId}${seat.leader ? "\tleader" : ""}`,
                )
                .join("\n") || "no occupied seats",
          };
        }
      } catch (cause) {
        return {
          kind: "error",
          text: cause instanceof Error ? cause.message : String(cause),
        };
      }
      return {
        kind: "error",
        text: "usage: /assignment list <workspace>",
      };
    },
  });
  ctx.tools.register({
    name: "collab_roles",
    description: "Inspect materialized role seats.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        operation: { type: "string", enum: ["list"] },
        workspaceId: { type: "string" },
      },
      required: ["operation", "workspaceId"],
    },
    output: stringToolOutput,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted();
      const parsed = parseOrInvalid(
        z.object({
          operation: z.enum(["list"]),
          workspaceId: idSchema,
        }),
        args,
      );
      return assignments
        .seats(parsed.workspaceId)
        .map((seat) => `${seat.seatId}\t${seat.status}\t${seat.assigneeId}`)
        .join("\n");
    },
  });
  let routeDisposers: Array<() => void> = [];
  const identityFiber = ctx.inject(["collabTeam"], (child) => {
    void assignments.hydratePrincipalAssignments().catch(() => undefined);
    routeDisposers = createRolesRoutes(
      personas,
      types,
      assignments,
      child.collabTeam,
      () => child.get("collabProjects") as ProjectServiceLike | undefined,
    ).map((route) => child.webServer.register(route)) as Array<() => void>;
  });
  return () => {
    identityFiber.dispose();
    for (const dispose of routeDisposers) dispose();
  };
}
