import { createHash, randomUUID } from "node:crypto";
import type {
  Agent,
  ContextPack,
  ContextReceipt,
  ContextSource,
  Project,
  Task,
} from "@pluginmax/contracts";

export interface BuildTaskContextInput {
  readonly runId: string;
  readonly project: Project;
  readonly task: Task;
  readonly agent: Agent;
  readonly now?: Date;
}

function contextHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildTaskContext(input: BuildTaskContextInput): {
  pack: ContextPack;
  receipt: ContextReceipt;
} {
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const sources: ContextSource[] = [
    {
      type: "project",
      id: input.project.id,
      label: input.project.name,
    },
    {
      type: "task",
      id: input.task.id,
      label: input.task.title,
    },
    ...input.task.acceptance.map((item, index) => ({
      type: "acceptance" as const,
      id: `${input.task.id}:acceptance:${index + 1}`,
      label: item,
    })),
  ];
  const renderedPrompt = [
    "# Agent identity",
    `You are ${input.agent.name}.`,
    input.agent.description,
    "",
    "# Project",
    `Name: ${input.project.name}`,
    `Code: ${input.project.code}`,
    input.project.description,
    "",
    "# Task",
    `Title: ${input.task.title}`,
    input.task.description,
    "",
    "# Acceptance criteria",
    ...(input.task.acceptance.length === 0
      ? ["No separate acceptance criteria were provided."]
      : input.task.acceptance.map(
          (item, index) => `${String(index + 1)}. ${item}`,
        )),
    "",
    "# Output requirements",
    "Return a concise final result with evidence and clearly identify any unresolved risk.",
  ].join("\n");
  const id = randomUUID();
  const pack: ContextPack = {
    id,
    runId: input.runId,
    projectId: input.project.id,
    taskId: input.task.id,
    agentId: input.agent.id,
    identity: {
      name: input.agent.name,
      runtimeKind: input.agent.runtimeKind,
    },
    sources,
    renderedPrompt,
    contentHash: contextHash(renderedPrompt),
    createdAt,
  };
  return {
    pack,
    receipt: {
      contextPackId: id,
      runId: input.runId,
      usedSources: sources,
      excludedSources: [],
      reason:
        "V1 context assembly uses the project, task contract, acceptance criteria, and selected agent identity.",
      createdAt,
    },
  };
}
