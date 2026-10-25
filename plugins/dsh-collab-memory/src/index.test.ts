import { describe, expect, it } from "vitest";
import { canDecideMemoryReview } from "./index.ts";
import {
  MemoryService,
  type KvTableLike,
  type MemoryExtractionExecutor,
} from "./service.ts";
import type {
  AgentMemoryEpisode,
  CurrentTruth,
  HandoffCard,
  IngestJob,
  ProjectClaim,
  ProjectTopic,
  ReviewItem,
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

function createService(
  now = "2026-10-22T00:00:00.000Z",
  executor?: MemoryExtractionExecutor,
) {
  return new MemoryService(
    {
      topics: new FakeTable<ProjectTopic>(),
      claims: new FakeTable<ProjectClaim>(),
      truths: new FakeTable<CurrentTruth>(),
      episodes: new FakeTable<AgentMemoryEpisode>(),
      handoffs: new FakeTable<HandoffCard>(),
      reviews: new FakeTable<ReviewItem>(),
      ingestJobs: new FakeTable<IngestJob>(),
    },
    {
      now: () => new Date(now),
      ...(executor === undefined ? {} : { executor: () => executor }),
    },
  );
}

describe("MemoryService", () => {
  it("limits Review decisions to admins, workspace owners, and the Review owner", () => {
    const base = {
      status: "pending" as const,
      actorUserId: "owner-a",
      globalRole: "member" as const,
      workspaceRole: "member" as const,
      reviewOwnerPrincipalId: "owner-a",
    };
    expect(canDecideMemoryReview(base)).toBe(true);
    expect(
      canDecideMemoryReview({
        ...base,
        actorUserId: "admin",
        globalRole: "admin",
        reviewOwnerPrincipalId: "owner-a",
      }),
    ).toBe(true);
    expect(
      canDecideMemoryReview({
        ...base,
        actorUserId: "workspace-owner",
        workspaceRole: "owner",
        reviewOwnerPrincipalId: "owner-a",
      }),
    ).toBe(true);
    expect(
      canDecideMemoryReview({
        ...base,
        actorUserId: "member-b",
      }),
    ).toBe(false);
    expect(
      canDecideMemoryReview({
        ...base,
        status: "approved",
      }),
    ).toBe(false);
  });

  it("resolves a decision from active to HOLD to conditional active", async () => {
    const service = createService();
    const topic = await service.createTopic({
      workspaceId: "project-a",
      title: "上线方案",
    });
    await service.publishClaim({
      workspaceId: "project-a",
      topicId: topic.id,
      kind: "decision",
      statement: "方案 A 可以上线",
      status: "active",
      publication: "system_effective",
      confidence: 0.95,
      sourceRefs: [{ type: "meeting", id: "meeting-1" }],
      effectiveAt: "2026-10-10T00:00:00.000Z",
      producerType: "agent",
      createdByPrincipalId: "principal-a",
    });
    await service.publishClaim({
      workspaceId: "project-a",
      topicId: topic.id,
      kind: "decision",
      statement: "成本数据不足，暂停方案 A",
      status: "hold",
      publication: "human_confirmed",
      confidence: 1,
      sourceRefs: [{ type: "meeting", id: "meeting-2" }],
      effectiveAt: "2026-10-15T00:00:00.000Z",
      reason: "成本数据缺失",
      resumeCriteria: "补齐成本表并通过复核",
      reviewOwnerPrincipalId: "principal-owner",
      producerType: "human",
    });
    const hold = service.resolveTruth(topic.id, "2026-10-16T00:00:00.000Z");
    expect(hold.status).toBe("hold");
    expect(hold.reason).toBe("成本数据缺失");
    expect(hold.resumeCriteria).toBe("补齐成本表并通过复核");

    await service.publishClaim({
      workspaceId: "project-a",
      topicId: topic.id,
      kind: "decision",
      statement: "方案 A 可以上线，但必须先灰度验证",
      status: "active",
      publication: "system_effective",
      confidence: 0.95,
      sourceRefs: [{ type: "meeting", id: "meeting-3" }],
      effectiveAt: "2026-10-18T00:00:00.000Z",
      reason: "成本数据已补齐",
      conditions: [
        {
          statement: "先完成小范围灰度验证",
          status: "unknown",
          evidenceRefs: [],
        },
      ],
      producerType: "agent",
    });
    const active = service.resolveTruth(topic.id, "2026-10-20T00:00:00.000Z");
    expect(active.status).toBe("active");
    expect(active.statement).toContain("灰度验证");
    expect(active.conditions).toHaveLength(1);
    expect(active.recentChange?.fromClaimId).toBeTruthy();
  });

  it("keeps supporting facts alongside the primary decision", async () => {
    const service = createService();
    const topic = await service.createTopic({
      workspaceId: "project-a",
      title: "供应商切换",
    });
    await service.publishClaim({
      workspaceId: "project-a",
      topicId: topic.id,
      kind: "decision",
      statement: "切换到供应商 B",
      status: "active",
      publication: "human_confirmed",
      confidence: 1,
      sourceRefs: [{ type: "meeting", id: "meeting-1" }],
      effectiveAt: "2026-10-10T00:00:00.000Z",
      producerType: "human",
    });
    await service.publishClaim({
      workspaceId: "project-a",
      topicId: topic.id,
      kind: "constraint",
      judgmentKey: "compliance",
      statement: "切换前必须完成合规审查",
      status: "active",
      publication: "human_confirmed",
      confidence: 1,
      sourceRefs: [{ type: "meeting", id: "meeting-1" }],
      effectiveAt: "2026-10-10T00:00:00.000Z",
      producerType: "human",
    });
    const truth = service.resolveTruth(topic.id, "2026-10-11T00:00:00.000Z");
    expect(truth.claims.map((claim) => claim.kind)).toEqual([
      "decision",
      "constraint",
    ]);
  });

  it("reports conflict for contradictory claims at the same effective time", async () => {
    const service = createService();
    const topic = await service.createTopic({
      workspaceId: "project-a",
      title: "发布窗口",
    });
    for (const statement of ["周五发布", "下周一发布"]) {
      await service.publishClaim({
        workspaceId: "project-a",
        topicId: topic.id,
        kind: "decision",
        judgmentKey: "release-window",
        statement,
        status: "active",
        publication: "human_confirmed",
        confidence: 1,
        sourceRefs: [{ type: "human-edit", id: statement }],
        effectiveAt: "2026-10-20T00:00:00.000Z",
        producerType: "human",
      });
    }
    const truth = service.resolveTruth(topic.id, "2026-10-22T00:00:00.000Z");
    expect(truth.status).toBe("conflict");
    expect(truth.conflicts).toHaveLength(1);
    expect(truth.statement).toBeUndefined();
  });

  it("isolates agent episodes by project", async () => {
    const service = createService();
    await service.writeEpisode({
      agentPrincipalId: "agent-a",
      ownerPrincipalIds: ["owner-a", "owner-b"],
      projectId: "project-x",
      scene: "task",
      sceneObjectId: "task-x",
      kind: "task-note",
      summary: "项目 X 的风险",
      sourceRefs: [{ type: "task", id: "task-x" }],
      occurredAt: "2026-10-20T00:00:00.000Z",
    });
    await service.writeEpisode({
      agentPrincipalId: "agent-a",
      ownerPrincipalId: "owner-a",
      projectId: "project-y",
      scene: "task",
      sceneObjectId: "task-y",
      kind: "task-note",
      summary: "项目 Y 的计划",
      sourceRefs: [{ type: "task", id: "task-y" }],
      occurredAt: "2026-10-21T00:00:00.000Z",
    });
    expect(
      service.recallAgent({
        agentPrincipalId: "agent-a",
        projectId: "project-x",
      }),
    ).toMatchObject([{ projectId: "project-x" }]);
    expect(
      service.recallAgent({
        agentPrincipalId: "agent-a",
        projectId: "project-x",
      })[0]?.ownerPrincipalIds,
    ).toEqual(["owner-a", "owner-b"]);
  });

  it("queues low-confidence candidates without changing current truth", async () => {
    const service = createService();
    const topic = await service.createTopic({
      workspaceId: "project-a",
      title: "新方案",
    });
    const candidate = await service.publishClaim({
      workspaceId: "project-a",
      topicId: topic.id,
      kind: "decision",
      statement: "可能下周启动",
      status: "proposed",
      publication: "review_required",
      confidence: 0.42,
      sourceRefs: [{ type: "meeting", id: "meeting-low" }],
      effectiveAt: "2026-10-20T00:00:00.000Z",
      producerType: "agent",
    });
    expect(candidate.publication).toBe("review_required");
    expect(service.truth(topic.id).status).toBe("no_truth");
    const reviews = service.listReview("project-a");
    expect(reviews).toMatchObject([
      { claimId: candidate.id, status: "pending" },
    ]);
    await service.decideReview({
      reviewId: reviews[0]!.id,
      decision: "approved",
      actorPrincipalId: "owner-a",
      note: "确认下周启动",
    });
    expect(service.truth(topic.id).status).toBe("active");
    expect(service.truth(topic.id).statement).toBe("可能下周启动");
  });

  it("extracts topics, claims and episodes from queued source snapshots", async () => {
    const executor: MemoryExtractionExecutor = async () => ({
      topics: [
        {
          title: "上线决策",
          aliases: ["发布日期"],
          claims: [
            {
              kind: "decision",
              statement: "确定在 10 月 30 日上线",
              judgmentKey: "primary-decision",
              confidence: 0.92,
              effectiveAt: "2026-10-22T00:00:00.000Z",
              conditions: [],
            },
          ],
        },
      ],
      episode: {
        kind: "episode",
        summary: "完成上线日期决策",
        agentPrincipalId: "principal-agent",
        occurredAt: "2026-10-22T00:00:00.000Z",
      },
      reviewOwnerPrincipalId: "owner-a",
    });
    const service = createService(undefined, executor);
    const job = await service.ingestSource({
      sourceType: "meeting",
      sourceId: "meeting-1",
      version: "v1",
      workspaceId: "project-a",
      payload: {
        title: "上线评审会",
        content: "会议决定在 10 月 30 日上线。",
        actorPrincipalId: "owner-a",
        projectId: "project-a",
        sourceRefs: [{ type: "meeting", id: "meeting-1" }],
        metadata: {},
      },
    });
    await service.waitIngestIdle();

    const topics = service.listTopics("project-a");
    expect(topics).toHaveLength(1);
    expect(topics[0]?.title).toBe("上线决策");
    expect(service.truth(topics[0]!.id)).toMatchObject({
      status: "active",
      statement: "确定在 10 月 30 日上线",
    });
    expect(
      service.recallAgent({
        agentPrincipalId: "principal-agent",
        projectId: "project-a",
      }),
    ).toMatchObject([{ summary: "完成上线日期决策" }]);
    expect(service.listIngestJobs("project-a")[0]).toMatchObject({
      id: job.id,
      status: "completed",
      attempts: 1,
    });
  });

  it("associates repeated topics and surfaces contradictory decisions as conflict", async () => {
    let decision = "第一版在 10 月 30 日上线";
    const executor: MemoryExtractionExecutor = async () => ({
      topics: [
        {
          title: "上线决策",
          aliases: ["发布日期"],
          claims: [
            {
              kind: "decision",
              statement: decision,
              judgmentKey: "primary-decision",
              confidence: 0.95,
              effectiveAt: "2026-10-22T00:00:00.000Z",
              conditions: [],
            },
          ],
        },
      ],
    });
    const service = createService(undefined, executor);
    await service.ingestSource({
      sourceType: "meeting",
      sourceId: "meeting-1",
      version: "v1",
      workspaceId: "project-a",
      payload: {
        title: "第一次上线评审",
        content: decision,
        sourceRefs: [{ type: "meeting", id: "meeting-1:first" }],
        metadata: {},
      },
    });
    await service.waitIngestIdle();
    decision = "改到 11 月 5 日上线";
    await service.ingestSource({
      sourceType: "meeting",
      sourceId: "meeting-2",
      version: "v1",
      workspaceId: "project-a",
      payload: {
        title: "第二次上线评审",
        content: decision,
        sourceRefs: [{ type: "meeting", id: "meeting-2:second" }],
        metadata: {},
      },
    });
    await service.waitIngestIdle();

    expect(service.listTopics("project-a")).toHaveLength(1);
    expect(service.truth(service.listTopics("project-a")[0]!.id)).toMatchObject({
      status: "conflict",
      conflicts: [{ claimIds: expect.any(Array) }],
    });
  });

  it("forces ambiguous topic associations into review and uses the trusted review owner", async () => {
    const executor: MemoryExtractionExecutor = async () => ({
      topics: [
        {
          title: "发布窗口",
          aliases: [],
          claims: [
            {
              kind: "decision",
              statement: "确定周五发布",
              judgmentKey: "release-window",
              confidence: 0.98,
              effectiveAt: "2026-10-22T00:00:00.000Z",
              conditions: [],
            },
          ],
        },
      ],
      reviewOwnerPrincipalId: "untrusted-model-owner",
    });
    const service = createService(undefined, executor);
    await service.createTopic({
      workspaceId: "project-a",
      title: "发布窗口",
    });
    await service.createTopic({
      workspaceId: "project-a",
      title: "发布窗口计划",
      aliases: ["发布窗口"],
    });
    await service.ingestSource({
      sourceType: "meeting",
      sourceId: "meeting-ambiguous",
      version: "v1",
      workspaceId: "project-a",
      payload: {
        title: "发布评审",
        content: "确定周五发布。",
        actorPrincipalId: "owner-a",
        sourceRefs: [{ type: "meeting", id: "meeting-ambiguous" }],
        metadata: {},
      },
    });
    await service.waitIngestIdle();

    const reviews = service.listReview("project-a");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.reason).toContain("主题关联待确认");
    const claim = service.claim(reviews[0]!.claimId!);
    expect(claim).toMatchObject({
      publication: "review_required",
      reviewOwnerPrincipalId: "owner-a",
    });
    expect(service.listTopics("project-a")).toHaveLength(2);
    expect(service.truth(claim!.topicId).status).toBe("no_truth");
  });

  it("marks legacy jobs without a source snapshot as unrecoverable", async () => {
    const service = createService();
    const job = await service.ingestSource({
      sourceType: "meeting",
      sourceId: "legacy-meeting",
      version: "v1",
      workspaceId: "project-a",
    });

    await service.drainIngestJobs();

    expect(service.listIngestJobs("project-a")[0]).toMatchObject({
      id: job.id,
      status: "unrecoverable",
      attempts: 0,
      error: expect.stringContaining("no source snapshot"),
    });
    await expect(service.retryFailedIngestJobs("project-a")).resolves.toBe(0);
    expect(service.listIngestJobs("project-a")[0]?.status).toBe(
      "unrecoverable",
    );
  });

  it("deduplicates source ingestion by source key", async () => {
    const service = createService();
    const first = await service.ingestSource({
      sourceType: "meeting",
      sourceId: "meeting-1",
      version: "v3",
      workspaceId: "project-a",
    });
    const second = await service.ingestSource({
      sourceType: "meeting",
      sourceId: "meeting-1",
      version: "v3",
      workspaceId: "project-a",
    });
    expect(second.id).toBe(first.id);
  });
});
