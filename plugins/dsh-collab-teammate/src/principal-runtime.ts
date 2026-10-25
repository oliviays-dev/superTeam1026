import { randomUUID } from "node:crypto";
import { z } from "zod";

const idSchema = z.string().trim().min(1).max(180);
const displayNameSchema = z.string().trim().min(1).max(120);
const actionSchema = z.string().trim().min(1).max(160);
const isoTimeSchema = z.string().datetime({ precision: 3 });

export const principalRuntimeProfileSchema = z.object({
  id: idSchema,
  principalId: idSchema,
  workspaceId: idSchema,
  name: displayNameSchema,
  personaId: idSchema.optional(),
  agentProfileId: idSchema,
  execution: z.enum(["builtin", "external"]),
  allowedTools: z.array(actionSchema).max(100).default([]),
  status: z.enum(["active", "disabled"]).default("active"),
  createdByUserId: idSchema,
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});

export const principalActionTicketSchema = z.object({
  id: idSchema,
  principalId: idSchema,
  workspaceId: idSchema,
  runtimeProfileId: idSchema,
  contextType: z.enum(["task", "workflow", "meeting", "review"]),
  contextId: idSchema,
  requestedActions: z.array(actionSchema).max(100).default([]),
  allowedActions: z.array(actionSchema).max(100).default([]),
  deniedActions: z.array(actionSchema).max(100).default([]),
  resourceScopes: z.array(z.string().trim().min(1).max(500)).max(100),
  status: z.enum(["active", "revoked", "expired"]).default("active"),
  expiresAt: isoTimeSchema,
  issuedByUserId: idSchema,
  createdAt: isoTimeSchema,
  updatedAt: isoTimeSchema,
});

export type PrincipalRuntimeProfile = z.infer<
  typeof principalRuntimeProfileSchema
>;
export type PrincipalActionTicket = z.infer<
  typeof principalActionTicketSchema
>;

export interface PrincipalRuntimeTable<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  put(key: string, value: V): Promise<void>;
}

export interface PrincipalRuntimeTables {
  readonly profiles: PrincipalRuntimeTable<PrincipalRuntimeProfile>;
  readonly tickets: PrincipalRuntimeTable<PrincipalActionTicket>;
}

export interface PrincipalRuntimePrincipalServiceLike {
  get(principalId: string): {
    readonly id: string;
    readonly kind: "human" | "ai";
    readonly status: "active" | "suspended" | "archived";
  };
  syncPrincipal(input: {
    readonly kind: "ai";
    readonly subjectType: "teammate";
    readonly subjectId: string;
    readonly displayName: string;
    readonly source: "ai-companion";
  }): Promise<{
    readonly id: string;
    readonly kind: "human" | "ai";
    readonly status: "active" | "suspended" | "archived";
  }>;
  syncExclusiveGrant(input: {
    readonly principalId: string;
    readonly scopeType: "workspace";
    readonly scopeId: string;
    readonly role: string;
    readonly permissions: readonly string[];
    readonly grantedByPrincipalId?: string;
  }): Promise<unknown>;
  grants(principalId?: string): readonly {
    readonly principalId: string;
    readonly scopeType: "platform" | "workspace" | "project";
    readonly scopeId: string;
    readonly role: string;
    readonly permissions: readonly string[];
    readonly status: "active" | "revoked" | "expired";
    readonly expiresAt?: string;
  }[];
}

export class PrincipalRuntimeError extends Error {
  constructor(
    readonly code:
      "invalid_input" | "forbidden" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "PrincipalRuntimeError";
  }
}

export const principalRuntimeDomainSpec = {
  name: "collab_principal_runtime",
  version: 1,
  tables: {
    profiles: { valueSchema: principalRuntimeProfileSchema },
    action_tickets: { valueSchema: principalActionTicketSchema },
  },
} as const;

export class PrincipalRuntimeService {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly tables: PrincipalRuntimeTables,
    private readonly principals: () =>
      | PrincipalRuntimePrincipalServiceLike
      | undefined,
    options: {
      readonly now?: () => Date;
      readonly randomId?: () => string;
    } = {},
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

  private principal(principalId: string) {
    const service = this.principals();
    if (service === undefined) {
      throw new PrincipalRuntimeError(
        "not_found",
        "Principal service is unavailable",
      );
    }
    return service.get(principalId);
  }

