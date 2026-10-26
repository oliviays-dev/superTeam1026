import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExternalProcess } from "./index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const fixture = resolve(
  import.meta.dirname,
  "../test-fixtures/external-cli.mjs",
);
const workspaces: string[] = [];

async function workspace(): Promise<string> {
  const root = join(repositoryRoot, ".tmp");
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(join(root, "agent-runtime-process-"));
  workspaces.push(path);
  return path;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error("condition was not met before timeout");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    workspaces
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("runExternalProcess", () => {
  it("passes argv literally without shell expansion", async () => {
    const cwd = await workspace();
    const tokens = [
      "semi;colon",
      "$(printf injected)",
      "pipe|value",
      "redirect>value",
      "single'quote",
      'double"quote',
    ];
    const result = await runExternalProcess({
      command: process.execPath,
      args: [fixture, "echo-argv", ...tokens],
      cwd,
      prompt: "unused",
      timeoutMs: 2_000,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).argv).toEqual(["echo-argv", ...tokens]);
  });

  it("captures exit codes and signals", async () => {
    const cwd = await workspace();
    const failed = await runExternalProcess({
      command: process.execPath,
      args: [fixture, "plain", "fail"],
      cwd,
      prompt: "",
      timeoutMs: 2_000,
    });
    expect(failed.exitCode).toBe(4);
    expect(failed.stderr).toContain("plain fixture failed");

    const signalled = await runExternalProcess({
      command: process.execPath,
      args: [fixture, "plain", "signal"],
      cwd,
      prompt: "",
      timeoutMs: 2_000,
    });
    expect(signalled.exitCode).toBeNull();
    expect(signalled.exitSignal).toBe("SIGTERM");
  });

  it("bounds stdout and reports truncation", async () => {
    const cwd = await workspace();
    const result = await runExternalProcess({
      command: process.execPath,
      args: [fixture, "stdout-large", "4096"],
      cwd,
      prompt: "",
      timeoutMs: 2_000,
      maxStdoutBytes: 128,
    });

    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(128);
    expect(result.stdoutBytes).toBe(128);
  });

  it("terminates a stubborn process group on cancellation", async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("fixture cancellation")), 50);

    await expect(
      runExternalProcess({
        command: process.execPath,
        args: [fixture, "plain", "stubborn"],
        cwd,
        prompt: "",
        signal: controller.signal,
        timeoutMs: 5_000,
        terminationGraceMs: 25,
      }),
    ).rejects.toMatchObject({
      code: "external_runtime_cancelled",
    });
  });

  it.skipIf(process.platform === "win32")(
    "terminates stubborn descendants in the POSIX process group",
    async () => {
      const cwd = await workspace();
      const pidFile = join(cwd, "child.pid");
      const controller = new AbortController();
      let descendantPid: number | undefined;
      const running = runExternalProcess({
        command: process.execPath,
        args: [fixture, "plain", "stubborn-tree", pidFile],
        cwd,
        prompt: "",
        signal: controller.signal,
        timeoutMs: 5_000,
        terminationGraceMs: 25,
      });
      try {
        await waitFor(async () => {
          try {
            descendantPid = Number(await readFile(pidFile, "utf8"));
            return Number.isInteger(descendantPid) && descendantPid > 0;
          } catch {
            return false;
          }
        });
        expect(processIsAlive(descendantPid!)).toBe(true);
        controller.abort(new Error("fixture group cancellation"));

        await expect(running).rejects.toMatchObject({
          code: "external_runtime_cancelled",
        });
        await waitFor(() => !processIsAlive(descendantPid!));
      } finally {
        controller.abort(new Error("fixture group test cleanup"));
        await running.catch(() => undefined);
        if (descendantPid !== undefined && processIsAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
      }
    },
  );

  it("terminates a stubborn process group on timeout", async () => {
    const cwd = await workspace();
    await expect(
      runExternalProcess({
        command: process.execPath,
        args: [fixture, "plain", "stubborn"],
        cwd,
        prompt: "",
        timeoutMs: 50,
        terminationGraceMs: 25,
      }),
    ).rejects.toMatchObject({
      code: "external_runtime_timeout",
    });
  });
});
