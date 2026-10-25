import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { AgentExecutionMetadata, ExternalAgentRuntime } from "./types.js";

export interface ExternalRunnerRequest {
  readonly runId: string;
  readonly runtime: ExternalAgentRuntime;
  /** Task-level override. Runtime default remains in args when omitted. */
  readonly model?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly prompt: string;
  readonly workspacePath: string;
  readonly signal: AbortSignal;
  readonly onProgress?: (text: string) => void;
  readonly onTrace?: (event: ExternalAgentTraceEvent) => void;
}

export interface ExternalRunnerResult {
  readonly output: ReadonlyArray<{
    readonly type: "text";
    readonly text: string;
  }>;
  readonly stopReason: "completed" | "failed" | "cancelled";
  readonly sessionId?: string | undefined;
  readonly execution?: Partial<AgentExecutionMetadata> | undefined;
  readonly diagnostic?: string | undefined;
}

type ExecutionMetadataPatch = {
  provider?: string | undefined;
  model?: string | undefined;
  reasoningEffort?: string | undefined;
  runtime?: string | undefined;
  runtimeVersion?: string | undefined;
  authMode?: string | undefined;
  sandbox?: string | undefined;
};

export type ExternalAgentTraceKind =
  | "spawn"
  | "stdin"
  | "stdout"
  | "stderr"
  | "error"
  | "close"
  | "session"
  | "thinking"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "result"
  | "retry";

export interface ExternalAgentTraceEvent {
  readonly kind: ExternalAgentTraceKind;
  readonly runId: string;
  readonly runtimeName: string;
  readonly provider: ExternalAgentRuntime["provider"];
  readonly protocol: ExternalAgentRuntime["protocol"];
  readonly command: string;
  readonly args: readonly string[];
  readonly workspacePath: string;
  readonly pid?: number | undefined;
  readonly stdinBytes?: number | undefined;
  readonly data?: string | undefined;
  readonly exitCode?: number | null | undefined;
  readonly exitSignal?: string | null | undefined;
  readonly durationMs?: number | undefined;
  readonly message?: string | undefined;
}

export type ExternalAgentTraceListener = (
  event: ExternalAgentTraceEvent,
) => void;

export type ExternalAgentRuntimeTraceAction =
  | "register"
  | "update"
  | "probe"
  | "enable"
  | "disable"
  | "archive"
  | "restore";

export interface ExternalAgentRuntimeTraceEvent {
  readonly action: ExternalAgentRuntimeTraceAction;
  readonly runtime: ExternalAgentRuntime;
  readonly actorUserId?: string | undefined;
  readonly previousStatus?: ExternalAgentRuntime["status"] | undefined;
  readonly message?: string | undefined;
  readonly fields?: Readonly<Record<string, unknown>> | undefined;
}

export type ExternalAgentRuntimeTraceListener = (
  event: ExternalAgentRuntimeTraceEvent,
) => void;

function traceField(value: unknown): string {
  if (value === undefined || value === null || value === "") return '""';
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (normalized === "") return '""';
  return /^[A-Za-z0-9._/@:+-]+$/.test(normalized)
    ? normalized
    : JSON.stringify(normalized);
}

/** Writes execution evidence to the terminal hosting the DSH service. */
export const terminalExternalAgentTrace: ExternalAgentTraceListener = (
  event,
) => {
  try {
    const header = [
      `[外部Agent]`,
      `run=${event.runId}`,
      `agent=${event.runtimeName}`,
      ...(event.pid === undefined ? [] : [`pid=${event.pid}`]),
    ].join(" ");
    const body =
      event.kind === "spawn"
        ? `${event.command} ${event.args.join(" ")} (cwd=${event.workspacePath})`
        : event.kind === "stdin"
          ? `stdin 已写入 ${event.stdinBytes ?? 0} 字节`
          : event.kind === "close"
            ? `exit=${event.exitCode ?? "-"} signal=${event.exitSignal ?? "-"} duration=${event.durationMs ?? 0}ms`
            : (event.data ?? event.message ?? "");
    const indented = body.replace(/\r/g, "").replace(/\n/g, "\n  ");
    process.stderr.write(`${header} ${event.kind}: ${indented}\n`);
  } catch {
    // Terminal tracing is best-effort and must never affect task execution.
  }
};

