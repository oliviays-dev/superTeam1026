import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type {
  McpProviderAuthKind,
  McpProviderErrorCategory,
  McpToolCallErrorCategory,
} from "@pluginmax/contracts";
import { MCP_PROVIDER_CONTROL_PLANE_FLAG } from "@pluginmax/contracts";
import type {
  ClaimedMcpProviderProbeJob,
  McpProviderDiscoveredToolInput,
  PlatformRepositories,
} from "@pluginmax/database";
import type { McpCredentialResolver } from "./secret-resolver.js";

export type { McpCredentialResolver } from "./secret-resolver.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOOL_SCHEMA_TOKENS = 240;

export interface McpProbeTransportInput {
  readonly endpointUrl: string;
  readonly authKind: McpProviderAuthKind;
  readonly credential: string | null;
  readonly credentialHeaderName: string | null;
  readonly timeoutMs: number;
}

export interface McpProbeTransport {
  probe(
    input: McpProbeTransportInput,
  ): Promise<readonly McpProviderDiscoveredToolInput[]>;
}

export interface McpToolCallTransportInput extends McpProbeTransportInput {
  readonly toolName: string;
  readonly arguments: Record<string, unknown>;
}

export interface McpToolCallTransport {
  callTool(
    input: McpToolCallTransportInput,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export class McpProbeFailure extends Error {
  constructor(
    readonly category: McpProviderErrorCategory,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpProbeFailure";
  }
}

export class McpToolCallFailure extends Error {
  constructor(
    readonly category: McpToolCallErrorCategory,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpToolCallFailure";
  }
}

export interface HttpStreamableMcpProbeTransportOptions {
  readonly allowHttp?: boolean;
  readonly allowPrivateHosts?: boolean;
  readonly allowedHosts?: readonly string[];
}

export class HttpStreamableMcpProbeTransport
  implements McpProbeTransport, McpToolCallTransport
{
  private readonly allowedHosts: ReadonlySet<string>;

  constructor(
    private readonly options: HttpStreamableMcpProbeTransportOptions = {},
  ) {
    this.allowedHosts = new Set(
      (options.allowedHosts ?? []).map((host) => host.trim().toLowerCase()),
    );
  }

  async probe(
    input: McpProbeTransportInput,
  ): Promise<readonly McpProviderDiscoveredToolInput[]> {
    const endpoint = await this.safeEndpoint(input.endpointUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    try {
      const headers: Record<string, string> = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      };
      if (input.authKind === "bearer" && input.credential !== null) {
        headers.authorization = `Bearer ${input.credential}`;
      } else if (
        input.authKind === "header" &&
        input.credential !== null &&
        input.credentialHeaderName !== null
      ) {
        headers[input.credentialHeaderName] = input.credential;
      }
      const initialized = await this.postJsonRpc(
        endpoint,
        headers,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "pluginmax", version: "0.1.0" },
          },
        },
        controller.signal,
      );
      const sessionId =
        initialized.response.headers.get("mcp-session-id") ?? null;
      const protocolVersion =
        initialized.response.headers.get("mcp-protocol-version") ??
        "2025-03-26";
      const sessionHeaders: Record<string, string> = {
        ...headers,
        "mcp-protocol-version": protocolVersion,
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
      };
      await this.postNotification(
        endpoint,
        sessionHeaders,
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        },
        controller.signal,
      );

