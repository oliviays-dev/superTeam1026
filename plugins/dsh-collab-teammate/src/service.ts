import { randomUUID } from "node:crypto";
import {
  teammateEventSchema,
  teammateSchema,
  teammateTemplateSchema,
  type Teammate,
  type TeammateEvent,
  type TeammateSource,
  type TeammateState,
  type TeammateTemplate,
  type TeammateTemplateState,
  type ProfileTemplate,
} from "./models.js";

export interface KvTableLike<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  readonly size: number;
  put(key: string, value: V): Promise<void>;
  delete?(key: string): Promise<boolean>;
}

export interface TeammateTables {
  readonly teammates: KvTableLike<Teammate>;
  readonly events: KvTableLike<TeammateEvent>;
}

export interface TeammateTemplateTables {
  readonly templates: KvTableLike<TeammateTemplate>;
}

export interface TeammateActor {
  readonly userId: string;
  readonly name: string;
  readonly role: "admin" | "owner" | "member" | "guest";
}

/**
 * 平台托管 owner：实例没有可归属的人类创建人时使用（如员工平台同步进来的历史数据）。
 * `TeammateRuntime.ownerOf()` 会把它判定为「无个人 owner」，因此这类实例的任务不会
 * 被交回给某个具体用户，而是保留在实例/Agent 侧，由平台管理员治理。
 */
export const PLATFORM_OWNER_USER_ID = "platform";
export const PLATFORM_OWNER_NAME = "平台";

export interface TeammateServiceOptions {
  readonly now?: () => Date;
}

export type TeammateInstanceView = Teammate & {
  readonly templateName: string;
  readonly templateSource: TeammateSource;
};

/** 供运行态使用的一次性投影：实例覆盖优先，定义字段始终从模版读取。 */
export interface TeammateEffectiveDefinition {
  readonly name: string;
  readonly description: string;
  readonly avatar: string;
  readonly role: string;
  readonly soul: string;
  readonly scenarios: readonly string[];
  readonly goals: readonly string[];
  readonly tools: readonly string[];
  readonly source: TeammateSource;
  readonly templateId?: string | undefined;
  readonly personaAlias?: string | undefined;
}

export class TeammateError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "unauthorized" | "forbidden" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "TeammateError";
  }
}

export interface CreateTeammateInput {
  /** 兼容旧调用：只提供 templateId 时无需再传 source。 */
  readonly source?: TeammateSource | undefined;
  readonly name?: string | undefined;
  readonly templateId?: string | undefined;
  readonly role?: string | undefined;
  readonly profileTemplateId?: string | undefined;
  readonly execution?: "builtin" | "external" | undefined;
  readonly externalRuntimeId?: string | undefined;
}

export interface UpdateTeammateInput {
  readonly teammateId: string;
  readonly name: string;
  readonly source?: TeammateSource | undefined;
  readonly execution?: "builtin" | "external" | undefined;
  readonly externalRuntimeId?: string | undefined;
  readonly role?: string | undefined;
  readonly description?: string | undefined;
  readonly soul?: string | undefined;
  readonly scenarios?: readonly string[] | undefined;
  readonly goals?: readonly string[] | undefined;
  readonly avatar?: string | undefined;
}

export interface ChangeTeammateStateInput {
  readonly teammateId: string;
  readonly state: TeammateState;
}

/** 实例资料：只维护名称与描述，不改人设内容。 */
export interface UpdateInstanceProfileInput {
  readonly teammateId: string;
  readonly name: string;
  readonly description: string;
}

export interface CreateTeammateTemplateInput {
  readonly source: TeammateSource;
  readonly name: string;
  readonly role?: string | undefined;
  readonly description?: string | undefined;
  readonly soul?: string | undefined;
  readonly scenarios?: readonly string[] | undefined;
  readonly goals?: readonly string[] | undefined;
  readonly tools?: readonly string[] | undefined;
  /** 迁移期兼容外部 `persona-*` 引用；新模版通常不传。 */
  readonly personaAlias?: string | undefined;
  readonly active?: boolean | undefined;
}

export interface UpdateTeammateTemplateInput {
  readonly templateId: string;
  readonly name: string;
  readonly role?: string | undefined;
  readonly description?: string | undefined;
  readonly soul?: string | undefined;
  readonly scenarios?: readonly string[] | undefined;
  readonly goals?: string[] | undefined;
  readonly tools?: string[] | undefined;
}

/**
 * 状态流转与 demo 一致：草稿保存后进入「已失效」，再按归属分别生效、暂停或归档。
 * 归档为终态，需要重新启用时由管理员另建定义。
 */
const STATUS_TRANSITIONS: Record<TeammateState, readonly TeammateState[]> = {
  draft: ["inactive", "archived"],
  active: ["paused", "inactive", "archived"],
  paused: ["active", "inactive", "archived"],
  inactive: ["active", "archived"],
  // 归档后允许「复原」回已失效，再按常规流程生效。
  archived: ["inactive"],
};

const STATE_LABELS: Record<TeammateState, string> = {
  draft: "草稿",
  active: "生效",
  paused: "暂停",
  inactive: "失效",
  archived: "归档",
};

const STATE_ORDER: Record<TeammateState, number> = {
  active: 0,
  draft: 1,
  paused: 2,
  inactive: 3,
  archived: 4,
};

const DEFAULT_NAME = "未命名 AI伙伴";
const DEFAULT_ROLE = "角色待定";
const DEFAULT_SOUL =
  "定义这名 AI伙伴是谁、如何判断、遇到什么情况需要升级给本人。";

function randomId(): string {
  return `tm-${randomUUID()}`;
}

const TEMPLATE_STATE_TRANSITIONS: Record<
  TeammateTemplateState,
  readonly TeammateTemplateState[]
> = {
  active: ["disabled", "archived"],
  disabled: ["active", "archived"],
  archived: [],
};

function teammateTemplateId(): string {
  return `tpl-${randomUUID()}`;
}

export function canManageTemplate(
  template: Pick<TeammateTemplate, "source" | "ownerUserId">,
  actor: TeammateActor,
): boolean {
  return template.source === "platform"
    ? actor.role === "admin"
    : template.ownerUserId === actor.userId;
}

