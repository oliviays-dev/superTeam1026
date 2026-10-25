import {
  DeepSeekHarness,
  type HarnessNotification,
  type RunResult,
} from "@deepseek-ai/dsh-sdk-client";
import type {
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  RuntimeTaskInput,
} from "./index.js";

export interface DshSdkAdapterOptions {
  readonly dshBin?: string | undefined;
  readonly profile?: string | undefined;
  readonly dshHome?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly maxTokens?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

interface QueueItem {
  readonly kind: "event" | "complete" | "error";
  readonly event?: AgentRuntimeEvent;
  readonly result?: RunResult;
  readonly error?: unknown;
}

class RuntimeEventQueue implements AsyncIterable<QueueItem> {
  private readonly items: QueueItem[] = [];
  private readonly waiters: Array<(result: IteratorResult<QueueItem>) => void> =
    [];
  private done = false;
  private failure: unknown;

  push(item: QueueItem): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ done: false, value: item });
      return;
    }
    this.items.push(item);
  }

  close(result?: RunResult): void {
    this.done = true;
    if (result !== undefined) {
      this.push({ kind: "complete", result });
    }
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    this.failure = error;
    this.done = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined });
    }
  }

  private next(): Promise<IteratorResult<QueueItem>> {
    const item = this.items.shift();
    if (item !== undefined) {
      return Promise.resolve({ done: false, value: item });
    }
    if (this.done) {
      if (this.failure !== undefined) {
        return Promise.reject(this.failure);
      }
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<QueueItem> {
    return {
      next: () => this.next(),
    };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

export function mapDshNotification(
  notification: HarnessNotification,
): AgentRuntimeEvent[] {
  if (notification.method === "session.status") {
    return notification.params.status === "running"
      ? [{ type: "progress", summary: "DSH Runtime 正在执行任务" }]
      : [];
  }
  if (notification.method === "subagent.started") {
    return [{ type: "progress", summary: "DSH 子 Agent 已启动" }];
  }
  if (notification.method === "subagent.finished") {
    return [{ type: "progress", summary: "DSH 子 Agent 已完成" }];
  }
  if (notification.method !== "session.event") return [];

  const event = notification.params.event as
    | {
        readonly type?: string;
        readonly data?: Record<string, unknown>;
      }
    | undefined;
  if (event?.type === "turn/start") {
    return [{ type: "progress", summary: "DSH 开始新一轮执行" }];
  }
  if (event?.type === "turn/end") {
    return [{ type: "progress", summary: "DSH 本轮执行结束" }];
  }
  if (event?.type === "tool/call") {
    const tool = stringValue(event.data?.name) ?? "unknown";
    return [
      {
        type: "tool.started",
        summary: `DSH 正在调用工具 ${tool}`,
        tool,
      },
    ];
  }
  if (event?.type === "tool/result") {
    const callId = stringValue(event.data?.callId) ?? "tool";
    return [
      {
        type: "tool.result",
        summary: `DSH 工具执行完成：${callId}`,
        tool: callId,
      },
    ];
  }
  return [];
}

export class DshSdkAdapter implements AgentRuntimeAdapter {
  readonly id = "dsh-sdk";

  constructor(private readonly options: DshSdkAdapterOptions = {}) {}

  async *execute(
    input: RuntimeTaskInput,
    signal: AbortSignal,
  ): AsyncIterable<AgentRuntimeEvent> {
    const queue = new RuntimeEventQueue();
    const harness = new DeepSeekHarness({
      ...(this.options.dshBin === undefined
        ? {}
        : { dshBin: this.options.dshBin }),
      profile: this.options.profile ?? "sdk",
      dshHome: this.options.dshHome ?? ".tmp/dsh-home",
      cwd: input.workspacePath,
      provider: this.options.provider ?? "deepseek-official",
      model: this.options.model ?? "deepseek-v4-flash",
      maxTokens: this.options.maxTokens ?? 4_000,
      requestTimeoutMs: this.options.timeoutMs ?? 30 * 60_000,
    });

    let result: RunResult | undefined;
    const abort = () =>
      queue.fail(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("DSH runtime aborted"),
      );
    signal.addEventListener("abort", abort, { once: true });

    void harness
      .run(input.instruction, {
        sessionId: `platform-${input.runId}`,
        onNotification: (notification) => {
          for (const event of mapDshNotification(notification)) {
            queue.push({ kind: "event", event });
          }
        },
      })
      .then((runResult) => {
        result = runResult;
        queue.close(runResult);
      })
      .catch((error: unknown) => {
        queue.fail(error);
      });

    try {
      for await (const item of queue) {
        if (item.kind === "event" && item.event !== undefined) {
          yield item.event;
        }
      }
      if (result === undefined) {
        throw new Error("DSH runtime finished without a result");
      }
      const output =
        result.finalResponse.trim() ||
        "DSH completed the task without returning assistant text.";
      for (let index = 0; index < output.length; index += 40) {
        yield { type: "delta", text: output.slice(index, index + 40) };
      }
      yield {
        type: "artifact",
        summary: "DSH 已生成最终输出",
        name: `${input.title.replace(/\s+/g, "-")}-dsh-output.md`,
      };
      yield { type: "completed", output };
    } finally {
      signal.removeEventListener("abort", abort);
      await harness.close().catch(() => undefined);
    }
  }
}
