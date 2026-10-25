import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  claimSchema,
  conditionSchema,
  currentTruthSchema,
  episodeSchema,
  handoffSchema,
  ingestJobSchema,
  memoryExtractionSchema,
  reviewItemSchema,
  sourceRefSchema,
  topicSchema,
  type AgentMemoryEpisode,
  type ClaimCondition,
  type CurrentTruth,
  type HandoffCard,
  type IngestJob,
  type MemoryExtraction,
  type ProjectClaim,
  type ProjectTopic,
  type ReviewItem,
  type SourceRef,
} from "./models.js";

export interface KvTableLike<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
  readonly size: number;
}

export interface MemoryTables {
  readonly topics: KvTableLike<ProjectTopic>;
  readonly claims: KvTableLike<ProjectClaim>;
  readonly truths: KvTableLike<CurrentTruth>;
  readonly episodes: KvTableLike<AgentMemoryEpisode>;
  readonly handoffs: KvTableLike<HandoffCard>;
  readonly reviews: KvTableLike<ReviewItem>;
  readonly ingestJobs: KvTableLike<IngestJob>;
}

export class MemoryError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "revision_conflict",
    message: string,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

export interface PublishClaimInput {
  readonly workspaceId: string;
  readonly topicId: string;
  readonly kind: ProjectClaim["kind"];
  readonly judgmentKey?: string;
  readonly statement: string;
  readonly status: ProjectClaim["status"];
  readonly publication: ProjectClaim["publication"];
  readonly confidence: number;
  readonly sourceRefs: readonly SourceRef[];
  readonly effectiveAt: string;
  readonly recordedAt?: string;
  readonly validUntil?: string;
  readonly reason?: string;
  readonly resumeCriteria?: string;
  readonly reviewOwnerPrincipalId?: string;
  readonly action?: ProjectClaim["action"];
  readonly conditions?: readonly ClaimCondition[];
  readonly supersedes?: readonly string[];
  readonly producerType: ProjectClaim["producerType"];
  readonly createdByPrincipalId?: string;
  readonly identitySnapshotId?: string;
  readonly templateVersion?: string;
  readonly extractorVersion?: string;
  /** Internal review routing reason; not persisted on the immutable Claim. */
  readonly reviewReason?: string;
}

export interface RecallProjectInput {
  readonly workspaceId: string;
  readonly query: string;
  readonly objectRefs?: readonly SourceRef[];
  readonly asOf?: string;
  readonly limit?: number;
}

export interface RecallProjectResult {
  readonly truths: readonly CurrentTruth[];
  readonly claims: readonly ProjectClaim[];
  readonly handoffs: readonly HandoffCard[];
  readonly excluded: readonly {
    readonly sourceId?: string;
    readonly reason:
      | "permission"
      | "wrong-project"
      | "irrelevant"
      | "superseded"
      | "user-excluded"
      | "budget"
      | "missing"
      | "unverified";
  }[];
}

export interface WriteEpisodeInput {
  readonly agentPrincipalId: string;
  readonly ownerPrincipalId?: string;
  readonly ownerPrincipalIds?: readonly string[];
  readonly projectId?: string;
  readonly scene: AgentMemoryEpisode["scene"];
  readonly chatCarrier?: AgentMemoryEpisode["chatCarrier"];
  readonly chatChannelId?: string;
  readonly sceneObjectId: string;
  readonly runId?: string;
  readonly kind: AgentMemoryEpisode["kind"];
  readonly summary: string;
  readonly sourceRefs: readonly SourceRef[];
  readonly occurredAt: string;
  readonly sensitivity?: AgentMemoryEpisode["sensitivity"];
}

export interface RecallAgentInput {
  readonly agentPrincipalId: string;
  readonly projectId?: string;
  readonly scene?: AgentMemoryEpisode["scene"];
  readonly query?: string;
  readonly limit?: number;
}

const publishInputSchema = z.object({
  workspaceId: z.string().trim().min(1).max(200),
  topicId: z.string().trim().min(1).max(180),
  kind: claimSchema.shape.kind,
  judgmentKey: z.string().trim().min(1).max(200).optional(),
  statement: z.string().trim().min(1).max(20_000),
  status: claimSchema.shape.status,
  publication: claimSchema.shape.publication,
  confidence: z.number().min(0).max(1),
  sourceRefs: z.array(sourceRefSchema).min(1).max(200),
  effectiveAt: z.string().datetime({ precision: 3 }),
  recordedAt: z.string().datetime({ precision: 3 }).optional(),
  validUntil: z.string().datetime({ precision: 3 }).optional(),
  reason: z.string().trim().max(4_000).optional(),
  resumeCriteria: z.string().trim().max(4_000).optional(),
  reviewOwnerPrincipalId: z.string().trim().min(1).max(180).optional(),
  action: claimSchema.shape.action,
  conditions: z.array(conditionSchema).max(100).default([]),
  supersedes: z.array(z.string().trim().min(1).max(180)).max(100).default([]),
  producerType: claimSchema.shape.producerType,
  createdByPrincipalId: z.string().trim().min(1).max(180).optional(),
  identitySnapshotId: z.string().trim().min(1).max(180).optional(),
  templateVersion: z.string().trim().max(80).optional(),
  extractorVersion: z.string().trim().max(80).optional(),
  reviewReason: z.string().trim().min(1).max(4_000).optional(),
});

