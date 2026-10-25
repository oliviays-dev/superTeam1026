import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ExternalAgentProcessRunner,
  probeExternalRuntime,
  terminalExternalAgentRuntimeTrace,
} from "./external.js";
import type { ExternalAgentRuntime } from "./types.js";

let workspacePath = "";
let scriptDirectory = "";

beforeAll(async () => {
  scriptDirectory = await mkdtemp(join(tmpdir(), "dsh-external-test-"));
  workspacePath = join(scriptDirectory, "project");
  await mkdir(workspacePath, { recursive: true });
});

afterAll(async () => {
  await rm(scriptDirectory, { recursive: true, force: true });
});

function runtime(
  overrides: Partial<ExternalAgentRuntime> = {},
): ExternalAgentRuntime {
  const timestamp = "2026-09-30T00:00:00.000Z";
  return {
    id: "runtime-1",
    name: "Test Runtime",
    provider: "command",
    protocol: "plain-text",
    command: "cat",
    args: [],
    status: "active",
    visibility: "workspace",
    ownerUserId: "owner",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

async function script(command: string): Promise<string> {
  const path = join(scriptDirectory, `agent-${crypto.randomUUID()}.js`);
  await writeFile(path, command, "utf8");
  await chmod(path, 0o700);
  return path;
}

describe("external agent process runner", () => {
  it("writes runtime governance events to the service terminal", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      terminalExternalAgentRuntimeTrace({
        action: "probe",
        runtime: runtime({ name: "WorkBuddy 外部 Agent" }),
        actorUserId: "admin",
        previousStatus: "active",
        message: "外部 Agent 运行时探测通过",
        fields: {
          ok: true,
          exit: 0,
          durationMs: 42,
          stdout: "2.161.0",
        },
      });
      const line = String(write.mock.calls[0]?.[0]);
      expect(line).toContain("[外部Agent治理] action=probe runtime=runtime-1");
      expect(line).toContain('name="WorkBuddy 外部 Agent"');
      expect(line).toContain("status=active previous=active");
      expect(line).toContain("actor=admin");
      expect(line).toContain("stdout=2.161.0");
    } finally {
      write.mockRestore();
    }
  });

  it("probes the command version and returns terminal diagnostics", async () => {
    const result = await probeExternalRuntime(process.execPath);
    expect(result.ok).toBe(true);
    expect(result.message).toBe("命令可用");
    expect(result.command).toBe(process.execPath);
    expect(result.args).toEqual(["--version"]);
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.stdout).toMatch(/^v\d+\./);
    expect(result.stderr).toBe("");
  });

  it("sends the prompt to a plain-text command and collects stdout", async () => {
    const path = await script(
      "let prompt = ''; process.stdin.on('data', (chunk) => { prompt += chunk; }); process.stdin.on('end', () => { process.stdout.write(`echo:${prompt.trim()}`); });",
    );
    const runner = new ExternalAgentProcessRunner();
    const chunks: string[] = [];
    const result = await runner.execute({
      runId: "run-1",
      runtime: runtime({ command: "node", args: [path] }),
      prompt: "请完成交付报告",
      workspacePath,
      signal: new AbortController().signal,
      onProgress: (text) => chunks.push(text),
    });
    expect(result.stopReason).toBe("completed");
    expect(result.output).toEqual([
      { type: "text", text: "echo:请完成交付报告" },
    ]);
    expect(chunks.join("")).toContain("请完成交付报告");
  });

  it("maps task-level model and reasoning overrides into provider CLI args", async () => {
    const path = await script(
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: 'override-session' }) + '\\n');",
        "});",
      ].join("\n"),
    );
    const traces: Array<{ args?: readonly string[] | undefined }> = [];
    const runner = new ExternalAgentProcessRunner({
      onTrace: (event) => {
        if (event.kind === "spawn") traces.push({ args: event.args });
      },
    });
    const result = await runner.execute({
      runId: "run-workbuddy-override",
      runtime: runtime({
        provider: "workbuddy",
        protocol: "plain-text",
        command: process.execPath,
        args: [
          path,
          "--model",
          "runtime-default",
          "--effort",
          "low",
          "--max-turns",
          "6",
        ],
      }),
      model: "task-selected-model",
      reasoningEffort: "high",
      prompt: "执行调研",
      workspacePath,
      signal: new AbortController().signal,
    });
    const args = traces.find((trace) => trace.args !== undefined)?.args ?? [];
    expect(result.stopReason).toBe("completed");
    expect(args.filter((arg) => arg === "--model")).toHaveLength(1);
    expect(args).toContain("task-selected-model");
    expect(args).not.toContain("runtime-default");
    expect(args.filter((arg) => arg === "--effort")).toHaveLength(1);
    expect(args).toContain("high");
    expect(args).not.toContain("low");
    expect(result.execution).toMatchObject({
      model: "task-selected-model",
      reasoningEffort: "high",
    });
  });

  it("passes Codex reasoning as model_reasoning_effort config", async () => {
    const path = await script("process.stdin.resume();");
    const traces: Array<{ args?: readonly string[] | undefined }> = [];
    const runner = new ExternalAgentProcessRunner({
      onTrace: (event) => {
        if (event.kind === "spawn") traces.push({ args: event.args });
      },
    });
    await runner.execute({
      runId: "run-codex-override",
      runtime: runtime({
        provider: "codex",
        protocol: "codex-jsonl",
        command: process.execPath,
        args: [path, "--model", "runtime-default"],
      }),
      model: "task-selected-model",
      reasoningEffort: "medium",
      prompt: "执行任务",
      workspacePath,
      signal: new AbortController().signal,
    });
    const args = traces[0]?.args ?? [];
    expect(args.filter((arg) => arg === "--model")).toHaveLength(1);
    expect(args).toContain("task-selected-model");
    expect(args).not.toContain("runtime-default");
    expect(args).toContain('model_reasoning_effort="medium"');
    expect(args).toContain("exec");
  });

  it("streams WorkBuddy reasoning summaries and tool events without leaking reasoning text", async () => {
    const path = await script(
      [
        "let prompt = '';",
        "process.stdin.on('data', (chunk) => { prompt += chunk; });",
        "process.stdin.on('end', () => {",
        "  const events = [",
        "    { type: 'system', subtype: 'init', session_id: 'wb-session-1', model: 'workbuddy-model', cwd: process.cwd() },",
        "    { type: 'assistant', session_id: 'wb-session-1', message: { content: [{ type: 'thinking', thinking: '先读取项目文件。' }] } },",
        "    { type: 'assistant', session_id: 'wb-session-1', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'package.json' } }] } },",
        "    { type: 'user', session_id: 'wb-session-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: false, content: [{ type: 'text', text: 'name=dsh-pluginmax' }] }] } },",
        "    { type: 'assistant', session_id: 'wb-session-1', message: { content: [{ type: 'text', text: '中间结论' }] } },",
        "    { type: 'result', subtype: 'success', is_error: false, result: 'STREAM_DONE', session_id: 'wb-session-1' },",
        "  ];",
        "  for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');",
        "});",
      ].join("\n"),
    );
    const traces: Array<{
      kind: string;
      data?: string | undefined;
      args?: readonly string[] | undefined;
    }> = [];
    const progress: string[] = [];
    const runner = new ExternalAgentProcessRunner({
      onTrace: (event) =>
        traces.push({
          kind: event.kind,
          data: event.data,
          args: event.kind === "spawn" ? event.args : undefined,
        }),
    });
    const result = await runner.execute({
      runId: "run-workbuddy-stream",
      runtime: runtime({
        provider: "workbuddy",
        protocol: "plain-text",
        command: "node",
        args: [path, "--output-format", "text", "--max-turns", "8"],
      }),
      prompt: "请执行",
      workspacePath,
      signal: new AbortController().signal,
      onProgress: (text) => progress.push(text),
    });

    expect(result.stopReason).toBe("completed");
    expect(result.sessionId).toBe("wb-session-1");
    expect(result.output).toEqual([{ type: "text", text: "STREAM_DONE" }]);
    expect(result.execution).toMatchObject({
      provider: "workbuddy",
      model: "workbuddy-model",
      runtime: "Test Runtime",
    });
    expect(traces.find((event) => event.kind === "spawn")?.args).toContain(
      "stream-json",
    );
    expect(traces.find((event) => event.kind === "spawn")?.args).toContain(
      "--print",
    );
    expect(traces.find((event) => event.kind === "thinking")?.data).toBe(
      "Runtime 报告了新的推理阶段",
    );
    expect(traces.find((event) => event.kind === "tool_call")?.data).toContain(
      "Read",
    );
    expect(
      traces.find((event) => event.kind === "tool_result")?.data,
    ).toContain("dsh-pluginmax");
    expect(traces.find((event) => event.kind === "assistant")?.data).toBe(
      "中间结论",
    );
    expect(traces.find((event) => event.kind === "result")?.data).toContain(
      "STREAM_DONE",
    );
    expect(traces.find((event) => event.kind === "stdout")).toBeUndefined();
    expect(progress.join("")).toContain("[thinking]");
    expect(progress.join("")).toContain("[tool_call]");
    expect(progress.join("")).not.toContain("先读取项目文件");
  });

  it("retries WorkBuddy after a transient TLS or 502 failure", async () => {
    const counterPath = join(
      scriptDirectory,
      `attempts-${crypto.randomUUID()}`,
    );
    const path = await script(
      [
        "const fs = require('node:fs');",
        "const counterPath = process.argv[2];",
        "let prompt = '';",
        "process.stdin.on('data', (chunk) => { prompt += chunk; });",
        "process.stdin.on('end', () => {",
        "  const attempt = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) + 1 : 1;",
        "  fs.writeFileSync(counterPath, String(attempt));",
        "  if (attempt === 1) {",
        "    const events = [",
        "      { type: 'assistant', session_id: 'wb-retry', message: { content: [{ type: 'text', text: '502 安全连接建立失败，TLS socket disconnected' }] } },",
        "      { type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: 'wb-retry' },",
        "    ];",
        "    for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');",
        "    return;",
        "  }",
        "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'RETRY_OK', session_id: 'wb-retry' }) + '\\n');",
        "});",
      ].join("\n"),
    );
    const traces: Array<{ kind: string; data?: string | undefined }> = [];
    const progress: string[] = [];
    const runner = new ExternalAgentProcessRunner({
      retryDelayMs: 0,
      onTrace: (event) => traces.push({ kind: event.kind, data: event.data }),
    });
    const result = await runner.execute({
      runId: "run-workbuddy-retry",
      runtime: runtime({
        provider: "workbuddy",
        protocol: "plain-text",
        command: "node",
        args: [path, counterPath, "--output-format", "text"],
      }),
      prompt: "请执行",
      workspacePath,
      signal: new AbortController().signal,
      onProgress: (text) => progress.push(text),
    });

    expect(result).toMatchObject({
      stopReason: "completed",
      output: [{ type: "text", text: "RETRY_OK" }],
    });
    await expect(readFile(counterPath, "utf8")).resolves.toBe("2");
    expect(traces.find((event) => event.kind === "retry")?.data).toContain(
      "2/3",
    );
    expect(progress.join("")).toContain("502");
    expect(progress.join("")).toContain("[retry]");
  });

  it("parses Codex progress, session id, and final message", async () => {
    const path = await script(
      [
        "#!/usr/bin/env node",
        "if (process.argv.includes('login') && process.argv.includes('status')) {",
        "  process.stdout.write('Logged in using an API key\\n');",
        "  process.exit(0);",
        "}",
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({ type: 'progress', text: 'working', thread_id: 'provider-thread-1' }) + '\\n');",
        "  const outputIndex = process.argv.indexOf('--output-last-message');",
        "  require('node:fs').writeFileSync(process.argv[outputIndex + 1], '# 交付报告\\n\\n## 交付说明\\n\\nCodex 已完成。');",
        "});",
      ].join("\n"),
    );
    const codexHome = join(
      scriptDirectory,
      `codex-home-${crypto.randomUUID()}`,
    );
    const date = new Date();
    const sessionDirectory = join(
      codexHome,
      "sessions",
      String(date.getFullYear()),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    );
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      join(sessionDirectory, `rollout-test-provider-thread-1.jsonl`),
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            model_provider: "custom",
            cli_version: "0.163.0-alpha.10.2",
          },
        }),
        JSON.stringify({
          type: "turn_context",
          payload: {
            model: "deepseek-flash",
            sandbox_policy: { type: "read-only" },
            permission_profile: { network: "restricted" },
          },
        }),
      ].join("\n"),
      "utf8",
    );
    const runner = new ExternalAgentProcessRunner({
      codexHome,
      inspectCodexAuth: async () => "api-key",
    });
    const result = await runner.execute({
      runId: "run-2",
      runtime: runtime({
        provider: "codex",
        protocol: "codex-jsonl",
        command: path,
        args: [],
      }),
      prompt: "请完成交付报告",
      workspacePath,
      signal: new AbortController().signal,
    });
    expect(result.stopReason).toBe("completed");
    expect(result.sessionId).toBe("provider-thread-1");
    expect(result.output[0]?.text).toContain("Codex 已完成。");
    expect(result.execution).toEqual({
      provider: "custom",
      model: "deepseek-flash",
      runtime: "Test Runtime",
      runtimeVersion: "0.163.0-alpha.10.2",
      authMode: "api-key",
      sandbox: "read-only / network restricted",
    });
  });

  it("streams process evidence to the configured terminal trace listener", async () => {
    const path = await script(
      [
        "process.stderr.write('starting\\n');",
        "let prompt = '';",
        "process.stdin.on('data', (chunk) => { prompt += chunk; });",
        "process.stdin.on('end', () => {",
        "  process.stdout.write('working\\n');",
        "  process.stdout.write(`echo:${prompt.trim()}`);",
        "});",
      ].join("\n"),
    );
    const traces: Array<{
      kind: string;
      pid?: number | undefined;
      data?: string | undefined;
      exitCode?: number | null | undefined;
    }> = [];
    const runner = new ExternalAgentProcessRunner({
      onTrace: (event) =>
        traces.push({
          kind: event.kind,
          pid: event.pid,
          data: event.data,
          exitCode: event.exitCode,
        }),
    });
    const result = await runner.execute({
      runId: "run-trace",
      runtime: runtime({ command: "node", args: [path] }),
      prompt: "请完成交付报告",
      workspacePath,
      signal: new AbortController().signal,
    });
    expect(result.stopReason).toBe("completed");
    expect(traces.find((event) => event.kind === "spawn")?.pid).toEqual(
      expect.any(Number),
    );
    expect(traces.find((event) => event.kind === "stderr")?.data).toContain(
      "starting",
    );
    expect(traces.find((event) => event.kind === "stdout")?.data).toContain(
      "working",
    );
    expect(traces.find((event) => event.kind === "close")?.exitCode).toBe(0);
  });

  it("reports launch failures as failed runs", async () => {
    const runner = new ExternalAgentProcessRunner();
    const result = await runner.execute({
      runId: "run-3",
      runtime: runtime({ command: "definitely-not-installed-command" }),
      prompt: "hello",
      workspacePath,
      signal: new AbortController().signal,
    });
    expect(result.stopReason).toBe("failed");
    expect(result.diagnostic).toContain("ENOENT");
  });

  it("rejects a zero-exit run with no output", async () => {
    const path = await script("process.exit(0);");
    const runner = new ExternalAgentProcessRunner();
    const result = await runner.execute({
      runId: "run-4",
      runtime: runtime({ command: "node", args: [path] }),
      prompt: "hello",
      workspacePath,
      signal: new AbortController().signal,
    });
    expect(result.stopReason).toBe("failed");
    expect(result.diagnostic).toBe("外部 Agent 未返回可用的文本输出");
  });

  it("includes stderr in a zero-exit empty-output diagnostic", async () => {
    const path = await script(
      "process.stderr.write('Authentication required...'); process.exit(0);",
    );
    const runner = new ExternalAgentProcessRunner();
    const result = await runner.execute({
      runId: "run-4-diagnostic",
      runtime: runtime({ command: "node", args: [path] }),
      prompt: "hello",
      workspacePath,
      signal: new AbortController().signal,
    });
    expect(result.stopReason).toBe("failed");
    expect(result.diagnostic).toBe(
      "外部 Agent 未返回可用的文本输出：Authentication required...",
    );
  });

  it("cancels a long-running process", async () => {
    const path = await script(
      [
        "process.stdout.write('started\\n');",
        "setInterval(() => {}, 1000);",
        "process.on('SIGTERM', () => process.exit(0));",
      ].join("\n"),
    );
    const runner = new ExternalAgentProcessRunner();
    const controller = new AbortController();
    const chunks: string[] = [];
    const execution = runner.execute({
      runId: "run-5",
      runtime: runtime({ command: "node", args: [path] }),
      prompt: "hello",
      workspacePath,
      signal: controller.signal,
      onProgress: (text) => chunks.push(text),
    });
    for (
      let index = 0;
      index < 50 && !chunks.join("").includes("started");
      index += 1
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    controller.abort();
    const result = await execution;
    expect(chunks.join("")).toContain("started");
    expect(result.stopReason).toBe("cancelled");
  });
});
