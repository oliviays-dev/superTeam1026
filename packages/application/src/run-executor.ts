import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  DshSdkAdapter,
  FakeRuntimeAdapter,
  type AgentRuntimeAdapter,
  type AgentRuntimeEvent,
  type DshSdkAdapterOptions,
} from "@pluginmax/agent-runtime";
import { buildTaskContext } from "@pluginmax/context";
import type { Agent, Run, Task } from "@pluginmax/contracts";
import type { PlatformRepositories } from "@pluginmax/database";

export class RunCancelledError extends Error {
  constructor() {
    super("run cancelled");
    this.name = "RunCancelledError";
  }
}

export interface RunExecutorOptions {
  readonly workspaceRoot: string;
  readonly dsh: DshSdkAdapterOptions;
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
  constructor(
    private readonly repositories: PlatformRepositories,
    private readonly options: RunExecutorOptions,
  ) {}

  async execute(runId: string): Promise<void> {
    const run = await this.requireRun(runId);
    const task = await this.requireTask(run.taskId);
    const agent = await this.repositories.agents.get(run.agentId);
    if (agent === undefined) throw new Error("agent is unavailable");
    const project = await this.repositories.projects.get(run.projectId);
    if (project === undefined) throw new Error("project is unavailable");
    const context = buildTaskContext({ runId, project, task, agent });
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
    try {
      const adapter = runtimeFor(agent, this.options);
      for await (const event of adapter.execute(
        {
          runId,
          title: task.title,
          description: task.description,
          acceptance: task.acceptance,
          instruction: context.pack.renderedPrompt,
          agentName: agent.name,
          runtimeKind: agent.runtimeKind,
          workspacePath,
        },
        controller.signal,
      )) {
        await this.assertStillRunning(runId);
        await this.persistEvent(runId, event);
        if (event.type === "completed") {
          const current = await this.requireRun(runId);
          if (current.status === "cancelled") throw new RunCancelledError();
          await this.repositories.runs.finish(
            runId,
            "completed",
            event.output,
            null,
          );
          await this.repositories.runs.appendEvent(
            runId,
            "run.completed",
            "Run 执行完成，等待人工验收",
            { output: event.output },
          );
          await this.repositories.tasks.setStatus(task.id, "review");
        }
      }
    } catch (error) {
      if (error instanceof RunCancelledError) {
        return;
      }
      const message =
        error instanceof Error ? error.message : "unknown runtime failure";
      await this.repositories.runs.appendEvent(runId, "error", "Run 执行失败", {
        error: message,
      });
      await this.repositories.runs.finish(runId, "failed", null, message);
      await this.repositories.tasks.setStatus(task.id, "queued");
      throw error;
    }
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
        await this.repositories.runs.appendEvent(
          runId,
          "artifact.created",
          event.summary,
          { name: event.name },
        );
        return;
      case "completed":
        return;
    }
  }

  private async assertStillRunning(runId: string): Promise<void> {
    const current = await this.requireRun(runId);
    if (current.status === "cancelled") throw new RunCancelledError();
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
