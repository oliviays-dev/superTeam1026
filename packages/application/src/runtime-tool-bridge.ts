import type {
  RuntimeMcpToolRequest,
  RuntimeMcpToolResult,
} from "@pluginmax/contracts";

export interface RuntimeToolBridgeRequest {
  readonly runId: string;
  readonly runAttempt: number;
  readonly request: RuntimeMcpToolRequest;
  readonly signal?: AbortSignal | undefined;
  readonly assertLease: () => Promise<void>;
}

export interface RuntimeToolBridgePort {
  request(input: RuntimeToolBridgeRequest): Promise<RuntimeMcpToolResult>;
}
