import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, expectTypeOf, it, describe } from "vitest";
import {
  DeepSeekHarness,
  HarnessClient,
  type DeepSeekHarnessOptions,
  type HarnessClientOptions,
  type HarnessNotification,
  type RunResult,
  type SdkPromptContentBlock,
} from "@deepseek-ai/dsh-sdk-client";
import { KNOWN_NOTIFICATION_METHODS, mapDshNotification } from "./dsh-sdk.js";

const execFileAsync = promisify(execFile);
const fakeRuntime = fileURLToPath(
  new URL(
    "../../../vendor/deepseek-harness/packages/sdk/client/tests/fake-runtime.ts",
    import.meta.url,
  ),
);

type RuntimeProcessOptions = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment: () => NodeJS.ProcessEnv;
  readonly description: string;
  readonly initializeTimeoutMs: number;
};

const ProcessHarnessClient = HarnessClient as unknown as new (
  options: HarnessClientOptions,
  runtime: RuntimeProcessOptions,
) => HarnessClient;
const ProcessHarness = DeepSeekHarness as unknown as new (
  options: DeepSeekHarnessOptions,
  clientFactory: () => HarnessClient,
) => DeepSeekHarness;

describe("DSH SDK contract", () => {
  it("C1 accepts every launch option consumed by DshSdkAdapter", () => {
    const options = {
      dshBin: ".tmp/dsh-fixture/bin.js",
      profile: "contract",
      dshHome: ".tmp/dsh-contract-home",
      cwd: ".tmp/dsh-contract-workspace",
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      maxTokens: 4_000,
      requestTimeoutMs: 30 * 60_000,
    } satisfies DeepSeekHarnessOptions;

    expect(new DeepSeekHarness(options)).toBeInstanceOf(DeepSeekHarness);
  });

  it("C2/C3 runs with sessionId and notification callback and returns finalResponse", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-contract-"));
    const cwd = join(root, "workspace");
    const initRecord = join(root, "initialize.jsonl");
    await mkdir(cwd);
    const runtime: RuntimeProcessOptions = {
      command: process.execPath,
      args: [fakeRuntime],
      cwd,
      environment: () => ({
        ...process.env,
        FAKE_TEXT: "contract-final-response",
        FAKE_RECORD_INIT: initRecord,
      }),
      description: "DSH contract fake runtime",
      initializeTimeoutMs: 10_000,
    };

    const options: DeepSeekHarnessOptions = {
      cwd,
      provider: "contract-provider",
      model: "contract-model",
      maxTokens: 1_234,
    };
    const harness = new ProcessHarness(
      options,
      () => new ProcessHarnessClient({}, runtime),
    );
    const notifications: HarnessNotification[] = [];
    try {
      const run: (
        input: string | SdkPromptContentBlock[],
        runOptions?: {
          sessionId?: string;
          onNotification?: (notification: HarnessNotification) => void;
        },
      ) => Promise<RunResult> = harness.run.bind(harness);

      const result = await run("contract input", {
        sessionId: "contract-session",
        onNotification: (notification) => {
          notifications.push(notification);
        },
      });

      expect(result.sessionId).toBe("contract-session");
      expect(result.finalResponse).toBe("contract-final-response");
      expectTypeOf<RunResult["finalResponse"]>().toEqualTypeOf<string>();
      expect(result.notifications).toEqual(notifications);

      const records = (await readFile(initRecord, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records[0]).toMatchObject({
        cwd,
        provider: "contract-provider",
        model: "contract-model",
        maxTokens: 1_234,
      });
    } finally {
      await harness.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("C4 accepts the documented notification method whitelist", () => {
    const methods = [
      "session.status",
      "subagent.started",
      "subagent.finished",
      "session.event",
    ] as const;

    expect([...KNOWN_NOTIFICATION_METHODS].sort()).toEqual([...methods].sort());
    for (const method of methods) {
      const events = mapDshNotification({ method, params: {} });
      expect(events.some((event) => event.type === "warning")).toBe(false);
    }
  });

  it("C5 maps the documented session.event type whitelist", () => {
    const eventTypes = [
      "turn/start",
      "turn/end",
      "tool/call",
      "tool/result",
    ] as const;
    const expected = [
      { type: "progress", summary: "DSH 开始新一轮执行" },
      { type: "progress", summary: "DSH 本轮执行结束" },
      {
        type: "tool.started",
        summary: "DSH 正在调用工具 contract-tool",
        tool: "contract-tool",
      },
      {
        type: "tool.result",
        summary: "DSH 工具执行完成：contract-call",
        tool: "contract-call",
      },
    ];

    expect(
      eventTypes.map((type) => {
        const data =
          type === "tool/call"
            ? { name: "contract-tool" }
            : type === "tool/result"
              ? { callId: "contract-call" }
              : {};
        const [event] = mapDshNotification({
          method: "session.event",
          params: { event: { type, data } },
        });
        return event;
      }),
    ).toEqual(expected);
  });

  it("C6 awaits close twice through the same owned runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-close-"));
    const runtime: RuntimeProcessOptions = {
      command: process.execPath,
      args: [fakeRuntime],
      cwd: root,
      environment: () => ({ ...process.env, FAKE_TEXT: "close" }),
      description: "DSH close fake runtime",
      initializeTimeoutMs: 10_000,
    };
    const harness = new ProcessHarness(
      { cwd: root },
      () => new ProcessHarnessClient({}, runtime),
    );

    try {
      await harness.start();
      await expect(harness.close()).resolves.toBeUndefined();
      await expect(harness.close()).resolves.toBeUndefined();
    } finally {
      await harness.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(Boolean(process.env.DSH_BIN))(
    "C7 checks DSH_BIN --version against the manifest",
    async () => {
      const manifest = await readFile(
        fileURLToPath(
          new URL("../../../ops/dsh-sync/manifest.yml", import.meta.url),
        ),
        "utf8",
      );
      const expected = /^  sdkClient: "?([^"\s]+)"?$/m.exec(manifest)?.[1];
      expect(expected).toBeDefined();
      const { stdout } = await execFileAsync(
        process.env.DSH_BIN!,
        ["--version"],
        { timeout: 10_000 },
      );
      expect(stdout.trim()).toBe(expected);
    },
  );
});
