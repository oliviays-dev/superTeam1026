import type {
  Agent,
  AgentEpisode,
  ContextPack,
  ContextReceipt,
  CreateSceneContextContributionInput,
  Project,
  Run,
  SceneChatChannel,
  SceneContextContribution,
  SceneContextExcludedSource,
  SceneContextReceipt,
  SceneContextSnapshot,
  SceneSessionBinding,
  SceneSourceRef,
  SceneType,
  Task,
  TaskDetail,
  TaskMessage,
} from "@pluginmax/contracts";
import {
  buildDirectChatContext,
  buildMeetingContext,
  buildTaskContext,
  type SceneContextBuildInput,
} from "@pluginmax/context";
import type {
  DirectChatRunContext,
  MeetingAiRunContext,
  PlatformRepositories,
} from "@pluginmax/database";
import { SceneContextRepositoryError } from "@pluginmax/database";

export interface PrepareSceneContextInput {
  readonly run: Run;
  readonly project: Project | null;
  readonly task: Task | null;
  readonly agent: Agent;
  readonly meetingContext: MeetingAiRunContext | null;
  readonly directChatContext: DirectChatRunContext | null;
  readonly episodes: readonly AgentEpisode[];
  readonly runtimeStateful?: boolean | undefined;
}

export interface PreparedSceneContext {
  readonly binding: SceneSessionBinding;
  readonly channel: SceneChatChannel | null;
  readonly pack: ContextPack;
  readonly legacyReceipt: ContextReceipt;
  readonly receipt: SceneContextReceipt;
  readonly snapshot: SceneContextSnapshot;
}

function sceneIdentity(input: PrepareSceneContextInput): {
  readonly sceneType: SceneType;
  readonly sceneId: string;
  readonly projectId: string | null;
  readonly ownerPrincipalId: string | null;
} {
  if (input.directChatContext !== null) {
    return {
      sceneType: "direct-chat",
      sceneId: input.directChatContext.thread.id,
      projectId: null,
      ownerPrincipalId: input.directChatContext.thread.ownerId,
    };
  }
  if (input.meetingContext !== null) {
    return {
      sceneType: "meeting",
      sceneId: input.meetingContext.meeting.id,
      projectId: input.project?.id ?? input.run.projectId,
      ownerPrincipalId: null,
    };
  }
  if (
    input.run.workflowInstanceId !== null &&
    input.run.workflowNodeId !== null
  ) {
    return {
      sceneType: "workflow-node",
      sceneId: `${input.run.workflowInstanceId}:${input.run.workflowNodeId}`,
      projectId: input.run.projectId,
      ownerPrincipalId: null,
    };
  }
  return {
    sceneType: "task",
    sceneId: input.run.taskId!,
    projectId: input.run.projectId,
    ownerPrincipalId: null,
  };
}

function sourceClassForContribution(
  kind: SceneContextContribution["kind"],
):
  | "workspace"
  | "task-attachments"
  | "meeting-context"
  | "project-memory"
  | "private-local-data" {
  switch (kind) {
    case "task-attachment":
      return "task-attachments";
    case "agent-memory":
    case "project-memory":
      return "project-memory";
    case "meeting-minutes":
    case "meeting-private-note":
      return "workspace";
    case "direct-chat-message":
      return "private-local-data";
    default:
      return "workspace";
  }
}

function runtimeStateful(run: Run, override?: boolean): boolean {
  if (override !== undefined) return override;
  return (
    run.executionEnvelope?.runtime.capability.capabilities.sessionResume ===
    "supported"
  );
}

function taskSourceRef(task: Task): SceneSourceRef {
  return {
    type: "task",
    id: task.id,
    label: task.title,
    projectId: task.projectId,
    sceneType: "task",
    sceneId: task.id,
  };
}

function episodeSourceRef(episode: AgentEpisode): SceneSourceRef {
  return {
    type: "agent-episode",
    id: episode.id,
    label: episode.summary,
    projectId: episode.projectId,
  };
}

