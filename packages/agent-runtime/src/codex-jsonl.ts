import { resolve } from "node:path";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  RuntimeTaskInput,
} from "./index.js";
import { ExternalRuntimeAdapterFailure } from "./external-adapter-error.js";
import {
  boundedDiagnostic,
  externalProcessDiagnostics,
  runExternalProcess,
  type ExternalProcessResult,
} from "./external-process.js";
import type {
  ExternalRuntimeExecutionMetadata,
  ExternalRuntimeLimitOptions,
} from "./external-runtime-types.js";

type JsonRecord = Record<string, unknown>;

export interface CodexJsonlAdapterOptions extends ExternalRuntimeLimitOptions {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly sandbox?: string | undefined;
  readonly provider?: string | undefined;
}

export interface CodexJsonlParseResult {
  readonly events: readonly AgentRuntimeEvent[];
  readonly output: string;
  readonly execution: ExternalRuntimeExecutionMetadata;
  readonly fatalError?: string | undefined;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function compact(value: string, maxLength = 1_000): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength)}...`;
}

function recordString(
  record: JsonRecord | undefined,
  keys: readonly string[],
): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = asString(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function nestedRecords(record: JsonRecord): JsonRecord[] {
  return [
    asRecord(record.payload),
    asRecord(record.item),
    asRecord(record.message),
  ].filter((value): value is JsonRecord => value !== undefined);
}

function codexSandboxLabel(record: JsonRecord): string | undefined {
  const payload = asRecord(record.payload) ?? record;
  const sandboxPolicy =
    asRecord(payload.sandbox_policy) ?? asRecord(record.sandbox_policy);
  const permissionProfile =
    asRecord(payload.permission_profile) ?? asRecord(record.permission_profile);
  const mode =
    recordString(sandboxPolicy, ["type", "mode"]) ??
    recordString(permissionProfile, ["type"]) ??
    recordString(payload, ["sandbox", "sandbox_mode"]) ??
    recordString(record, ["sandbox", "sandbox_mode"]);
  const network =
    recordString(permissionProfile, [
      "network",
      "network_access",
      "networkAccess",
    ]) ??
    recordString(sandboxPolicy, ["network", "network_access", "networkAccess"]);
  if (mode === undefined) return network;
  return network === undefined ? mode : `${mode} / network ${network}`;
}

function updateMetadata(
  metadata: {
    provider: string;
    model: string;
    runtimeVersion: string;
    authMode: string;
    sandbox: string;
    sessionId?: string;
  },
  record: JsonRecord,
): void {
  const records = [record, ...nestedRecords(record)];
  for (const candidate of records) {
    const sessionId = recordString(candidate, [
      "session_id",
      "sessionId",
      "thread_id",
      "threadId",
    ]);
    if (sessionId !== undefined) metadata.sessionId = sessionId;
    metadata.provider =
      recordString(candidate, [
        "model_provider",
        "modelProvider",
        "provider",
      ]) ?? metadata.provider;
    metadata.model =
      recordString(candidate, ["model", "model_id", "modelId"]) ??
      metadata.model;
    metadata.runtimeVersion =
      recordString(candidate, [
        "runtime_version",
        "runtimeVersion",
        "cli_version",
        "cliVersion",
      ]) ?? metadata.runtimeVersion;
    metadata.authMode =
      recordString(candidate, ["auth_mode", "authMode"]) ?? metadata.authMode;
    metadata.sandbox = codexSandboxLabel(candidate) ?? metadata.sandbox;
  }
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() === "" ? undefined : value;
  }
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const block = asRecord(item);
    if (block === undefined) continue;
    const type = asString(block.type);
    if (
      type !== undefined &&
      type !== "text" &&
      type !== "output_text" &&
      type !== "assistant_text"
    ) {
      continue;
    }
    const text = asString(block.text) ?? asString(block.content);
    if (text !== undefined) parts.push(text);
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

function assistantText(record: JsonRecord): string | undefined {
  const item = asRecord(record.item);
  const message = asRecord(record.message);
  return (
    contentText(item?.text) ??
    contentText(record.text) ??
    contentText(message?.content) ??
    contentText(record.content) ??
    asString(message?.text) ??
    asString(record.output) ??
    asString(record.result)
  );
}

function warningText(record: JsonRecord): string {
  return (
    asString(record.message) ??
    asString(record.text) ??
    asString(asRecord(record.item)?.text) ??
    "Codex reported a warning"
  );
}

function errorText(record: JsonRecord): string {
  const error = asRecord(record.error);
  return (
    asString(error?.message) ??
    asString(record.message) ??
    asString(record.text) ??
    asString(asRecord(record.item)?.text) ??
    "Codex reported an error"
  );
}

function toolName(record: JsonRecord, itemType: string): string {
  const item = asRecord(record.item);
  const explicit =
    asString(item?.name) ??
    asString(item?.tool) ??
    asString(record.name) ??
    asString(record.tool);
  if (explicit !== undefined) return explicit;
  if (itemType === "command_execution") return "exec_command";
  if (itemType === "file_change") return "file_change";
  if (itemType === "web_search") return "web_search";
  if (itemType === "mcp_tool_call") return "mcp_tool_call";
  return itemType;
}

function toolCallSummary(record: JsonRecord, tool: string): string {
  const item = asRecord(record.item);
  const detail =
    asString(item?.command) ??
    asString(record.command) ??
    asString(item?.query) ??
    asString(record.query);
  return detail === undefined
    ? `Codex 调用工具 ${tool}`
    : `Codex 调用工具 ${tool}: ${compact(detail)}`;
}

function toolResultSummary(record: JsonRecord, tool: string): string {
  const item = asRecord(record.item);
  const exitCode =
    typeof item?.exit_code === "number"
      ? item.exit_code
      : typeof record.exit_code === "number"
        ? record.exit_code
        : undefined;
  const output =
    asString(item?.aggregated_output) ??
    asString(item?.output) ??
    asString(record.output);
  const status = exitCode === undefined ? "完成" : `完成，exit=${exitCode}`;
  return output === undefined
    ? `Codex 工具 ${tool} ${status}`
    : `Codex 工具 ${tool} ${status}: ${compact(output)}`;
}

export function parseCodexJsonl(
  stdout: string,
  initial: {
    readonly provider?: string | undefined;
    readonly model?: string | undefined;
    readonly runtimeVersion?: string | undefined;
    readonly authMode?: string | undefined;
    readonly sandbox?: string | undefined;
  } = {},
): CodexJsonlParseResult {
  const metadata: {
    provider: string;
    model: string;
    runtimeVersion: string;
    authMode: string;
    sandbox: string;
    sessionId?: string;
  } = {
    provider: initial.provider ?? "codex",
    model: initial.model ?? "unknown",
    runtimeVersion: initial.runtimeVersion ?? "unknown",
    authMode: initial.authMode ?? "unknown",
    sandbox: initial.sandbox ?? "unknown",
  };
  const events: AgentRuntimeEvent[] = [];
  let output = "";
  let fatalError: string | undefined;

  const lines = stdout.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch (error) {
      throw new ExternalRuntimeAdapterFailure(
        "external_runtime_protocol_error",
        `Codex JSONL line ${lineIndex + 1} is invalid JSON: ${
          error instanceof Error ? error.message : "parse failed"
        }`,
      );
    }
    const record = asRecord(decoded);
    if (record === undefined) {
      throw new ExternalRuntimeAdapterFailure(
        "external_runtime_protocol_error",
        `Codex JSONL line ${lineIndex + 1} must be an object`,
      );
    }
    updateMetadata(metadata, record);

    const type = asString(record.type);
    const item = asRecord(record.item);
    const itemType = asString(item?.type);

    if (type === "warning") {
      events.push({
        type: "warning",
        summary: `Codex 警告：${compact(warningText(record))}`,
      });
      continue;
    }
    if (type === "error" || type === "turn.failed") {
      const message = errorText(record);
      fatalError = message;
      events.push({
        type: "error",
        summary: `Codex 错误：${compact(message)}`,
      });
      continue;
    }
    if (type === "thread.started" || type === "session.started") {
      events.push({
        type: "progress",
        summary:
          metadata.sessionId === undefined
            ? "Codex Session 已启动"
            : `Codex Session 已启动：${metadata.sessionId}`,
      });
      continue;
    }
    if (type === "turn.started") {
      events.push({ type: "progress", summary: "Codex 开始新一轮执行" });
      continue;
    }
    if (type === "turn.completed") {
      events.push({ type: "progress", summary: "Codex 本轮执行结束" });
      continue;
    }

    if (type === "tool_call" || type === "tool.started") {
      const tool = asString(record.name) ?? asString(record.tool) ?? "unknown";
      events.push({
        type: "tool.started",
        summary: toolCallSummary(record, tool),
        tool,
      });
      continue;
    }
    if (type === "tool_result" || type === "tool.completed") {
      const tool = asString(record.name) ?? asString(record.tool) ?? "unknown";
      events.push({
        type: "tool.result",
        summary: toolResultSummary(record, tool),
        tool,
      });
      continue;
    }
    if (type === "assistant" || type === "assistant_message") {
      const text = assistantText(record);
      if (text !== undefined) {
        output = text.trim();
        events.push({ type: "delta", text });
      }
      continue;
    }
    if (type === "result") {
      if (record.is_error === true) {
        const message = errorText(record);
        fatalError = message;
        events.push({
          type: "error",
          summary: `Codex 错误：${compact(message)}`,
        });
      } else {
        const text = assistantText(record);
        if (text !== undefined) {
          output = text.trim();
          events.push({ type: "delta", text });
        }
      }
      continue;
    }

    if (type !== "item.completed" && type !== "item.started") continue;
    if (itemType === "reasoning") {
      if (type === "item.completed") {
        events.push({
          type: "progress",
          summary: "Codex 报告了一个推理阶段",
        });
      }
      continue;
    }
    if (itemType === "agent_message") {
      if (type !== "item.completed") continue;
      const text = assistantText(record);
      if (text !== undefined) {
        output = text.trim();
        events.push({ type: "delta", text });
      }
      continue;
    }
    if (
      itemType === "command_execution" ||
      itemType === "file_change" ||
      itemType === "mcp_tool_call" ||
      itemType === "web_search" ||
      itemType === "custom_tool_call" ||
      itemType === "collab_tool_call"
    ) {
      const tool = toolName(record, itemType);
      if (type === "item.started") {
        events.push({
          type: "tool.started",
          summary: toolCallSummary(record, tool),
          tool,
        });
      } else {
        events.push(
          {
            type: "tool.started",
            summary: toolCallSummary(record, tool),
            tool,
          },
          {
            type: "tool.result",
            summary: toolResultSummary(record, tool),
            tool,
          },
        );
      }
      continue;
    }
    if (itemType === "warning") {
      events.push({
        type: "warning",
        summary: `Codex 警告：${compact(warningText(record))}`,
      });
      continue;
    }
    if (itemType === "error") {
      const message = errorText(record);
      fatalError = message;
      events.push({
        type: "error",
        summary: `Codex 错误：${compact(message)}`,
      });
    }
  }

  return {
    events,
    output,
    execution: {
      ...metadata,
      ...(metadata.sessionId === undefined
        ? {}
        : { sessionId: metadata.sessionId }),
    },
    ...(fatalError === undefined ? {} : { fatalError }),
  };
}

function launchArgs(
  input: RuntimeTaskInput,
  options: CodexJsonlAdapterOptions,
): string[] {
  const args = [...(options.args ?? [])];
  if (options.model !== undefined) args.push("--model", options.model);
  if (options.reasoningEffort !== undefined) {
    args.push(
      "-c",
      `model_reasoning_effort="${options.reasoningEffort.replaceAll('"', '\\"')}"`,
    );
  }
  args.push(
    "exec",
    "--json",
    "--cd",
    resolve(input.workspacePath),
    "--sandbox",
    options.sandbox ?? "read-only",
    "-",
  );
  return args;
}

function failForProcess(
  result: ExternalProcessResult,
  execution: ExternalRuntimeExecutionMetadata,
): void {
  const diagnostics = externalProcessDiagnostics(result);
  if (result.exitCode !== 0 || result.exitSignal !== null) {
    const status =
      result.exitSignal === null
        ? `exit code ${result.exitCode ?? "unknown"}`
        : `signal ${result.exitSignal}`;
    throw new ExternalRuntimeAdapterFailure(
      "external_runtime_exit",
      `Codex process failed with ${status}${
        result.stderr.trim() === ""
          ? ""
          : `: ${boundedDiagnostic(result.stderr)}`
      }`,
      { result, execution, diagnostics },
    );
  }
  if (result.stdoutTruncated) {
    throw new ExternalRuntimeAdapterFailure(
      "external_runtime_output_limit",
      "Codex JSONL stdout exceeded its configured output limit",
      { result, execution, diagnostics },
    );
  }
  if (result.stdout.trim() === "") {
    throw new ExternalRuntimeAdapterFailure(
      "external_runtime_empty_output",
      "Codex returned no JSONL output",
      { result, execution, diagnostics },
    );
  }
}

export class CodexJsonlAdapter implements AgentRuntimeAdapter {
  readonly id = "codex-jsonl";
  readonly planVisibility = "summary" as const;
  readonly toolEventCompleteness = "partial" as const;
  readonly textStreaming = "message" as const;

  constructor(private readonly options: CodexJsonlAdapterOptions) {}

  async *execute(
    input: RuntimeTaskInput,
    signal: AbortSignal,
  ): AsyncIterable<AgentRuntimeEvent> {
    yield {
      type: "progress",
      summary: "Codex JSONL Runtime 正在执行任务",
    };
    const initialExecution: ExternalRuntimeExecutionMetadata = {
      provider: this.options.provider ?? "codex",
      model: this.options.model ?? "unknown",
      runtimeVersion: "unknown",
      authMode: "unknown",
      sandbox: this.options.sandbox ?? "unknown",
    };
    const result = await runExternalProcess({
      command: this.options.command,
      args: launchArgs(input, this.options),
      cwd: input.workspacePath,
      prompt: input.instruction,
      signal,
      ...(this.options.timeoutMs === undefined
        ? {}
        : { timeoutMs: this.options.timeoutMs }),
      ...(this.options.terminationGraceMs === undefined
        ? {}
        : { terminationGraceMs: this.options.terminationGraceMs }),
      ...(this.options.maxStdoutBytes === undefined
        ? {}
        : { maxStdoutBytes: this.options.maxStdoutBytes }),
      ...(this.options.maxStderrBytes === undefined
        ? {}
        : { maxStderrBytes: this.options.maxStderrBytes }),
    });
    failForProcess(result, initialExecution);
    let parsed: CodexJsonlParseResult;
    try {
      parsed = parseCodexJsonl(result.stdout, {
        provider: this.options.provider ?? "codex",
        ...(this.options.model === undefined
          ? {}
          : { model: this.options.model }),
        ...(this.options.sandbox === undefined
          ? {}
          : { sandbox: this.options.sandbox }),
      });
    } catch (error) {
      if (error instanceof ExternalRuntimeAdapterFailure) {
        throw new ExternalRuntimeAdapterFailure(error.code, error.message, {
          result,
          execution: initialExecution,
          diagnostics: externalProcessDiagnostics(result),
        });
      }
      throw error;
    }
    for (const event of parsed.events) yield event;
    if (result.stderr.trim() !== "") {
      yield {
        type: "warning",
        summary: `Codex stderr：${boundedDiagnostic(result.stderr)}${
          result.stderrTruncated ? " [truncated]" : ""
        }`,
      };
    }
    if (parsed.fatalError !== undefined) {
      throw new ExternalRuntimeAdapterFailure(
        "external_runtime_protocol_error",
        `Codex reported an error: ${boundedDiagnostic(parsed.fatalError)}`,
        {
          result,
          execution: parsed.execution,
          diagnostics: externalProcessDiagnostics(result),
        },
      );
    }
    if (parsed.output.trim() === "") {
      throw new ExternalRuntimeAdapterFailure(
        "external_runtime_empty_output",
        "Codex completed without a final assistant message",
        {
          result,
          execution: parsed.execution,
          diagnostics: externalProcessDiagnostics(result),
        },
      );
    }
    yield {
      type: "completed",
      output: parsed.output,
      execution: parsed.execution,
      diagnostics: externalProcessDiagnostics(result),
    };
  }
}
