import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import type {
  ExternalRuntimeLimitOptions,
  ExternalRuntimeProcessDiagnostics,
} from "./external-runtime-types.js";

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

const inheritedEnvironmentKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  ...(process.platform === "win32"
    ? ["SystemRoot", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]
    : []),
] as const;

export type ExternalProcessFailureCode =
  | "external_runtime_cancelled"
  | "external_runtime_timeout"
  | "external_runtime_spawn_failed";

export class ExternalProcessFailure extends Error {
  constructor(
    readonly code: ExternalProcessFailureCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ExternalProcessFailure";
  }
}

export interface ExternalProcessOptions extends ExternalRuntimeLimitOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly prompt: string;
  readonly signal?: AbortSignal | undefined;
}

export interface ExternalProcessResult {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly stdinBytes: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export function externalProcessDiagnostics(
  result: ExternalProcessResult,
): ExternalRuntimeProcessDiagnostics {
  const stderrExcerpt = boundedDiagnostic(result.stderr);
  return {
    exitCode: result.exitCode,
    exitSignal: result.exitSignal,
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    ...(stderrExcerpt === "" ? {} : { stderrExcerpt }),
  };
}

export function boundedDiagnostic(value: string, maxLength = 2_000): string {
  const normalized = value
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}... [truncated ${
    normalized.length - maxLength
  } chars]`;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return resolved;
}

function safeEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of inheritedEnvironmentKeys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (environment.PATH === undefined) {
    environment.PATH = "/usr/local/bin:/usr/bin:/bin";
  }
  if (environment.LANG === undefined) environment.LANG = "C.UTF-8";
  if (environment.TZ === undefined) environment.TZ = "UTC";
  return environment;
}

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  truncated = false;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    const remaining = this.limit - this.capturedBytes;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    const captured = chunk.subarray(0, remaining);
    this.chunks.push(captured);
    this.capturedBytes += captured.length;
    if (captured.length < chunk.length) this.truncated = true;
  }

  get bytes(): number {
    return this.capturedBytes;
  }

  text(): string {
    return Buffer.concat(this.chunks, this.capturedBytes).toString("utf8");
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if the group has already been reaped.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may have exited between the check and the signal.
  }
}

export function runExternalProcess(
  options: ExternalProcessOptions,
): Promise<ExternalProcessResult> {
  const command = options.command.trim();
  if (command === "") {
    return Promise.reject(
      new ExternalProcessFailure(
        "external_runtime_spawn_failed",
        "external runtime command must not be empty",
      ),
    );
  }
  const signal = options.signal;
  if (signal?.aborted === true) {
    return Promise.reject(
      new ExternalProcessFailure(
        "external_runtime_cancelled",
        "external runtime was cancelled before spawn",
        signal.reason,
      ),
    );
  }

  let timeoutMs: number;
  let terminationGraceMs: number;
  let maxStdoutBytes: number;
  let maxStderrBytes: number;
  try {
    timeoutMs = positiveInteger(
      options.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      "timeoutMs",
    );
    terminationGraceMs = nonNegativeInteger(
      options.terminationGraceMs,
      DEFAULT_TERMINATION_GRACE_MS,
      "terminationGraceMs",
    );
    maxStdoutBytes = positiveInteger(
      options.maxStdoutBytes,
      DEFAULT_MAX_STDOUT_BYTES,
      "maxStdoutBytes",
    );
    maxStderrBytes = positiveInteger(
      options.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
      "maxStderrBytes",
    );
  } catch (error) {
    return Promise.reject(error);
  }

  const cwd = resolve(options.cwd);
  const args = [...options.args];
  const stdout = new BoundedOutput(maxStdoutBytes);
  const stderr = new BoundedOutput(maxStderrBytes);
  const stdinBytes = Buffer.byteLength(options.prompt, "utf8");
  const startedAt = Date.now();

  return new Promise((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd,
        env: safeEnvironment(),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new ExternalProcessFailure(
          "external_runtime_spawn_failed",
          error instanceof Error
            ? error.message
            : "external runtime failed to spawn",
          error,
        ),
      );
      return;
    }

    let settled = false;
    let termination: "cancelled" | "timeout" | undefined;
    let spawnError: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const timeoutTimer = setTimeout(() => {
      requestTermination("timeout");
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };

    const requestTermination = (reason: "cancelled" | "timeout"): void => {
      if (termination !== undefined || child.exitCode !== null) return;
      termination = reason;
      signalProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        signalProcessGroup(child, "SIGKILL");
      }, terminationGraceMs);
    };

    const onAbort = (): void => {
      requestTermination("cancelled");
    };

    const finishWithFailure = (error: ExternalProcessFailure): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
    child.once("error", (error) => {
      spawnError = error;
      if (child.pid === undefined) {
        finishWithFailure(
          new ExternalProcessFailure(
            "external_runtime_spawn_failed",
            error.message,
            error,
          ),
        );
      }
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
    });
    child.stdin?.on("error", () => {
      // A CLI may close stdin before consuming the full prompt.
    });
    child.stdin?.end(Buffer.from(options.prompt, "utf8"));

    child.once("close", (exitCode, exitSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (termination === "cancelled") {
        reject(
          new ExternalProcessFailure(
            "external_runtime_cancelled",
            "external runtime was cancelled",
            signal?.reason,
          ),
        );
        return;
      }
      if (termination === "timeout") {
        reject(
          new ExternalProcessFailure(
            "external_runtime_timeout",
            `external runtime exceeded ${timeoutMs}ms`,
          ),
        );
        return;
      }
      if (spawnError !== undefined) {
        reject(
          new ExternalProcessFailure(
            "external_runtime_spawn_failed",
            spawnError.message,
            spawnError,
          ),
        );
        return;
      }
      resolvePromise({
        command,
        args,
        cwd,
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode,
        exitSignal,
        durationMs: Date.now() - startedAt,
        stdinBytes,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });
  });
}
