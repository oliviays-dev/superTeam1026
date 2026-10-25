import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { sendJson } from "@pluginmax/shared";

export const name = "dsh-pluginmax-canary";
export const inject = ["storageDomain", "commands", "tools", "webServer"];

const canaryCheck = z.enum([
  "storage-domain",
  "command",
  "tool",
  "http-route",
  "client-bundle",
]);
const canaryRecord = z.object({
  startedAt: z.string().min(1),
  checks: z.array(canaryCheck).min(1),
});

export type CanaryRecord = z.infer<typeof canaryRecord>;
export type CanaryCheck = z.infer<typeof canaryCheck>;

interface SchemaLike<V> {
  safeParse(value: unknown): { success: boolean; data?: V };
}

interface DomainSpecLike {
  readonly name: string;
  readonly version: number;
  readonly tables: Record<
    string,
    { readonly valueSchema: SchemaLike<unknown> }
  >;
}

interface KvTableLike<V> {
  entries(): IterableIterator<[string, V]>;
  put(key: string, value: V): Promise<void>;
}

interface DomainLike {
  table(name: "checks"): KvTableLike<CanaryRecord>;
  close(): Promise<void>;
}

interface CommandResultLike {
  readonly kind: "success" | "error";
  readonly text: string;
}

interface CommandInvocationLike {
  readonly rawInput: string;
}

interface ToolExecLike {
  readonly signal: AbortSignal;
}

interface ToolOutputLike {
  readonly schema: { readonly type: "string" };
  render(
    args: Record<string, never>,
    value: string,
  ): Array<{ type: "text"; text: string }>;
}

interface WebRouteLike {
  readonly kind: "exact";
  readonly path: string;
  handler(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> | void;
}

export interface CanaryContext {
  effect(register: () => () => void): void;
  commands: {
    register(definition: {
      name: string;
      description: string;
      input: { hint: string; attachments: boolean };
      handler(invocation: CommandInvocationLike): CommandResultLike;
    }): unknown;
  };
  tools: {
    register(definition: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      output: ToolOutputLike;
      execute(args: Record<string, never>, exec: ToolExecLike): Promise<string>;
    }): unknown;
  };
  webServer: {
    register(route: WebRouteLike): unknown;
  };
  storageDomain: {
    open(spec: DomainSpecLike): Promise<DomainLike>;
  };
}

export const canaryDomainSpec: DomainSpecLike = {
  name: "pluginmax_canary",
  version: 1,
  tables: {
    checks: { valueSchema: canaryRecord as unknown as SchemaLike<unknown> },
  },
};

const canaryToolOutput: ToolOutputLike = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: value }],
};

export async function apply(ctx: CanaryContext): Promise<unknown> {
  const domain = await ctx.storageDomain.open(canaryDomainSpec);
  const checks = domain.table("checks");
  const startedAt = new Date().toISOString();
  await checks.put("boot", {
    startedAt,
    checks: [
      "storage-domain",
      "command",
      "tool",
      "http-route",
      "client-bundle",
    ],
  });

  ctx.effect(() => () => void domain.close());

  ctx.commands.register({
    name: "canary",
    description: "show DSH Pluginmax extension-point health",
    input: { hint: "[status]", attachments: false },
    handler: (invocation) => {
      const input = invocation.rawInput.trim();
      if (input !== "" && input !== "status") {
        return { kind: "error", text: `unknown canary input: ${input}` };
      }
      const record = [...checks.entries()].at(-1)?.[1];
      return record === undefined
        ? { kind: "error", text: "canary storage domain is empty" }
        : {
            kind: "success",
            text: `Pluginmax canary started at ${record.startedAt}`,
          };
    },
  });

  ctx.tools.register({
    name: "pluginmax_canary",
    description: "Return the DSH Pluginmax extension canary status.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: canaryToolOutput,
    execute: async (_args, exec) => {
      exec.signal.throwIfAborted();
      const record = [...checks.entries()].at(-1)?.[1];
      return record === undefined
        ? "canary storage domain is empty"
        : `ok ${record.startedAt}`;
    },
  });

  return ctx.webServer.register({
    kind: "exact",
    path: "/api/collab/canary/health",
    handler: (_request, response) => {
      const records = [...checks.entries()].map(([key, value]) => ({
        key,
        ...value,
      }));
      sendJson(response, 200, {
        ok: true,
        plugin: name,
        domain: canaryDomainSpec.name,
        records,
      });
    },
  });
}
