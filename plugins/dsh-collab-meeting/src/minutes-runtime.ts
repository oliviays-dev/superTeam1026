import type { MinuteVersion, MinutesSourceRefs } from "./phase1-models.js";
import type { MeetingMinutesService } from "./minutes.js";

export type MinutesTrigger = MinuteVersion["trigger"];

export interface MinutesGenerationRequest {
  readonly meetingId: string;
  readonly versionId: string;
  readonly trigger: MinutesTrigger;
  readonly requestedBy: string;
}

export interface MinutesGenerationResult {
  readonly content: string;
  readonly runId?: string;
  readonly sourceRefs?: MinutesSourceRefs;
}

/** Produces the markdown for one minutes version. */
export interface MinutesGenerator {
  generate(request: MinutesGenerationRequest): Promise<MinutesGenerationResult>;
}

/**
 * Narrow view of the agent dispatch layer. The meeting plugin already owns a
 * `FacilitatorMinutesService` that knows how to open the platform facilitator
 * runtime and dispatch a bounded run; this port lets the minutes runtime reuse
 * exactly that path instead of re-implementing dispatch.
 */
export interface MinutesDispatchPort {
  dispatch(meetingId: string): Promise<
    | {
        readonly runId?: string;
        readonly dispatchKey: string;
      }
    | undefined
  >;
  status(
    meetingId: string,
    dispatchKey: string,
  ):
    | {
        readonly status: string;
        readonly content?: string;
        readonly error?: string;
      }
    | undefined;
}

export interface AgentMinutesGeneratorOptions {
  /** Poll interval while waiting for the run to settle. */
  readonly intervalMs?: number;
  /** Overall wait budget; exceeding it marks the version failed. */
  readonly timeoutMs?: number;
  /** Injectable sleep for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "timeout",
  "cancelled",
  "interrupted",
]);

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 运行摘要里常带有模型自己的前言/思考段落（例如英文的 “I need to …”）。
 * 纪要应只承载 Markdown 正文，这里在正文确实含标题时裁掉标题之前的前言。
 */
function normalizeMinutesContent(raw: string): string {
  const text = raw.trim();
  if (text === "") return "";
  const match = /^#{1,6}\s/m.exec(text);
  if (match !== null && match.index > 0) return text.slice(match.index).trim();
  return text;
}

/**
 * Adapts the fire-and-forget agent dispatch into an awaitable generator by
 * polling the run record until it reaches a terminal status.
 */
export function createAgentMinutesGenerator(
  port: MinutesDispatchPort,
  options: AgentMinutesGeneratorOptions = {},
): MinutesGenerator {
  const intervalMs = options.intervalMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const sleep = options.sleep ?? sleepDefault;
  return {
    async generate(request) {
      const dispatched = await port.dispatch(request.meetingId);
      if (dispatched === undefined)
        throw new Error("no meeting dialogue available for minutes");
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const run = port.status(request.meetingId, dispatched.dispatchKey);
        if (run !== undefined && TERMINAL_RUN_STATUSES.has(run.status)) {
          if (run.status !== "succeeded")
            throw new Error(
              run.error === undefined || run.error === ""
                ? `minutes run ended with ${run.status}`
                : run.error,
            );
          const content = normalizeMinutesContent(run.content ?? "");
          // 只有结构化的 Markdown 纪要才算可用结果：没有任何标题、
          // 或仍残留工具调用标记（模型越界）时视为生成失败，
          // 避免把思考/工具调用乱码当纪要写进群聊。
          if (
            content === "" ||
            // 模型输出的是全角竖线「｜」，兼容半角即可。
            /<[|｜]+\s*[|｜]?\s*DSML/i.test(content) ||
            !/^#{1,6}\s/m.test(content)
          ) {
            throw new Error("外部 Agent 未返回可用的结构化会议纪要");
          }
          return {
            content,
            ...(dispatched.runId === undefined
              ? {}
              : { runId: dispatched.runId }),
          };
        }
        if (Date.now() >= deadline)
          throw new Error("minutes run did not settle before the deadline");
        await sleep(intervalMs);
      }
    },
  };
}

export interface MeetingMinutesRuntimeDeps {
  readonly minutes: MeetingMinutesService;
  readonly generator: MinutesGenerator;
  /**
   * Called once a version reaches `pending_confirm`. Phase 1 uses it to post
   * the minutes to the group chat and notify the meeting owner.
   */
  readonly onCompleted?: (version: MinuteVersion) => Promise<void> | void;
}

/**
 * Orchestrates one minutes version: allocate it synchronously (so the caller
 * gets a version id immediately) and complete it asynchronously once the
 * generator returns. Failures are recorded on the version, never thrown at the
 * caller, because the HTTP trigger is intentionally fire-and-forget.
 */
export class MeetingMinutesRuntime {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly deps: MeetingMinutesRuntimeDeps) {}

  async trigger(input: {
    readonly meetingId: string;
    readonly trigger: MinutesTrigger;
    readonly requestedBy: string;
    readonly sourceRefs?: MinutesSourceRefs;
  }): Promise<MinuteVersion> {
    const version = await this.deps.minutes.requestVersion(input);
    const task = this.generate(version).catch(() => undefined);
    this.running.set(version.id, task);
    void task.finally(() => {
      if (this.running.get(version.id) === task) this.running.delete(version.id);
    });
    return version;
  }

  async waitIdle(): Promise<void> {
    while (this.running.size > 0)
      await Promise.allSettled(this.running.values());
  }

  private async generate(version: MinuteVersion): Promise<void> {
    try {
      const result = await this.deps.generator.generate({
        meetingId: version.meetingId,
        versionId: version.id,
        trigger: version.trigger,
        requestedBy: version.requestedBy,
      });
      const completed = await this.deps.minutes.completeVersion(
        version.id,
        result.content,
        {
        ...(result.runId === undefined ? {} : { runId: result.runId }),
        ...(result.sourceRefs === undefined
          ? {}
          : { sourceRefs: result.sourceRefs }),
        },
      );
      await this.deps.onCompleted?.(completed);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "minutes generation failed";
      await this.deps.minutes.failVersion(version.id, message);
    }
  }
}