function contributionInputs(
  input: PrepareSceneContextInput,
  sceneType: SceneType,
  sceneId: string,
  projectTasks: readonly Task[],
  taskMessages: readonly TaskMessage[],
  attachments: readonly TaskDetail["attachments"][number][],
  meetingMinutes: Awaited<
    ReturnType<PlatformRepositories["meetingDecisions"]["getMinutes"]>
  >,
): {
  readonly sourceKey: string;
  readonly kind: SceneContextContribution["kind"];
  readonly version: string;
  readonly authority: SceneContextContribution["authority"];
  readonly visibility: SceneContextContribution["visibility"];
  readonly text: string;
  readonly sourceRefs: SceneSourceRef[];
  readonly createdBy: string;
  readonly ownerPrincipalId?: string | null;
}[] {
  const task = input.task;
  const values: ReturnType<typeof contributionInputs> = [];
  if (task !== null) {
    for (const message of taskMessages.filter(
      (candidate) => candidate.isKeyConsensus,
    )) {
      values.push({
        sourceKey: `task-comment:${message.id}`,
        kind: "task-comment-consensus",
        version: "1",
        authority: "evidence",
        visibility: "project",
        text: `[${message.authorName}] ${message.content}`,
        sourceRefs: [
          taskSourceRef(task),
          {
            type: "task-comment",
            id: message.id,
            label: `Comment by ${message.authorName}`,
            projectId: task.projectId,
            sceneType: "task",
            sceneId: task.id,
            quote: message.content.slice(0, 4_000),
          },
        ],
        createdBy: message.authorId,
      });
    }
    for (const dependencyId of task.dependsOn) {
      const dependency = projectTasks.find(
        (candidate) => candidate.id === dependencyId,
      );
      values.push({
        sourceKey: `task-dependency:${dependencyId}`,
        kind: "task-dependency",
        version: dependency?.updatedAt ?? task.updatedAt,
        authority: "evidence",
        visibility: "project",
        text:
          dependency === undefined
            ? `Dependency ${dependencyId} is unavailable.`
            : `[${dependency.status}] ${dependency.title} (${dependency.id})`,
        sourceRefs: [
          taskSourceRef(task),
          {
            type: "task-dependency",
            id: dependencyId,
            label: dependency?.title ?? "Unavailable dependency",
            projectId: task.projectId,
            sceneType: "task",
            sceneId: task.id,
          },
        ],
        createdBy: "system-context",
      });
    }
    for (const attachment of attachments.filter(
      (candidate) => candidate.archivedAt === null,
    )) {
      values.push({
        sourceKey: `task-attachment:${attachment.id}`,
        kind: "task-attachment",
        version: attachment.sha256,
        authority: "evidence",
        visibility: "project",
        text: `${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes)`,
        sourceRefs: [
          taskSourceRef(task),
          {
            type: "attachment",
            id: attachment.id,
            label: attachment.name,
            version: attachment.sha256,
            projectId: task.projectId,
            sceneType: "task",
            sceneId: task.id,
          },
        ],
        createdBy: attachment.uploadedBy,
      });
    }
  }
  if (
    sceneType === "workflow-node" &&
    input.run.workflowInstanceId !== null &&
    input.run.workflowNodeId !== null
  ) {
    values.push({
      sourceKey: `workflow-node:${sceneId}`,
      kind: "workflow-node",
      version: input.run.status,
      authority: "evidence",
      visibility: "project",
      text: `Workflow node ${input.run.workflowNodeId} is ${input.run.status}.`,
      sourceRefs: [
        {
          type: "workflow",
          id: input.run.workflowInstanceId,
          projectId: input.run.projectId ?? undefined,
          sceneType: "workflow-node",
          sceneId,
        },
        {
          type: "workflow-node",
          id: input.run.workflowNodeId,
          projectId: input.run.projectId ?? undefined,
          sceneType: "workflow-node",
          sceneId,
        },
      ],
      createdBy: input.run.executionEnvelope?.principalId ?? "system-worker",
    });
  }
  if (meetingMinutes !== undefined) {
    const latest = [...meetingMinutes.versions].sort(
      (left, right) => right.version - left.version,
    )[0];
    if (latest !== undefined) {
      values.push({
        sourceKey: `meeting-minutes:${latest.id}`,
        kind: "meeting-minutes",
        version: String(latest.version),
        authority: "evidence",
        visibility: "project",
        text: [
          latest.content,
          ...(latest.decisions.length === 0
            ? []
            : [
                "",
                "Decisions:",
                ...latest.decisions.map((item) => `- ${item}`),
              ]),
        ].join("\n"),
        sourceRefs: [
          {
            type: "meeting",
            id: sceneId,
            projectId: input.run.projectId ?? undefined,
            sceneType: "meeting",
            sceneId,
          },
          {
            type: "minutes-version",
            id: latest.id,
            label: `Minutes v${latest.version}`,
            version: String(latest.version),
            projectId: input.run.projectId ?? undefined,
            sceneType: "meeting",
            sceneId,
          },
        ],
        createdBy: latest.publishedBy,
      });
    }
  }
  for (const episode of input.episodes) {
    values.push({
      sourceKey: `agent-episode:${episode.id}`,
      kind: "agent-memory",
      version: episode.createdAt,
      authority: "evidence",
      visibility: episode.visibility === "private" ? "private" : "project",
      text: `[${episode.kind}] ${episode.summary}${episode.content === "" ? "" : `: ${episode.content}`}`,
      sourceRefs: [episodeSourceRef(episode)],
      createdBy: episode.createdBy,
      ...(input.run.executionEnvelope?.principalId === undefined
        ? {}
        : { ownerPrincipalId: input.run.executionEnvelope.principalId }),
    });
  }
  return values;
}

