import {
  MCP_RUNTIME_TOOL_BRIDGE_FLAG,
  MCP_TOOL_INVOCATION_FLAG,
  type McpToolCallReconcileResult,
  type RuntimeToolRequestDetail,
  type RuntimeToolRequestReconcileResult,
  type RuntimeToolRequestRetentionResult,
  type RuntimeToolRequestSummary,
} from "@pluginmax/contracts";
import type {
  McpToolCallRepository,
  PlatformRepositories,
  RuntimeToolRequestRepository,
} from "@pluginmax/database";

export type McpToolCallApplicationErrorCode =
  | "mcp_tool_invocation_disabled"
  | "mcp_tool_admin_required"
  | "mcp_runtime_tool_bridge_disabled"
  | "mcp_runtime_tool_admin_required";

export class McpToolCallApplicationError extends Error {
  constructor(
    readonly code: McpToolCallApplicationErrorCode,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "McpToolCallApplicationError";
  }
}

export class McpToolCallApplicationService {
  constructor(
    private readonly calls: McpToolCallRepository,
    private readonly runtimeRequests: RuntimeToolRequestRepository,
    private readonly featureFlags: PlatformRepositories["featureFlags"],
  ) {}

  async listForRun(runId: string) {
    await this.requireEnabled();
    return this.calls.listByRun(runId);
  }

  async reconcilePlatform(input: {
    readonly actor: {
      readonly principalId: string;
      readonly platformAdministrator: boolean;
    };
    readonly limit?: number;
  }): Promise<McpToolCallReconcileResult> {
    await this.requireEnabled();
    if (!input.actor.platformAdministrator) {
      throw new McpToolCallApplicationError(
        "mcp_tool_admin_required",
        "Platform administrator permission is required",
        403,
      );
    }
    return {
      reconciled: await this.calls.reconcileExpired(input.limit ?? 50),
    };
  }

  async listRuntimeToolRequestsForRun(
    runId: string,
  ): Promise<RuntimeToolRequestDetail[]> {
    await this.requireRuntimeBridgeEnabled();
    return this.runtimeRequests.listByRun(runId);
  }

  async runtimeToolRequestSummary(input: {
    readonly actor: {
      readonly principalId: string;
      readonly platformAdministrator: boolean;
    };
  }): Promise<RuntimeToolRequestSummary> {
    await this.requireRuntimeBridgeEnabled();
    this.requirePlatformAdministrator(input.actor);
    return this.runtimeRequests.summary();
  }

  async reconcileRuntimeToolRequestsPlatform(input: {
    readonly actor: {
      readonly principalId: string;
      readonly platformAdministrator: boolean;
    };
    readonly limit?: number;
  }): Promise<RuntimeToolRequestReconcileResult> {
    await this.requireRuntimeBridgeEnabled();
    this.requirePlatformAdministrator(input.actor);
    return {
      reconciled: await this.runtimeRequests.reconcileExpired(
        input.limit ?? 50,
      ),
    };
  }

  async runtimeToolRequestRetentionPreview(input: {
    readonly actor: {
      readonly principalId: string;
      readonly platformAdministrator: boolean;
    };
    readonly retentionDays: number;
  }): Promise<RuntimeToolRequestRetentionResult> {
    await this.requireRuntimeBridgeEnabled();
    this.requirePlatformAdministrator(input.actor);
    return this.runtimeRequests.retentionPreview({
      retentionDays: input.retentionDays,
    });
  }

  private async requireEnabled(): Promise<void> {
    if (
      !(await this.featureFlags.isEnabled(MCP_TOOL_INVOCATION_FLAG))
    ) {
      throw new McpToolCallApplicationError(
        "mcp_tool_invocation_disabled",
        "MCP Tool invocation is disabled",
        503,
      );
    }
  }

  private async requireRuntimeBridgeEnabled(): Promise<void> {
    if (
      !(await this.featureFlags.isEnabled(MCP_RUNTIME_TOOL_BRIDGE_FLAG))
    ) {
      throw new McpToolCallApplicationError(
        "mcp_runtime_tool_bridge_disabled",
        "The Agent Runtime MCP Tool Request bridge is disabled",
        503,
      );
    }
  }

  private requirePlatformAdministrator(actor: {
    readonly principalId: string;
    readonly platformAdministrator: boolean;
  }): void {
    if (!actor.platformAdministrator) {
      throw new McpToolCallApplicationError(
        "mcp_runtime_tool_admin_required",
        "Platform administrator permission is required",
        403,
      );
    }
  }
}
