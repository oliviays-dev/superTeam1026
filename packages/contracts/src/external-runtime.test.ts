import { describe, expect, it } from "vitest";
import {
  adapterCapabilityProfile,
  canTransitionExternalRuntimeStatus,
  createExternalRuntimeInputSchema,
  declaredCapabilityProfile,
  emptyExternalRuntimeCapabilitySet,
  mergeCapabilityProfiles,
} from "./external-runtime.js";

const validRuntime = {
  name: "Codex CLI",
  provider: "codex",
  protocol: "codex-jsonl",
  command: "codex",
  managedArgs: [],
  customArgs: ["--model", "gpt-5"],
  supportedModels: ["gpt-5"],
  defaultModel: "gpt-5",
  contextWindowTokens: 128_000,
  supportedTools: ["structured_plan"],
  networkMode: "restricted",
  sandboxMode: "read-only",
  visibility: "owner",
} as const;

describe("external runtime contracts", () => {
  it("keeps command and argv as separate controlled values", () => {
    const parsed = createExternalRuntimeInputSchema.parse(validRuntime);
    expect(parsed.command).toBe("codex");
    expect(parsed.customArgs).toEqual(["--model", "gpt-5"]);
  });

  it.each([
    ["command plus arguments", { command: "codex --version" }],
    ["shell separator", { customArgs: ["--model", "gpt-5; rm -rf /"] }],
    ["pipe", { customArgs: ["--model", "gpt-5|cat"] }],
    ["redirect", { customArgs: [">/tmp/probe-output"] }],
    ["command substitution", { customArgs: ["$(whoami)"] }],
    ["backtick substitution", { customArgs: ["`whoami`"] }],
    ["shell executable", { command: "bash" }],
    ["parent traversal", { command: "../bin/codex" }],
  ])("rejects %s", (_label, patch) => {
    expect(() =>
      createExternalRuntimeInputSchema.parse({
        ...validRuntime,
        ...patch,
      }),
    ).toThrow();
  });

  it("requires provider-specific protocols and model membership", () => {
    expect(() =>
      createExternalRuntimeInputSchema.parse({
        ...validRuntime,
        protocol: "plain-text",
      }),
    ).toThrow(/codex runtimes require codex-jsonl/);
    expect(() =>
      createExternalRuntimeInputSchema.parse({
        ...validRuntime,
        defaultModel: "not-in-pool",
      }),
    ).toThrow(/defaultModel must belong/);
  });

  it("keeps WorkBuddy on the generic plain-text contract", () => {
    const parsed = createExternalRuntimeInputSchema.parse({
      ...validRuntime,
      provider: "workbuddy",
      protocol: "plain-text",
      command: "codebuddy",
      customArgs: ["--print", "--output-format", "text", "--max-turns", "8"],
      supportedModels: [],
      defaultModel: null,
      contextWindowTokens: null,
      supportedTools: ["read_file"],
      networkMode: "unknown",
      sandboxMode: "workspace-write",
    });
    expect(parsed.provider).toBe("workbuddy");
    expect(parsed.protocol).toBe("plain-text");

    const capability = adapterCapabilityProfile(parsed.protocol);
    expect(capability.structuredPlan).toBe("unsupported");
    expect(capability.structuredToolEvents).toBe("unsupported");
    expect(capability.structuredSubagent).toBe("unsupported");
    expect(capability.sessionResume).toBe("unknown");

    expect(() =>
      createExternalRuntimeInputSchema.parse({
        ...validRuntime,
        provider: "workbuddy",
        protocol: "codex-jsonl",
        command: "codebuddy",
      }),
    ).toThrow(/this provider requires plain-text/);
  });

  it("merges adapter, declaration, and probe capability sources", () => {
    const adapter = adapterCapabilityProfile("codex-jsonl");
    const declared = declaredCapabilityProfile(
      ["structured_plan", "read_file"],
      "restricted",
    );
    const probe = {
      ...emptyExternalRuntimeCapabilitySet("unknown"),
      structuredPlan: "supported",
      fileRead: "unsupported",
    } as const;
    const effective = mergeCapabilityProfiles({ adapter, declared, probe });
    expect(effective.structuredPlan).toBe("supported");
    expect(effective.fileRead).toBe("unsupported");
    expect(effective.browser).toBe("unsupported");
  });

  it("allows only the Batch 13A runtime state machine", () => {
    expect(canTransitionExternalRuntimeStatus("disabled", "active")).toBe(true);
    expect(canTransitionExternalRuntimeStatus("active", "disabled")).toBe(true);
    expect(canTransitionExternalRuntimeStatus("active", "archived")).toBe(true);
    expect(canTransitionExternalRuntimeStatus("archived", "disabled")).toBe(
      true,
    );
    expect(canTransitionExternalRuntimeStatus("archived", "active")).toBe(
      false,
    );
    expect(canTransitionExternalRuntimeStatus("disabled", "disabled")).toBe(
      false,
    );
  });
});