export class TeammateTemplateService {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      readonly tables: TeammateTemplateTables;
      readonly now?: () => Date;
    },
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private timestamp(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private values(): TeammateTemplate[] {
    return [...this.options.tables.templates.entries()].map(
      ([, value]) => value,
    );
  }

  private require(templateId: string): TeammateTemplate {
    const template = this.options.tables.templates.get(templateId);
    if (template === undefined) {
      throw new TeammateError("not_found", "AI伙伴模版不存在");
    }
    return template;
  }

  private assertUniqueName(input: {
    readonly id?: string | undefined;
    readonly source: TeammateSource;
    readonly name: string;
  }): void {
    const normalized = input.name.trim().toLocaleLowerCase("zh-Hans-CN");
    const conflict = this.values().find(
      (item) =>
        item.id !== input.id &&
        item.state !== "archived" &&
        item.source === input.source &&
        item.name.trim().toLocaleLowerCase("zh-Hans-CN") === normalized,
    );
    if (conflict !== undefined) {
      throw new TeammateError(
        "conflict",
        `${input.source === "platform" ? "平台" : "个人"}模版已存在同名定义「${conflict.name}」`,
      );
    }
  }

  list(actor: TeammateActor): readonly TeammateTemplate[] {
    return this.values()
      .filter((template) =>
        actor.role === "admin"
          ? true
          : template.source === "platform"
            ? template.state === "active"
            : template.ownerUserId === actor.userId,
      )
      .sort(
        (left, right) =>
          left.source.localeCompare(right.source) ||
          Number(right.state === "active") - Number(left.state === "active") ||
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.name.localeCompare(right.name, "zh-Hans-CN"),
      );
  }

  get(templateId: string): TeammateTemplate | undefined {
    return this.options.tables.templates.get(templateId);
  }

  private assertCanCreate(
    actor: TeammateActor,
    input: Pick<CreateTeammateTemplateInput, "source">,
  ): void {
    if (
      input.source === "platform"
        ? actor.role !== "admin"
        : actor.role === "guest"
    ) {
      throw new TeammateError(
        "forbidden",
        input.source === "platform"
          ? "平台管理员可以维护平台模版"
          : "活跃用户可以维护个人模版",
      );
    }
  }

  private buildTemplate(
    actor: TeammateActor,
    input: CreateTeammateTemplateInput,
  ): TeammateTemplate {
    const name = input.name.trim();
    if (name === "") {
      throw new TeammateError("invalid_input", "模版名称不能为空");
    }
    this.assertUniqueName({ source: input.source, name });
    const timestamp = this.timestamp();
    return teammateTemplateSchema.parse({
      id: teammateTemplateId(),
      source: input.source,
      ...(input.source === "personal" ? { ownerUserId: actor.userId } : {}),
      name,
      role: input.role?.trim() ?? "",
      description: input.description?.trim() ?? "",
      soul: input.soul ?? "",
      scenarios: input.scenarios ?? [],
      goals: input.goals ?? [],
      tools: input.tools ?? [],
      state: input.active === false ? "disabled" : "active",
      version: "v1.0",
      ...(input.personaAlias === undefined
        ? {}
        : { personaAlias: input.personaAlias }),
      createdBy: actor.userId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  create(
    actor: TeammateActor,
    input: CreateTeammateTemplateInput,
  ): Promise<TeammateTemplate> {
    return this.enqueue(async () => {
      this.assertCanCreate(actor, input);
      const template = this.buildTemplate(actor, input);
      await this.options.tables.templates.put(template.id, template);
      return template;
    });
  }

  /**
   * 兼容旧「按 source + name 找定义」入口。仅在不存在同归属同名模版时创建，
   * 避免迁移期和旧客户端产生两条并存的模版。
   */
  findOrCreate(
    actor: TeammateActor,
    input: CreateTeammateTemplateInput,
  ): Promise<TeammateTemplate> {
    return this.enqueue(async () => {
      this.assertCanCreate(actor, input);
      const name = input.name.trim();
      const normalized = name.toLocaleLowerCase("zh-Hans-CN");
      const existing = this.values().find(
        (template) =>
          template.state !== "archived" &&
          template.source === input.source &&
          template.name.trim().toLocaleLowerCase("zh-Hans-CN") === normalized,
      );
      if (existing !== undefined) return existing;
      const template = this.buildTemplate(actor, input);
      await this.options.tables.templates.put(template.id, template);
      return template;
    });
  }

  update(
    actor: TeammateActor,
    input: UpdateTeammateTemplateInput,
  ): Promise<TeammateTemplate> {
    return this.enqueue(async () => {
      const current = this.require(input.templateId);
      if (!canManageTemplate(current, actor)) {
        throw new TeammateError(
          "forbidden",
          "只有模版归属人或平台管理员可以编辑模版",
        );
      }
      if (current.state === "archived") {
        throw new TeammateError("conflict", "归档的模版不能编辑");
      }
      const name = input.name.trim();
      if (name === "") {
        throw new TeammateError("invalid_input", "模版名称不能为空");
      }
      this.assertUniqueName({ id: current.id, source: current.source, name });
      const next = teammateTemplateSchema.parse({
        ...current,
        name,
        role: input.role?.trim() ?? current.role,
        description: input.description?.trim() ?? current.description,
        soul: input.soul ?? current.soul,
        scenarios: input.scenarios ?? current.scenarios,
        goals: input.goals ?? current.goals,
        tools: input.tools ?? current.tools,
        version: nextVersion(current.version),
        updatedAt: this.timestamp(),
      });
      await this.options.tables.templates.put(next.id, next);
      return next;
    });
  }

  changeState(
    actor: TeammateActor,
    input: {
      readonly templateId: string;
      readonly state: TeammateTemplateState;
    },
  ): Promise<TeammateTemplate> {
    return this.enqueue(async () => {
      const current = this.require(input.templateId);
      if (!canManageTemplate(current, actor)) {
        throw new TeammateError(
          "forbidden",
          "只有模版归属人或平台管理员可以变更模版状态",
        );
      }
      if (
        !["active", "disabled", "archived"].includes(input.state) ||
        !TEMPLATE_STATE_TRANSITIONS[current.state].includes(input.state)
      ) {
        throw new TeammateError(
          "conflict",
          `模版不能从「${current.state}」变更为「${input.state}」`,
        );
      }
      const next = teammateTemplateSchema.parse({
        ...current,
        state: input.state,
        updatedAt: this.timestamp(),
      });
      await this.options.tables.templates.put(next.id, next);
      return next;
    });
  }
}

export function nextVersion(current: string): string {
  const match = /^v(\d+)\.(\d+)$/.exec(current.trim());
  if (match === null) return "v1.0";
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return `v${major}.${minor + 1}`;
}

export function canManageTeammate(
  teammate: Teammate,
  actor: TeammateActor,
): boolean {
  return teammate.source === "personal"
    ? teammate.ownerUserId === actor.userId
    : actor.role === "admin";
}

/**
 * 实例级操作的权限口径：实例归创建人（owner）所有，跟模版是平台归属还是个人归属无关；
 * 平台管理员保留全局治理权限（owner 缺失的历史实例只有管理员能动）。
 */
export function canManageInstance(
  teammate: Pick<Teammate, "ownerUserId">,
  actor: TeammateActor,
): boolean {
  return actor.role === "admin" || teammate.ownerUserId === actor.userId;
}

export class TeammateService {
  private readonly templates: TeammateTemplateService | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: {
      readonly tables: TeammateTables;
      readonly now?: () => Date;
      readonly templates?: TeammateTemplateService;
      readonly users?: () => readonly {
        readonly id: string;
        readonly name: string;
      }[];
    },
  ) {
    this.templates = options.templates;
    // 服务启动时修复历史遗留的共享模版重名实例，后续变更入口再做强校验。
    this.queue = this.repairHistoricalDuplicateNames();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private values<V>(table: KvTableLike<V>): V[] {
    return [...table.entries()].map(([, value]) => value);
  }

  private requireTeammate(teammateId: string): Teammate {
    const teammate = this.options.tables.teammates.get(teammateId);
    if (teammate === undefined) {
      throw new TeammateError("not_found", "AI伙伴不存在");
    }
    return teammate;
  }

  /**
   * 定义编辑权限以实例引用的模版为准；没有 templateId 的历史记录才回退旧口径。
   * 实例资料/归档/身份启停等实例操作统一走 canManageInstance。
   */
  private assertCanManageDefinition(
    teammate: Teammate,
    actor: TeammateActor,
  ): void {
    const template = this.templateOf(teammate);
    if (
      (template !== undefined && canManageTemplate(template, actor)) ||
      (template === undefined && canManageTeammate(teammate, actor))
    ) {
      return;
    }
    throw new TeammateError(
      "forbidden",
      template?.source === "platform" || teammate.source === "platform"
        ? "平台模版只有平台管理员可以维护"
        : "个人模版只有归属人可以维护",
    );
  }

  private normalizedTeammateName(name: string): string {
    return name.trim().toLocaleLowerCase("zh-Hans-CN");
  }

  /** 历史实例通过 person 或 profile 别名表达同一 Agent 模版。 */
  private templateKeyOf(
    teammate: Pick<Teammate, "personaId" | "profileTemplateId">,
  ): string | undefined {
    return teammate.profileTemplateId ?? teammate.personaId;
  }

  private assertUniqueTemplateName(
    teammate: Pick<Teammate, "id" | "name" | "personaId" | "profileTemplateId">,
    templateId: string | undefined = this.templateKeyOf(teammate),
  ): void {
    if (templateId === undefined) return;
    const normalized = this.normalizedTeammateName(teammate.name);
    const conflict = this.values(this.options.tables.teammates).find(
      (item) =>
        item.id !== teammate.id &&
        item.state !== "archived" &&
        this.templateKeyOf(item) === templateId &&
        this.normalizedTeammateName(item.name) === normalized,
    );
    if (conflict !== undefined) {
      throw new TeammateError(
        "conflict",
        `同一 Agent 模版下已存在未归档 AI伙伴「${conflict.name}」，不能重名`,
      );
    }
  }

  private uniqueHistoricalName(base: string, usedNames: Set<string>): string {
    const normalizedBase = base.trim().slice(0, 114);
    for (let index = 2; ; index += 1) {
      const candidate = `${normalizedBase} (${index})`;
      if (!usedNames.has(candidate.toLocaleLowerCase("zh-Hans-CN"))) {
        return candidate;
      }
    }
  }

  /**
   * 自动导入数字员工时的重名处理：同一 Agent 模版下已经有同名实例时顺延序号，
   * 而不是抛错——否则一次同步失败会让整个 AI Teammate 列表接口不可用。
   */
  private deduplicatedImportName(
    base: string,
    personaId: string | undefined,
  ): string {
    if (personaId === undefined) return base;
    const used = new Set(
      this.values(this.options.tables.teammates)
        .filter(
          (item) =>
            item.state !== "archived" &&
            this.templateKeyOf(item) === personaId,
        )
        .map((item) => this.normalizedTeammateName(item.name)),
    );
    if (!used.has(this.normalizedTeammateName(base))) return base;
    return this.uniqueHistoricalName(base, used);
  }

  private async repairHistoricalDuplicateNames(): Promise<void> {
    const activeInstances = this.values(this.options.tables.teammates).filter(
      (teammate) =>
        teammate.state !== "archived" &&
        this.templateKeyOf(teammate) !== undefined,
    );
    const groups = new Map<string, Teammate[]>();
    for (const teammate of activeInstances) {
      const key = this.templateKeyOf(teammate) ?? "";
      const group = groups.get(key) ?? [];
      group.push(teammate);
      groups.set(key, group);
    }

    const actor: TeammateActor = {
      userId: "system",
      name: "系统",
      role: "admin",
    };
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.id.localeCompare(right.id)
          : left.createdAt.localeCompare(right.createdAt),
      );
      const usedNames = new Set(
        group.map((item) => this.normalizedTeammateName(item.name)),
      );
      const seenCounts = new Map<string, number>();
      for (const teammate of group) {
        const normalized = this.normalizedTeammateName(teammate.name);
        const seenCount = seenCounts.get(normalized) ?? 0;
        seenCounts.set(normalized, seenCount + 1);
        if (seenCount === 0) {
          continue;
        }
        const previousName = teammate.name;
        const nextName = this.uniqueHistoricalName(previousName, usedNames);
        const next = teammateSchema.parse({
          ...teammate,
          name: nextName,
          updatedAt: this.timestamp(),
        });
        usedNames.add(this.normalizedTeammateName(nextName));
        await this.options.tables.teammates.put(next.id, next);
        await this.record(
          next,
          actor,
          "updated",
          `修正历史重名：「${previousName}」 → 「${next.name}」`,
        );
      }
    }
  }

  private async record(
    teammate: Teammate,
    actor: TeammateActor,
    kind: TeammateEvent["kind"],
    message: string,
  ): Promise<TeammateEvent> {
    const event = teammateEventSchema.parse({
      id: `evt-${randomUUID()}`,
      teammateId: teammate.id,
      seq: this.options.tables.events.size,
      at: this.timestamp(),
      actorUserId: actor.userId,
      actorName: actor.name,
      kind,
      message,
    });
    await this.options.tables.events.put(event.id, event);
    return event;
  }

  templateOf(
    teammate: Pick<Teammate, "templateId" | "source">,
  ): TeammateTemplate | undefined {
    if (teammate.templateId === undefined) return undefined;
    return this.templates?.get(teammate.templateId);
  }

  /**
   * 运行态的有效定义。名称/描述/头像属于实例覆盖；岗位、人设、场景、目标、工具
   * 属于模版定义，模版缺失时只对历史数据回退实例字段。
   */
  effectiveDefinitionOf(teammate: Teammate): TeammateEffectiveDefinition {
    const template = this.templateOf(teammate);
    const instanceDescription = teammate.description.trim();
    return {
      name: teammate.name,
      description:
        instanceDescription === ""
          ? (template?.description ?? teammate.description)
          : teammate.description,
      avatar: teammate.avatar,
      role: template?.role ?? teammate.role,
      soul: template?.soul ?? teammate.soul,
      scenarios: template?.scenarios ?? teammate.scenarios,
      goals: template?.goals ?? teammate.goals,
      tools: template?.tools ?? [],
      source: template?.source ?? teammate.source,
      ...(template === undefined ? {} : { templateId: template.id }),
      ...(template?.personaAlias === undefined
        ? {}
        : { personaAlias: template.personaAlias }),
    };
  }

  viewOf(teammate: Teammate): TeammateInstanceView {
    const template = this.templateOf(teammate);
    const definition = this.effectiveDefinitionOf(teammate);
    const ownerName =
      teammate.ownerUserId === PLATFORM_OWNER_USER_ID
        ? PLATFORM_OWNER_NAME
        : (this.options.users?.().find((user) => user.id === teammate.ownerUserId)
            ?.name ?? teammate.ownerName);
    return {
      ...teammate,
      name: definition.name,
      description: definition.description,
      avatar: definition.avatar,
      role: definition.role,
      soul: definition.soul,
      scenarios: [...definition.scenarios],
      goals: [...definition.goals],
      source: definition.source,
      ownerName,
      templateName: template?.name ?? teammate.name,
      templateSource: definition.source,
    };
  }

  /**
   * 实例列表默认只返回"平台归属（团队共享）+ 自己创建"的实例；
   * 平台管理员需要看全量时，必须显式传 `scope: "all"`（对应独立的"全量视图"入口）。
   */
  listInstances(
    actor?: TeammateActor,
    options?: {
      readonly scope?: "mine" | "all" | undefined;
      /**
       * 每个实例的"最近使用"时间（ISO 字符串）。语义是真实使用：绑定到该实例的
       * Agent 运行、以该实例身份参与的会议、以及实例编辑时间取最大值；缺省时
       * 回退到实例自身的 `updatedAt`。
       */
      readonly lastUsedAt?: ReadonlyMap<string, string> | undefined;
    },
  ): readonly TeammateInstanceView[] {
    const includeAll =
      actor !== undefined &&
      actor.role === "admin" &&
      options?.scope === "all";
    const visible = this.values(this.options.tables.teammates).filter(
      (teammate) => {
        if (actor === undefined) return true;
        if (includeAll) return true;
        if (teammate.ownerUserId === actor.userId) return true;
        return (this.templateOf(teammate)?.source ?? teammate.source) ===
          "platform";
      },
    );
    const lastUsedAt = options?.lastUsedAt;
    return visible
      .map((teammate) => this.viewOf(teammate))
      .sort((left, right) => {
        // 运行态列表：先按实例状态（生效 > 草稿 > 暂停 > 失效 > 已归档），
        // 同一状态内按最近使用倒序，最后用来源与名称兜底保证稳定。
        const stateOrder = STATE_ORDER[left.state] - STATE_ORDER[right.state];
        if (stateOrder !== 0) return stateOrder;
        const leftUsedAt = lastUsedAt?.get(left.id) ?? left.updatedAt;
        const rightUsedAt = lastUsedAt?.get(right.id) ?? right.updatedAt;
        const recency = rightUsedAt.localeCompare(leftUsedAt);
        if (recency !== 0) return recency;
        if (left.templateSource !== right.templateSource) {
          return left.templateSource === "platform" ? -1 : 1;
        }
        return left.name.localeCompare(right.name, "zh-Hans-CN");
      });
  }

  list(): readonly Teammate[] {
    return this.values(this.options.tables.teammates).sort((left, right) => {
      const leftSource = this.templateOf(left)?.source ?? left.source;
      const rightSource = this.templateOf(right)?.source ?? right.source;
      if (leftSource !== rightSource) {
        return leftSource === "platform" ? -1 : 1;
      }
      const stateOrder = STATE_ORDER[left.state] - STATE_ORDER[right.state];
      if (stateOrder !== 0) return stateOrder;
      return left.name.localeCompare(right.name, "zh-Hans-CN");
    });
  }

  get(teammateId: string): Teammate {
    return this.requireTeammate(teammateId);
  }

  /**
   * 平台内置定义：按固定 id 幂等写入。已存在时原样返回（包括管理员归档后的状态），
   * 避免把平台的维护动作覆盖掉。用于「会议 Facilitator」这类开箱即用的数据种子。
   */
  ensureSeededPlatformTeammate(input: {
    id: string;
    name: string;
    role?: string;
    description?: string;
    soul?: string;
    scenarios?: readonly string[];
    goals?: readonly string[];
  }): Promise<Teammate> {
    return this.enqueue(async () => {
      const existing = this.options.tables.teammates.get(input.id);
      if (existing !== undefined) return existing;
      if (this.templates === undefined) {
        throw new TeammateError("conflict", "AI伙伴模版服务不可用");
      }
      const template = await this.templates.findOrCreate(
        { userId: "system", name: "系统", role: "admin" },
        {
          source: "platform",
          name: input.name,
          role: input.role,
          description: input.description,
          soul: input.soul,
          scenarios: input.scenarios,
          goals: input.goals,
          active: true,
        },
      );
      const timestamp = this.timestamp();
      const teammate = teammateSchema.parse({
        id: input.id,
        source: "platform",
        name: input.name.trim(),
        ownerUserId: PLATFORM_OWNER_USER_ID,
        ownerName: PLATFORM_OWNER_NAME,
        state: "active",
        version: "v1.0",
        templateId: template.id,
        createdBy: "platform",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.options.tables.teammates.put(teammate.id, teammate);
      return teammate;
    });
  }

  events(teammateId: string): readonly TeammateEvent[] {
    return this.values(this.options.tables.events)
      .filter((event) => event.teammateId === teammateId)
      .sort((left, right) => right.seq - left.seq);
  }

  create(actor: TeammateActor, input: CreateTeammateInput): Promise<Teammate> {
    return this.enqueue(async () => {
      if (actor.role === "guest") {
        throw new TeammateError("forbidden", "访客不能创建 AI伙伴");
      }
      const templates = this.templates;
      if (templates === undefined) {
        throw new TeammateError("conflict", "AI伙伴模版服务不可用");
      }
      let template: TeammateTemplate | undefined;
      if (input.templateId !== undefined) {
        template = templates.get(input.templateId);
        if (template === undefined) {
          throw new TeammateError("not_found", "AI伙伴模版不存在");
        }
      } else if (input.profileTemplateId !== undefined) {
        // 历史 Profile 资产在启动迁移后已是平台 AI Teammate 模版，这里只按 id 引用。
        template = templates.get(input.profileTemplateId);
        if (template === undefined) {
          throw new TeammateError("not_found", "AI伙伴模版不存在");
        }
      } else {
        const source = input.source ?? "personal";
        template = await templates.findOrCreate(actor, {
          source,
          name: input.name?.trim() || DEFAULT_NAME,
          role: input.role,
          active: true,
        });
      }
      if (template.state === "archived") {
        throw new TeammateError("invalid_input", "归档的模版不能创建新 AI伙伴");
      }
      if (
        template.source === "personal" &&
        template.ownerUserId !== actor.userId &&
        actor.role !== "admin"
      ) {
        throw new TeammateError(
          "forbidden",
          "个人模版只有归属人可以用于创建 AI伙伴",
        );
      }
      const timestamp = this.timestamp();
      const teammate = teammateSchema.parse({
        id: randomId(),
        source: template.source,
        name: input.name?.trim() || template.name,
        ownerUserId: actor.userId,
        ownerName: actor.name,
        // 新建实例默认生效：创建完即可被派发，无需再手动点一次「生效」。
        state: "active",
        version: "v0.1",
        templateId: template.id,
        ...(input.execution === undefined
          ? {}
          : { execution: input.execution }),
        ...(input.externalRuntimeId === undefined
          ? {}
          : { externalRuntimeId: input.externalRuntimeId }),
        createdBy: actor.userId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.options.tables.teammates.put(teammate.id, teammate);
      await this.record(
        teammate,
        actor,
        "created",
        `基于${template.source === "platform" ? "平台" : "个人"}模版「${template.name}」创建了 AI伙伴`,
      );
      return teammate;
    });
  }

  switchTemplate(
    actor: TeammateActor,
    input: { teammateId: string; templateId: string },
  ): Promise<Teammate> {
    const template = this.templates?.get(input.templateId);
    if (template === undefined) {
      throw new TeammateError("not_found", "AI伙伴模版不存在");
    }
    if (template.state === "archived") {
      throw new TeammateError("invalid_input", "归档的模版不可用");
    }
    if (
      template.source === "personal" &&
      template.ownerUserId !== actor.userId &&
      actor.role !== "admin"
    ) {
      throw new TeammateError("forbidden", "个人模版只有归属人可以应用");
    }
    return this.enqueue(async () => {
      const current = this.requireTeammate(input.teammateId);
      if (!canManageInstance(current, actor)) {
        throw new TeammateError(
          "forbidden",
          "只有 AI伙伴负责人或平台管理员可以切换模版",
        );
      }
      const next = teammateSchema.parse({
        ...current,
        templateId: template.id,
        updatedAt: this.timestamp(),
      });
      await this.options.tables.teammates.put(next.id, next);
      await this.record(
        next,
        actor,
        "updated",
        `将 AI伙伴切换到模版「${template.name}」`,
      );
      return next;
    });
  }

  update(actor: TeammateActor, input: UpdateTeammateInput): Promise<Teammate> {
    return this.enqueue(async () => {
      const current = this.requireTeammate(input.teammateId);
      const wasDraft = current.state === "draft";
      let template = this.templateOf(current);
      const definitionTouched =
        input.source !== undefined ||
        input.role !== undefined ||
        input.soul !== undefined ||
        input.scenarios !== undefined ||
        input.goals !== undefined;
      if (definitionTouched) {
        if (template === undefined) {
          this.assertCanManageDefinition(current, actor);
          if (this.templates === undefined) {
            throw new TeammateError("conflict", "AI伙伴模版服务不可用");
          }
          template = await this.templates.findOrCreate(actor, {
            source: input.source ?? current.source,
            name: current.name,
            role: current.role,
            description: current.description,
            soul: current.soul,
            scenarios: current.scenarios,
            goals: current.goals,
            active: current.state !== "archived",
          });
        } else {
          if (!canManageTemplate(template, actor)) {
            throw new TeammateError(
              "forbidden",
              "只有模版归属人或平台管理员可以编辑模版",
            );
          }
          if (input.source !== undefined && input.source !== template.source) {
            throw new TeammateError(
              "conflict",
              "模版归属不可直接修改，请重新创建对应归属的模版",
            );
          }
          if (this.templates === undefined) {
            throw new TeammateError("conflict", "AI伙伴模版服务不可用");
          }
          template = await this.templates.update(actor, {
            templateId: template.id,
            name: template.name,
            role: input.role?.trim() ?? template.role,
            description: input.description?.trim() ?? template.description,
            soul: input.soul ?? template.soul,
            scenarios: input.scenarios ?? template.scenarios,
            goals: input.goals === undefined ? [...template.goals] : [...input.goals],
            tools: [...template.tools],
          });
        }
      }
      if (!canManageInstance(current, actor)) {
        throw new TeammateError(
          "forbidden",
          "只有 AI伙伴负责人或平台管理员可以维护 AI伙伴资料",
        );
      }
      const teammate = teammateSchema.parse({
        ...current,
        ...(template === undefined ? {} : { templateId: template.id }),
        execution: input.execution ?? current.execution,
        externalRuntimeId: input.externalRuntimeId ?? current.externalRuntimeId,
        name: input.name.trim() || DEFAULT_NAME,
        description: definitionTouched
          ? template?.description ?? current.description
          : (input.description?.trim() ?? current.description),
        avatar: input.avatar ?? current.avatar,
        state: wasDraft ? "inactive" : current.state,
        updatedAt: this.timestamp(),
      });
      await this.options.tables.teammates.put(teammate.id, teammate);
      await this.record(
        teammate,
        actor,
        "updated",
        wasDraft
          ? "保存 AI伙伴资料并发布"
          : definitionTouched
            ? "更新了 AI伙伴资料和模版定义"
            : "更新了 AI伙伴资料",
      );
      return teammate;
    });
  }

  /**
   * 实例资料维护：只写名称与描述，用于运行态实例的轻量编辑入口。
   * 与 update() 的区别是不触碰人设内容，也不推进定义版本号。
   */
  updateInstanceProfile(
    actor: TeammateActor,
    input: UpdateInstanceProfileInput,
  ): Promise<Teammate> {
    return this.enqueue(async () => {
      const current = this.requireTeammate(input.teammateId);
      // 实例归创建人所有：来自平台模版的实例同样由 owner 维护资料。
      if (!canManageInstance(current, actor)) {
        throw new TeammateError(
          "forbidden",
          "只有 AI伙伴负责人或平台管理员可以维护 AI伙伴资料",
        );
      }
      const name = input.name.trim();
      if (name === "") {
        throw new TeammateError("invalid_input", "AI伙伴名称不能为空");
      }
      const description = input.description.trim();
      if (name === current.name && description === current.description) {
        return current;
      }
      const teammate = teammateSchema.parse({
        ...current,
        name,
        description,
        updatedAt: this.timestamp(),
      });
      if (current.templateId === undefined) {
        this.assertUniqueTemplateName(teammate);
      }
      await this.options.tables.teammates.put(teammate.id, teammate);
      await this.record(
        teammate,
        actor,
        "updated",
        name === current.name
          ? "更新了 AI伙伴描述"
          : `将 AI伙伴名称改为「${name}」`,
      );
      return teammate;
    });
  }

  /**
   * 归档实例：实例归创建人所有，所以实例 owner 也能归档自己的实例，
   * 不受模版平台归属（只有管理员能维护平台模版）的限制。
   */
  archiveInstanceRecord(
    actor: TeammateActor,
    teammateId: string,
  ): Promise<Teammate> {
    return this.enqueue(async () => {
      const current = this.requireTeammate(teammateId);
      if (!canManageInstance(current, actor)) {
        throw new TeammateError(
          "forbidden",
          "只有 AI伙伴负责人或平台管理员可以归档 AI伙伴",
        );
      }
      if (current.state === "archived") return current;
      const teammate = teammateSchema.parse({
        ...current,
        state: "archived",
        updatedAt: this.timestamp(),
      });
      await this.options.tables.teammates.put(teammate.id, teammate);
      await this.record(teammate, actor, "archived", "归档了该 AI伙伴");
      return teammate;
    });
  }

  changeState(
    actor: TeammateActor,
    input: ChangeTeammateStateInput,
  ): Promise<Teammate> {
    return this.enqueue(async () => {
      const current = this.requireTeammate(input.teammateId);
      if (!canManageInstance(current, actor)) {
        throw new TeammateError(
          "forbidden",
          "只有 AI伙伴负责人或平台管理员可以变更 AI伙伴状态",
        );
      }
      if (input.state === current.state) {
        throw new TeammateError("conflict", "AI伙伴已处于该状态");
      }
      if (!STATUS_TRANSITIONS[current.state].includes(input.state)) {
        throw new TeammateError(
          "conflict",
          `不允许从「${STATE_LABELS[current.state]}」变更为「${STATE_LABELS[input.state]}」`,
        );
      }
      const teammate = teammateSchema.parse({
        ...current,
        state: input.state,
        updatedAt: this.timestamp(),
      });
      await this.options.tables.teammates.put(teammate.id, teammate);
      await this.record(
        teammate,
        actor,
        input.state === "archived" ? "archived" : "state",
        current.state === "archived" && input.state === "inactive"
          ? "复原了该 AI伙伴"
          : `将实例设为「${STATE_LABELS[input.state]}」`,
      );
      return teammate;
    });
  }

  /** Runtime 停用/归档时，由受信任的跨域治理链路暂停所有仍生效的绑定实例。 */
  pauseForExternalRuntime(input: {
    readonly runtimeId: string;
    readonly runtimeName: string;
    readonly runtimeStatus: "disabled" | "archived";
    readonly actor: TeammateActor;
  }): Promise<readonly Teammate[]> {
    return this.enqueue(async () => {
      const affected = this.values(this.options.tables.teammates).filter(
        (teammate) =>
          teammate.state === "active" &&
          (teammate.execution ?? "builtin") === "external" &&
          teammate.externalRuntimeId === input.runtimeId,
      );
      const updated: Teammate[] = [];
      for (const current of affected) {
        const teammate = teammateSchema.parse({
          ...current,
          state: "paused",
          updatedAt: this.timestamp(),
        });
        await this.options.tables.teammates.put(teammate.id, teammate);
        await this.record(
          teammate,
          input.actor,
          "state",
          `外部 Agent 运行时「${input.runtimeName}」${input.runtimeStatus === "archived" ? "已归档" : "已停用"}，自动暂停该 AI伙伴`,
        );
        updated.push(teammate);
      }
      return updated;
    });
  }

  bindPrincipal(
    actor: TeammateActor,
    teammateId: string,
    principalId: string,
  ): Promise<Teammate> {
    return this.enqueue(async () => {
      const current = this.requireTeammate(teammateId);
      if (!canManageInstance(current, actor)) {
        throw new TeammateError(
          "forbidden",
          "只有 AI伙伴负责人或平台管理员可以绑定 Principal",
        );
      }
      if (current.principalId === principalId) return current;
      const teammate = teammateSchema.parse({
        ...current,
        principalId,
        updatedAt: this.timestamp(),
      });
      await this.options.tables.teammates.put(teammate.id, teammate);
      await this.record(
        teammate,
        actor,
        "updated",
        `绑定 Principal 执行身份 ${current.name}（${principalId}）`,
      );
      return teammate;
    });
  }

  /** 记录自动开通出来的运行时身份，后续派发复用同一个数字员工。 */
  bindEmployee(
    actor: TeammateActor,
    teammateId: string,
    employeeId: string,
  ): Promise<Teammate> {
    return this.enqueue(async () => {
      const current = this.requireTeammate(teammateId);
      if (!canManageInstance(current, actor)) {
        throw new TeammateError(
          "forbidden",
          "只有 AI伙伴负责人或平台管理员可以绑定执行身份",
        );
      }
      if (current.employeeId === employeeId) return current;
      const teammate = teammateSchema.parse({
        ...current,
        employeeId,
        updatedAt: this.timestamp(),
      });
      await this.options.tables.teammates.put(teammate.id, teammate);
      await this.record(
        teammate,
        actor,
        "updated",
        `绑定执行身份 ${current.name}（${employeeId}）`,
      );
      return teammate;
    });
  }

  /**
   * 把员工平台里已存在的数字员工等价成平台归属定义（系统同步，不做权限校验）。
   * 只在该 employeeId 还没有 teammate 记录时调用，保证幂等。
   */
  importFromEmployee(input: {
    readonly employeeId: string;
    readonly name: string;
    readonly role: string;
    readonly state: TeammateState;
    readonly soul?: string | undefined;
    readonly personaId?: string | undefined;
    readonly avatar?: string | undefined;
    /** 实例 owner（= 创建人）：由调用方按数字员工的负责人解析，解析不到时按平台托管处理。 */
    readonly ownerUserId?: string | undefined;
    readonly ownerName?: string | undefined;
  }): Promise<Teammate> {
    return this.enqueue(async () => {
      const existing = this.values(this.options.tables.teammates).find(
        (teammate) => teammate.employeeId === input.employeeId,
      );
      if (existing !== undefined) return existing;
      const name = this.deduplicatedImportName(input.name, input.personaId);
      if (this.templates === undefined) {
        throw new TeammateError("conflict", "AI伙伴模版服务不可用");
      }
      const template = await this.templates.findOrCreate(
        { userId: "system", name: "系统", role: "admin" },
        {
          source: "platform",
          name,
          role: input.role,
          soul: input.soul,
          active: input.state === "active",
          ...(input.personaId === undefined
            ? {}
            : { personaAlias: input.personaId }),
        },
      );
      const ownerUserId = input.ownerUserId?.trim() || PLATFORM_OWNER_USER_ID;
      const ownerName =
        ownerUserId === PLATFORM_OWNER_USER_ID
          ? PLATFORM_OWNER_NAME
          : input.ownerName?.trim() ||
            this.options.users?.().find((user) => user.id === ownerUserId)?.name ||
            ownerUserId;
      const teammate = teammateSchema.parse({
        id: randomId(),
        source: "platform",
        name,
        ownerUserId,
        ownerName,
        avatar: input.avatar ?? "",
        state: input.state,
        version: "v1.0",
        templateId: template.id,
        ...(input.personaId === undefined
          ? {}
          : { personaId: input.personaId }),
        employeeId: input.employeeId,
        createdBy: "system",
        createdAt: this.timestamp(),
        updatedAt: this.timestamp(),
      });
      await this.options.tables.teammates.put(teammate.id, teammate);
      await this.record(
        teammate,
        { userId: "system", name: "系统", role: "admin" },
        "created",
        `从员工平台身份 ${input.employeeId} 同步为平台归属 AI伙伴`,
      );
      return teammate;
    });
  }
}

export interface TeammateTemplateMigrationOptions {
  readonly teammates: KvTableLike<Teammate>;
  readonly templates: KvTableLike<TeammateTemplate>;
  readonly events?: KvTableLike<TeammateEvent>;
  readonly profileTemplates?: KvTableLike<ProfileTemplate>;
  readonly users?: readonly {
    readonly id: string;
    readonly name: string;
  }[];
}

function legacyGroupKey(teammate: Teammate): string {
  return teammate.profileTemplateId ?? teammate.personaId ?? `instance:${teammate.id}`;
}

function templateIdForGroup(groupKey: string, usedIds: Set<string>): string {
  const sanitized =
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(groupKey)
      ? groupKey
      : `tpl-${groupKey.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
  if (!usedIds.has(sanitized)) return sanitized;
  for (let index = 2; ; index += 1) {
    const candidate = `${sanitized}-${index}`;
    if (!usedIds.has(candidate)) return candidate;
  }
}

function legacyTemplateState(state: Teammate["state"]): TeammateTemplate["state"] {
  if (state === "active") return "active";
  return state === "archived" ? "archived" : "disabled";
}

/**
 * 一次性物化旧数据里的 Agent 定义。保持 domain version 不变，并用
 * 「实例是否已有 templateId」做数据幂等，不引入单独的迁移标记。
 */
export async function migrateTeammateTemplates(
  options: TeammateTemplateMigrationOptions,
): Promise<void> {
  const instances = [...options.teammates.entries()].map(([, value]) => value);
  const pending = instances.filter(
    (teammate) => teammate.templateId === undefined,
  );
  const ownerCorrections = instances.filter((teammate) => {
    if (teammate.ownerUserId === PLATFORM_OWNER_USER_ID) return false;
    const name = options.users?.find(
      (user) => user.id === teammate.ownerUserId,
    )?.name;
    return name !== undefined && name !== teammate.ownerName;
  });
  const profileAssets = [...(options.profileTemplates?.entries() ?? [])].map(
    ([, value]) => value,
  );
  const unmaterializedProfiles = profileAssets.filter(
    (profile) => options.templates.get(profile.id) === undefined,
  );
  if (
    pending.length === 0 &&
    ownerCorrections.length === 0 &&
    unmaterializedProfiles.length === 0
  ) {
    return;
  }

  const groups = new Map<string, Teammate[]>();
  for (const teammate of instances) {
    const key = legacyGroupKey(teammate);
    const group = groups.get(key) ?? [];
    group.push(teammate);
    groups.set(key, group);
  }
  const usedIds = new Set(
    [...options.templates.entries()].map(([key]) => key),
  );
  const templateIds = new Map<string, string>();
  const actor = { userId: "system", name: "系统", role: "admin" as const };

  for (const [groupKey, group] of groups) {
    const unresolved = group.filter(
      (teammate) => teammate.templateId === undefined,
    );
    if (unresolved.length === 0) continue;
    const representative = [...group].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )[0];
    if (representative === undefined) continue;

    const existing = options.templates.get(groupKey);
    const profileAsset = options.profileTemplates?.get(groupKey);
    const template =
      existing ??
      teammateTemplateSchema.parse(
        profileAsset === undefined
          ? {
              id: templateIdForGroup(groupKey, usedIds),
              source: representative.source,
              ...(representative.source === "personal"
                ? { ownerUserId: representative.ownerUserId }
                : {}),
              name: representative.name,
              role: representative.role,
              description: representative.description,
              soul: representative.soul,
              scenarios: representative.scenarios,
              goals: representative.goals,
              tools: [],
              state: legacyTemplateState(representative.state),
              version: representative.version,
              ...(representative.personaId === undefined
                ? {}
                : { personaAlias: representative.personaId }),
              createdBy: representative.createdBy,
              createdAt: representative.createdAt,
              updatedAt: representative.updatedAt,
            }
          : {
              id: profileAsset.id,
              source: "platform",
              name: profileAsset.name,
              role: profileAsset.role,
              description: profileAsset.description,
              soul: profileAsset.soul,
              scenarios: profileAsset.scenarios,
              goals: profileAsset.goals,
              tools: profileAsset.tools,
              state: profileAsset.state,
              version: profileAsset.version,
              createdBy: profileAsset.createdBy,
              createdAt: profileAsset.createdAt,
              updatedAt: profileAsset.updatedAt,
            },
      );
    usedIds.add(template.id);
    templateIds.set(groupKey, template.id);
    if (existing === undefined) {
      await options.templates.put(template.id, template);
    }
  }

  // 历史 Profile 资产统一物化成平台 AI Teammate 模版；即使没有实例引用，
  // 也要迁移，避免唯一模版列表漏掉可用定义。
  for (const profile of unmaterializedProfiles) {
    if (options.templates.get(profile.id) !== undefined) continue;
    const template = teammateTemplateSchema.parse({
      id: profile.id,
      source: "platform",
      name: profile.name,
      role: profile.role,
      description: profile.description,
      soul: profile.soul,
      scenarios: profile.scenarios,
      goals: profile.goals,
      tools: profile.tools,
      state: profile.state,
      version: profile.version,
      createdBy: profile.createdBy,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    });
    await options.templates.put(template.id, template);
  }

  const targets = new Map<string, Teammate>();
  for (const teammate of [...pending, ...ownerCorrections]) {
    targets.set(teammate.id, teammate);
  }
  for (const teammate of targets.values()) {
    const templateId =
      teammate.templateId ?? templateIds.get(legacyGroupKey(teammate));
    if (templateId === undefined) continue;
    if (
      teammate.templateId === templateId &&
      !ownerCorrections.some((item) => item.id === teammate.id)
    ) {
      continue;
    }
    const ownerUser = options.users?.find(
      (user) =>
        user.id === teammate.ownerUserId &&
        teammate.ownerUserId !== PLATFORM_OWNER_USER_ID,
    );
    const ownerName = ownerUser?.name ?? teammate.ownerName;
    const next = teammateSchema.parse({
      ...teammate,
      templateId,
      ...(ownerName === teammate.ownerName ? {} : { ownerName }),
      updatedAt: teammate.updatedAt,
    });
    await options.teammates.put(next.id, next);
    if (options.events !== undefined) {
      const event = teammateEventSchema.parse({
        id: `evt-${randomUUID()}`,
        teammateId: next.id,
        seq: options.events.size,
        at: new Date().toISOString(),
        actorUserId: actor.userId,
        actorName: actor.name,
        kind: "updated",
        message: "系统补齐了该 AI伙伴的 Agent 模版引用",
      });
      await options.events.put(event.id, event);
    }
  }
}