/** Runtime governance actions are logged separately from task execution runs. */
export const terminalExternalAgentRuntimeTrace: ExternalAgentRuntimeTraceListener =
  (event) => {
    try {
      const runtime = event.runtime;
      const fields = [
        `action=${event.action}`,
        `runtime=${runtime.id}`,
        `name=${traceField(runtime.name)}`,
        `provider=${runtime.provider}`,
        `protocol=${runtime.protocol}`,
        `status=${runtime.status}`,
        ...(event.previousStatus === undefined
          ? []
          : [`previous=${event.previousStatus}`]),
        ...(runtime.workspaceId === undefined
          ? []
          : [`workspace=${runtime.workspaceId}`]),
        ...(event.actorUserId === undefined
          ? []
          : [`actor=${event.actorUserId}`]),
        ...(event.message === undefined
          ? []
          : [`message=${traceField(event.message)}`]),
        ...Object.entries(event.fields ?? {}).map(
          ([key, value]) => `${key}=${traceField(value)}`,
        ),
      ];
      process.stderr.write(`[外部Agent治理] ${fields.join(" ")}\n`);
    } catch {
      // Runtime audit tracing is best-effort and must never block management.
    }
  };

export interface ExternalAgentRunner {
  progress(runId: string): string | undefined;
  execute(request: ExternalRunnerRequest): Promise<ExternalRunnerResult>;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as JsonRecord)
    : undefined;
}

function collectText(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.trim() !== "") found.push(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, found);
    return found;
  }
  const record = asRecord(value);
  if (record === undefined) return found;
  for (const key of ["text", "message", "content", "delta", "summary"]) {
    if (key in record) collectText(record[key], found);
  }
  return found;
}