      const tools: McpProviderDiscoveredToolInput[] = [];
      const toolNames = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 20; page += 1) {
        const result = await this.postJsonRpc(
          endpoint,
          sessionHeaders,
          {
            jsonrpc: "2.0",
            id: 2 + page,
            method: "tools/list",
            params: cursor === null ? {} : { cursor },
          },
          controller.signal,
        );
        const payload = jsonRpcResult(result.payload, "tools/list");
        const listed = payload.tools;
        if (!Array.isArray(listed)) {
          throw new McpProbeFailure(
            "schema",
            "tools_list_invalid",
            "MCP tools/list did not return a tools array",
          );
        }
        for (const rawTool of listed) {
          const tool = normalizeDiscoveredTool(rawTool);
          if (toolNames.has(tool.name)) {
            throw new McpProbeFailure(
              "schema",
              "duplicate_tool_name",
              "MCP tools/list returned duplicate tool names",
            );
          }
          toolNames.add(tool.name);
          tools.push(tool);
        }
        const nextCursor = payload.nextCursor;
        if (nextCursor === undefined || nextCursor === null) break;
        if (
          typeof nextCursor !== "string" ||
          nextCursor.length === 0 ||
          nextCursor.length > 500
        ) {
          throw new McpProbeFailure(
            "schema",
            "next_cursor_invalid",
            "MCP tools/list returned an invalid cursor",
          );
        }
        cursor = nextCursor;
      }
      return tools;
    } catch (error) {
      if (error instanceof McpProbeFailure) throw error;
      throw classifyMcpProbeError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async callTool(
    input: McpToolCallTransportInput,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const endpoint = await this.safeEndpoint(input.endpointUrl);
    const controller = new AbortController();
    const timeoutTimer = setTimeout(
      () =>
        controller.abort(
          new McpToolCallFailure(
            "timeout",
            "tool_call_timeout",
            "MCP Tool call timed out",
          ),
        ),
      input.timeoutMs,
    );
    const relayAbort = () => {
      controller.abort(
        new McpToolCallFailure(
          "cancelled",
          "tool_call_cancelled",
          "MCP Tool call was cancelled",
        ),
      );
    };
    if (signal?.aborted) {
      relayAbort();
    } else {
      signal?.addEventListener("abort", relayAbort, { once: true });
    }
    try {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      const headers: Record<string, string> = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      };
      if (input.authKind === "bearer" && input.credential !== null) {
        headers.authorization = `Bearer ${input.credential}`;
      } else if (
        input.authKind === "header" &&
        input.credential !== null &&
        input.credentialHeaderName !== null
      ) {
        headers[input.credentialHeaderName] = input.credential;
      }
      const initialized = await this.postJsonRpc(
        endpoint,
        headers,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "pluginmax", version: "0.1.0" },
          },
        },
        controller.signal,
      );
      const sessionId =
        initialized.response.headers.get("mcp-session-id") ?? null;
      const protocolVersion =
        initialized.response.headers.get("mcp-protocol-version") ??
        "2025-03-26";
      const sessionHeaders: Record<string, string> = {
        ...headers,
        "mcp-protocol-version": protocolVersion,
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
      };
      await this.postNotification(
        endpoint,
        sessionHeaders,
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        },
        controller.signal,
      );
      const called = await this.postJsonRpc(
        endpoint,
        sessionHeaders,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: input.toolName,
            arguments: input.arguments,
          },
        },
        controller.signal,
      );
      const result = jsonRpcResult(called.payload, "tools/call");
      if (result.isError === true) {
        throw new McpToolCallFailure(
          "tool",
          "tool_reported_error",
          "MCP Tool reported an execution error",
        );
      }
      return result;
    } catch (error) {
      const reason = controller.signal.reason;
      if (reason instanceof McpToolCallFailure) throw reason;
      if (error instanceof McpToolCallFailure) throw error;
      if (controller.signal.aborted) {
        throw new McpToolCallFailure(
          "unknown",
          "tool_call_aborted",
          "MCP Tool call was aborted",
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", relayAbort);
    }
  }

  private async safeEndpoint(value: string): Promise<URL> {
    let endpoint: URL;
    try {
      endpoint = new URL(value);
    } catch {
      throw new McpProbeFailure(
        "protocol",
        "endpoint_invalid",
        "MCP Provider endpoint is not a valid URL",
      );
    }
    if (
      endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && this.options.allowHttp === true)
    ) {
      throw new McpProbeFailure(
        "protocol",
        "endpoint_scheme_denied",
        "MCP Provider endpoint must use HTTPS",
      );
    }
    if (endpoint.username !== "" || endpoint.password !== "") {
      throw new McpProbeFailure(
        "protocol",
        "endpoint_credentials_denied",
        "MCP Provider endpoint must not embed credentials",
      );
    }
    const hostname = endpoint.hostname.toLowerCase();
    if (
      this.allowedHosts.size > 0 &&
      !this.allowedHosts.has(hostname) &&
      !this.allowedHosts.has(endpoint.host.toLowerCase())
    ) {
      throw new McpProbeFailure(
        "authorization",
        "endpoint_host_denied",
        "MCP Provider endpoint host is not allowlisted",
      );
    }
    if (this.options.allowPrivateHosts !== true) {
      const addresses = isIP(hostname)
        ? [{ address: hostname }]
        : await lookup(hostname, { all: true, verbatim: true });
      if (
        addresses.length === 0 ||
        addresses.some((address) => isPrivateAddress(address.address))
      ) {
        throw new McpProbeFailure(
          "network",
          "endpoint_private_address_denied",
          "MCP Provider endpoint resolves to a private address",
        );
      }
    }
    return endpoint;
  }

  private async postNotification(
    endpoint: URL,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    requireHttpSuccess(response);
    await readBoundedText(response);
  }

  private async postJsonRpc(
    endpoint: URL,
    headers: Record<string, string>,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ readonly response: Response; readonly payload: unknown }> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    requireHttpSuccess(response);
    const text = await readBoundedText(response);
    const contentType = response.headers.get("content-type") ?? "";
    return {
      response,
      payload: parseJsonRpcPayload(text, contentType),
    };
  }
}

