import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DshSdkAdapter,
  FakeRuntimeAdapter,
  type AgentRuntimeAdapter,
  type AgentRuntimeEvent,
  type DshSdkAdapterOptions,
} from "@pluginmax/agent-runtime";
import { buildMeetingContext, buildTaskContext } from "@pluginmax/context";
import type { Agent, Run, Task } from "@pluginmax/contracts";
import {
  MeetingAiPreconditionError,
  type MeetingAiRunContext,
  type PlatformRepositories,
} from "@pluginmax/database";
import { isTerminalRunStatus } from "@pluginmax/domain";
import { LocalFileStore } from "@pluginmax/files";

export class RunCancelledError extends Error {
  constructor() {
    super("run cancelled");
    this.name = "RunCancelledError";
  }
}

export class RunTimedOutError extends Error {
  constructor() {
    super("run timed out");
    this.name = "RunTimedOutError";
  }
}

export class RunLeaseLostError extends Error {
  constructor(message = "worker lease lost") {
    super(message);
    this.name = "RunLeaseLostError";
  }
}

export function runtimeEffectKey(runId: string): string {
  return `run:${runId}:agent.execute:v1`;
}

export interface RunExecutorOptions {
  readonly workspaceRoot: string;
  readonly fileStoreRoot: string;
  readonly dsh: DshSdkAdapterOptions;
  readonly runtimeEffectPollIntervalMs?: number;
}

function runtimeFor(
  agent: Agent,
  options: RunExecutorOptions,
): AgentRuntimeAdapter {
  if (agent.runtimeKind === "fake") {
    return new FakeRuntimeAdapter();
  }
  if (agent.runtimeKind === "dsh-sdk") {
    return new DshSdkAdapter(options.dsh);
  }
  throw new Error(`runtime adapter is not implemented: ${agent.runtimeKind}`);
}

export class RunExecutor {
  private readonly fileStore: LocalFileStore;

  constructor(
    private readonly repositories: PlatformRepositories,
    private readonly options: RunExecutorOptions,
  ) {
    this.fileStore = new LocalFileStore(options.fileStoreRoot);
  }

