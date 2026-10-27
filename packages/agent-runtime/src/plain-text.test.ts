import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExternalRuntimeAdapterFailure,
  PlainTextAdapter,
  type AgentRuntimeEvent,
  type RuntimeTaskInput,
} from "./index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const fixture = resolve(
  import.meta.dirname,
  "../test-fixtures/external-cli.mjs",
);
const workspaces: string[] = [];

async function workspace(): Promise<string> {
  const root = join(repositoryRoot, ".tmp");
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(join(root, "agent-runtime-plain-"));
  workspaces.push(path);
  return path;
}

async function input(instruction: string): Promise<RuntimeTaskInput> {
  return {
    runId: "run-plain-fixture",
    effectKey: "effect-plain-fixture",
    title: "Plain fixture",
    description: "Exercise the plain-text adapter.",
    acceptance: [],
    instruction,
    agentName: "Plain fixture",
    runtimeKind: "plain-text",
    workspacePath: await workspace(),
  };
}

function adapter(scenario: string, options = {}) {
  return new PlainTextAdapter({
    command: process.execPath,
    args: [fixture, "plain", scenario],
    timeoutMs: 2_000,
    terminationGraceMs: 25,
    ...options,
  });
}

async function collect(
  runtime: PlainTextAdapter,
  task: RuntimeTaskInput,
  signal = new AbortController().signal,
): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.execute(task, signal)) events.push(event);
  return events;
}

async function failure(
  runtime: PlainTextAdapter,
  task: RuntimeTaskInput,
  signal = new AbortController().signal,
): Promise<ExternalRuntimeAdapterFailure> {
  try {
    await collect(runtime, task, signal);
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalRuntimeAdapterFailure);
    return error as ExternalRuntimeAdapterFailure;
  }
  throw new Error("expected adapter to fail");
}

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("PlainTextAdapter", () => {
  it("writes the full prompt to stdin as UTF-8 bytes", async () => {
    const instruction = "第一行\r\nsecond line\n";
    const events = await collect(
      adapter("stdin-base64"),
      await input(instruction),
    );
    const completed = events.at(-1);
    if (completed?.type !== "completed") throw new Error("missing completion");
    expect(Buffer.from(completed.output, "base64").toString("utf8")).toBe(
      instruction,
    );
  });

  it("sends the complete UTF-8 prompt and returns stdout as final-only text", async () => {
    const instruction = "第一行\nsecond line with spaces\n$(not-a-shell)";
    const events = await collect(adapter("normal"), await input(instruction));

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("progress");
    const completed = events.at(-1);
    expect(completed?.type).toBe("completed");
    if (completed?.type !== "completed") throw new Error("missing completion");
    expect(completed.output).toBe(`PLAIN:${instruction}`);
    expect(events.some((event) => event.type === "plan")).toBe(false);
    expect(events.some((event) => event.type === "tool.started")).toBe(false);
    expect(completed.execution).toMatchObject({
      provider: "command",
      model: "unknown",
      runtimeVersion: "unknown",
      authMode: "unknown",
      sandbox: "unknown",
    });
  });

  it("keeps WorkBuddy on generic argv and stdin semantics", async () => {
    const instruction = "完整 WorkBuddy Prompt\n第二行";
    const workbuddy = new PlainTextAdapter({
      provider: "workbuddy",
      command: process.execPath,
      args: [
        fixture,
        "plain",
        "argv-and-stdin",
        "--print",
        "--output-format",
        "text",
      ],
      timeoutMs: 2_000,
      terminationGraceMs: 25,
    });
    const events = await collect(workbuddy, await input(instruction));
    const completed = events.at(-1);
    if (completed?.type !== "completed") throw new Error("missing completion");

    expect(JSON.parse(completed.output)).toEqual({
      args: ["--print", "--output-format", "text"],
      prompt: instruction,
    });
    expect(completed.execution).toMatchObject({
      provider: "workbuddy",
      model: "unknown",
    });
    expect(events.some((event) => event.type === "plan")).toBe(false);
    expect(events.some((event) => event.type === "tool.started")).toBe(false);
  });

  it("keeps stderr as a bounded warning on success", async () => {
    const events = await collect(adapter("stderr"), await input("stderr"));
    expect(events.some((event) => event.type === "warning")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
    const completed = events.at(-1);
    if (completed?.type !== "completed") throw new Error("missing completion");
    expect(completed.diagnostics?.stderrExcerpt).toContain(
      "plain fixture diagnostic",
    );
  });

  it("fails on empty stdout", async () => {
    const error = await failure(adapter("empty"), await input("empty"));
    expect(error.code).toBe("external_runtime_empty_output");
  });

  it("fails on nonzero exit with stderr diagnostics", async () => {
    const error = await failure(adapter("fail"), await input("fail"));
    expect(error.code).toBe("external_runtime_exit");
    expect(error.message).toContain("exit code 4");
    expect(error.message).toContain("plain fixture failed");
  });

  it("fails on external process signals", async () => {
    const error = await failure(adapter("signal"), await input("signal"));
    expect(error.code).toBe("external_runtime_exit");
    expect(error.message).toContain("SIGTERM");
  });

  it("cancels the process through AbortSignal", async () => {
    const task = await input("cancel");
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancel plain")), 50);
    await expect(
      collect(adapter("cancel"), task, controller.signal),
    ).rejects.toMatchObject({ code: "external_runtime_cancelled" });
  });

  it("times out the process", async () => {
    await expect(
      collect(
        adapter("timeout", {
          timeoutMs: 50,
          terminationGraceMs: 25,
        }),
        await input("timeout"),
      ),
    ).rejects.toMatchObject({ code: "external_runtime_timeout" });
  });

  it("fails when stdout exceeds the configured limit", async () => {
    const error = await failure(
      adapter("normal", { maxStdoutBytes: 10 }),
      await input("truncate"),
    );
    expect(error.code).toBe("external_runtime_output_limit");
  });
});