export interface McpProviderProbeServiceOptions {
  readonly owner: string;
  readonly leaseSeconds: number;
}

export class McpProviderProbeService {
  constructor(
    private readonly repositories: PlatformRepositories,
    private readonly options: McpProviderProbeServiceOptions,
    private readonly transport: McpProbeTransport,
    private readonly credentials: McpCredentialResolver,
    private readonly log?: (
      event: string,
      data?: Record<string, unknown>,
    ) => void,
  ) {}

  async runOnce(): Promise<number> {
    if (
      !(await this.repositories.featureFlags.isEnabled(
        MCP_PROVIDER_CONTROL_PLANE_FLAG,
      ))
    ) {
      return 0;
    }
    const job = await this.repositories.mcpProviders.claimProbeJob(
      this.options.owner,
      this.options.leaseSeconds,
    );
    if (job === undefined) return 0;
    this.log?.("mcp_provider_probe.started", {
      probeId: job.probeId,
      providerId: job.providerId,
      providerVersion: job.providerVersion,
    });
    const startedAt = Date.now();
    try {
      const credential = await this.resolveCredential(job);
      const tools = await this.transport.probe({
        endpointUrl: job.endpointUrl,
        authKind: job.authKind,
        credential,
        credentialHeaderName: job.credentialHeaderName,
        timeoutMs: job.requestTimeoutMs,
      });
      const completed = await this.repositories.mcpProviders.completeProbeJob({
        probeId: job.probeId,
        owner: this.options.owner,
        leaseToken: job.leaseToken,
        passed: true,
        durationMs: Date.now() - startedAt,
        tools,
      });
      this.log?.(
        completed
          ? "mcp_provider_probe.passed"
          : "mcp_provider_probe.claim_lost",
        {
          probeId: job.probeId,
          providerId: job.providerId,
          toolCount: tools.length,
          durationMs: Date.now() - startedAt,
        },
      );
      return 1;
    } catch (error) {
      const failure = classifyMcpProbeError(error);
      const completed = await this.repositories.mcpProviders.completeProbeJob({
        probeId: job.probeId,
        owner: this.options.owner,
        leaseToken: job.leaseToken,
        passed: false,
        durationMs: Date.now() - startedAt,
        tools: [],
        errorCategory: failure.category,
        errorCode: failure.code,
        errorMessage: failure.message,
      });
      this.log?.(
        completed
          ? "mcp_provider_probe.failed"
          : "mcp_provider_probe.claim_lost",
        {
          probeId: job.probeId,
          providerId: job.providerId,
          category: failure.category,
          code: failure.code,
          durationMs: Date.now() - startedAt,
        },
      );
      return 1;
    }
  }