  async execute(
    runId: string,
    options: {
      readonly signal?: AbortSignal;
      readonly assertLease?: () => Promise<void>;
      readonly jobId?: string;
      readonly owner?: string;
      readonly leaseSeconds?: number;
      readonly leaseRenewIntervalMs?: number;
      readonly traceId?: string;
      readonly jobSpanId?: string;
    } = {},
  ): Promise<void> {
    if (options.jobId === undefined) {
      throw new Error("runtime execution requires a claimed job id");
    }
    const owner = options.owner ?? `run-executor-${process.pid}`;
    const leaseSeconds = options.leaseSeconds ?? 60;
    const leaseRenewIntervalMs = options.leaseRenewIntervalMs ?? 10_000;
    const assertLease = async () => {
      await options.assertLease?.();
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new RunLeaseLostError();
      }
    };
    await assertLease();
    let run = await this.requireRun(runId);
    if (
      options.traceId !== undefined &&
      run.traceId !== null &&
      run.traceId !== options.traceId
    ) {
      throw new Error("claimed job trace does not match its run");
    }
    const task =
      run.taskId === null ? null : await this.requireTask(run.taskId);
    let meetingContext: MeetingAiRunContext | null = null;
    if (run.meetingTurnId !== null) {
      try {
        meetingContext = await this.repositories.meetingAi.prepareRun(runId);
      } catch (error) {
        if (!(error instanceof MeetingAiPreconditionError)) throw error;
        if (run.status === "cancelled") return;
        await this.repositories.runs.appendEventIfAbsent(
          runId,
          "error",
          "Meeting AI participation was rejected before execution",
          { code: error.code, error: error.message },
        );
        await this.repositories.runs.finish(
          runId,
          "failed",
          null,
          error.message,
        );
        await this.repositories.meetingAi.failTurn(
          runId,
          error.code,
          error.message,
        );
        return;
      }
      run = await this.requireRun(runId);
    }
    const agent = await this.repositories.agents.get(run.agentId);
    if (agent === undefined) throw new Error("agent is unavailable");
    const project = await this.repositories.projects.get(run.projectId);
    if (project === undefined) throw new Error("project is unavailable");
    const effectKey = runtimeEffectKey(runId);
    const effect = await this.repositories.runtimeEffects.begin({
      effectKey,
      runId,
      jobId: options.jobId,
      operation: "agent.execute",
      owner,
      leaseSeconds,
    });
    if (effect.kind === "replay") {
      const output = effect.receipt.result?.output;
      if (typeof output !== "string") {
        throw new Error("runtime effect replay is missing its output");
      }
      await this.repositories.runs.markRunning(runId);
      await this.repositories.runs.appendEventIfAbsent(
        runId,
        "runtime.effect_replayed",
        "复用已持久化的 Runtime effect 回执",
        {
          effectKey,
          attempt: effect.receipt.attempt,
        },
      );
      await this.completeRun(runId, task, meetingContext, output, assertLease);
      return;
    }
    if (effect.kind === "cancelled") {
      throw new RunCancelledError();
    }
    if (effect.kind === "busy") {
      throw new RunLeaseLostError("runtime effect is leased elsewhere");
    }
    const effectLeaseToken = effect.leaseToken;
    try {
      await assertLease();
    } catch (error) {
      if (
        error instanceof RunCancelledError ||
        options.signal?.reason instanceof RunCancelledError
      ) {
        await this.repositories.runtimeEffects.acknowledgeCancellation(
          effectKey,
          owner,
          effectLeaseToken,
        );
      }
      throw error;
    }
    const episodes =
      await this.repositories.memoryClosure.listEpisodesForContext(
        project.id,
        agent.id,
      );
    if (meetingContext !== null) {
      const currentMeetingContext =
        await this.repositories.meetingAi.getRunContext(runId);
      if (currentMeetingContext === undefined) {
        throw new Error("meeting AI turn context is unavailable");
      }
      meetingContext = currentMeetingContext;
    }
    const context =
      meetingContext === null
        ? buildTaskContext({
            runId,
            project,
            task: task!,
            agent,
            episodes,
          })
        : buildMeetingContext({
            runId,
            project,
            meeting: meetingContext.meeting,
            turn: meetingContext.turn,
            messages: meetingContext.messages,
            agent,
            episodes,
          });
    await this.repositories.contexts.save(context.pack, context.receipt);
    const workspacePath = resolve(this.options.workspaceRoot, run.projectId);
    await mkdir(workspacePath, { recursive: true });

    await this.repositories.runs.markRunning(runId);
    await this.repositories.runs.appendEvent(
      runId,
      "run.started",
      `${agent.name} 开始执行任务`,
      { runtimeKind: agent.runtimeKind },
    );
    await this.repositories.runs.appendEvent(
      runId,
      "context.ready",
      "ContextPack 已生成并保存",
      {
        contextPackId: context.pack.id,
        sourceCount: context.pack.sources.length,
        contentHash: context.pack.contentHash,
      },
    );

