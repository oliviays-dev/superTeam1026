import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { PlatformRepositories } from "@pluginmax/database";

const PROBE_ARGV = ["--version"] as const;
const MAX_CAPTURED_BYTES = 64 * 1024;

function safeEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "",
    TZ: process.env.TZ ?? "UTC",
    ...(process.platform === "win32"
      ? { SystemRoot: process.env.SystemRoot ?? "" }
      : {}),
  };
}

function sanitizeOutput(value: string): string {
  return value
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, 2_000);
}

function appendCaptured(
  current: string,
  chunk: Buffer | string,
): string {
  if (Buffer.byteLength(current, "utf8") >= MAX_CAPTURED_BYTES) return current;
  const next = current + chunk.toString();
  return Buffer.from(next, "utf8").subarray(0, MAX_CAPTURED_BYTES).toString();
}

export interface RuntimeProbeServiceOptions {
  readonly owner: string;
  readonly workspaceRoot: string;
  readonly timeoutMs: number;
  readonly leaseSeconds: number;
}

export class RuntimeProbeService {
  constructor(
    private readonly repositories: PlatformRepositories,
    private readonly options: RuntimeProbeServiceOptions,
    private readonly log?: (
      event: string,
      data?: Record<string, unknown>,
    ) => void,
  ) {}

  async runOnce(): Promise<number> {
    const claimed = await this.repositories.externalRuntimes.claimProbeJob(
      this.options.owner,
      this.options.leaseSeconds,
    );
    if (claimed === undefined) return 0;
    const workspace = this.workspaceFor(claimed.runtime.id);
    await mkdir(workspace, { recursive: true });
    this.log?.("runtime_probe.started", {
      jobId: claimed.jobId,
      probeId: claimed.probe.id,
      runtimeId: claimed.runtime.id,
      revision: claimed.runtime.revision,
    });
    const execution = await this.execute(
      claimed.runtime.command,
      workspace,
    );
    const completed =
      await this.repositories.externalRuntimes.completeProbeJob({
        jobId: claimed.jobId,
        owner: this.options.owner,
        leaseToken: claimed.leaseToken,
        exitCode: execution.exitCode,
        timedOut: execution.timedOut,
        stdoutExcerpt: execution.stdout,
        stderrExcerpt: execution.stderr,
        ...(execution.errorCode === undefined
          ? {}
          : { errorCode: execution.errorCode }),
        ...(execution.errorMessage === undefined
          ? {}
          : { errorMessage: execution.errorMessage }),
      });
    if (!completed) {
      this.log?.("runtime_probe.claim_lost", {
        jobId: claimed.jobId,
        probeId: claimed.probe.id,
      });
      return 1;
    }
    this.log?.(
      execution.exitCode === 0 && !execution.timedOut
        ? "runtime_probe.completed"
        : "runtime_probe.failed",
      {
        jobId: claimed.jobId,
        probeId: claimed.probe.id,
        runtimeId: claimed.runtime.id,
        exitCode: execution.exitCode,
        timedOut: execution.timedOut,
        durationMs: execution.durationMs,
      },
    );
    return 1;
  }

  private workspaceFor(runtimeId: string): string {
    const root = resolve(this.options.workspaceRoot);
    const workspace = resolve(root, runtimeId);
    const pathFromRoot = relative(root, workspace);
    if (
      pathFromRoot === "" ||
      pathFromRoot.startsWith("..") ||
      isAbsolute(pathFromRoot)
    ) {
      throw new Error("runtime probe workspace escaped its configured root");
    }
    return workspace;
  }

  private execute(
    command: string,
    cwd: string,
  ): Promise<{
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly stdout: string;
    readonly stderr: string;
    readonly durationMs: number;
    readonly errorCode?: string;
    readonly errorMessage?: string;
  }> {
    return new Promise((resolvePromise) => {
      const startedAt = Date.now();
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let spawnError: Error | undefined;
      const child = spawn(command, [...PROBE_ARGV], {
        cwd,
        env: safeEnvironment(),
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform !== "win32" && child.pid !== undefined) {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          child.kill("SIGKILL");
        }
      }, this.options.timeoutMs);
      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout = appendCaptured(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr = appendCaptured(stderr, chunk);
      });
      child.on("error", (error) => {
        spawnError = error;
      });
      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const stdoutExcerpt = sanitizeOutput(stdout);
        const stderrExcerpt = sanitizeOutput(stderr);
        resolvePromise({
          exitCode,
          timedOut,
          stdout: stdoutExcerpt,
          stderr: stderrExcerpt,
          durationMs: Math.max(0, Date.now() - startedAt),
          ...(spawnError === undefined
            ? {}
            : {
                errorCode: "probe_spawn_failed",
                errorMessage: spawnError.message,
              }),
        });
      };
      child.on("close", finish);
      child.on("error", () => finish(null));
    });
  }
}
