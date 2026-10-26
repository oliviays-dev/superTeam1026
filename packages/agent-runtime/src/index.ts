import type { RuntimeKind } from "@pluginmax/contracts";
import type {
  ExternalRuntimeExecutionMetadata,
  ExternalRuntimeProcessDiagnostics,
} from "./external-runtime-types.js";

export interface RuntimeTaskInput {
  readonly runId: string;
  readonly effectKey: string;
  readonly title: string;
  readonly description: string;
  readonly acceptance: readonly string[];
  readonly instruction: string;
  readonly agentName: string;
  readonly runtimeKind: RuntimeKind;
  readonly workspacePath: string;
  readonly runtimeOptions?: {
    readonly fault?: "fail" | "timeout" | undefined;
    readonly delayMs?: number | undefined;
  };
}

export type AgentRuntimeEvent =
  | {
      readonly type: "plan";
      readonly summary: string;
      readonly steps: readonly string[];
    }
  | {
      readonly type: "progress";
      readonly summary: string;
    }
  | {
      readonly type: "tool.started";
      readonly summary: string;
      readonly tool: string;
    }
  | {
      readonly type: "tool.result";
      readonly summary: string;
      readonly tool: string;
    }
  | {
      readonly type: "delta";
      readonly text: string;
    }
  | {
      readonly type: "artifact";
      readonly summary: string;
      readonly name: string;
    }
  | {
      readonly type: "warning";
      readonly summary: string;
    }
  | {
      readonly type: "error";
      readonly summary: string;
    }
  | {
      readonly type: "completed";
      readonly output: string;
      readonly execution?: ExternalRuntimeExecutionMetadata;
      readonly diagnostics?: ExternalRuntimeProcessDiagnostics;
    };

export interface AgentRuntimeAdapter {
  readonly id: string;
  execute(
    input: RuntimeTaskInput,
    signal: AbortSignal,
  ): AsyncIterable<AgentRuntimeEvent>;
}

const delay = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolvePromise, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("runtime aborted"));
      return;
    }
    const timer = setTimeout(resolvePromise, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("runtime aborted"));
      },
      { once: true },
    );
  });

function chunks(value: string, size = 18): string[] {
  const result: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    result.push(value.slice(index, index + size));
  }
  return result;
}

export class FakeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly id = "fake";

  async *execute(
    input: RuntimeTaskInput,
    signal: AbortSignal,
  ): AsyncIterable<AgentRuntimeEvent> {
    if ((input.runtimeOptions?.delayMs ?? 0) > 0) {
      await delay(input.runtimeOptions!.delayMs!, signal);
    }
    if (input.runtimeOptions?.fault === "fail") {
      throw new Error("Fake Runtime injected failure");
    }
    if (input.runtimeOptions?.fault === "timeout") {
      await delay(60_000, signal);
      throw new Error("Fake Runtime injected timeout");
    }
    yield {
      type: "plan",
      summary: "已生成任务执行计划",
      steps: [
        "读取任务定义和验收标准",
        "整理与任务相关的项目信息",
        "生成并校验交付结果",
      ],
    };

    await delay(180, signal);
    yield { type: "progress", summary: "正在读取任务定义和验收标准" };
    yield {
      type: "tool.started",
      summary: "读取任务上下文",
      tool: "task.context.read",
    };

    await delay(220, signal);
    yield {
      type: "tool.result",
      summary: `已读取 ${input.acceptance.length} 项验收标准`,
      tool: "task.context.read",
    };

    const output = [
      `任务「${input.title}」已由 ${input.agentName} 完成。`,
      "",
      "执行结论：",
      `- 任务目标：${input.description}`,
      `- 验收标准：${input.acceptance.length === 0 ? "未单独设置" : input.acceptance.join("；")}`,
      "- 执行过程、工具活动和最终输出已写入平台 Run 记录。",
      "- 当前使用 Fake Runtime，后续可替换为 DSH 或其他外部 Runtime。",
    ].join("\n");

    yield { type: "progress", summary: "正在生成任务交付结果" };
    for (const text of chunks(output)) {
      await delay(25, signal);
      yield { type: "delta", text };
    }

    yield {
      type: "artifact",
      summary: "已生成任务执行报告",
      name: `${input.title.replace(/\s+/g, "-")}-report.md`,
    };
    yield { type: "completed", output };
  }
}

export {
  DshSdkAdapter,
  mapDshNotification,
  type DshSdkAdapterOptions,
} from "./dsh-sdk.js";
export {
  CodexJsonlAdapter,
  parseCodexJsonl,
  type CodexJsonlAdapterOptions,
  type CodexJsonlParseResult,
} from "./codex-jsonl.js";
export {
  PlainTextAdapter,
  type PlainTextAdapterOptions,
} from "./plain-text.js";
export {
  ExternalProcessFailure,
  boundedDiagnostic,
  externalProcessDiagnostics,
  runExternalProcess,
  type ExternalProcessFailureCode,
  type ExternalProcessOptions,
  type ExternalProcessResult,
} from "./external-process.js";
export {
  ExternalRuntimeAdapterFailure,
  type ExternalRuntimeAdapterFailureCode,
} from "./external-adapter-error.js";
export type {
  ExternalRuntimeExecutionMetadata,
  ExternalRuntimeLimitOptions,
  ExternalRuntimeProcessDiagnostics,
} from "./external-runtime-types.js";