export class SceneContextService {
  constructor(private readonly repositories: PlatformRepositories) {}

  async prepare(
    input: PrepareSceneContextInput,
  ): Promise<PreparedSceneContext> {
    const scene = sceneIdentity(input);
    const principalId =
      input.run.executionEnvelope?.principalId ??
      scene.ownerPrincipalId ??
      "local-admin";
    const agentPrincipalId =
      input.run.executionEnvelope?.agentPrincipalId ??
      input.agent.principalId ??
      null;
    const channel =
      scene.sceneType === "direct-chat"
        ? await this.repositories.sceneContext.ensureChatChannel({
            sceneId: scene.sceneId,
            projectId: scene.projectId,
            ownerPrincipalId: scene.ownerPrincipalId!,
            agentId: input.agent.id,
            agentPrincipalId,
          })
        : null;
    const binding = await this.repositories.sceneContext.ensureSession({
      sceneType: scene.sceneType,
      sceneId: scene.sceneId,
      projectId: scene.projectId,
      agentId: input.agent.id,
      agentPrincipalId,
      ownerPrincipalId: scene.ownerPrincipalId,
      channelId: channel?.id ?? null,
    });
    const [projectTasks, messages, attachments, minutes] = await Promise.all([
      input.project === null
        ? Promise.resolve([])
        : this.repositories.tasks.list(input.project.id),
      input.task === null
        ? Promise.resolve([])
        : this.repositories.tasks.listMessages(input.task.id),
      input.task === null
        ? Promise.resolve([])
        : this.repositories.taskCollaboration.listAttachments(input.task.id),
      scene.sceneType === "meeting"
        ? this.repositories.meetingDecisions.getMinutes(scene.sceneId)
        : Promise.resolve(undefined),
    ]);
    for (const contribution of contributionInputs(
      input,
      scene.sceneType,
      scene.sceneId,
      projectTasks,
      messages,
      attachments,
      minutes,
    )) {
      await this.repositories.sceneContext.addContribution({
        session: binding,
        ...contribution,
      });
    }
    const [cursor, previousReceipt, contributions] = await Promise.all([
      this.repositories.sceneContext.cursor(binding.id),
      this.repositories.sceneContext.previousReceipt(binding.id, input.run.id),
      this.repositories.sceneContext.listContributions({
        session: binding,
        actorPrincipalId: principalId,
      }),
    ]);
    const stateful = runtimeStateful(input.run, input.runtimeStateful);
    const sourcePolicy = input.run.executionEnvelope?.envelope.sourcePolicy;
    const excluded: SceneContextExcludedSource[] = [];
    const allowedContributions = contributions.filter((contribution) => {
      if (
        contribution.projectId !== null &&
        contribution.projectId !== scene.projectId
      ) {
        excluded.push({
          sourceId: contribution.id,
          reason: "wrong-project",
        });
        return false;
      }
      const sourceClass = sourceClassForContribution(contribution.kind);
      if (
        sourcePolicy !== undefined &&
        (sourcePolicy.deny.includes(sourceClass) ||
          (sourcePolicy.allow.length > 0 &&
            !sourcePolicy.allow.includes(sourceClass)))
      ) {
        excluded.push({
          sourceId: contribution.id,
          reason: "source-policy",
        });
        return false;
      }
      return true;
    });
    const sceneBuild: SceneContextBuildInput = {
      binding,
      actorPrincipalId: principalId,
      contributions: allowedContributions,
      previousReceipt: stateful ? previousReceipt : undefined,
      runtimeStateful: stateful,
      cursorBefore: cursor?.cursorSequence ?? 0,
      excluded,
    };
    const createdAt = input.run.createdAt;
    const context =
      input.directChatContext !== null
        ? buildDirectChatContext({
            runId: input.run.id,
            thread: input.directChatContext.thread,
            turn: input.directChatContext.turn,
            messages: input.directChatContext.messages,
            agent: input.agent,
            scene: sceneBuild,
            now: new Date(createdAt),
          })
        : input.meetingContext !== null
          ? buildMeetingContext({
              runId: input.run.id,
              project: input.project!,
              meeting: input.meetingContext.meeting,
              turn: input.meetingContext.turn,
              messages: input.meetingContext.messages,
              agent: input.agent,
              scene: sceneBuild,
              now: new Date(createdAt),
            })
          : buildTaskContext({
              runId: input.run.id,
              project: input.project!,
              task: input.task!,
              agent: input.agent,
              dependencies: input.task!.dependsOn.flatMap((dependencyId) => {
                const dependency = projectTasks.find(
                  (candidate) => candidate.id === dependencyId,
                );
                return dependency === undefined
                  ? []
                  : [
                      {
                        id: dependency.id,
                        title: dependency.title,
                        status: dependency.status,
                      },
                    ];
              }),
              ...(scene.sceneType === "workflow-node"
                ? {
                    workflow: {
                      instanceId: input.run.workflowInstanceId!,
                      nodeId: input.run.workflowNodeId!,
                      status: input.run.status,
                    },
                  }
                : {}),
              scene: sceneBuild,
              now: new Date(createdAt),
            });
    const delivered = context.receipt.deliveredContributions;
    const reused = context.receipt.reusedContributions;
    const receipt: SceneContextReceipt = {
      id: context.receipt.id!,
      runId: input.run.id,
      contextPackId: context.pack.id,
      sceneSessionId: binding.id,
      sceneType: binding.sceneType,
      sceneId: binding.sceneId,
      projectId: binding.projectId,
      agentId: binding.agentId,
      principalId,
      agentPrincipalId: binding.agentPrincipalId,
      logicalDigest: context.pack.logicalDigest!,
      contentHash: context.pack.contentHash,
      rendererVersion: context.pack.rendererVersion!,
      runtimeStateful: stateful,
      cursorBefore: sceneBuild.cursorBefore,
      cursorAfter: context.receipt.cursorAfter!,
      delivered,
      reused,
      sourceRefs: context.receipt.sourceRefs!,
      excluded: context.receipt.sceneExcludedSources ?? excluded,
      createdAt,
    };
    const snapshot: SceneContextSnapshot = {
      binding,
      channel,
      cursor: cursor ?? null,
      receipt: null,
      contributions: allowedContributions,
    };
    return {
      binding,
      channel,
      pack: context.pack,
      legacyReceipt: context.receipt,
      receipt,
      snapshot,
    };
  }

