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
} from "./external-process.js";
import type {
  ExternalRuntimeExecutionMetadata,
  ExternalRuntimeLimitOptions,
} from "./external-runtime-types.js";

export interface PlainTextAdapterOptions extends ExternalRuntimeLimitOptions {
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly provider?: string | undefined;
  readonly sandbox?: string | undefined;
}

function executionMetadata(
  options: PlainTextAdapterOptions,
): ExternalRuntimeExecutionMetadata {
  return {
    provider: options.provider ?? "command",
    model: "unknown",
    runtimeVersion: "unknown",
    authMode: "unknown",
    sandbox: options.sandbox ?? "unknown",
  };
}

export class PlainTextAdapter implements AgentRuntimeAdapter {
  readonly id = "plain-text";
  readonly planVisibility = "opaque" as const;
  readonly toolEventCompleteness = "none" as const;
  readonly textStreaming = "final-only" as const;

  constructor(private readonly options: PlainTextAdapterOptions) {}

  async *execute(
    input: RuntimeTaskInput,
    signal: AbortSignal,
  ): AsyncIterable<AgentRuntimeEvent> {
    const execution = executionMetadata(this.options);
    yield {
      type: "progress",
      summary: "Plain-text Runtime 正在执行任务",
    };
    const result = await runExternalProcess({
      command: this.options.command,
      args: this.options.args ?? [],
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
    const diagnostics = externalProcessDiagnostics(result);
    if (result.exitCode !== 0 || result.exitSignal !== null) {
      const status =
        result.exitSignal === null
          ? `exit code ${result.exitCode ?? "unknown"}`
          : `signal ${result.exitSignal}`;
      throw new ExternalRuntimeAdapterFailure(
        "external_runtime_exit",
        `plain-text process failed with ${status}${
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
        "plain-text stdout exceeded its configured output limit",
        { result, execution, diagnostics },
      );
    }
    const output = result.stdout.trim();
    if (output === "") {
      throw new ExternalRuntimeAdapterFailure(
        "external_runtime_empty_output",
        "plain-text process completed without stdout output",
        { result, execution, diagnostics },
      );
    }
    if (result.stderr.trim() !== "") {
      yield {
        type: "warning",
        summary: `Plain-text stderr：${boundedDiagnostic(result.stderr)}${
          result.stderrTruncated ? " [truncated]" : ""
        }`,
      };
    }
    yield {
      type: "completed",
      output,
      execution,
      diagnostics,
    };
  }
}