function findSessionId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  for (const key of ["sessionId", "session_id", "threadId", "thread_id"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  for (const child of Object.values(record)) {
    const nested = findSessionId(child);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function executionMetadata(
  runtime: ExternalAgentRuntime,
  details: ExecutionMetadataPatch = {},
): Partial<AgentExecutionMetadata> {
  return {
    provider: details.provider ?? runtime.provider,
    model: details.model ?? "unknown",
    ...(details.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: details.reasoningEffort }),
    runtime: details.runtime ?? runtime.name,
    runtimeVersion: details.runtimeVersion ?? "unknown",
    authMode: details.authMode ?? "unknown",
    sandbox: details.sandbox ?? "unknown",
  };
}

function codexSandboxLabel(value: unknown): string | undefined {
  const payload = asRecord(value);
  if (payload === undefined) return undefined;
  const sandboxPolicy = asRecord(payload.sandbox_policy);
  const permissionProfile = asRecord(payload.permission_profile);
  const mode =
    asString(sandboxPolicy?.type) ??
    asString(permissionProfile?.type) ??
    "unknown";
  const network =
    asString(permissionProfile?.network) ??
    asString(permissionProfile?.network_access);
  return network === undefined ? mode : `${mode} / network ${network}`;
}

interface CodexSessionMetadata {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly runtimeVersion?: string | undefined;
  readonly sandbox?: string | undefined;
}

function dateParts(value: Date): readonly [string, string, string] {
  return [
    String(value.getFullYear()),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ];
}

async function findCodexSessionFile(input: {
  readonly threadId: string;
  readonly codexHome: string;
  readonly at: Date;
}): Promise<string | undefined> {
  const sessionsRoot = join(input.codexHome, "sessions");
  for (let offset = 0; offset < 10; offset += 1) {
    for (const dayOffset of [-1, 0, 1]) {
      const date = new Date(input.at);
      date.setDate(date.getDate() + dayOffset);
      const [year, month, day] = dateParts(date);
      const directory = join(sessionsRoot, year, month, day);
      const names = await readdir(directory).catch(() => []);
      const match = names.find(
        (name) =>
          name.startsWith("rollout-") &&
          name.endsWith(`-${input.threadId}.jsonl`),
      );
      if (match !== undefined) return join(directory, match);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

async function readCodexSessionMetadata(input: {
  readonly threadId: string | undefined;
  readonly codexHome: string;
  readonly at: Date;
}): Promise<CodexSessionMetadata> {
  if (input.threadId === undefined) return {};
  const path = await findCodexSessionFile({
    threadId: input.threadId,
    codexHome: input.codexHome,
    at: input.at,
  });
  if (path === undefined) return {};
  let provider: string | undefined;
  let model: string | undefined;
  let runtimeVersion: string | undefined;
  let sandbox: string | undefined;
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim() === "") continue;
      let event: JsonRecord;
      try {
        const parsed = asRecord(JSON.parse(line));
        if (parsed === undefined) continue;
        event = parsed;
      } catch {
        continue;
      }
      const payload = asRecord(event.payload);
      if (event.type === "session_meta" && payload !== undefined) {
        provider = asString(payload.model_provider) ?? provider;
        runtimeVersion = asString(payload.cli_version) ?? runtimeVersion;
      }
      if (event.type === "turn_context" && payload !== undefined) {
        model = asString(payload.model) ?? model;
        sandbox = codexSandboxLabel(payload) ?? sandbox;
      }
      if (
        provider !== undefined &&
        model !== undefined &&
        runtimeVersion !== undefined &&
        sandbox !== undefined
      ) {
        break;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return { provider, model, runtimeVersion, sandbox };
}

function probeCodexAuthMode(command: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      ["login", "status"],
      { timeout: 2_500, maxBuffer: 64 * 1024 },
      (_error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.toLowerCase();
        if (output.includes("logged in using an api key")) {
          resolve("api-key");
          return;
        }
        if (
          output.includes("logged in using chatgpt") ||
          output.includes("chatgpt account")
        ) {
          resolve("chatgpt");
          return;
        }
        if (output.includes("not logged in")) {
          resolve("none");
          return;
        }
        resolve("unknown");
      },
    );
  });
}

function compactTraceText(value: string, maxLength = 4_000): string {
  const normalized = value.trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength)}... [truncated ${normalized.length - maxLength} chars]`;
}

function workbuddyStreamArgs(args: readonly string[]): string[] {
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--output-format") {
      index += 1;
      continue;
    }
    if (arg?.startsWith("--output-format=") === true) continue;
    if (arg === "--print" || arg === "-p") continue;
    if (arg !== undefined) normalized.push(arg);
  }
  normalized.push("--print", "--output-format", "stream-json");
  return normalized;
}

function stripManagedArgs(
  args: readonly string[],
  options: {
    readonly model?: boolean | undefined;
    readonly reasoning?: boolean | undefined;
    readonly provider?: ExternalAgentRuntime["provider"] | undefined;
  },
): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (options.model === true) {
      if (token === "--model" || token === "-m") {
        index += 1;
        continue;
      }
      if (token?.startsWith("--model=") === true) continue;
    }
    if (options.provider === "workbuddy" && options.reasoning === true) {
      if (token === "--effort") {
        index += 1;
        continue;
      }
      if (token?.startsWith("--effort=") === true) continue;
    }
    if (
      options.reasoning === true &&
      (token === "-c" || token === "--config")
    ) {
      const next = args[index + 1] ?? "";
      if (next.startsWith("model_reasoning_effort=")) {
        index += 1;
        continue;
      }
    }
    if (
      options.reasoning === true &&
      (token?.startsWith("-c=model_reasoning_effort=") === true ||
        token?.startsWith("--config=model_reasoning_effort=") === true)
    ) {
      continue;
    }
    if (token !== undefined) result.push(token);
  }
  return result;
}

function launchArgs(
  runtime: ExternalAgentRuntime,
  request: ExternalRunnerRequest,
): string[] {
  let args = stripManagedArgs(runtime.args, {
    model: request.model !== undefined,
    reasoning:
      request.reasoningEffort !== undefined && runtime.provider === "codex",
    provider: runtime.provider,
  });
  if (request.model !== undefined) args.push("--model", request.model);
  if (request.reasoningEffort !== undefined) {
    if (runtime.provider === "codex") {
      args.push(
        "-c",
        `model_reasoning_effort="${request.reasoningEffort.replaceAll('"', '\\"')}"`,
      );
    } else if (runtime.provider === "workbuddy") {
      args = stripManagedArgs(args, {
        reasoning: true,
        provider: runtime.provider,
      });
      args.push("--effort", request.reasoningEffort);
    }
  }
  return args;
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function isTransientWorkBuddyFailure(result: ExternalRunnerResult): boolean {
  if (result.stopReason !== "failed") return false;
  const diagnostic = result.diagnostic?.toLowerCase() ?? "";
  return [
    "502",
    "503",
    "504",
    "429",
    "tls",
    "socket disconnected",
    "connection reset",
    "econnreset",
    "etimedout",
    "eai_again",
    "network error",
    "temporarily unavailable",
  ].some((pattern) => diagnostic.includes(pattern));
}

export class ExternalAgentProcessRunner implements ExternalAgentRunner {
  private readonly progressByRun = new Map<string, string>();

  constructor(
    private readonly options: {
      readonly onTrace?: ExternalAgentTraceListener | undefined;
      readonly maxWorkBuddyAttempts?: number | undefined;
      readonly retryDelayMs?: number | undefined;
      readonly codexHome?: string | undefined;
      readonly inspectCodexAuth?:
        ((command: string) => Promise<string>) | undefined;
    } = {},
  ) {}

  progress(runId: string): string | undefined {
    return this.progressByRun.get(runId);
  }

  private commandAndArgs(
    runtime: ExternalAgentRuntime,
    request: ExternalRunnerRequest,
    outputFileName: string | undefined,
  ): { readonly command: string; readonly args: string[] } {
    const args = launchArgs(runtime, request);
    if (runtime.protocol === "codex-jsonl") {
      return {
        command: runtime.command,
        args: [
          ...args,
          "exec",
          "--json",
          "--cd",
          request.workspacePath,
          "--sandbox",
          "read-only",
          ...(outputFileName === undefined
            ? []
            : ["--output-last-message", outputFileName]),
          "-",
        ],
      };
    }
    return {
      command: runtime.command,
      args: runtime.provider === "workbuddy" ? workbuddyStreamArgs(args) : args,
    };
  }

  async execute(request: ExternalRunnerRequest): Promise<ExternalRunnerResult> {
    if (request.signal.aborted) {
      return { output: [], stopReason: "cancelled" };
    }
    if (request.runtime.protocol === "codex-jsonl") {
      return await this.executeCodex(request);
    }
    if (request.runtime.provider === "workbuddy") {
      return await this.executeWorkBuddyWithRetry(request);
    }
    return await this.executePlainText(request);
  }

  private async executeWorkBuddyWithRetry(
    request: ExternalRunnerRequest,
  ): Promise<ExternalRunnerResult> {
    const { command, args } = this.commandAndArgs(
      request.runtime,
      request,
      undefined,
    );
    const maxAttempts = Math.max(
      1,
      Math.trunc(this.options.maxWorkBuddyAttempts ?? 3),
    );
    let result = await this.executeWorkBuddyStream(request);
    for (
      let attempt = 2;
      attempt <= maxAttempts && isTransientWorkBuddyFailure(result);
      attempt += 1
    ) {
      if (request.signal.aborted) {
        return { output: [], stopReason: "cancelled" };
      }
      const message = `WorkBuddy 瞬时连接失败，正在自动重试（${attempt}/${maxAttempts}）`;
      const retryEvent: ExternalAgentTraceEvent = {
        runId: request.runId,
        runtimeName: request.runtime.name,
        provider: request.runtime.provider,
        protocol: request.runtime.protocol,
        command,
        args,
        workspacePath: request.workspacePath,
        kind: "retry",
        data: message,
      };
      this.options.onTrace?.(retryEvent);
      request.onTrace?.(retryEvent);
      this.appendProgress(request.runId, `[retry] ${message}\n`);
      request.onProgress?.(this.progressByRun.get(request.runId) ?? "");
      await this.waitForRetry(
        (this.options.retryDelayMs ?? 1_500) * (attempt - 1),
        request.signal,
      );
      if (request.signal.aborted) {
        return { output: [], stopReason: "cancelled" };
      }
      result = await this.executeWorkBuddyStream(request);
    }
    return result;
  }

  private async waitForRetry(
    delayMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (delayMs <= 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, delayMs);
      function finish(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      }
      signal.addEventListener("abort", finish, { once: true });
    });
  }

  private async executeCodex(
    request: ExternalRunnerRequest,
  ): Promise<ExternalRunnerResult> {
    const directory = await mkdtemp(join(tmpdir(), "dsh-external-agent-"));
    const outputFile = join(directory, "last-message.md");
    const authModePromise = (
      this.options.inspectCodexAuth ?? probeCodexAuthMode
    )(request.runtime.command).catch(() => "unknown");
    const reportTrace = (kind: ExternalAgentTraceKind, data: string): void => {
      request.onTrace?.({
        runId: request.runId,
        runtimeName: request.runtime.name,
        provider: request.runtime.provider,
        protocol: request.runtime.protocol,
        command: request.runtime.command,
        args: request.runtime.args,
        workspacePath: request.workspacePath,
        kind,
        data,
      });
    };
    try {
      await writeFile(outputFile, "", { encoding: "utf8" });
      const { command, args } = this.commandAndArgs(
        request.runtime,
        request,
        outputFile,
      );
      const execution = await this.spawnAndCollect({
        ...request,
        runtimeName: request.runtime.name,
        provider: request.runtime.provider,
        protocol: request.runtime.protocol,
        command,
        args,
        captureStdoutAsOutput: false,
        allowEmptyStdout: true,
        onStdoutLine: (line) => {
          try {
            const event = JSON.parse(line) as unknown;
            const texts = collectText(event);
            if (texts.length > 0) {
              this.appendProgress(request.runId, texts.join("\n"));
              request.onProgress?.(this.progressByRun.get(request.runId) ?? "");
            }
            const record = asRecord(event);
            const item = asRecord(record?.item);
            const itemType = asString(item?.type);
            if (itemType === "reasoning") {
              reportTrace("thinking", "Codex reported a reasoning item");
            } else if (itemType === "command_execution") {
              const command =
                asString(item?.command) ??
                asString(record?.command) ??
                "command";
              reportTrace("tool_call", `exec_command ${command}`);
              const output =
                asString(item?.aggregated_output) ?? asString(item?.output);
              if (output !== undefined) {
                reportTrace("tool_result", output);
              }
            } else if (itemType === "file_change") {
              reportTrace(
                "tool_call",
                `file_change ${compactTraceText(
                  JSON.stringify(item?.changes ?? item ?? {}),
                  1_500,
                )}`,
              );
            } else if (itemType === "agent_message") {
              const message = asString(item?.text);
              if (message !== undefined) {
                reportTrace("assistant", compactTraceText(message));
              }
            }
            return findSessionId(event);
          } catch {
            return undefined;
          }
        },
      });
      const [sessionMetadata, authMode] = await Promise.all([
        readCodexSessionMetadata({
          threadId: execution.sessionId,
          codexHome:
            this.options.codexHome ??
            process.env.CODEX_HOME ??
            join(homedir(), ".codex"),
          at: new Date(),
        }).catch(() => ({})),
        authModePromise,
      ]);
      const metadata = executionMetadata(request.runtime, {
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.reasoningEffort }),
        ...sessionMetadata,
        authMode,
      });
      if (execution.stopReason !== "completed") {
        return { ...execution, execution: metadata };
      }
      const finalText = (await readFile(outputFile, "utf8")).trim();
      if (finalText === "") {
        return {
          output: execution.output,
          stopReason: "failed",
          execution: metadata,
          ...(execution.sessionId === undefined
            ? {}
            : { sessionId: execution.sessionId }),
          diagnostic: "Codex did not return a final message",
        };
      }
      return {
        output: [{ type: "text", text: finalText }],
        stopReason: "completed",
        execution: metadata,
        ...(execution.sessionId === undefined
          ? {}
          : { sessionId: execution.sessionId }),
      };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  private async executeWorkBuddyStream(
    request: ExternalRunnerRequest,
  ): Promise<ExternalRunnerResult> {
    const { command, args } = this.commandAndArgs(
      request.runtime,
      request,
      undefined,
    );
    let resultText = "";
    let sessionId: string | undefined;
    let streamError: string | undefined;
    const assistantParts: string[] = [];
    const executionDetails: ExecutionMetadataPatch = {
      provider: request.runtime.provider,
      runtime: request.runtime.name,
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: request.reasoningEffort }),
    };
    const reportProgress = (kind: string, text: string): void => {
      this.appendProgress(request.runId, `[${kind}] ${text}\n`);
      request.onProgress?.(this.progressByRun.get(request.runId) ?? "");
    };

    const executionResult = await this.spawnAndCollect({
      ...request,
      runtimeName: request.runtime.name,
      provider: request.runtime.provider,
      protocol: request.runtime.protocol,
      command,
      args,
      captureStdoutAsOutput: false,
      allowEmptyStdout: true,
      traceStdout: false,
      onStdoutLine: (line, trace) => {
        let event: JsonRecord | undefined;
        try {
          event = asRecord(JSON.parse(line));
        } catch {
          trace("stdout", compactTraceText(line));
          return undefined;
        }
        if (event === undefined) {
          trace("stdout", compactTraceText(line));
          return undefined;
        }

        const lineSessionId =
          asString(event.session_id) ?? findSessionId(event);
        if (lineSessionId !== undefined) sessionId = lineSessionId;
        const type = asString(event.type);
        const subtype = asString(event.subtype);

        if (type === "system" && subtype === "init") {
          const model = asString(event.model) ?? "unknown";
          executionDetails.model = model;
          const provider =
            asString(event.model_provider) ?? asString(event.provider);
          if (provider !== undefined) executionDetails.provider = provider;
          const runtimeVersion =
            asString(event.runtime_version) ?? asString(event.cli_version);
          if (runtimeVersion !== undefined) {
            executionDetails.runtimeVersion = runtimeVersion;
          }
          const authMode = asString(event.auth_mode);
          if (authMode !== undefined) executionDetails.authMode = authMode;
          const sandbox = asString(event.sandbox);
          if (sandbox !== undefined) executionDetails.sandbox = sandbox;
          const cwd = asString(event.cwd) ?? request.workspacePath;
          const text = `started session=${lineSessionId ?? "-"} model=${model} cwd=${cwd}`;
          trace("session", text);
          reportProgress("session", text);
          return lineSessionId;
        }

        if (type === "assistant") {
          const message = asRecord(event.message);
          const content = Array.isArray(message?.content)
            ? message.content
            : [];
          for (const item of content) {
            const block = asRecord(item);
            const blockType = asString(block?.type);
            if (blockType === "thinking") {
              const thinking = asString(block?.thinking);
              if (thinking !== undefined) {
                // Reasoning text may contain private chain-of-thought. Keep a
                // stable phase marker without persisting or rendering content.
                const summary = "Runtime 报告了新的推理阶段";
                trace("thinking", summary);
                reportProgress("thinking", summary);
              }
              continue;
            }
            if (blockType === "text") {
              const text = asString(block?.text);
              if (text !== undefined) {
                assistantParts.push(text);
                const preview = compactTraceText(text);
                trace("assistant", preview);
                reportProgress("assistant", preview);
              }
              continue;
            }
            if (blockType === "tool_use") {
              const name = asString(block?.name) ?? "unknown";
              const input =
                typeof block?.input === "string"
                  ? block.input
                  : JSON.stringify(block?.input ?? {});
              const text = `${name} ${compactTraceText(input, 1_500)}`;
              trace("tool_call", text);
              reportProgress("tool_call", text);
            }
          }
          return lineSessionId;
        }

        if (type === "user") {
          const message = asRecord(event.message);
          const content = Array.isArray(message?.content)
            ? message.content
            : [];
          for (const item of content) {
            const block = asRecord(item);
            if (asString(block?.type) !== "tool_result") continue;
            const text = collectText(block?.content).join("\n");
            const status = block?.is_error === true ? "error" : "ok";
            const summary = `${status} tool=${asString(block?.tool_use_id) ?? "-"} ${compactTraceText(text, 1_500)}`;
            trace("tool_result", summary);
            reportProgress("tool_result", summary);
          }
          return lineSessionId;
        }

        if (type === "result") {
          resultText = asString(event.result) ?? resultText;
          const failed =
            event.is_error === true ||
            (subtype !== undefined && subtype !== "success");
          if (failed) {
            streamError =
              resultText ||
              compactTraceText(assistantParts.join("\n"), 4_000) ||
              `WorkBuddy stream result failed: ${subtype ?? "unknown"}`;
            trace("error", compactTraceText(streamError));
            reportProgress("error", compactTraceText(streamError));
          } else {
            const text = `success ${compactTraceText(resultText, 2_000)}`;
            trace("result", text);
            reportProgress("result", text);
          }
        }
        return lineSessionId;
      },
    });

    if (executionResult.stopReason !== "completed") {
      return {
        ...executionResult,
        execution: executionMetadata(request.runtime, executionDetails),
      };
    }
    if (streamError !== undefined) {
      return {
        output: [],
        stopReason: "failed",
        execution: executionMetadata(request.runtime, executionDetails),
        ...(sessionId === undefined ? {} : { sessionId }),
        diagnostic: streamError,
      };
    }
    const finalText = resultText.trim() || assistantParts.join("\n").trim();
    if (finalText === "") {
      return {
        output: [],
        stopReason: "failed",
        execution: executionMetadata(request.runtime, executionDetails),
        ...(sessionId === undefined ? {} : { sessionId }),
        diagnostic: "WorkBuddy 未返回可解析的 stream-json 最终结果",
      };
    }
    return {
      output: [{ type: "text", text: finalText }],
      stopReason: "completed",
      execution: executionMetadata(request.runtime, executionDetails),
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }

  private async executePlainText(
    request: ExternalRunnerRequest,
  ): Promise<ExternalRunnerResult> {
    const { command, args } = this.commandAndArgs(
      request.runtime,
      request,
      undefined,
    );
    const result = await this.spawnAndCollect({
      ...request,
      runtimeName: request.runtime.name,
      provider: request.runtime.provider,
      protocol: request.runtime.protocol,
      command,
      args,
      captureStdoutAsOutput: true,
      onStdoutChunk: (chunk) => {
        this.appendProgress(request.runId, chunk);
        request.onProgress?.(this.progressByRun.get(request.runId) ?? "");
      },
    });
    return {
      ...result,
      execution: executionMetadata(request.runtime, {
        ...result.execution,
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: request.reasoningEffort }),
      }),
    };
  }

  private appendProgress(runId: string, text: string): void {
    const current = this.progressByRun.get(runId) ?? "";
    this.progressByRun.set(runId, `${current}${text}`.slice(-60_000));
  }

  private spawnAndCollect(input: {
    readonly runId: string;
    readonly runtimeName: string;
    readonly provider: ExternalAgentRuntime["provider"];
    readonly protocol: ExternalAgentRuntime["protocol"];
    readonly command: string;
    readonly args: readonly string[];
    readonly prompt: string;
    readonly signal: AbortSignal;
    readonly workspacePath: string;
    readonly captureStdoutAsOutput: boolean;
    readonly allowEmptyStdout?: boolean | undefined;
    readonly traceStdout?: boolean | undefined;
    readonly onStdoutLine?:
      | ((
          line: string,
          trace: (kind: ExternalAgentTraceKind, data: string) => void,
        ) => string | undefined)
      | undefined;
    readonly onStdoutChunk?: (chunk: string) => void;
    readonly onTrace?: (event: ExternalAgentTraceEvent) => void;
  }): Promise<ExternalRunnerResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let sessionId: string | undefined;
      let lineBuffer = "";
      let settled = false;
      const startedAt = Date.now();
      const trace = (
        event: Omit<
          ExternalAgentTraceEvent,
          | "runId"
          | "runtimeName"
          | "provider"
          | "protocol"
          | "command"
          | "args"
          | "workspacePath"
        >,
      ): void => {
        const eventWithContext: ExternalAgentTraceEvent = {
          runId: input.runId,
          runtimeName: input.runtimeName,
          provider: input.provider,
          protocol: input.protocol,
          command: input.command,
          args: input.args,
          workspacePath: input.workspacePath,
          ...event,
        };
        this.options.onTrace?.(eventWithContext);
        input.onTrace?.(eventWithContext);
      };
      const child = spawn(input.command, [...input.args], {
        cwd: input.workspacePath,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      trace({ kind: "spawn", pid: child.pid });
      const finish = (result: ExternalRunnerResult): void => {
        if (settled) return;
        settled = true;
        input.signal.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = (): void => {
        terminate(child);
        finish({ output: [], stopReason: "cancelled" });
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      child.once("error", (cause: Error) => {
        trace({ kind: "error", message: cause.message });
        finish({
          output: [],
          stopReason: "failed",
          ...(sessionId === undefined ? {} : { sessionId }),
          diagnostic: cause.message,
        });
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = `${stdout}${chunk}`.slice(-120_000);
        if (input.traceStdout !== false) trace({ kind: "stdout", data: chunk });
        if (input.onStdoutChunk !== undefined) input.onStdoutChunk(chunk);
        if (input.onStdoutLine === undefined) return;
        lineBuffer += chunk;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim() === "") continue;
          const found = input.onStdoutLine(line, (kind, data) =>
            trace({ kind, data }),
          );
          if (found !== undefined) sessionId = found;
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-20_000);
        trace({ kind: "stderr", data: chunk });
      });
      child.once("close", (code) => {
        trace({
          kind: "close",
          exitCode: code,
          exitSignal: child.signalCode,
          durationMs: Date.now() - startedAt,
        });
        if (input.onStdoutLine !== undefined && lineBuffer.trim() !== "") {
          const found = input.onStdoutLine(lineBuffer, (kind, data) =>
            trace({ kind, data }),
          );
          if (found !== undefined) sessionId = found;
        }
        const outputText = input.captureStdoutAsOutput ? stdout.trim() : "";
        const diagnostic = [stderr.trim(), stdout.trim()].find(
          (value) => value !== "",
        );
        if (code === 0) {
          if (outputText === "" && input.allowEmptyStdout === true) {
            finish({
              output: [],
              stopReason: "completed",
              ...(sessionId === undefined ? {} : { sessionId }),
            });
            return;
          }
          finish({
            output:
              outputText === "" ? [] : [{ type: "text", text: outputText }],
            stopReason: outputText === "" ? "failed" : "completed",
            ...(sessionId === undefined ? {} : { sessionId }),
            ...(outputText === ""
              ? {
                  diagnostic:
                    diagnostic === undefined
                      ? "外部 Agent 未返回可用的文本输出"
                      : `外部 Agent 未返回可用的文本输出：${diagnostic}`,
                }
              : {}),
          });
          return;
        }
        finish({
          output: [],
          stopReason: "failed",
          ...(sessionId === undefined ? {} : { sessionId }),
          diagnostic: `process exited with ${code}${diagnostic === undefined ? "" : `: ${diagnostic}`}`,
        });
      });
      child.stdin.on("error", () => undefined);
      trace({ kind: "stdin", stdinBytes: Buffer.byteLength(input.prompt) });
      child.stdin.end(input.prompt, "utf8");
    });
  }
}

export function externalSessionId(runId: string): string {
  return `external-${runId}-${randomUUID()}`
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 200);
}

export function probeExternalRuntime(
  command: string,
  timeoutMs = 3_000,
): Promise<{
  readonly ok: boolean;
  readonly message: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null | undefined;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let exitCode: number | null | undefined;
    const child = spawn(command, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (ok: boolean, message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok,
        message: message.slice(0, 500),
        command,
        args: ["--version"],
        exitCode,
        durationMs: Date.now() - startedAt,
        stdout: stdout.trim().slice(0, 1_000),
        stderr: stderr.trim().slice(0, 1_000),
      });
    };
    const timer = setTimeout(() => {
      terminate(child);
      finish(false, "探测超时：命令未在 3 秒内返回 --version");
    }, timeoutMs);
    child.once("error", (cause: Error) => finish(false, cause.message));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("close", (code) => {
      exitCode = code;
      finish(
        code === 0,
        code === 0
          ? "命令可用"
          : `命令退出码 ${code}${stderr.trim() === "" ? "" : `：${stderr.trim()}`}`,
      );
    });
  });
}
