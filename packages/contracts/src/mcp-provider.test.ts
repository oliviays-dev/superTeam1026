import { describe, expect, it } from "vitest";
import {
  MCP_PROVIDER_CONTROL_PLANE_FLAG,
  createMcpProviderInputSchema,
  mcpProviderSchema,
  mcpProviderToolSchema,
} from "./mcp-provider.js";

describe("MCP Provider contracts", () => {
  it("requires credential references only for authenticated providers", () => {
    expect(() =>
      createMcpProviderInputSchema.parse({
        providerKey: "m13a.contract",
        name: "M13a",
        transport: "streamable-http",
        endpointUrl: "https://example.test/mcp",
        authKind: "bearer",
      }),
    ).toThrow(/credentialRef/);
    expect(
      createMcpProviderInputSchema.parse({
        providerKey: "m13a.contract",
        name: "M13a",
        transport: "streamable-http",
        endpointUrl: "https://example.test/mcp",
        authKind: "header",
        credentialRef: "env://MCP_TOKEN",
        credentialHeaderName: "X-API-Key",
      }),
    ).toMatchObject({
      authKind: "header",
      credentialRef: "env://MCP_TOKEN",
      requestTimeoutMs: 10_000,
    });
  });

  it("rejects embedded endpoint credentials and non-HTTP transports", () => {
    expect(() =>
      createMcpProviderInputSchema.parse({
        providerKey: "m13a.contract",
        name: "M13a",
        transport: "streamable-http",
        endpointUrl: "https://user:password@example.test/mcp",
        authKind: "none",
      }),
    ).toThrow(/must not embed credentials/);
    expect(() =>
      createMcpProviderInputSchema.parse({
        providerKey: "m13a.contract",
        name: "M13a",
        transport: "streamable-http",
        endpointUrl: "file:///tmp/mcp",
        authKind: "none",
      }),
    ).toThrow(/http or https/);
  });

  it("does not expose credential references in public provider or tool shapes", () => {
    expect(MCP_PROVIDER_CONTROL_PLANE_FLAG).toBe(
      "mcp.provider_control_plane",
    );
    const providerShape = mcpProviderSchema.shape;
    expect("credentialRef" in providerShape).toBe(false);
    expect("endpointUrl" in providerShape).toBe(false);
    expect(
      mcpProviderToolSchema.parse({
        toolKey: "a".repeat(64),
        name: "orders.lookup",
        description: "",
        inputSchema: { type: "object" },
        outputSchema: null,
        schemaDigest: "a".repeat(64),
        schemaRef: "mcp://provider/version/orders.lookup",
        invocationEnabled: false,
        grantsExecution: false,
      }),
    ).toMatchObject({
      invocationEnabled: false,
      grantsExecution: false,
    });
  });
});
