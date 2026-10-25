import { describe, expect, it } from "vitest";
import {
  apply,
  canaryDomainSpec,
  inject,
  type CanaryContext,
  type CanaryRecord,
} from "./index.ts";

class FakeTable {
  readonly records = new Map<string, CanaryRecord>();
  entries(): IterableIterator<[string, CanaryRecord]> {
    return this.records.entries();
  }
  async put(key: string, value: CanaryRecord): Promise<void> {
    this.records.set(key, value);
  }
}

function setup() {
  const table = new FakeTable();
  let closed = false;
  const disposers: Array<() => void> = [];
  const commands: unknown[] = [];
  const tools: unknown[] = [];
  const routes: unknown[] = [];
  const ctx: CanaryContext = {
    effect: (register) => disposers.push(register()),
    commands: { register: (definition) => commands.push(definition) },
    tools: { register: (definition) => tools.push(definition) },
    webServer: { register: (route) => routes.push(route) },
    storageDomain: {
      open: async (spec) => {
        expect(spec.name).toBe("pluginmax_canary");
        return {
          table: () => table,
          close: async () => {
            closed = true;
          },
        };
      },
    },
  };
  return {
    ctx,
    table,
    disposers,
    commands,
    tools,
    routes,
    isClosed: () => closed,
  };
}

describe("dsh-pluginmax-canary", () => {
  it("declares a versioned storage domain", () => {
    expect(canaryDomainSpec).toMatchObject({
      name: "pluginmax_canary",
      version: 1,
    });
    expect(Object.keys(canaryDomainSpec.tables)).toEqual(["checks"]);
    expect(inject).toEqual(["storageDomain", "commands", "tools", "webServer"]);
  });

  it("registers command, tool, route, writes health, and closes its domain", async () => {
    const fake = setup();
    await apply(fake.ctx);

    expect(fake.table.records.get("boot")?.checks).toHaveLength(5);
    expect(fake.commands).toHaveLength(1);
    expect(fake.tools).toHaveLength(1);
    expect(fake.routes).toHaveLength(1);

    const command = fake.commands[0] as {
      handler(input: { rawInput: string }): { kind: string; text: string };
    };
    expect(command.handler({ rawInput: "status" }).text).toContain(
      "Pluginmax canary started at",
    );

    const tool = fake.tools[0] as {
      output: {
        schema: unknown;
        render(
          args: unknown,
          value: string,
        ): Array<{ type: string; text: string }>;
      };
      execute(args: unknown, exec: { signal: AbortSignal }): Promise<string>;
    };
    expect(tool.output.schema).toEqual({ type: "string" });
    expect(tool.output.render({}, "ready")).toEqual([
      { type: "text", text: "ready" },
    ]);
    await expect(
      tool.execute({}, { signal: new AbortController().signal }),
    ).resolves.toContain("ok ");

    const route = fake.routes[0] as {
      path: string;
      handler: (_request: unknown, response: unknown) => void;
    };
    expect(route.path).toBe("/api/collab/canary/health");

    fake.disposers.forEach((dispose) => dispose());
    expect(fake.isClosed()).toBe(true);
  });
});