    const controller = new AbortController();
    const relayExternalAbort = () => {
      controller.abort(options.signal?.reason ?? new RunLeaseLostError());
    };
    if (options.signal?.aborted) {
      relayExternalAbort();
    } else {
      options.signal?.addEventListener("abort", relayExternalAbort, {
        once: true,
      });
    }
    const timeoutTimer =
      run.timeoutAt === null
        ? undefined
        : setTimeout(
            () => controller.abort(new RunTimedOutError()),
            Math.max(0, new Date(run.timeoutAt).getTime() - Date.now()),
          );
    let checkingEffect = false;
    const effectTimer = setInterval(
      () => {
        if (checkingEffect || controller.signal.aborted) return;
        checkingEffect = true;
        void this.repositories.runtimeEffects
          .renew(effectKey, owner, effectLeaseToken, leaseSeconds)
          .then((renewed) => {
            if (!renewed && !controller.signal.aborted) {
              controller.abort(new RunLeaseLostError());
            }
          })
          .catch(() => {
            // The main execution path reports effect persistence failures.
          })
          .finally(() => {
            checkingEffect = false;
          });
      },
      Math.max(100, leaseRenewIntervalMs),
    );
    let controlling = false;
    const controlTimer = setInterval(() => {
      if (controlling || controller.signal.aborted) return;
      controlling = true;
      void this.repositories.runtimeEffects
        .control(effectKey, owner, effectLeaseToken)
        .then((control) => {
          if (control === undefined || controller.signal.aborted) return;
          if (control.cancellationRequested) {
            controller.abort(new RunCancelledError());
          } else if (control.leaseLost) {
            controller.abort(new RunLeaseLostError());
          }
        })
        .catch(() => {
          // Lease renewal remains the authoritative ownership check.
        })
        .finally(() => {
          controlling = false;
        });
    }, this.options.runtimeEffectPollIntervalMs ?? 500);
    try {
      const adapter = runtimeFor(agent, this.options);
      for await (const event of adapter.execute(
        {
          runId,
          effectKey,
          title:
            task?.title ??
            `${meetingContext!.meeting.title} · ${meetingContext!.turn.triggerKind}`,
          description: task?.description ?? meetingContext!.turn.triggerReason,
          acceptance: task?.acceptance ?? [],
          instruction: context.pack.renderedPrompt,
          agentName: agent.name,
          runtimeKind: agent.runtimeKind,
          workspacePath,
          ...(run.inputSnapshot.runtimeOptions === undefined
            ? {}
            : { runtimeOptions: run.inputSnapshot.runtimeOptions }),
        },
        controller.signal,
      )) {
        await assertLease();
        await this.assertStillRunning(runId);
        await this.persistEvent(runId, event);
        await assertLease();
        if (event.type === "completed") {
          const current = await this.requireRun(runId);
          if (current.status === "cancelled") throw new RunCancelledError();
          const completed = await this.repositories.runtimeEffects.complete(
            effectKey,
            owner,
            effectLeaseToken,
            { output: event.output },
          );
          if (completed === undefined) throw new RunLeaseLostError();
          await this.completeRun(
            runId,
            task,
            meetingContext,
            event.output,
            assertLease,
          );
          return;
        }
      }
    } catch (error) {
      if (
        error instanceof RunCancelledError ||
        controller.signal.reason instanceof RunCancelledError
      ) {
        await this.repositories.runtimeEffects.acknowledgeCancellation(
          effectKey,
          owner,
          effectLeaseToken,
        );
        await this.repositories.runs.appendEventIfAbsent(
          runId,
          "runtime.effect_cancelled",
          "Runtime effect 已跨进程取消并确认",
          { effectKey },
        );
        throw error instanceof RunCancelledError
          ? error
          : new RunCancelledError();
      }
      if (
        error instanceof RunTimedOutError ||
        controller.signal.reason instanceof RunTimedOutError
      ) {
        await this.repositories.runtimeEffects.fail(
          effectKey,
          owner,
          effectLeaseToken,
          "Run exceeded its timeout",
        );
        await this.repositories.runs.timeout(runId, "Run exceeded its timeout");
        if (task !== null) {
          await this.repositories.tasks.setStatus(task.id, "queued");
        } else {
          await this.repositories.meetingAi.failTurn(
            runId,
            "meeting_ai_timeout",
            "Meeting AI turn exceeded its run budget",
          );
        }
        await this.repositories.runs.appendEvent(
          runId,
          "error",
          "Run 超过执行时限",
          { error: "Run exceeded its timeout" },
        );
        return;
      }
      if (options.signal?.aborted) {
        await this.repositories.runtimeEffects.fail(
          effectKey,
          owner,
          effectLeaseToken,
          "worker lease lost",
        );
        throw options.signal.reason ?? new RunLeaseLostError();
      }
      const message =
        error instanceof Error ? error.message : "unknown runtime failure";
      await this.repositories.runtimeEffects.fail(
        effectKey,
        owner,
        effectLeaseToken,
        message,
      );
      await this.repositories.runs.appendEvent(runId, "error", "Run 执行失败", {
        error: message,
      });
      throw error;
    } finally {
      clearInterval(effectTimer);
      clearInterval(controlTimer);
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", relayExternalAbort);
    }
  }

  private async completeRun(
    runId: string,
    task: Task | null,
    meetingContext: MeetingAiRunContext | null,
    output: string,
    assertLease: () => Promise<void>,
  ): Promise<void> {
    const run = await this.requireRun(runId);
    if (run.status === "cancelled") throw new RunCancelledError();
    if (run.status === "completed") {
      if (meetingContext !== null) {
        await this.repositories.meetingAi.completeTurn(runId, output);
      }
      return;
    }
    if (output.trim() === "") {
      throw new Error("runtime returned an empty output");
    }
    await this.repositories.runs.finish(runId, "completed", output, null);
    if (meetingContext !== null) {
      await this.repositories.meetingAi.completeTurn(runId, output);
      await this.repositories.runs.appendEventIfAbsent(
        runId,
        "run.completed",
        "Meeting AI turn completed and was published to the meeting",
        { meetingId: meetingContext.meeting.id },
      );
      return;
    }
    const ref = await this.fileStore.put({
      workspaceId: run.projectId,
      name: `${task!.title.replace(/[^a-zA-Z0-9._-]+/g, "-")}-result.md`,
      mimeType: "text/markdown",
      content: Buffer.from(output, "utf8"),
    });
    await assertLease();
    const existingArtifacts =
      await this.repositories.artifacts.listByRun(runId);
    const artifact =
      existingArtifacts.find(
        (candidate) =>
          candidate.name === ref.name && candidate.sha256 === ref.sha256,
      ) ??
      (await this.repositories.artifacts.save({
        runId,
        projectId: run.projectId,
        ref,
      }));
    await this.repositories.runs.appendEventIfAbsent(
      runId,
      "run.completed",
      "Run 执行完成，等待人工验收",
      { output },
    );
    await this.repositories.runs.appendEventIfAbsent(
      runId,
      "artifact.created",
      "最终交付物已保存",
      {
        artifactId: artifact.id,
        name: artifact.name,
        size: artifact.size,
      },
    );
    await this.repositories.tasks.setStatus(task!.id, "review");
  }

  private async persistEvent(
    runId: string,
    event: AgentRuntimeEvent,
  ): Promise<void> {
    switch (event.type) {
      case "plan":
        await this.repositories.runs.appendEvent(
          runId,
          "plan.snapshot",
          event.summary,
          { steps: event.steps },
        );
        return;
      case "progress":
        await this.repositories.runs.appendEvent(
          runId,
          "progress.summary",
          event.summary,
        );
        return;
      case "tool.started":
        await this.repositories.runs.appendEvent(
          runId,
          "tool.call",
          event.summary,
          { tool: event.tool },
        );
        return;
      case "tool.result":
        await this.repositories.runs.appendEvent(
          runId,
          "tool.result",
          event.summary,
          { tool: event.tool },
        );
        return;
      case "delta":
        await this.repositories.runs.appendDelta(runId, event.text);
        return;
      case "artifact":
        return;
      case "completed":
        return;
    }
  }

  private async assertStillRunning(runId: string): Promise<void> {
    const current = await this.requireRun(runId);
    if (current.status === "cancelled") throw new RunCancelledError();
    if (current.status === "timeout") throw new RunTimedOutError();
    if (isTerminalRunStatus(current.status)) {
      throw new Error(`run already finished with status ${current.status}`);
    }
    if (
      current.timeoutAt !== null &&
      new Date(current.timeoutAt).getTime() <= Date.now()
    ) {
      await this.repositories.runs.timeout(runId, "Run exceeded its timeout");
      throw new RunTimedOutError();
    }
  }

  private async requireRun(runId: string): Promise<Run> {
    const run = await this.repositories.runs.get(runId);
    if (run === undefined) throw new Error(`run not found: ${runId}`);
    return run;
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.repositories.tasks.get(taskId);
    if (task === undefined) throw new Error(`task not found: ${taskId}`);
    return task;
  }
}