  private async resolveCredential(
    job: ClaimedMcpProviderProbeJob,
  ): Promise<string | null> {
    if (job.authKind === "none") return null;
    if (job.credentialRef === null) {
      throw new McpProbeFailure(
        "credential",
        "credential_reference_missing",
        "MCP Provider credential reference is missing",
      );
    }
    const value = await this.credentials.resolve(job.credentialRef);
    if (value === undefined || value === "") {
      throw new McpProbeFailure(
        "credential",
        "credential_unavailable",
        "MCP Provider credential reference could not be resolved",
      );
    }
    return value;
  }
}

export function classifyMcpProbeError(error: unknown): McpProbeFailure {
  if (error instanceof McpProbeFailure) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { readonly name?: unknown }).name === "AbortError"
  ) {
    return new McpProbeFailure(
      "timeout",
      "probe_timeout",
      "MCP Provider probe timed out",
    );
  }
  const code =
    typeof error === "object" && error !== null && "cause" in error
      ? networkErrorCode((error as { readonly cause?: unknown }).cause)
      : undefined;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new McpProbeFailure(
      "dns",
      "dns_resolution_failed",
      "MCP Provider host could not be resolved",
    );
  }
  if (
    code?.startsWith("CERT_") === true ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
  ) {
    return new McpProbeFailure(
      "tls",
      "tls_validation_failed",
      "MCP Provider TLS validation failed",
    );
  }
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "ETIMEDOUT"
  ) {
    return new McpProbeFailure(
      "network",
      "network_unreachable",
      "MCP Provider network connection failed",
    );
  }
  return new McpProbeFailure(
    "unknown",
    "probe_failed",
    "MCP Provider probe failed",
  );
}

function requireHttpSuccess(response: Response): void {
  if (response.status === 401) {
    throw new McpProbeFailure(
      "authentication",
      "http_401",
      "MCP Provider rejected the credential",
    );
  }
  if (response.status === 403) {
    throw new McpProbeFailure(
      "authorization",
      "http_403",
      "MCP Provider denied access",
    );
  }
  if (!response.ok) {
    throw new McpProbeFailure(
      "http_status",
      `http_${response.status}`,
      `MCP Provider returned HTTP ${response.status}`,
    );
  }
}

async function readBoundedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new McpProbeFailure(
      "protocol",
      "response_too_large",
      "MCP Provider response exceeded the size limit",
    );
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new McpProbeFailure(
        "protocol",
        "response_too_large",
        "MCP Provider response exceeded the size limit",
      );
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

function parseJsonRpcPayload(text: string, contentType: string): unknown {
  const candidate =
    contentType.includes("text/event-stream") ||
    text.trimStart().startsWith("event:") ||
    text.trimStart().startsWith("data:")
      ? parseServerSentEvents(text)
      : parseJson(text);
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  ) {
    throw new McpProbeFailure(
      "protocol",
      "json_rpc_response_invalid",
      "MCP Provider returned an invalid JSON-RPC response",
    );
  }
  return candidate;
}

function parseServerSentEvents(text: string): unknown {
  const payloads: unknown[] = [];
  let dataLines: string[] = [];
  const flush = () => {
    if (dataLines.length === 0) return;
    payloads.push(parseJson(dataLines.join("\n")));
    dataLines = [];
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flush();
  if (payloads.length === 0) {
    throw new McpProbeFailure(
      "protocol",
      "sse_payload_missing",
      "MCP Provider event stream did not contain JSON-RPC data",
    );
  }
  return payloads.at(-1);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new McpProbeFailure(
      "protocol",
      "json_invalid",
      "MCP Provider returned invalid JSON",
    );
  }
}

