import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexJsonlAdapter,
  ExternalRuntimeAdapterFailure,
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
  const path = await mkdtemp(join(root, "agent-runtime-codex-"));
  workspaces.push(path);
  return path;
}

async function input(instruction: string): Promise<RuntimeTaskInput> {
  return {
    runId: "run-codex-fixture",
    effectKey: "effect-codex-fixture",
    title: "Codex fixture",
    description: "Exercise the Codex JSONL adapter.",
    acceptance: [],
    instruction,
    agentName: "Codex fixture",
    runtimeKind: "codex-jsonl",
    workspacePath: await workspace(),
  };
}

function adapter(scenario: string, options = {}) {
  return new CodexJsonlAdapter({
    command: process.execPath,
    args: [fixture, "codex", scenario],
    timeoutMs: 2_000,
    terminationGraceMs: 25,
    ...options,
  });
}

async function collect(
  runtime: CodexJsonlAdapter,
  task: RuntimeTaskInput,
  signal = new AbortController().signal,
): Promise<AgentRuntimeEvent[]> {
  const events: AgentRuntimeEvent[] = [];
  for await (const event of runtime.execute(task, signal)) events.push(event);
  return events;
}

async function failure(
  runtime: CodexJsonlAdapter,
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

describe("CodexJsonlAdapter", () => {
  it("normalizes assistant, progress, tool, session and sandbox diagnostics", async () => {
    const instruction = "review this\nwith two lines";
    const events = await collect(adapter("normal"), await input(instruction));
    const serialized = JSON.stringify(events);

    expect(events[0]).toEqual({
      type: "progress",
      summary: "Codex JSONL Runtime 正在执行任务",
    });
    expect(events.some((event) => event.type === "progress")).toBe(true);
    expect(events.some((event) => event.type === "delta")).toBe(true);
    expect(events.some((event) => event.type === "tool.started")).toBe(true);
    expect(events.some((event) => event.type === "tool.result")).toBe(true);
    expect(serialized).not.toContain("PRIVATE_REASONING_MUST_NOT_LEAK");
    expect(serialized).toContain("Codex 报告了一个推理阶段");

    const completed = events.at(-1);
    expect(completed?.type).toBe("completed");
    if (completed?.type !== "completed") throw new Error("missing completion");
    expect(completed.output).toBe(`FINAL:${instruction}`);
    expect(completed.execution).toMatchObject({
      provider: "openai-fixture",
      model: "gpt-fixture",
      runtimeVersion: "9.8.7-fixture",
      authMode: "chatgpt",
      sandbox: "read-only / network restricted",
      sessionId: "codex-session-fixture",
    });
    expect(completed.diagnostics).toMatchObject({
      exitCode: 0,
      exitSignal: null,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });

  it("surfaces provider warnings without failing the run", async () => {
    const events = await collect(adapter("warning"), await input("warn"));
    expect(events).toContainEqual({
      type: "warning",
      summary: "Codex 警告：fixture warning from provider",
    });
    expect(events.at(-1)?.type).toBe("completed");
  });

  it("surfaces provider errors and fails the run", async () => {
    const events: AgentRuntimeEvent[] = [];
    const runtime = adapter("error-event");
    await expect(
      (async () => {
        for await (const event of runtime.execute(
          await input("error"),
          new AbortController().signal,
        )) {
          events.push(event);
        }
      })(),
    ).rejects.toMatchObject({
      code: "external_runtime_protocol_error",
    });
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  it("fails on nonzero exit with bounded stderr diagnostics", async () => {
    const error = await failure(adapter("fail"), await input("fail"));
    expect(error.code).toBe("external_runtime_exit");
    expect(error.message).toContain("exit code 7");
    expect(error.message).toContain("codex fixture failed");
    expect(error.details.diagnostics?.stderrExcerpt).toContain(
      "codex fixture failed",
    );
  });

  it("fails on empty final output", async () => {
    const error = await failure(adapter("empty"), await input("empty"));
    expect(error.code).toBe("external_runtime_empty_output");
  });

  it("fails on malformed JSONL", async () => {
    const error = await failure(adapter("bad-json"), await input("bad json"));
    expect(error.code).toBe("external_runtime_protocol_error");
    expect(error.message).toContain("invalid JSON");
  });

  it("fails when stdout exceeds the configured limit", async () => {
    const error = await failure(
      adapter("normal", { maxStdoutBytes: 80 }),
      await input("truncate"),
    );
    expect(error.code).toBe("external_runtime_output_limit");
    expect(error.details.diagnostics?.stdoutTruncated).toBe(true);
  });

  it("cancels the process through AbortSignal", async () => {
    const task = await input("cancel");
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancel codex")), 50);
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
});