const handoffInputSchema = handoffSchema
  .omit({
    id: true,
    status: true,
    revision: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    status: handoffSchema.shape.status.optional(),
    revision: z.number().int().positive().optional(),
  });

const reviewDecisionSchema = z.object({
  reviewId: z.string().trim().min(1).max(180),
  decision: z.enum(["approved", "rejected", "superseded"]),
  actorPrincipalId: z.string().trim().min(1).max(180),
  note: z.string().trim().max(4_000).optional(),
});

const sourceIngestSchema = z.object({
  sourceType: ingestJobSchema.shape.sourceType,
  sourceId: z.string().trim().min(1).max(240),
  version: z.string().trim().min(1).max(120),
  workspaceId: z.string().trim().min(1).max(200).optional(),
  payload: ingestJobSchema.shape.payload,
});

export type MemoryExtractionExecutor = (
  job: IngestJob,
) => Promise<MemoryExtraction>;

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new MemoryError("invalid_input", "memory input is invalid");
  }
  return parsed.data;
}

function values<V>(table: KvTableLike<V>): V[] {
  return [...table.entries()].map(([, value]) => value);
}

function claimKey(claim: ProjectClaim): string {
  return `${claim.workspaceId}:${claim.topicId}:${claim.id}`;
}

function truthKey(workspaceId: string, topicId: string): string {
  return `${workspaceId}:${topicId}`;
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function latestPerJudgment(
  claims: readonly ProjectClaim[],
  defaultKey: (claim: ProjectClaim) => string,
): Map<string, ProjectClaim[]> {
  const grouped = new Map<string, ProjectClaim[]>();
  for (const claim of claims) {
    const key = claim.judgmentKey ?? defaultKey(claim);
    const group = grouped.get(key) ?? [];
    group.push(claim);
    grouped.set(key, group);
  }
  const latest = new Map<string, ProjectClaim[]>();
  for (const [key, group] of grouped) {
    const maxEffectiveAt = group
      .map((claim) => claim.effectiveAt)
      .sort()
      .at(-1);
    latest.set(
      key,
      group
        .filter((claim) => claim.effectiveAt === maxEffectiveAt)
        .sort((left, right) => right.sequence - left.sequence),
    );
  }
  return latest;
}

function hasSupersession(left: ProjectClaim, right: ProjectClaim): boolean {
  return (
    left.supersedes.includes(right.id) || right.supersedes.includes(left.id)
  );
}

function normalizeTokens(value: string): string[] {
  return value
    .toLocaleLowerCase("zh-Hans-CN")
    .split(/[\s,，。；;、/]+/)
    .map((token) => token.trim())
    .filter((token) => token !== "");
}

function normalizedLabel(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-Hans-CN").trim();
}

interface TopicAssociation {
  readonly topic: ProjectTopic;
  readonly score: number;
  readonly method: "object-ref" | "label" | "lexical";
  readonly candidates: readonly ProjectTopic[];
  readonly requiresReview: boolean;
}

const TOPIC_ASSOCIATION_VERSION = "topic-association-v1";
const TOPIC_ASSOCIATION_AUTO_THRESHOLD = 0.82;
const TOPIC_ASSOCIATION_REVIEW_THRESHOLD = 0.65;

function associationFeatures(value: string): Set<string> {
  const features = new Set<string>();
  for (const token of normalizeTokens(value)) {
    features.add(token);
    for (const segment of token.match(/[a-z0-9]+|[\p{Script=Han}]+/gu) ?? []) {
      const characters = [...segment];
      for (const character of characters) features.add(character);
      for (let index = 0; index < characters.length - 1; index += 1) {
        features.add(`${characters[index]}${characters[index + 1]}`);
      }
    }
  }
  return features;
}

function associationSimilarity(left: string, right: string): number {
  const leftLabel = normalizedLabel(left);
  const rightLabel = normalizedLabel(right);
  if (leftLabel === "" || rightLabel === "") return 0;
  if (leftLabel === rightLabel) return 1;
  if (leftLabel.includes(rightLabel) || rightLabel.includes(leftLabel)) {
    return Math.min(
      0.96,
      0.8 +
        Math.min(leftLabel.length, rightLabel.length) /
          Math.max(leftLabel.length, rightLabel.length) /
        5,
    );
  }
  const leftFeatures = associationFeatures(leftLabel);
  const rightFeatures = associationFeatures(rightLabel);
  if (leftFeatures.size === 0 || rightFeatures.size === 0) return 0;
  let intersection = 0;
  for (const feature of leftFeatures) {
    if (rightFeatures.has(feature)) intersection += 1;
  }
  return (2 * intersection) / (leftFeatures.size + rightFeatures.size);
}

function heuristicExtraction(job: IngestJob): MemoryExtraction {
  const payload = job.payload;
  if (payload === undefined) {
    throw new MemoryError(
      "invalid_input",
      "ingest job has no source snapshot; re-submit the source",
    );
  }
  const text = payload.content.replace(/\s+/g, " ").trim();
  const kind =
    /(决定|决策|确认|采用|定稿)/.test(text)
      ? ("decision" as const)
      : /(风险|阻塞|问题|冲突)/.test(text)
        ? ("risk" as const)
        : /(待办|下一步|行动项|负责人)/.test(text)
          ? ("action" as const)
          : ("fact" as const);
  const statement = text.slice(0, 20_000);
  const occurredAt = payload.occurredAt ?? job.createdAt;
  return memoryExtractionSchema.parse({
    topics: [
      {
        title: payload.title,
        aliases: [],
        claims:
          statement === ""
            ? []
            : [
                {
                  kind,
                  statement,
                  judgmentKey: `${job.sourceType}:${payload.title}:${kind}`,
                  confidence: 0.72,
                  effectiveAt: occurredAt,
                  conditions: [],
                },
              ],
      },
    ],
    ...(payload.agentPrincipalId === undefined
      ? {}
      : {
          episode: {
            kind:
              job.sourceType === "meeting"
                ? ("meeting-note" as const)
                : job.sourceType === "task"
                  ? ("task-note" as const)
                  : ("episode" as const),
            summary: `${payload.title}\n${statement}`.slice(0, 20_000),
            agentPrincipalId: payload.agentPrincipalId,
            occurredAt,
          },
        }),
    ...(payload.actorPrincipalId === undefined
      ? {}
      : { reviewOwnerPrincipalId: payload.actorPrincipalId }),
  });
}

export class MemoryService {
  private ingestTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly tables: MemoryTables,
    private readonly options: {
      readonly now?: () => Date;
      readonly executor?: () => MemoryExtractionExecutor | undefined;
    } = {},
  ) {}

  private now(): string {
    return nowIso(this.options.now ?? (() => new Date()));
  }

  createTopic(input: {
    readonly workspaceId: string;
    readonly title: string;
    readonly aliases?: readonly string[];
    readonly objectRefs?: readonly SourceRef[];
    readonly createdBy?: ProjectTopic["createdBy"];
  }): Promise<ProjectTopic> {
    const timestamp = this.now();
    const topic = parse(topicSchema, {
      id: `topic-${randomUUID()}`,
      workspaceId: input.workspaceId,
      title: input.title,
      aliases: input.aliases ?? [],
      objectRefs: input.objectRefs ?? [],
      status: "active",
      createdBy: input.createdBy ?? "system",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return this.tables.topics.put(topic.id, topic).then(() => topic);
  }

  topic(topicId: string): ProjectTopic {
    const topic = this.tables.topics.get(topicId);
    if (topic === undefined) {
      throw new MemoryError("not_found", "memory topic not found");
    }
    return topic;
  }

  listTopics(workspaceId: string): ProjectTopic[] {
    return values(this.tables.topics)
      .filter((topic) => topic.workspaceId === workspaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async publishClaim(input: PublishClaimInput): Promise<ProjectClaim> {
    const parsed = parse(publishInputSchema, input);
    const topic = this.topic(parsed.topicId);
    if (topic.workspaceId !== parsed.workspaceId) {
      throw new MemoryError("forbidden", "claim and topic workspace mismatch");
    }
    if (parsed.status === "hold" && (parsed.reason ?? "").trim() === "") {
      throw new MemoryError("invalid_input", "HOLD reason is required");
    }
    const existing = values(this.tables.claims).filter(
      (claim) =>
        claim.workspaceId === parsed.workspaceId &&
        claim.topicId === parsed.topicId,
    );
    const sequence =
      Math.max(0, ...existing.map((claim) => claim.sequence)) + 1;
    const superseded = existing.filter((claim) =>
      parsed.supersedes.includes(claim.id),
    );
    if (superseded.length !== parsed.supersedes.length) {
      throw new MemoryError(
        "invalid_input",
        "supersedes must reference claims in the same topic",
      );
    }
    const claim = parse(claimSchema, {
      id: `claim-${randomUUID()}`,
      workspaceId: parsed.workspaceId,
      topicId: parsed.topicId,
      kind: parsed.kind,
      ...(parsed.judgmentKey === undefined
        ? {}
        : { judgmentKey: parsed.judgmentKey }),
      statement: parsed.statement,
      status: parsed.status,
      publication: parsed.publication,
      confidence: parsed.confidence,
      sourceRefs: parsed.sourceRefs,
      recordedAt: parsed.recordedAt ?? this.now(),
      effectiveAt: parsed.effectiveAt,
      sequence,
      ...(parsed.validUntil === undefined
        ? {}
        : { validUntil: parsed.validUntil }),
      ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
      ...(parsed.resumeCriteria === undefined
        ? {}
        : { resumeCriteria: parsed.resumeCriteria }),
      ...(parsed.reviewOwnerPrincipalId === undefined
        ? {}
        : { reviewOwnerPrincipalId: parsed.reviewOwnerPrincipalId }),
      ...(parsed.action === undefined ? {} : { action: parsed.action }),
      conditions: parsed.conditions,
      supersedes: parsed.supersedes,
      producerType: parsed.producerType,
      ...(parsed.createdByPrincipalId === undefined
        ? {}
        : { createdByPrincipalId: parsed.createdByPrincipalId }),
      ...(parsed.identitySnapshotId === undefined
        ? {}
        : { identitySnapshotId: parsed.identitySnapshotId }),
      ...(parsed.templateVersion === undefined
        ? {}
        : { templateVersion: parsed.templateVersion }),
      ...(parsed.extractorVersion === undefined
        ? {}
        : { extractorVersion: parsed.extractorVersion }),
    });
    await this.tables.claims.put(claimKey(claim), claim);
    await this.tables.topics.put(topic.id, {
      ...topic,
      updatedAt: claim.recordedAt,
    });
    if (
      claim.publication === "review_required" ||
      claim.publication === "candidate_high"
    ) {
      const review = parse(reviewItemSchema, {
        id: `review-${randomUUID()}`,
        workspaceId: claim.workspaceId,
        topicId: claim.topicId,
        claimId: claim.id,
        reason:
          parsed.reviewReason ??
          (claim.publication === "review_required"
            ? "低置信记忆候选待人工 Review"
            : "高置信候选待发布"),
        status: "pending",
        createdAt: claim.recordedAt,
        updatedAt: claim.recordedAt,
      });
      await this.tables.reviews.put(review.id, review);
    }
    await this.refreshTruth(claim.workspaceId, claim.topicId);
    return claim;
  }

  async createCorrection(input: {
    readonly claimId: string;
    readonly statement: string;
    readonly reason: string;
    readonly actorPrincipalId: string;
    readonly sourceRefs: readonly SourceRef[];
  }): Promise<ProjectClaim> {
    const previous = values(this.tables.claims).find(
      (claim) => claim.id === input.claimId,
    );
    if (previous === undefined) {
      throw new MemoryError("not_found", "claim not found");
    }
    return this.publishClaim({
      workspaceId: previous.workspaceId,
      topicId: previous.topicId,
      kind: previous.kind,
      ...(previous.judgmentKey === undefined
        ? {}
        : { judgmentKey: previous.judgmentKey }),
      statement: input.statement,
      status: previous.status,
      publication: "human_confirmed",
      confidence: 1,
      sourceRefs: input.sourceRefs,
      effectiveAt: this.now(),
      reason: input.reason,
      supersedes: [previous.id],
      producerType: "human",
      createdByPrincipalId: input.actorPrincipalId,
    });
  }

  resolveTruth(topicId: string, asOf = this.now()): CurrentTruth {
    const topic = this.topic(topicId);
    const superseded = new Set<string>();
    const claims = values(this.tables.claims).filter(
      (claim) =>
        claim.workspaceId === topic.workspaceId && claim.topicId === topic.id,
    );
    for (const claim of claims) {
      for (const id of claim.supersedes) superseded.add(id);
    }
    const eligible = claims
      .filter((claim) => !superseded.has(claim.id))
      .filter(
        (claim) =>
          claim.publication !== "review_required" &&
          claim.publication !== "candidate_high" &&
          claim.status !== "proposed" &&
          claim.effectiveAt <= asOf,
      );
    const decisions = latestPerJudgment(
      eligible.filter((claim) => claim.kind === "decision"),
      () => "primary-decision",
    );
    const supporting = latestPerJudgment(
      eligible.filter((claim) => claim.kind !== "decision"),
      (claim) => `claim:${claim.id}`,
    );
    const conflicts: CurrentTruth["conflicts"] = [];
    const selected: ProjectClaim[] = [];
    for (const group of [...decisions.values(), ...supporting.values()]) {
      const latest = group[0];
      if (latest === undefined) continue;
      const contradictory = group.filter(
        (candidate, index) =>
          index > 0 &&
          candidate.statement.trim() !== latest.statement.trim() &&
          !hasSupersession(candidate, latest),
      );
      if (contradictory.length > 0) {
        conflicts.push({
          claimIds: [latest.id, ...contradictory.map((claim) => claim.id)],
          reason: "同一判断在相同生效时间出现互斥结论",
        });
      }
      selected.push(latest);
    }
    const primaryGroup = decisions.get("primary-decision") ?? [];
    const primary = primaryGroup[0];
    const previousClaimIds = claims
      .filter(
        (claim) =>
          claim.kind === "decision" &&
          claim.id !== primary?.id &&
          claim.effectiveAt <= asOf,
      )
      .sort((left, right) => right.effectiveAt.localeCompare(left.effectiveAt))
      .map((claim) => claim.id);
    const isExpired =
      primary?.validUntil !== undefined && primary.validUntil <= asOf;
    const status: CurrentTruth["status"] =
      conflicts.length > 0
        ? "conflict"
        : primary === undefined
          ? selected.length === 0
            ? "no_truth"
            : "active"
          : isExpired
            ? "expired"
            : primary.status === "proposed"
              ? "no_truth"
              : primary.status;
    const previous = previousClaimIds
      .map((id) => claims.find((claim) => claim.id === id))
      .find((claim): claim is ProjectClaim => claim !== undefined);
    return parse(currentTruthSchema, {
      workspaceId: topic.workspaceId,
      topicId: topic.id,
      status,
      ...(primary === undefined ? {} : { primaryClaimId: primary.id }),
      claims: selected.map((claim) => ({
        claimId: claim.id,
        kind: claim.kind,
        statement: claim.statement,
        status: claim.status,
        effectiveAt: claim.effectiveAt,
        conditions: claim.conditions,
        sourceRefs: claim.sourceRefs,
      })),
      previousClaimIds,
      ...(primary === undefined
        ? {}
        : {
            statement: primary.statement,
            effectiveAt: primary.effectiveAt,
            ...(primary.reason === undefined ? {} : { reason: primary.reason }),
            ...(primary.resumeCriteria === undefined
              ? {}
              : { resumeCriteria: primary.resumeCriteria }),
            ...(primary.reviewOwnerPrincipalId === undefined
              ? {}
              : {
                  reviewOwnerPrincipalId: primary.reviewOwnerPrincipalId,
                }),
          }),
      conditions: primary?.conditions ?? [],
      ...(status === "reopened"
        ? { unresolvedQuestion: "原结论已重开，等待新的明确决定" }
        : {}),
      conflicts,
      ...(primary === undefined || previous === undefined
        ? {}
        : {
            recentChange: {
              fromClaimId: previous.id,
              toClaimId: primary.id,
              reason: primary.reason ?? "结论发生更新",
              changedAt: primary.effectiveAt,
            },
          }),
      basedOnClaimIds: selected.map((claim) => claim.id),
      revision: Math.max(0, ...claims.map((claim) => claim.sequence)),
      asOf,
      updatedAt: this.now(),
    });
  }

  async refreshTruth(
    workspaceId: string,
    topicId: string,
  ): Promise<CurrentTruth> {
    const truth = this.resolveTruth(topicId, this.now());
    if (truth.workspaceId !== workspaceId) {
      throw new MemoryError("forbidden", "truth workspace mismatch");
    }
    await this.tables.truths.put(truthKey(workspaceId, topicId), truth);
    return truth;
  }

  truth(topicId: string, asOf = this.now()): CurrentTruth {
    const topic = this.topic(topicId);
    return (
      this.tables.truths.get(truthKey(topic.workspaceId, topic.id)) ??
      this.resolveTruth(topic.id, asOf)
    );
  }

  async recallProject(input: RecallProjectInput): Promise<RecallProjectResult> {
    const asOf = input.asOf ?? this.now();
    const limit = Math.max(1, Math.min(input.limit ?? 8, 50));
    const tokens = normalizeTokens(input.query);
    const objectIds = new Set(
      (input.objectRefs ?? []).map((ref) => `${ref.type}:${ref.id}`),
    );
    const topics = this.listTopics(input.workspaceId)
      .filter((topic) => topic.status === "active")
      .map((topic) => {
        const objectScore = topic.objectRefs.some((ref) =>
          objectIds.has(`${ref.type}:${ref.id}`),
        )
          ? 10
          : 0;
        const text = [topic.title, ...topic.aliases].join(" ").toLowerCase();
        const lexicalScore = tokens.reduce(
          (score, token) => score + (text.includes(token) ? 1 : 0),
          0,
        );
        return { topic, score: objectScore + lexicalScore };
      })
      .filter(({ score }) => tokens.length === 0 || score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.topic.updatedAt.localeCompare(left.topic.updatedAt),
      )
      .slice(0, limit)
      .map(({ topic }) => topic);
    const truths = topics.map((topic) => this.resolveTruth(topic.id, asOf));
    const truthClaimIds = new Set(
      truths.flatMap((truth) => truth.basedOnClaimIds),
    );
    const claims = values(this.tables.claims)
      .filter((claim) => truthClaimIds.has(claim.id))
      .sort(
        (left, right) =>
          right.effectiveAt.localeCompare(left.effectiveAt) ||
          right.sequence - left.sequence,
      );
    const handoffs = values(this.tables.handoffs)
      .filter(
        (handoff) =>
          handoff.workspaceId === input.workspaceId &&
          (tokens.length === 0 ||
            `${handoff.title} ${handoff.oneLineConclusion}`
              .toLowerCase()
              .includes(tokens[0] ?? "")),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
    return {
      truths,
      claims,
      handoffs,
      excluded: [{ reason: "irrelevant" }],
    };
  }

  async writeEpisode(input: WriteEpisodeInput): Promise<AgentMemoryEpisode> {
    const existing = values(this.tables.episodes).filter(
      (episode) => episode.agentPrincipalId === input.agentPrincipalId,
    );
    const timestamp = this.now();
    const episode = parse(episodeSchema, {
      id: `episode-${randomUUID()}`,
      agentPrincipalId: input.agentPrincipalId,
      ...(input.ownerPrincipalId === undefined
        ? {}
        : { ownerPrincipalId: input.ownerPrincipalId }),
      ownerPrincipalIds: [
        ...new Set([
          ...(input.ownerPrincipalIds ?? []),
          ...(input.ownerPrincipalId === undefined
            ? []
            : [input.ownerPrincipalId]),
        ]),
      ],
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      scene: input.scene,
      ...(input.chatCarrier === undefined
        ? {}
        : { chatCarrier: input.chatCarrier }),
      ...(input.chatChannelId === undefined
        ? {}
        : { chatChannelId: input.chatChannelId }),
      sceneObjectId: input.sceneObjectId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      kind: input.kind,
      summary: input.summary,
      sourceRefs: input.sourceRefs,
      occurredAt: input.occurredAt,
      recordedAt: timestamp,
      sequence: Math.max(0, ...existing.map((episode) => episode.sequence)) + 1,
      visibility: "agent-owner-admin",
      sensitivity: input.sensitivity ?? "normal",
      contentHash: contentHash(
        `${input.agentPrincipalId}\n${input.projectId ?? ""}\n${input.summary}`,
      ),
    });
    await this.tables.episodes.put(episode.id, episode);
    return episode;
  }

  recallAgent(input: RecallAgentInput): AgentMemoryEpisode[] {
    const query = input.query?.toLocaleLowerCase("zh-Hans-CN") ?? "";
    return values(this.tables.episodes)
      .filter(
        (episode) =>
          episode.agentPrincipalId === input.agentPrincipalId &&
          (input.projectId === undefined
            ? true
            : episode.projectId === input.projectId) &&
          (input.scene === undefined || episode.scene === input.scene) &&
          (query === "" ||
            episode.summary.toLocaleLowerCase("zh-Hans-CN").includes(query)),
      )
      .sort(
        (left, right) =>
          right.occurredAt.localeCompare(left.occurredAt) ||
          right.sequence - left.sequence,
      )
      .slice(0, Math.max(1, Math.min(input.limit ?? 20, 100)));
  }

  async createHandoff(
    input: Omit<
      HandoffCard,
      "id" | "status" | "revision" | "createdAt" | "updatedAt"
    > & {
      readonly status?: HandoffCard["status"];
      readonly revision?: number;
    },
  ): Promise<HandoffCard> {
    const parsed = parse(handoffInputSchema, input);
    const timestamp = this.now();
    const handoff = parse(handoffSchema, {
      ...parsed,
      id: `handoff-${randomUUID()}`,
      status: parsed.status ?? "published",
      revision: parsed.revision ?? 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.tables.handoffs.put(handoff.id, handoff);
    return handoff;
  }

  listReview(workspaceId: string): ReviewItem[] {
    return values(this.tables.reviews)
      .filter((review) => review.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  review(reviewId: string): ReviewItem {
    const review = this.tables.reviews.get(reviewId);
    if (review === undefined) {
      throw new MemoryError("not_found", "review item not found");
    }
    return review;
  }

  claim(claimId: string): ProjectClaim | undefined {
    return values(this.tables.claims).find((claim) => claim.id === claimId);
  }

  claimsForTopic(topicId: string): ProjectClaim[] {
    return values(this.tables.claims)
      .filter((claim) => claim.topicId === topicId)
      .sort((left, right) => right.sequence - left.sequence);
  }

  listIngestJobs(workspaceId: string): IngestJob[] {
    return values(this.tables.ingestJobs)
      .filter((job) => job.workspaceId === workspaceId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async retryFailedIngestJobs(workspaceId: string): Promise<number> {
    let retried = 0;
    for (const job of values(this.tables.ingestJobs)) {
      if (
        job.workspaceId !== workspaceId ||
        job.status !== "failed" ||
        job.payload === undefined
      ) {
        continue;
      }
      await this.tables.ingestJobs.put(
        job.id,
        parse(ingestJobSchema, {
          ...job,
          status: "queued",
          error: undefined,
          updatedAt: this.now(),
        }),
      );
      retried += 1;
    }
    if (retried > 0) void this.drainIngestJobs();
    return retried;
  }

  async decideReview(input: {
    readonly reviewId: string;
    readonly decision: "approved" | "rejected" | "superseded";
    readonly actorPrincipalId: string;
    readonly note?: string;
  }): Promise<ReviewItem> {
    const parsed = parse(reviewDecisionSchema, input);
    const review = this.tables.reviews.get(parsed.reviewId);
    if (review === undefined) {
      throw new MemoryError("not_found", "review item not found");
    }
    if (review.status !== "pending") {
      throw new MemoryError("conflict", "review item is already decided");
    }
    if (parsed.decision === "approved" && review.claimId !== undefined) {
      const candidate = values(this.tables.claims).find(
        (claim) => claim.id === review.claimId,
      );
      if (candidate === undefined) {
        throw new MemoryError("not_found", "review claim not found");
      }
      const alreadyPublished = values(this.tables.claims).some(
        (claim) =>
          claim.supersedes.includes(candidate.id) &&
          claim.sourceRefs.some((ref) => ref.id === `review:${review.id}`),
      );
      if (!alreadyPublished) {
        await this.publishClaim({
          workspaceId: candidate.workspaceId,
          topicId: candidate.topicId,
          kind: candidate.kind,
          ...(candidate.judgmentKey === undefined
            ? {}
            : { judgmentKey: candidate.judgmentKey }),
          statement: candidate.statement,
          status: candidate.status === "proposed" ? "active" : candidate.status,
          publication: "human_confirmed",
          confidence: candidate.confidence,
          sourceRefs: [
            ...candidate.sourceRefs,
            { type: "human-edit", id: `review:${review.id}` },
          ],
          effectiveAt: this.now(),
          ...(candidate.reason === undefined
            ? {}
            : { reason: candidate.reason }),
          ...(candidate.resumeCriteria === undefined
            ? {}
            : { resumeCriteria: candidate.resumeCriteria }),
          ...(candidate.reviewOwnerPrincipalId === undefined
            ? {}
            : {
                reviewOwnerPrincipalId: candidate.reviewOwnerPrincipalId,
              }),
          ...(candidate.action === undefined
            ? {}
            : { action: candidate.action }),
          conditions: candidate.conditions,
          supersedes: [candidate.id],
          producerType: "human",
          createdByPrincipalId: parsed.actorPrincipalId,
        });
      }
    }
    const timestamp = this.now();
    const updated = parse(reviewItemSchema, {
      ...review,
      status: parsed.decision,
      updatedAt: timestamp,
      decidedAt: timestamp,
      decidedByPrincipalId: parsed.actorPrincipalId,
      ...(parsed.note === undefined ? {} : { decisionNote: parsed.note }),
    });
    await this.tables.reviews.put(updated.id, updated);
    return updated;
  }

  private sourceRefForJob(job: IngestJob): SourceRef {
    const type =
      job.sourceType === "task"
        ? "task"
        : job.sourceType === "meeting"
          ? "meeting"
          : job.sourceType === "minute-version"
            ? "minute-version"
            : job.sourceType === "workflow"
              ? "workflow"
              : job.sourceType === "chat"
                ? "chat"
                : "document";
    return { type, id: job.sourceId, version: job.version };
  }

  private associateTopic(
    workspaceId: string,
    extractionTopic: MemoryExtraction["topics"][number],
    refs: readonly SourceRef[],
  ): TopicAssociation | undefined {
    const labels = [extractionTopic.title, ...extractionTopic.aliases];
    const refIds = new Set(refs.map((ref) => `${ref.type}:${ref.id}`));
    const ranked = values(this.tables.topics)
      .filter(
        (topic) =>
          topic.workspaceId === workspaceId &&
          topic.status === "active" &&
          topic.canonicalTopicId === undefined,
      )
      .map((topic) => {
        if (
          topic.objectRefs.some((ref) => refIds.has(`${ref.type}:${ref.id}`))
        ) {
          return { topic, score: 1, method: "object-ref" as const };
        }
        const topicLabels = [topic.title, ...topic.aliases];
        if (
          topicLabels.some((topicLabel) =>
            labels.some(
              (label) =>
                normalizedLabel(topicLabel) === normalizedLabel(label),
            ),
          )
        ) {
          return { topic, score: 1, method: "label" as const };
        }
        const score = Math.max(
          0,
          ...topicLabels.flatMap((topicLabel) =>
            labels.map((label) => associationSimilarity(topicLabel, label)),
          ),
        );
        return { topic, score, method: "lexical" as const };
      })
      .filter(
        (candidate) =>
          candidate.score >= TOPIC_ASSOCIATION_REVIEW_THRESHOLD,
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.topic.updatedAt.localeCompare(left.topic.updatedAt),
      );
    const best = ranked[0];
    if (best === undefined) return undefined;
    const candidates = ranked.filter(
      (candidate) => candidate.score >= best.score - 0.05,
    );
    return {
      topic: best.topic,
      score: best.score,
      method: best.method,
      candidates: candidates.map((candidate) => candidate.topic),
      requiresReview:
        best.score < TOPIC_ASSOCIATION_AUTO_THRESHOLD ||
        candidates.length > 1,
    };
  }

  private async attachTopicRefs(
    topic: ProjectTopic,
    extractionTopic: MemoryExtraction["topics"][number],
    refs: readonly SourceRef[],
  ): Promise<ProjectTopic> {
    const aliases = [
      ...new Set([
        ...topic.aliases,
        ...extractionTopic.aliases,
        extractionTopic.title,
      ]),
    ].filter((alias) => normalizedLabel(alias) !== normalizedLabel(topic.title));
    const objectRefs = [
      ...new Map(
        [...topic.objectRefs, ...refs].map((ref) => [
          `${ref.type}:${ref.id}:${ref.version ?? ""}`,
          ref,
        ]),
      ).values(),
    ];
    if (
      aliases.length === topic.aliases.length &&
      objectRefs.length === topic.objectRefs.length
    ) {
      return topic;
    }
    const updated = parse(topicSchema, {
      ...topic,
      aliases,
      objectRefs,
      updatedAt: this.now(),
    });
    await this.tables.topics.put(updated.id, updated);
    return updated;
  }

  private async applyExtraction(
    job: IngestJob,
    extraction: MemoryExtraction,
  ): Promise<void> {
    const payload = job.payload;
    if (payload === undefined || job.workspaceId === undefined) {
      throw new MemoryError(
        "invalid_input",
        "ingest job requires a workspace and source snapshot",
      );
    }
    const refs =
      payload.sourceRefs.length === 0
        ? [this.sourceRefForJob(job)]
        : [...payload.sourceRefs];
    for (const topicInput of extraction.topics) {
      const association = this.associateTopic(job.workspaceId, topicInput, refs);
      const topic =
        association === undefined
          ? await this.createTopic({
              workspaceId: job.workspaceId,
              title: topicInput.title,
              aliases: topicInput.aliases,
              objectRefs: refs,
            })
          : association.requiresReview
            ? association.topic
            : await this.attachTopicRefs(association.topic, topicInput, refs);
      const associationReviewReason =
        association?.requiresReview === true
          ? [
              `主题关联待确认（${TOPIC_ASSOCIATION_VERSION}）`,
              `top=${association.score.toFixed(2)}`,
              `candidates=${association.candidates.map((item) => item.id).join(",")}`,
            ].join("；")
          : undefined;
      for (const claim of topicInput.claims) {
        const systemEffective =
          associationReviewReason === undefined &&
          claim.confidence >= 0.85 &&
          claim.kind === "decision" &&
          (job.sourceType === "meeting" ||
            job.sourceType === "minute-version");
        await this.publishClaim({
          workspaceId: job.workspaceId,
          topicId: topic.id,
          kind: claim.kind,
          ...(claim.judgmentKey === undefined
            ? {}
            : { judgmentKey: claim.judgmentKey }),
          statement: claim.statement,
          status: "active",
          publication: systemEffective
            ? "system_effective"
            : associationReviewReason === undefined && claim.confidence >= 0.85
              ? "candidate_high"
              : "review_required",
          confidence: claim.confidence,
          sourceRefs: refs,
          effectiveAt: claim.effectiveAt ?? payload.occurredAt ?? job.createdAt,
          ...(claim.reason === undefined ? {} : { reason: claim.reason }),
          ...(claim.resumeCriteria === undefined
            ? {}
            : { resumeCriteria: claim.resumeCriteria }),
          ...((claim.action ?? undefined) === undefined
            ? {}
            : { action: claim.action }),
          conditions: claim.conditions,
          producerType: "agent",
          ...(payload.actorPrincipalId === undefined
            ? {}
            : {
                createdByPrincipalId: payload.actorPrincipalId,
                reviewOwnerPrincipalId: payload.actorPrincipalId,
              }),
          ...(associationReviewReason === undefined
            ? {}
            : { reviewReason: associationReviewReason }),
          extractorVersion: "memory-extractor-v1",
        });
      }
    }
    const episode = extraction.episode;
    const agentPrincipalId =
      episode?.agentPrincipalId ?? payload.agentPrincipalId;
    if (episode !== undefined && agentPrincipalId !== undefined) {
      await this.writeEpisode({
        agentPrincipalId,
        ...(payload.actorPrincipalId === undefined
          ? {}
          : { ownerPrincipalId: payload.actorPrincipalId }),
        projectId: payload.projectId ?? job.workspaceId,
        scene:
          job.sourceType === "meeting"
            ? "meeting"
            : job.sourceType === "workflow"
              ? "workflow-node"
              : job.sourceType === "chat"
                ? "chat"
                : "task",
        sceneObjectId: job.sourceId,
        ...(job.sourceType === "run" ? { runId: job.sourceId } : {}),
        kind: episode.kind,
        summary: episode.summary,
        sourceRefs: refs,
        occurredAt: episode.occurredAt ?? payload.occurredAt ?? job.createdAt,
      });
    }
  }

  drainIngestJobs(): Promise<void> {
    const operation = this.ingestTail
      .catch(() => undefined)
      .then(async () => {
        const unrecoverable = values(this.tables.ingestJobs).filter(
          (job) =>
            job.payload === undefined &&
            (job.status === "queued" || job.status === "failed"),
        );
        for (const job of unrecoverable) {
          await this.tables.ingestJobs.put(
            job.id,
            parse(ingestJobSchema, {
              ...job,
              status: "unrecoverable",
              error:
                "legacy ingest job has no source snapshot; re-submit the source",
              updatedAt: this.now(),
            }),
          );
        }
        const queued = values(this.tables.ingestJobs)
          .filter((job) => job.status === "queued")
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        for (const job of queued) {
          const processing = parse(ingestJobSchema, {
            ...job,
            status: "processing",
            attempts: job.attempts + 1,
            error: undefined,
            updatedAt: this.now(),
          });
          await this.tables.ingestJobs.put(processing.id, processing);
          try {
            const executor = this.options.executor?.();
            const extracted =
              executor === undefined
                ? heuristicExtraction(processing)
                : await executor(processing);
            const extraction = parse(memoryExtractionSchema, extracted);
            await this.applyExtraction(processing, extraction);
            await this.tables.ingestJobs.put(
              processing.id,
              parse(ingestJobSchema, {
                ...processing,
                status: "completed",
                error: undefined,
                updatedAt: this.now(),
              }),
            );
          } catch (cause) {
            await this.tables.ingestJobs.put(
              processing.id,
              parse(ingestJobSchema, {
                ...processing,
                status: "failed",
                error: (
                  cause instanceof Error ? cause.message : "memory extraction failed"
                ).slice(0, 2_000),
                updatedAt: this.now(),
              }),
            );
          }
        }
      });
    this.ingestTail = operation;
    return operation;
  }

  async waitIngestIdle(): Promise<void> {
    await this.ingestTail;
  }

  async ingestSource(input: {
    readonly sourceType: IngestJob["sourceType"];
    readonly sourceId: string;
    readonly version: string;
    readonly workspaceId?: string;
    readonly payload?: IngestJob["payload"];
  }): Promise<IngestJob> {
    const parsed = parse(sourceIngestSchema, input);
    const sourceKey = `${parsed.sourceType}:${parsed.sourceId}:${parsed.version}`;
    const existing = values(this.tables.ingestJobs).find(
      (job) => job.sourceKey === sourceKey,
    );
    if (existing !== undefined) return existing;
    const timestamp = this.now();
    const job = parse(ingestJobSchema, {
      id: `ingest-${contentHash(sourceKey).slice(0, 24)}`,
      sourceKey,
      sourceType: parsed.sourceType,
      sourceId: parsed.sourceId,
      version: parsed.version,
      ...(parsed.workspaceId === undefined
        ? {}
        : { workspaceId: parsed.workspaceId }),
      ...(parsed.payload === undefined ? {} : { payload: parsed.payload }),
      status: "queued",
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.tables.ingestJobs.put(job.id, job);
    if (job.payload !== undefined) {
      void this.drainIngestJobs();
    }
    return job;
  }
}