  async commit(input: PreparedSceneContext): Promise<SceneContextReceipt> {
    const receipt = await this.repositories.sceneContext.saveDelivery({
      pack: input.pack,
      legacyReceipt: input.legacyReceipt,
      receipt: input.receipt,
    });
    return receipt;
  }

  async getRunSnapshot(
    runId: string,
    actorPrincipalId: string,
  ): Promise<SceneContextSnapshot | undefined> {
    return this.repositories.sceneContext.snapshotForRun(
      runId,
      actorPrincipalId,
    );
  }

  async addContribution(
    runId: string,
    input: CreateSceneContextContributionInput,
    actorPrincipalId: string,
  ): Promise<SceneContextContribution> {
    const receipt = await this.repositories.sceneContext.receiptByRun(runId);
    if (receipt === undefined) {
      throw new SceneContextRepositoryError(
        "scene_session_not_found",
        "Run Scene context is not available yet",
      );
    }
    const binding = await this.repositories.sceneContext.session(
      receipt.sceneSessionId,
    );
    if (binding === undefined) {
      throw new SceneContextRepositoryError(
        "scene_session_not_found",
        "Run Scene session is unavailable",
      );
    }
    const invalidRef = input.sourceRefs.find(
      (ref) =>
        (ref.projectId !== undefined && ref.projectId !== binding.projectId) ||
        (ref.sceneType !== undefined && ref.sceneType !== binding.sceneType) ||
        (ref.sceneId !== undefined && ref.sceneId !== binding.sceneId),
    );
    if (invalidRef !== undefined) {
      throw new SceneContextRepositoryError(
        "scene_context_conflict",
        "Contribution source reference is outside the Scene scope",
        { sourceRef: invalidRef },
      );
    }
    if (input.visibility === "private" && binding.ownerPrincipalId !== null) {
      if (binding.ownerPrincipalId !== actorPrincipalId) {
        throw new SceneContextRepositoryError(
          "scene_context_conflict",
          "Private Scene contributions require the Scene owner",
        );
      }
    }
    return this.repositories.sceneContext.addContribution({
      session: binding,
      ...input,
      visibility:
        binding.sceneType === "direct-chat" && input.visibility === "project"
          ? "scene"
          : input.visibility,
      createdBy: actorPrincipalId,
      ownerPrincipalId:
        input.visibility === "private"
          ? actorPrincipalId
          : binding.ownerPrincipalId,
    });
  }
}
