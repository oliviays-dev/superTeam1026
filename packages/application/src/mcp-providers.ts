import {
  MCP_PROVIDER_CONTROL_PLANE_FLAG,
  type CreateMcpProviderInput,
  type CreateMcpProviderVersionInput,
  type McpProvider,
  type McpProviderDetail,
  type McpProviderHealthCheckInput,
  type McpProviderHealthCheckResult,
  type McpProviderProbeInput,
  type McpProviderProbeRequestResult,
  type McpProviderRevisionInput,
  type McpProviderToolList,
} from "@pluginmax/contracts";
import type {
  McpProviderRepository,
  McpProviderRepositoryError,
  PlatformRepositories,
} from "@pluginmax/database";

export interface McpProviderActor {
  readonly principalId: string;
  readonly platformAdministrator: boolean;
}

export type McpProviderApplicationErrorCode =
  | "mcp_provider_control_plane_disabled"
  | "mcp_provider_admin_required";

export class McpProviderApplicationError extends Error {
  constructor(
    readonly code: McpProviderApplicationErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "McpProviderApplicationError";
  }
}

export class McpProviderApplicationService {
  constructor(
    private readonly providers: McpProviderRepository,
    private readonly featureFlags: PlatformRepositories["featureFlags"],
  ) {}

  async list(actor: McpProviderActor): Promise<McpProvider[]> {
    await this.requireEnabled();
    return this.providers.listProviders(actor);
  }

  async get(
    actor: McpProviderActor,
    providerId: string,
  ): Promise<McpProviderDetail> {
    await this.requireEnabled();
    return this.providers.getProvider(actor, providerId);
  }

  async create(
    actor: McpProviderActor,
    input: CreateMcpProviderInput,
  ): Promise<McpProviderDetail> {
    await this.requireEnabled();
    return this.providers.createProvider(actor, input);
  }

  async createVersion(
    actor: McpProviderActor,
    providerId: string,
    input: CreateMcpProviderVersionInput,
  ): Promise<McpProviderDetail> {
    await this.requireEnabled();
    return this.providers.createVersion(actor, providerId, input);
  }

  async activate(
    actor: McpProviderActor,
    providerId: string,
    input: McpProviderRevisionInput,
  ): Promise<McpProviderDetail> {
    await this.requireEnabled();
    return this.providers.activateProvider(actor, providerId, input);
  }

  async disable(
    actor: McpProviderActor,
    providerId: string,
    input: McpProviderRevisionInput,
  ): Promise<McpProviderDetail> {
    await this.requireEnabled();
    return this.providers.disableProvider(actor, providerId, input);
  }

  async archive(
    actor: McpProviderActor,
    providerId: string,
    input: McpProviderRevisionInput,
  ): Promise<McpProviderDetail> {
    await this.requireEnabled();
    return this.providers.archiveProvider(actor, providerId, input);
  }

  async requestProbe(
    actor: McpProviderActor,
    providerId: string,
    input: McpProviderProbeInput,
  ): Promise<McpProviderProbeRequestResult> {
    await this.requireEnabled();
    return this.providers.requestProbe(
      actor,
      providerId,
      input,
      actor.platformAdministrator ? "admin" : "owner",
    );
  }

  async requestPlatformHealthCheck(
    actor: McpProviderActor,
    input: McpProviderHealthCheckInput,
  ): Promise<McpProviderHealthCheckResult> {
    await this.requireEnabled();
    if (!actor.platformAdministrator) {
      throw new McpProviderApplicationError(
        "mcp_provider_admin_required",
        "Platform administrator permission is required",
        403,
      );
    }
    return this.providers.requestPlatformHealthCheck(actor, input);
  }

  async listTools(
    actor: McpProviderActor,
    providerId: string,
  ): Promise<McpProviderToolList> {
    await this.requireEnabled();
    return this.providers.listTools(actor, providerId);
  }

  private async requireEnabled(): Promise<void> {
    if (
      !(await this.featureFlags.isEnabled(MCP_PROVIDER_CONTROL_PLANE_FLAG))
    ) {
      throw new McpProviderApplicationError(
        "mcp_provider_control_plane_disabled",
        "MCP Provider control plane is disabled",
        503,
      );
    }
  }
}

export function isMcpProviderRepositoryError(
  error: unknown,
): error is McpProviderRepositoryError {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { readonly name?: unknown }).name ===
      "McpProviderRepositoryError"
  );
}
