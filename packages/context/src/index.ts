import { createHash, randomUUID } from "node:crypto";
import type {
  Agent,
  AgentEpisode,
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
  readonly episodes?: readonly AgentEpisode[];
  readonly now?: Date;
}

export interface BuildMeetingContextInput {
  readonly runId: string;
  readonly project: Project;
  readonly meeting: {
    readonly id: string;
    readonly title: string;
    readonly agenda: string;
  };
  readonly turn: {
    readonly id: string;
    readonly triggerKind: "mention" | "round" | "agenda" | "summary";
    readonly triggerReason: string;
    readonly agendaItem: string | null;
  };
  readonly messages: readonly {
    readonly authorName: string;
    readonly authorType: "human" | "agent";
    readonly content: string;
  }[];
  readonly agent: Agent;
  readonly episodes?: readonly AgentEpisode[];
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
    ...(input.episodes ?? []).map((episode) => ({
      type: "memory" as const,
      id: episode.id,
      label: `Agent Episode: ${episode.summary}`,
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
    ...((input.episodes ?? []).length === 0
      ? []
      : [
          "",
          "# Agent episodes",
          "These episodes are scoped to this project and agent.",
          ...(input.episodes ?? []).map(
            (episode) =>
              `- [${episode.kind}] ${episode.summary}${episode.content === "" ? "" : `: ${episode.content}`}`,
          ),
        ]),
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
    meetingTurnId: null,
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

export function buildMeetingContext(input: BuildMeetingContextInput): {
  pack: ContextPack;
  receipt: ContextReceipt;
} {
  const now = input.now ?? new Date();
  const createdAt = now.toISOString();
  const recentMessages = input.messages.slice(-30);
  const sources: ContextSource[] = [
    {
      type: "project",
      id: input.project.id,
      label: input.project.name,
    },
    {
      type: "task",
      id: input.turn.id,
      label: `${input.meeting.title} · ${input.turn.triggerKind}`,
    },
    ...(input.episodes ?? []).map((episode) => ({
      type: "memory" as const,
      id: episode.id,
      label: `Agent Episode: ${episode.summary}`,
    })),
  ];
  const renderedPrompt = [
    "# Agent identity",
    `You are ${input.agent.name}, an AI participant in a platform meeting.`,
    input.agent.description,
    input.agent.soul,
    "",
    "# Meeting",
    `Title: ${input.meeting.title}`,
    `Agenda: ${input.meeting.agenda || "No agenda supplied."}`,
    "",
    "# Trigger",
    `Kind: ${input.turn.triggerKind}`,
    `Reason: ${input.turn.triggerReason}`,
    ...(input.turn.agendaItem === null
      ? []
      : [`Agenda item: ${input.turn.agendaItem}`]),
    "",
    "# Recent meeting transcript",
    ...(recentMessages.length === 0
      ? ["No messages are available."]
      : recentMessages.map(
          (message) =>
            `[${message.authorType}] ${message.authorName}: ${message.content}`,
        )),
    ...((input.episodes ?? []).length === 0
      ? []
      : [
          "",
          "# Agent episodes",
          "These episodes are scoped to this project and agent.",
          ...(input.episodes ?? []).map(
            (episode) =>
              `- [${episode.kind}] ${episode.summary}${episode.content === "" ? "" : `: ${episode.content}`}`,
          ),
        ]),
    "",
    "# Output requirements",
    "Return one concise meeting message. Do not impersonate a human, do not invent decisions, and clearly identify assumptions or unresolved risks.",
  ].join("\n");
  const id = randomUUID();
  const pack: ContextPack = {
    id,
    runId: input.runId,
    projectId: input.project.id,
    taskId: null,
    meetingTurnId: input.turn.id,
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
        "Meeting context contains the agent identity, policy trigger, recent meeting transcript, and scoped episodes.",
      createdAt,
    },
  };
}
