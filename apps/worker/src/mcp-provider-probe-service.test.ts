import { describe, expect, it, vi } from "vitest";
import type { ClaimedMcpProviderProbeJob, PlatformRepositories } from "@pluginmax/database";
import {
  classifyMcpProbeError,
  HttpStreamableMcpProbeTransport,
  McpProbeFailure,
  type McpCredentialResolver,
  type McpProbeTransport,
  McpProviderProbeService,
} from "./mcp-provider-probe-service.js";

function claimedJob(
  overrides: Partial<ClaimedMcpProviderProbeJob> = {},
): ClaimedMcpProviderProbeJob {
  return {
    probeId: "00000000-0000-4000-8000-000000130001",
    providerId: "00000000-0000-4000-8000-000000130002",
    providerVersionId: "00000000-0000-4000-8000-000000130003",
    providerVersion: 1,
    providerRevision: 2,
    endpointUrl: "http://127.0.0.1/mcp",
    authKind: "bearer",
    credentialRef: "env://MCP_TEST_TOKEN",
    credentialHeaderName: null,
    requestTimeoutMs: 1_000,
    leaseToken: "00000000-0000-4000-8000-000000130004",
    ...overrides,
  };
}

describe("MCP Provider probe worker", () => {
  it("discovers tools over Streamable HTTP without exposing credentials", async () => {
    const requests: Array<{
      readonly method: unknown;
      readonly authorization: string | null;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          readonly method?: string;
        };
        const headers = new Headers(init?.headers);
        requests.push({
          method: body.method,
          authorization: headers.get("authorization"),
        });
        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "mcp-session-id": "session-1",
              },
            },
          );
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: {
              tools: [
                {
                  name: "orders.lookup",
                  description: "Lookup order",
                  inputSchema: {
                    type: "object",
                    properties: { orderId: { type: "string" } },
                  },
                },
              ],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
    const transport = new HttpStreamableMcpProbeTransport({
      allowHttp: true,
      allowPrivateHosts: true,
    });
    const tools = await transport.probe({
      endpointUrl: "http://127.0.0.1/mcp",
      authKind: "bearer",
      credential: "secret-token-value",
      credentialHeaderName: null,
      timeoutMs: 1_000,
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "orders.lookup",
      inputSchema: {
        type: "object",
      },
    });
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(
      requests.every(
        (request) => request.authorization === "Bearer secret-token-value",
      ),
    ).toBe(true);
    vi.unstubAllGlobals();
  });

  it("classifies timeout, DNS, TLS and HTTP authentication failures", async () => {
    expect(
      classifyMcpProbeError(
        Object.assign(new Error("aborted"), { name: "AbortError" }),
      ),
    ).toMatchObject({ category: "timeout", code: "probe_timeout" });
    expect(
      classifyMcpProbeError(
        Object.assign(new Error("lookup"), {
          cause: { code: "ENOTFOUND" },
        }),
      ),
    ).toMatchObject({ category: "dns", code: "dns_resolution_failed" });
    expect(
      classifyMcpProbeError(
        Object.assign(new Error("certificate"), {
          cause: { code: "CERT_HAS_EXPIRED" },
        }),
      ),
    ).toMatchObject({ category: "tls", code: "tls_validation_failed" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("denied", { status: 401 })),
    );
    const transport = new HttpStreamableMcpProbeTransport({
      allowHttp: true,
      allowPrivateHosts: true,
    });
    await expect(
      transport.probe({
        endpointUrl: "http://127.0.0.1/mcp",
        authKind: "bearer",
        credential: "secret-token-value",
        credentialHeaderName: null,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      category: "authentication",
      code: "http_401",
    });
    vi.unstubAllGlobals();
  });

  it("calls tools/call over Streamable HTTP and distinguishes timeout from cancellation", async () => {
    const requests: Array<{
      readonly method?: string;
      readonly params?: unknown;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          readonly method?: string;
          readonly params?: unknown;
        };
        requests.push(body);
        if (body.method === "initialize") {
          return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "mcp-session-id": "session-tool",
              },
            },
          );
        }
        if (body.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            result: {
              content: [{ type: "text", text: "result-body-secret" }],
              isError: false,
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
    const transport = new HttpStreamableMcpProbeTransport({
      allowHttp: true,
      allowPrivateHosts: true,
    });
    const result = await transport.callTool({
      endpointUrl: "http://127.0.0.1/mcp",
      authKind: "none",
      credential: null,
      credentialHeaderName: null,
      timeoutMs: 1_000,
      toolName: "orders.lookup",
      arguments: { orderId: "order-1" },
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "result-body-secret" }],
    });
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    expect(requests[2]?.params).toEqual({
      name: "orders.lookup",
      arguments: { orderId: "order-1" },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: URL | RequestInfo, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () =>
                reject(
                  Object.assign(new Error("aborted"), { name: "AbortError" }),
                ),
              { once: true },
            );
          }),
      ),
    );
    await expect(
      transport.callTool({
        endpointUrl: "http://127.0.0.1/mcp",
        authKind: "none",
        credential: null,
        credentialHeaderName: null,
        timeoutMs: 20,
        toolName: "orders.lookup",
        arguments: {},
      }),
    ).rejects.toMatchObject({
      category: "timeout",
      code: "tool_call_timeout",
    });
    const controller = new AbortController();
    const cancelled = transport.callTool(
      {
        endpointUrl: "http://127.0.0.1/mcp",
        authKind: "none",
        credential: null,
        credentialHeaderName: null,
        timeoutMs: 1_000,
        toolName: "orders.lookup",
        arguments: {},
      },
      controller.signal,
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({
      category: "cancelled",
      code: "tool_call_cancelled",
    });
    vi.unstubAllGlobals();
  });

  it("never logs resolved credential values or probe error messages", async () => {
    const secret = "resolved-secret-value";
    const logs: Array<{ readonly event: string; readonly data: unknown }> = [];
    const completeProbeJob = vi.fn(async () => true);
    const repositories = {
      featureFlags: {
        isEnabled: vi.fn(async () => true),
      },
      mcpProviders: {
        claimProbeJob: vi.fn(async () => claimedJob()),
        completeProbeJob,
      },
    } as unknown as PlatformRepositories;
    const credentials: McpCredentialResolver = {
      resolve: vi.fn(async () => secret),
    };
    const transport: McpProbeTransport = {
      probe: vi.fn(async () => {
        throw new McpProbeFailure(
          "authentication",
          "http_401",
          "MCP Provider rejected the credential",
        );
      }),
    };
    const service = new McpProviderProbeService(
      repositories,
      { owner: "worker-test", leaseSeconds: 30 },
      transport,
      credentials,
      (event, data) => {
        logs.push({ event, data });
      },
    );
    expect(await service.runOnce()).toBe(1);
    expect(completeProbeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        passed: false,
        errorCategory: "authentication",
        errorCode: "http_401",
      }),
    );
    const serialized = JSON.stringify({ logs, calls: completeProbeJob.mock.calls });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("env://MCP_TEST_TOKEN");
  });

  it("does not claim probe work while the feature flag is off", async () => {
    const claimProbeJob = vi.fn();
    const repositories = {
      featureFlags: {
        isEnabled: vi.fn(async () => false),
      },
      mcpProviders: {
        claimProbeJob,
        completeProbeJob: vi.fn(),
      },
    } as unknown as PlatformRepositories;
    const service = new McpProviderProbeService(
      repositories,
      { owner: "worker-test", leaseSeconds: 30 },
      { probe: vi.fn() },
      { resolve: vi.fn() },
    );
    expect(await service.runOnce()).toBe(0);
    expect(claimProbeJob).not.toHaveBeenCalled();
  });
});