  async ensureTeammatePrincipal(input: {
    readonly teammateId: string;
    readonly displayName: string;
  }): Promise<{ readonly id: string }> {
    const service = this.principals();
    if (service === undefined) {
      throw new PrincipalRuntimeError(
        "not_found",
        "Principal service is unavailable",
      );
    }
    return service.syncPrincipal({
      kind: "ai",
      subjectType: "teammate",
      subjectId: input.teammateId,
      displayName: input.displayName,
      source: "ai-companion",
    });
  }

  ensureProfile(input: {
    readonly principalId: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly personaId?: string;
    readonly agentProfileId: string;
    readonly execution: "builtin" | "external";
    readonly allowedTools: readonly string[];
    readonly createdByUserId: string;
    readonly grantedByPrincipalId?: string;
  }): Promise<PrincipalRuntimeProfile> {
    return this.enqueue(async () => {
      const principal = this.principal(input.principalId);
      if (principal.kind !== "ai") {
        throw new PrincipalRuntimeError(
          "invalid_input",
          "Principal runtime profiles require an AI Principal",
        );
      }
      if (principal.status === "archived") {
        throw new PrincipalRuntimeError(
          "conflict",
          "archived AI Principal cannot receive a runtime profile",
        );
      }
      const timestamp = this.timestamp();
      const existing = [...this.tables.profiles.entries()]
        .map(([, profile]) => profile)
        .find(
          (profile) =>
            profile.principalId === input.principalId &&
            profile.workspaceId === input.workspaceId,
        );
      for (const [key, profile] of this.tables.profiles.entries()) {
        if (
          profile.principalId === input.principalId &&
          profile.workspaceId === input.workspaceId &&
          profile.id !== existing?.id &&
          profile.status === "active"
        ) {
          await this.tables.profiles.put(
            key,
            principalRuntimeProfileSchema.parse({
              ...profile,
              status: "disabled",
              updatedAt: timestamp,
            }),
          );
        }
      }
      const record = principalRuntimeProfileSchema.parse({
        id: existing?.id ?? `prp-${this.randomId()}`,
        principalId: input.principalId,
        workspaceId: input.workspaceId,
        name: input.name,
        ...(input.personaId === undefined
          ? {}
          : { personaId: input.personaId }),
        agentProfileId: input.agentProfileId,
        execution: input.execution,
        allowedTools: [...input.allowedTools],
        status: "active",
        createdByUserId: existing?.createdByUserId ?? input.createdByUserId,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      await this.tables.profiles.put(record.id, record);
      const principals = this.principals();
      if (principals !== undefined) {
        await principals.syncExclusiveGrant({
          principalId: input.principalId,
          scopeType: "workspace",
          scopeId: input.workspaceId,
          role: "workspace-member",
          permissions: ["read", "write"],
          ...(input.grantedByPrincipalId === undefined
            ? {}
            : { grantedByPrincipalId: input.grantedByPrincipalId }),
        });
      }
      return record;
    });
  }

  profile(
    principalId: string,
    workspaceId: string,
  ): PrincipalRuntimeProfile | undefined {
    return [...this.tables.profiles.entries()]
      .map(([, profile]) => profile)
      .find(
        (profile) =>
          profile.principalId === principalId &&
          profile.workspaceId === workspaceId &&
          profile.status === "active",
      );
  }

  profiles(input: {
    readonly principalId?: string;
    readonly workspaceId?: string;
  } = {}): PrincipalRuntimeProfile[] {
    return [...this.tables.profiles.entries()]
      .map(([, profile]) => profile)
      .filter(
        (profile) =>
          (input.principalId === undefined ||
            profile.principalId === input.principalId) &&
          (input.workspaceId === undefined ||
            profile.workspaceId === input.workspaceId),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async setProfileStatus(
    profileId: string,
    status: PrincipalRuntimeProfile["status"],
  ): Promise<PrincipalRuntimeProfile> {
    for (const [key, profile] of this.tables.profiles.entries()) {
      if (profile.id !== profileId) continue;
      const next = principalRuntimeProfileSchema.parse({
        ...profile,
        status,
        updatedAt: this.timestamp(),
      });
      await this.tables.profiles.put(key, next);
      return next;
    }
    throw new PrincipalRuntimeError("not_found", "runtime profile not found");
  }

  issueTicket(input: {
    readonly principalId: string;
    readonly workspaceId: string;
    readonly contextType: PrincipalActionTicket["contextType"];
    readonly contextId: string;
    readonly requestedActions: readonly string[];
    readonly resourceScopes?: readonly string[];
    readonly durationMinutes?: number;
    readonly issuedByUserId: string;
  }): Promise<PrincipalActionTicket> {
    return this.enqueue(async () => {
      const principal = this.principal(input.principalId);
      if (principal.kind !== "ai" || principal.status !== "active") {
        throw new PrincipalRuntimeError(
          "forbidden",
          "active AI Principal is required for an action ticket",
        );
      }
      const profile = this.profile(input.principalId, input.workspaceId);
      if (profile === undefined) {
        throw new PrincipalRuntimeError(
          "forbidden",
          "active Principal Runtime Profile is required",
        );
      }
      const principals = this.principals();
      const grants =
        principals?.grants(input.principalId).filter(
          (grant) =>
            grant.status === "active" &&
            grant.scopeType === "workspace" &&
            grant.scopeId === input.workspaceId,
        ) ?? [];
      const allowed = new Set(grants.flatMap((grant) => grant.permissions));
      const requested = [...new Set(input.requestedActions)];
      const now = this.now();
      const timestamp = now.toISOString();
      const record = principalActionTicketSchema.parse({
        id: `pat-${this.randomId()}`,
        principalId: input.principalId,
        workspaceId: input.workspaceId,
        runtimeProfileId: profile.id,
        contextType: input.contextType,
        contextId: input.contextId,
        requestedActions: requested,
        allowedActions: requested.filter((action) => allowed.has(action)),
        deniedActions: requested.filter((action) => !allowed.has(action)),
        resourceScopes: [...(input.resourceScopes ?? [])],
        status: "active",
        expiresAt: new Date(
          now.getTime() + (input.durationMinutes ?? 30) * 60_000,
        ).toISOString(),
        issuedByUserId: input.issuedByUserId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      await this.tables.tickets.put(record.id, record);
      return record;
    });
  }

  async authorizeTicket(input: {
    readonly ticketId: string;
    readonly action: string;
    readonly resource?: string;
    readonly workspaceId: string;
    readonly contextType: PrincipalActionTicket["contextType"];
    readonly contextId: string;
  }): Promise<{ readonly principalId: string; readonly employeeId?: string }> {
    const ticket = this.tables.tickets.get(input.ticketId);
    if (
      ticket === undefined ||
      ticket.status !== "active" ||
      new Date(ticket.expiresAt).getTime() <= this.now().getTime() ||
      ticket.workspaceId !== input.workspaceId ||
      ticket.contextType !== input.contextType ||
      ticket.contextId !== input.contextId
    ) {
      throw new PrincipalRuntimeError(
        "forbidden",
        "ticket is revoked, expired, or outside this context",
      );
    }
    if (ticket.deniedActions.includes(input.action)) {
      throw new PrincipalRuntimeError(
        "forbidden",
        "action is explicitly denied",
      );
    }
    if (!ticket.allowedActions.includes(input.action)) {
      throw new PrincipalRuntimeError(
        "forbidden",
        "action is not allowed",
      );
    }
    if (
      input.resource !== undefined &&
      ticket.resourceScopes.length > 0 &&
      !ticket.resourceScopes.some(
        (scope) =>
          input.resource === scope || input.resource!.startsWith(`${scope}/`),
      )
    ) {
      throw new PrincipalRuntimeError(
        "forbidden",
        "resource is outside the ticket scope",
      );
    }
    return { principalId: ticket.principalId };
  }

  tickets(input: {
    readonly principalId?: string;
    readonly workspaceId?: string;
  } = {}): PrincipalActionTicket[] {
    return [...this.tables.tickets.entries()]
      .map(([, ticket]) => ticket)
      .filter(
        (ticket) =>
          (input.principalId === undefined ||
            ticket.principalId === input.principalId) &&
          (input.workspaceId === undefined ||
            ticket.workspaceId === input.workspaceId),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}
