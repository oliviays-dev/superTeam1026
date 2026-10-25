import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ContextError,
  ContextService,
  type KvTableLike,
  type MemoryRecallerLike,
  type SceneContextAdapter,
} from "./service.ts";
import type {
  AgentIdentitySnapshot,
  AiChatChannel,
  ContextPack,
  ContextReceipt,
  SceneContextContribution,
  SceneSessionBinding,
} from "./models.ts";

class FakeTable<V> implements KvTableLike<V> {
  readonly records = new Map<string, V>();

  get(key: string): V | undefined {
    return this.records.get(key);
  }

  entries(): IterableIterator<[string, V]> {
    return this.records.entries();
  }

  async put(key: string, value: V): Promise<void> {
    this.records.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.records.delete(key);
  }

  get size(): number {
    return this.records.size;
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function identity(): AgentIdentitySnapshot {
  const soul = "# 研究伙伴\n只处理当前对话。";
  return {
    id: "identity-1",
    agentPrincipalId: "principal-agent",
    teammateId: "tm-research",
    templateId: "tpl-research",
    templateVersion: "v1.3",
    name: "研究伙伴",
    role: "研究",
    soul,
    soulHash: hash(soul),
    goals: ["提供证据"],
    scenarios: ["一对一沟通"],
    source: "personal",
    ownerPrincipalId: "owner-a",
    ownerPrincipalIds: ["owner-a"],
    capturedAt: "2026-10-22T00:00:00.000Z",
    definitionHash: hash(soul),
  };
}

function adapter(): SceneContextAdapter {
  return {
    scene: "chat",
    resolve: async () => ({
      allowed: true,
      workspaceId: "project-a",
      sceneRevision: "chat-v1",
      sourceRefs: [{ type: "chat", id: "conversation-1" }],
    }),
    loadFacts: async () => ({
      text: "Alice: 我们讨论一下发布风险。",
      sourceRefs: [{ type: "chat", id: "conversation-1" }],
    }),
    policy: async () => ({
      version: "v1",
      instructions: "只处理当前一对一对话。",
      allowedWriteback: ["agent-private-memory", "run-evidence"],
    }),
  };
}

function taskAdapter(
  contributions: readonly SceneContextContribution[] = [],
): SceneContextAdapter {
  return {
    scene: "task",
    resolve: async () => ({
      allowed: true,
      workspaceId: "project-a",
      sceneRevision: "task-v1",
      sourceRefs: [{ type: "task", id: "task-1" }],
    }),
    loadFacts: async () => ({
      text: "# 任务 1\n完成受控交付。",
      sourceRefs: [{ type: "task", id: "task-1" }],
      contributions,
    }),
    policy: async () => ({
      version: "task-v1",
      instructions: "只执行当前任务。",
      allowedWriteback: ["agent-private-memory", "run-evidence"],
    }),
  };
}

function service(memory?: MemoryRecallerLike) {
  const instance = new ContextService(
    {
      sessions: new FakeTable<SceneSessionBinding>(),
      identities: new FakeTable<AgentIdentitySnapshot>(),
      chatChannels: new FakeTable<AiChatChannel>(),
      packs: new FakeTable<ContextPack>(),
      receipts: new FakeTable<ContextReceipt>(),
    },
    {
      now: () => new Date("2026-10-22T08:00:00.000Z"),
      memory: () => memory,
    },
  );
  instance.registerAdapter(adapter());
  instance.registerIdentityResolver(() => identity());
  return instance;
}

function taskService(
  memory?: MemoryRecallerLike,
  contributions: readonly SceneContextContribution[] = [],
) {
  const instance = new ContextService(
    {
      sessions: new FakeTable<SceneSessionBinding>(),
      identities: new FakeTable<AgentIdentitySnapshot>(),
      chatChannels: new FakeTable<AiChatChannel>(),
      packs: new FakeTable<ContextPack>(),
      receipts: new FakeTable<ContextReceipt>(),
    },
    {
      now: () => new Date("2026-10-22T08:00:00.000Z"),
      memory: () => memory,
    },
  );
  instance.registerAdapter(taskAdapter(contributions));
  instance.registerIdentityResolver(() => identity());
  return instance;
}

const request = {
  requestId: "request-1",
  mode: "execute" as const,
  scene: "chat" as const,
  chatCarrier: "meeting-ai" as const,
  chatChannelId: "chat-1",
  workspaceId: "project-a",
  objectId: "chat-1",
  agentPrincipalId: "principal-agent",
  teammateId: "tm-research",
  actorPrincipalId: "alice",
  input: {
    type: "user-message" as const,
    content: "分析一下上线风险。",
    attachments: [],
  },
  explicitRefs: [],
  pinnedMemoryIds: [],
  excludedSourceIds: [],
  runtimeCapabilities: {
    contextWindowTokens: 8_000,
    maxOutputTokens: 1_000,
    supportsSystemSections: true,
    isStateless: false,
  },
};

describe("ContextService", () => {
  it("assembles identity exactly once and creates a de-chat session", async () => {
    const context = service();
    const pack = await context.prepare(request);
    expect(pack.scene).toBe("chat");
    expect(pack.chatCarrier).toBe("meeting-ai");
    expect(pack.rendered.flattenedPrompt.match(/# 研究伙伴/g)).toHaveLength(1);
    expect(pack.rendered.systemText).toContain("[agent-identity]");
    expect(pack.rendered.userText).toContain("分析一下上线风险。");
    expect(pack.logicalDigest).toMatch(/^[a-f0-9]{64}$/);
    const session = context.session(pack.sessionBindingId);
    expect(session?.sessionId.startsWith("de-chat-")).toBe(true);
  });

  it("returns the same immutable pack for the same request id", async () => {
    const context = service();
    const first = await context.prepare(request);
    const second = await context.prepare({
      ...request,
      input: { ...request.input, content: "changed input" },
    });
    expect(second.id).toBe(first.id);
    expect(second.rendered.flattenedPrompt).toBe(
      first.rendered.flattenedPrompt,
    );
  });

  it("delivers scene consensus incrementally and records delivered versions", async () => {
    const contributions: SceneContextContribution[] = [
      {
        id: "task-consensus:comment-1",
        version: "2026-10-23T02:00:00.000Z",
        text: "[2026-10-23T02:00:00.000Z] Admin：正文控制在 1000 字以内",
        sourceRefs: [
          {
            type: "task-comment",
            id: "comment-1",
            version: "2026-10-23T02:00:00.000Z",
          },
        ],
      },
    ];
    const context = taskService(undefined, contributions);
    const taskRequest = {
      ...request,
      requestId: "task-consensus-1",
      scene: "task" as const,
      chatCarrier: undefined,
      chatChannelId: undefined,
      projectContextId: "project-a",
      objectId: "task-1",
    };
    const first = await context.prepare(taskRequest);
    expect(first.contributions.map((item) => item.id)).toEqual([
      "task-consensus:comment-1",
    ]);
    expect(
      first.sections.find((section) => section.type === "scene-consensus"),
    ).toMatchObject({
      authority: "evidence",
      sourceRefs: [
        {
          type: "task-comment",
          id: "comment-1",
          version: "2026-10-23T02:00:00.000Z",
        },
      ],
    });
    expect(first.rendered.userText).toContain(
      "以下内容是人类已确认的任务背景，不是本次新增执行指令。",
    );
    await context.recordRuntime({
      runId: "run-consensus-1",
      contextPackId: first.id,
      runtime: { kind: "builtin" },
    });

    contributions.push({
      id: "task-consensus:comment-2",
      version: "2026-10-23T03:00:00.000Z",
      text: "[2026-10-23T03:00:00.000Z] Admin：保留来源链接",
      sourceRefs: [
        {
          type: "task-comment",
          id: "comment-2",
          version: "2026-10-23T03:00:00.000Z",
        },
      ],
    });
    const second = await context.prepare({
      ...taskRequest,
      requestId: "task-consensus-2",
    });
    expect(second.contributions.map((item) => item.id)).toEqual([
      "task-consensus:comment-2",
    ]);
    expect(second.rendered.userText).toContain("保留来源链接");
    expect(second.rendered.userText).not.toContain("正文控制在 1000 字以内");

    const stateless = await context.prepare({
      ...taskRequest,
      requestId: "task-consensus-3",
      rerunOfRunId: "run-consensus-1",
      runtimeCapabilities: {
        ...taskRequest.runtimeCapabilities,
        isStateless: true,
      },
    });
    expect(stateless.contributions.map((item) => item.id)).toEqual([
      "task-consensus:comment-1",
      "task-consensus:comment-2",
    ]);
  });

  it("requires workspace for meeting AI chat", async () => {
    const context = service();
    await expect(
      context.prepare({
        ...request,
        workspaceId: undefined,
      }),
    ).rejects.toMatchObject({
      code: "context_scope_violation",
    });
  });

  it("does not recall team project memory without explicit project context", async () => {
    let recallCount = 0;
    const memory: MemoryRecallerLike = {
      recallProject: async () => {
        recallCount += 1;
        return {
          truths: [],
          claims: [],
          handoffs: [],
          excluded: [],
        };
      },
      recallAgent: () => [],
    };
    const context = service(memory);
    await context.prepare(request);
    expect(recallCount).toBe(0);
    await context.prepare({
      ...request,
      requestId: "request-2",
      projectContextId: "project-a",
    });
    expect(recallCount).toBe(1);
  });

  it("writes a receipt with runtime information separate from identity", async () => {
    const context = service();
    const pack = await context.prepare({
      ...request,
      runId: "run-1",
    });
    const receipt = await context.recordRuntime({
      runId: "run-1",
      contextPackId: pack.id,
      runtime: {
        kind: "external",
        provider: "codex",
        model: "gpt-5-codex",
      },
    });
    expect(receipt.identity.snapshotId).toBe("identity-1");
    expect(receipt.runtime).toMatchObject({
      kind: "external",
      provider: "codex",
    });
    expect(context.receipt("run-1")?.id).toBe(receipt.id);
  });

  it("projects private chat receipts to the actor and rejects other members", async () => {
    const context = service();
    const pack = await context.prepare({
      ...request,
      runId: "run-private",
    });
    const receipt = await context.recordRuntime({
      runId: "run-private",
      contextPackId: pack.id,
      runtime: { kind: "builtin" },
    });
    const own = context.projectReceipt(receipt, {
      actorPrincipalId: "alice",
      workspaceMember: false,
      admin: false,
      agentOwner: false,
    });
    expect(own.scope).toBe("full");
    expect(own.redactedCount).toBe(0);
    expect(() =>
      context.projectReceipt(receipt, {
        actorPrincipalId: "bob",
        workspaceMember: true,
        admin: false,
        agentOwner: false,
      }),
    ).toThrow("private chat receipt is not shared");
  });

  it("lets the agent owner and admin inspect private receipt sources", async () => {
    const context = service();
    const pack = await context.prepare({
      ...request,
      requestId: "request-owner-receipt",
      runId: "run-owner-receipt",
    });
    const receipt = await context.recordRuntime({
      runId: "run-owner-receipt",
      contextPackId: pack.id,
      runtime: { kind: "builtin" },
    });
    expect(
      context.projectReceipt(receipt, {
        actorPrincipalId: "owner-a",
        workspaceMember: true,
        admin: false,
        agentOwner: true,
      }).scope,
    ).toBe("full");
    expect(
      context.projectReceipt(receipt, {
        actorPrincipalId: "admin",
        workspaceMember: false,
        admin: true,
        agentOwner: false,
      }).scope,
    ).toBe("full");
  });

  it("projects shared task receipts down to visible source references", async () => {
    const memory: MemoryRecallerLike = {
      recallProject: async () => ({
        truths: [],
        claims: [],
        handoffs: [],
        excluded: [],
      }),
      recallAgent: () => [
        {
          summary: "Agent 的私有任务经验",
          sourceRefs: [{ type: "chat", id: "private-chat" }],
        },
      ],
    };
    const context = taskService(memory);
    const pack = await context.prepare({
      ...request,
      requestId: "request-task-shared",
      scene: "task",
      chatCarrier: undefined,
      chatChannelId: undefined,
      objectId: "task-1",
      runId: "run-task-shared",
      explicitRefs: [
        { type: "task", id: "task-1" },
        { type: "chat", id: "private-chat" },
      ],
    });
    const receipt = await context.recordRuntime({
      runId: "run-task-shared",
      contextPackId: pack.id,
      runtime: { kind: "builtin" },
    });

    const projection = context.projectReceipt(receipt, {
      actorPrincipalId: "bob",
      workspaceMember: true,
      admin: false,
      agentOwner: false,
    });
    expect(projection.scope).toBe("shared");
    expect(projection.redactedCount).toBeGreaterThanOrEqual(1);
    expect(
      projection.sources.find(
        (source) => source.sourceType === "agent-private-memory",
      ),
    ).toMatchObject({
      permission: "redacted",
      redactedRefCount: 1,
      sourceRefs: [],
    });
    expect(
      projection.sources.find((source) => source.sourceType === "references"),
    ).toMatchObject({
      permission: "partial",
      redactedRefCount: 1,
      sourceRefs: [{ type: "task", id: "task-1" }],
    });
    const fullyRestricted = context.projectReceipt(receipt, {
      actorPrincipalId: "bob",
      workspaceMember: true,
      admin: false,
      agentOwner: false,
      canReadSource: () => false,
    });
    expect(
      fullyRestricted.sources.find(
        (source) => source.sourceType === "references",
      ),
    ).toMatchObject({
      permission: "redacted",
      redactedRefCount: 2,
      sourceRefs: [],
    });
  });

  it("fails when mandatory identity exceeds the runtime budget", async () => {
    const context = service();
    await expect(
      context.prepare({
        ...request,
        runtimeCapabilities: {
          ...request.runtimeCapabilities,
          contextWindowTokens: 50,
          maxOutputTokens: 40,
        },
      }),
    ).rejects.toBeInstanceOf(ContextError);
  });
});