function jsonRpcResult(payload: unknown, method: string): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new McpProbeFailure(
      "protocol",
      "json_rpc_response_invalid",
      "MCP Provider returned an invalid JSON-RPC response",
    );
  }
  const record = payload as Record<string, unknown>;
  if (record.error !== undefined) {
    const code =
      typeof record.error === "object" &&
      record.error !== null &&
      "code" in record.error &&
      typeof (record.error as { readonly code?: unknown }).code === "number"
        ? (record.error as { readonly code: number }).code
        : "unknown";
    throw new McpProbeFailure(
      "protocol",
      `json_rpc_error_${code}`,
      `MCP ${method} returned a JSON-RPC error`,
    );
  }
  if (
    typeof record.result !== "object" ||
    record.result === null ||
    Array.isArray(record.result)
  ) {
    throw new McpProbeFailure(
      "protocol",
      "json_rpc_result_invalid",
      `MCP ${method} returned an invalid result`,
    );
  }
  return record.result as Record<string, unknown>;
}

function normalizeDiscoveredTool(
  value: unknown,
): McpProviderDiscoveredToolInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new McpProbeFailure(
      "schema",
      "tool_invalid",
      "MCP Provider returned an invalid tool definition",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.name !== "string" ||
    record.name.trim() === "" ||
    record.name.length > 240
  ) {
    throw new McpProbeFailure(
      "schema",
      "tool_name_invalid",
      "MCP Provider returned an invalid tool name",
    );
  }
  if (
    typeof record.inputSchema !== "object" ||
    record.inputSchema === null ||
    Array.isArray(record.inputSchema)
  ) {
    throw new McpProbeFailure(
      "schema",
      "tool_input_schema_invalid",
      "MCP Provider returned an invalid tool input schema",
    );
  }
  if (
    record.outputSchema !== undefined &&
    record.outputSchema !== null &&
    (typeof record.outputSchema !== "object" ||
      Array.isArray(record.outputSchema))
  ) {
    throw new McpProbeFailure(
      "schema",
      "tool_output_schema_invalid",
      "MCP Provider returned an invalid tool output schema",
    );
  }
  const inputSchema = record.inputSchema as Record<string, unknown>;
  const outputSchema =
    record.outputSchema === undefined || record.outputSchema === null
      ? null
      : (record.outputSchema as Record<string, unknown>);
  if (
    countJsonTokens(inputSchema, 0, MAX_TOOL_SCHEMA_TOKENS) >
    MAX_TOOL_SCHEMA_TOKENS
  ) {
    throw new McpProbeFailure(
      "schema",
      "tool_schema_too_complex",
      "MCP Provider tool schema exceeded the complexity limit",
    );
  }
  const description =
    typeof record.description === "string"
      ? record.description.slice(0, 4_000)
      : "";
  return {
    name: record.name,
    description,
    inputSchema,
    outputSchema,
    schemaDigest: createHash("sha256")
      .update(stableJson({ inputSchema, outputSchema }))
      .digest("hex"),
  };
}

function countJsonTokens(value: unknown, count: number, limit: number): number {
  if (count > limit) return count;
  if (typeof value === "string") {
    return count + Buffer.byteLength(value, "utf8");
  }
  if (Array.isArray(value)) {
    return value.reduce(
      (next, item) => countJsonTokens(item, next, limit),
      count + 1,
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce(
      (next, [key, item]) =>
        countJsonTokens(item, next + Buffer.byteLength(key, "utf8"), limit),
      count + 1,
    );
  }
  return count + 1;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function networkErrorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) {
    return undefined;
  }
  const code = (value as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isPrivateAddress(value: string): boolean {
  if (value.includes(":")) {
    const normalized = value.toLowerCase();
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    );
  }
  const parts = value.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true;
  }
  const [first, second] = parts;
  return (
    first === 10 ||
    first === 127 ||
    first === 0 ||
    (first === 169 && second === 254) ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}
