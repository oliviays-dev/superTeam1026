import { createHash } from "node:crypto";
import type {
  Agent,
  AgentEpisode,
  ContextPack,
  ContextReceipt,
  CreateSceneContextContributionInput,
  Delegation,
  MeetingPrivateBriefing,
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
  readonly delegation?: Delegation | undefined;
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
  if (input.delegation !== undefined) {
    return {
      sceneType: "delegation",
      sceneId: input.delegation.id,
      projectId: input.delegation.projectId,
      ownerPrincipalId: input.delegation.ownerPrincipalId,
    };
  }
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
      return "workspace";
    case "meeting-private-note":
      return "private-local-data";
    case "direct-chat-message":
      return "private-local-data";
    case "delegation-brief":
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
  privateBriefings: readonly MeetingPrivateBriefing[],
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
  for (const briefing of privateBriefings) {
    values.push({
      sourceKey: `meeting-private-briefing:${briefing.id}`,
      kind: "meeting-private-note",
      version: String(briefing.revision),
      authority: "instruction",
      visibility: "private",
      text: `[Private briefing from ${briefing.ownerPrincipalId}] ${briefing.content}`,
      sourceRefs: [
        {
          type: "meeting",
          id: sceneId,
          projectId: input.run.projectId ?? undefined,
          sceneType: "meeting",
          sceneId,
        },
        {
          type: "meeting-private-briefing",
          id: briefing.id,
          label: "Private meeting briefing",
          version: String(briefing.revision),
          projectId: input.run.projectId ?? undefined,
          sceneType: "meeting",
          sceneId,
        },
      ],
      createdBy: briefing.ownerPrincipalId,
      ownerPrincipalId:
        input.run.executionEnvelope?.principalId ??
        briefing.audiencePrincipalId,
    });
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
    const delegation =
      input.delegation ??
      (await this.repositories.delegations.getByRun(input.run.id));
    const effectiveInput = { ...input, delegation };
    const scene = sceneIdentity(effectiveInput);
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
    const participantBinding =
      scene.sceneType === "meeting" || scene.sceneType === "group"
        ? await this.repositories.sceneContext.ensureParticipantBinding({
            sceneId: scene.sceneId,
            projectId: scene.projectId!,
            agentId: input.agent.id,
            agentPrincipalId:
              agentPrincipalId ?? input.agent.principalId ?? input.agent.id,
            principalId:
              agentPrincipalId ??
              input.agent.principalId ??
              input.agent.id,
          })
        : undefined;
    const binding = await this.repositories.sceneContext.ensureSession({
      sceneType: scene.sceneType,
      sceneId: scene.sceneId,
      projectId: scene.projectId,
      agentId: input.agent.id,
      agentPrincipalId,
      ownerPrincipalId: scene.ownerPrincipalId,
      channelId: channel?.id ?? null,
      delegationId: delegation?.id ?? null,
      participantBindingId: participantBinding?.id ?? null,
    });
    const [
      projectTasks,
      messages,
      attachments,
      minutes,
      privateBriefings,
    ] = await Promise.all([
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
      scene.sceneType === "meeting"
        ? this.repositories.meetingCollaboration.listBriefingsForContext({
            meetingId: scene.sceneId,
            principalId,
            agentId: input.agent.id,
            agentPrincipalId,
          })
        : Promise.resolve([]),
    ]);
    for (const contribution of contributionInputs(
      effectiveInput,
      scene.sceneType,
      scene.sceneId,
      projectTasks,
      messages,
      attachments,
      minutes,
      privateBriefings,
    )) {
      await this.repositories.sceneContext.addContribution({
        session: binding,
        ...contribution,
      });
    }
    if (delegation !== undefined && delegation.status === "active") {
      await this.repositories.sceneContext.addContribution({
        session: binding,
        sourceKey: `delegation-brief:${delegation.revision}`,
        kind: "delegation-brief",
        version: String(delegation.revision),
        authority: "instruction",
        visibility: "scene",
        text: [
          `Objective: ${delegation.objective}`,
          delegation.stance === "" ? "" : `Stance: ${delegation.stance}`,
          delegation.watchItems.length === 0
            ? ""
            : `Watch items: ${delegation.watchItems.join("; ")}`,
          `Allowed: ${delegation.allowedActions.join(", ")}`,
          `Denied: ${delegation.deniedActions.join(", ")}`,
        ]
          .filter((line) => line !== "")
          .join("\n")
          .slice(0, 20_000),
        sourceRefs: [
          {
            type: "delegation",
            id: delegation.id,
            label: delegation.displayName,
            version: String(delegation.revision),
            ...(delegation.projectId === null
              ? {}
              : { projectId: delegation.projectId }),
            sceneType: "delegation",
            sceneId: delegation.id,
          },
        ],
        createdBy: "system:delegation",
        ownerPrincipalId: delegation.ownerPrincipalId,
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
    const contextPolicy =
      await this.repositories.contextPolicies.effective(
        scene.projectId,
        scene.sceneType === "group"
          ? "group"
          : scene.sceneType === "meeting"
            ? "meeting"
            : scene.sceneType === "direct-chat"
              ? "direct-chat"
              : "default",
      );
    const sourcePolicy = input.run.executionEnvelope?.envelope.sourcePolicy;
    const excluded: SceneContextExcludedSource[] = [];
    let allowedContributions = contributions.filter((contribution) => {
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
    const estimatedChars = allowedContributions.reduce(
      (total, contribution) => total + contribution.text.length,
      0,
    );
    const contextUsageRatio = Math.min(
      99,
      estimatedChars / contextPolicy.settings.maxContextChars,
    );
    let budgetExceeded = false;
    if (contextUsageRatio >= contextPolicy.settings.rolloverRatio) {
      budgetExceeded = true;
      for (const contribution of allowedContributions) {
        excluded.push({
          sourceId: contribution.id,
          reason: "budget",
          safeLabel: contribution.sourceKey,
        });
      }
      allowedContributions = [];
    }
    const sceneBuild: SceneContextBuildInput = {
      binding,
      actorPrincipalId: principalId,
      contributions: allowedContributions,
      previousReceipt: stateful ? previousReceipt : undefined,
      runtimeStateful: stateful,
      cursorBefore: binding.lastContextSeq,
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
    let pack = context.pack;
    if (budgetExceeded) {
      const index = excluded
        .filter((source) => source.reason === "budget")
        .map((source) => `- ${source.safeLabel ?? source.sourceId ?? "source"}`)
        .join("\n");
      const renderedPrompt = [
        pack.renderedPrompt,
        "",
        "# Context budget exceeded",
        "Full source text was withheld because the Scene budget rollover threshold was reached.",
        "Only the source index and controlled tool entry points are available:",
        index,
        "Use entity.read, task.runs, or meeting.history to retrieve an authorized source incrementally.",
      ].join("\n");
      const contentHash = createHash("sha256")
        .update(renderedPrompt)
        .digest("hex");
      pack = {
        ...pack,
        renderedPrompt,
        contentHash,
        logicalDigest: contentHash,
      };
    }
    const delivered = context.receipt.deliveredContributions;
    const reused = context.receipt.reusedContributions;
    const boundarySeq = context.receipt.cursorAfter!;
    pack = {
      ...pack,
      contextBoundarySeq: boundarySeq,
      contextPolicyVersion: contextPolicy.revision,
      contextUsageRatio,
      rendererVersion:
        contextUsageRatio >= contextPolicy.settings.rolloverRatio
          ? "scene-context-v2-budget-index"
          : "scene-context-v2-incremental",
    };
    const receipt: SceneContextReceipt = {
      id: context.receipt.id!,
      runId: input.run.id,
      contextPackId: pack.id,
      sceneSessionId: binding.id,
      sceneType: binding.sceneType,
      sceneId: binding.sceneId,
      projectId: binding.projectId,
      delegationId: binding.delegationId ?? null,
      agentId: binding.agentId,
      principalId,
      agentPrincipalId: binding.agentPrincipalId,
      logicalDigest: context.pack.logicalDigest!,
      contentHash: context.pack.contentHash,
      rendererVersion: pack.rendererVersion!,
      runtimeStateful: stateful,
      contextBoundarySeq: boundarySeq,
      contextPolicyVersion: contextPolicy.revision,
      contextUsageRatio,
      cursorBefore: sceneBuild.cursorBefore,
      cursorAfter: boundarySeq,
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
      commitReceipt: null,
      contributions: allowedContributions,
    };
    return {
      binding,
      channel,
      pack,
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

  async stage(input: PreparedSceneContext): Promise<SceneContextReceipt> {
    return this.repositories.sceneContext.savePreparedDelivery({
      pack: input.pack,
      legacyReceipt: input.legacyReceipt,
      receipt: input.receipt,
    });
  }

  async commitConsumed(runId: string) {
    return this.repositories.sceneContext.commitConsumed(runId);
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
