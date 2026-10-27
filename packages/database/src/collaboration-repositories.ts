import { randomUUID } from "node:crypto";
import type {
  Artifact,
  CreateMeetingInput,
  CreateMemoryClaimInput,
  CreateMemoryTopicInput,
  CreateWorkflowInput,
  Meeting,
  MeetingDetail,
  MeetingMessage,
  MemoryClaim,
  MemoryTopic,
  MemoryTruth,
  MemorySourceRef,
  PublishMemoryTruthInput,
  TaskReviewInput,
  UpdateMemoryClaimInput,
  WorkbenchSummary,
  WorkflowDefinition,
  WorkflowGraph,
  WorkflowInstance,
  WorkflowStepDefinition,
  WorkflowStepState,
} from "@pluginmax/contracts";
import type { FileRef } from "@pluginmax/files";
import type { Database } from "./database.js";

interface ArtifactRow {
  id: string;
  run_id: string;
  project_id: string;
  name: string;
  mime_type: string;
  size: string;
  sha256: string;
  storage_key: string;
  created_at: Date;
}

export class ArtifactRepository {
  constructor(private readonly database: Database) {}

  async save(input: {
    readonly runId: string;
    readonly projectId: string;
    readonly ref: FileRef;
  }): Promise<Artifact> {
    const result = await this.database.query<ArtifactRow>(
      `INSERT INTO artifacts (
         id, run_id, project_id, name, mime_type, size,
         sha256, storage_key, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       RETURNING *`,
      [
        input.ref.id,
        input.runId,
        input.projectId,
        input.ref.name,
        input.ref.mimeType,
        input.ref.size,
        input.ref.sha256,
        input.ref.storageKey,
      ],
    );
    return artifactFromRow(result.rows[0]!);
  }

  async listByRun(runId: string): Promise<Artifact[]> {
    const result = await this.database.query<ArtifactRow>(
      "SELECT * FROM artifacts WHERE run_id = $1 ORDER BY created_at",
      [runId],
    );
    return result.rows.map(artifactFromRow);
  }

  async get(id: string): Promise<Artifact | undefined> {
    const result = await this.database.query<ArtifactRow>(
      "SELECT * FROM artifacts WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : artifactFromRow(row);
  }
}

interface MemoryTopicRow {
  id: string;
  project_id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
}

interface MemoryClaimRow {
  id: string;
  topic_id: string;
  content: string;
  status: MemoryClaim["status"];
  source_type: string;
  source_id: string;
  version: number;
  source_refs: MemorySourceRef[];
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface MemoryTruthRow {
  id: string;
  topic_id: string;
  content: string;
  version: number;
  source_type: string;
  source_id: string;
  created_at: Date;
}

export class MemoryRepository {
  constructor(private readonly database: Database) {}

  async publishTask(input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly title: string;
    readonly content: string;
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const topicId = randomUUID();
      const claimId = randomUUID();
      const truthId = randomUUID();
      await client.query(
        `INSERT INTO memory_topics (id, project_id, title, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [topicId, input.projectId, input.title],
      );
      await client.query(
        `INSERT INTO memory_claims (
           id, topic_id, project_id, content, status,
           source_type, source_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'confirmed', 'task', $5, NOW(), NOW())`,
        [claimId, topicId, input.projectId, input.content, input.taskId],
      );
      await client.query(
        `INSERT INTO memory_truths (
           id, topic_id, project_id, content, version,
           source_type, source_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          truthId,
          topicId,
          input.projectId,
          input.content,
          1,
          "task",
          input.taskId,
          new Date().toISOString(),
        ],
      );
      await client.query(
        `INSERT INTO memory_truth_claims (truth_id, claim_id)
         VALUES ($1, $2)`,
        [truthId, claimId],
      );
    });
  }

  async createTopic(
    projectId: string,
    input: CreateMemoryTopicInput,
  ): Promise<MemoryTopic> {
    const result = await this.database.query<MemoryTopicRow>(
      `INSERT INTO memory_topics (
         id, project_id, title, created_at, updated_at
       ) VALUES ($1, $2, $3, NOW(), NOW())
       RETURNING *`,
      [randomUUID(), projectId, input.title],
    );
    return memoryTopicFromRow(result.rows[0]!, [], null);
  }

  async addClaim(
    projectId: string,
    topicId: string,
    input: CreateMemoryClaimInput,
  ): Promise<MemoryClaim> {
    await this.requireTopic(projectId, topicId);
    const result = await this.database.query<MemoryClaimRow>(
      `INSERT INTO memory_claims (
         id, topic_id, project_id, content, status,
         source_type, source_id, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'proposed', $5, $6, NOW(), NOW())
       RETURNING *`,
      [
        randomUUID(),
        topicId,
        projectId,
        input.content,
        input.sourceType,
        input.sourceId,
      ],
    );
    return memoryClaimFromRow(result.rows[0]!);
  }

  async updateClaim(
    projectId: string,
    topicId: string,
    claimId: string,
    input: UpdateMemoryClaimInput,
  ): Promise<MemoryClaim | undefined> {
    const result = await this.database.query<MemoryClaimRow>(
      `UPDATE memory_claims
       SET status = $4, updated_at = NOW()
       WHERE id = $1 AND topic_id = $2 AND project_id = $3
       RETURNING *`,
      [claimId, topicId, projectId, input.status],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : memoryClaimFromRow(row);
  }

  async publishTruth(
    projectId: string,
    topicId: string,
    input: PublishMemoryTruthInput,
  ): Promise<MemoryTopic> {
    await this.requireTopic(projectId, topicId);
    await this.database.transaction(async (client) => {
      const claims =
        input.claimIds.length === 0
          ? []
          : (
              await client.query<MemoryClaimRow>(
                `SELECT * FROM memory_claims
                 WHERE topic_id = $1
                   AND project_id = $2
                   AND id = ANY($3::uuid[])
                 ORDER BY created_at, id`,
                [topicId, projectId, input.claimIds],
              )
            ).rows;
      if (claims.length !== input.claimIds.length) {
        throw new Error("memory claim scope mismatch");
      }
      if (claims.some((claim) => claim.status === "rejected")) {
        throw new Error("rejected memory claims cannot form current truth");
      }
      const content =
        input.content ??
        claims
          .map((claim) => claim.content.trim())
          .filter(Boolean)
          .join("\n");
      const versionResult = await client.query<{ version: number }>(
        `SELECT COALESCE(MAX(version), 0)::integer + 1 AS version
         FROM memory_truths
         WHERE topic_id = $1`,
        [topicId],
      );
      const truthId = randomUUID();
      await client.query(
        `INSERT INTO memory_truths (
           id, topic_id, project_id, content, version,
           source_type, source_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          truthId,
          topicId,
          projectId,
          content,
          versionResult.rows[0]!.version,
          input.sourceType,
          input.sourceId,
        ],
      );
      for (const claim of claims) {
        await client.query(
          "INSERT INTO memory_truth_claims (truth_id, claim_id) VALUES ($1, $2)",
          [truthId, claim.id],
        );
      }
      await client.query(
        "UPDATE memory_topics SET updated_at = NOW() WHERE id = $1",
        [topicId],
      );
    });
    const topic = await this.list(projectId).then((topics) =>
      topics.find((candidate) => candidate.id === topicId),
    );
    if (topic === undefined) throw new Error("published topic is missing");
    return topic;
  }

  async list(projectId: string): Promise<MemoryTopic[]> {
    const topics = await this.database.query<MemoryTopicRow>(
      `SELECT * FROM memory_topics
       WHERE project_id = $1
       ORDER BY updated_at DESC, id`,
      [projectId],
    );
    if (topics.rowCount === 0) return [];
    const topicIds = topics.rows.map((topic) => topic.id);
    const claims = await this.database.query<MemoryClaimRow>(
      `SELECT * FROM memory_claims
       WHERE project_id = $1 AND topic_id = ANY($2::uuid[])
       ORDER BY created_at, id`,
      [projectId, topicIds],
    );
    const truths = await this.database.query<MemoryTruthRow>(
      `SELECT * FROM memory_truths
       WHERE project_id = $1 AND topic_id = ANY($2::uuid[])
       ORDER BY version DESC`,
      [projectId, topicIds],
    );
    const truthIds = truths.rows.map((truth) => truth.id);
    const links =
      truthIds.length === 0
        ? { rows: [] as Array<{ truth_id: string; claim_id: string }> }
        : await this.database.query<{ truth_id: string; claim_id: string }>(
            `SELECT truth_id, claim_id
             FROM memory_truth_claims
             WHERE truth_id = ANY($1::uuid[])`,
            [truthIds],
          );
    const claimIdsByTruth = new Map<string, string[]>();
    for (const link of links.rows) {
      const ids = claimIdsByTruth.get(link.truth_id) ?? [];
      ids.push(link.claim_id);
      claimIdsByTruth.set(link.truth_id, ids);
    }
    const claimsByTopic = new Map<string, MemoryClaim[]>();
    for (const claim of claims.rows) {
      const items = claimsByTopic.get(claim.topic_id) ?? [];
      items.push(memoryClaimFromRow(claim));
      claimsByTopic.set(claim.topic_id, items);
    }
    const currentTruthByTopic = new Map<string, MemoryTruth>();
    for (const truth of truths.rows) {
      if (currentTruthByTopic.has(truth.topic_id)) continue;
      currentTruthByTopic.set(truth.topic_id, {
        id: truth.id,
        topicId: truth.topic_id,
        content: truth.content,
        version: truth.version,
        sourceType: truth.source_type,
        sourceId: truth.source_id,
        claimIds: claimIdsByTruth.get(truth.id) ?? [],
        createdAt: truth.created_at.toISOString(),
      });
    }
    return topics.rows.map((row) =>
      memoryTopicFromRow(
        row,
        claimsByTopic.get(row.id) ?? [],
        currentTruthByTopic.get(row.id) ?? null,
      ),
    );
  }

  private async requireTopic(
    projectId: string,
    topicId: string,
  ): Promise<MemoryTopicRow> {
    const result = await this.database.query<MemoryTopicRow>(
      "SELECT * FROM memory_topics WHERE id = $1 AND project_id = $2",
      [topicId, projectId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error("memory topic not found");
    return row;
  }
}

function memoryClaimFromRow(row: MemoryClaimRow): MemoryClaim {
  return {
    id: row.id,
    topicId: row.topic_id,
    content: row.content,
    status: row.status,
    sourceType: row.source_type,
    sourceId: row.source_id,
    version: row.version,
    sourceRefs: row.source_refs,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    reviewedBy: row.reviewed_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function memoryTopicFromRow(
  row: MemoryTopicRow,
  claims: MemoryClaim[],
  currentTruth: MemoryTruth | null,
): MemoryTopic {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    currentTruth,
    claims,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class ReviewRepository {
  constructor(private readonly database: Database) {}

  async save(
    taskId: string,
    actorId: string,
    input: TaskReviewInput,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO task_reviews (
         id, task_id, decision, note, actor_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, NOW())`,
      [randomUUID(), taskId, input.decision, input.note, actorId],
    );
  }
}

interface WorkflowRow {
  id: string;
  project_id: string;
  name: string;
  description: string;
  steps: WorkflowStepDefinition[];
  source_md: string;
  graph: WorkflowGraph | null;
  status: WorkflowDefinition["status"];
  source_template_id: string | null;
  source_template_version: number | null;
  created_at: Date;
  updated_at: Date;
}

interface WorkflowInstanceRow {
  id: string;
  workflow_id: string;
  project_id: string;
  title: string;
  status: WorkflowInstance["status"];
  current_step: number;
  steps: WorkflowStepState[];
  created_at: Date;
  updated_at: Date;
}

export class WorkflowRepository {
  constructor(private readonly database: Database) {}

  async list(projectId: string): Promise<WorkflowDefinition[]> {
    const result = await this.database.query<WorkflowRow>(
      "SELECT * FROM workflow_definitions WHERE project_id = $1 ORDER BY updated_at DESC",
      [projectId],
    );
    return result.rows.map(workflowFromRow);
  }

  async create(input: CreateWorkflowInput): Promise<WorkflowDefinition> {
    return this.createResolved(input);
  }

  async createResolved(
    input: CreateWorkflowInput,
    stepAgentIds: readonly (string | undefined)[] = [],
    metadata: {
      readonly sourceMarkdown?: string;
      readonly graph?: WorkflowGraph | null;
      readonly steps?: readonly WorkflowStepDefinition[];
    } = {},
  ): Promise<WorkflowDefinition> {
    const steps: WorkflowStepDefinition[] =
      metadata.steps === undefined
        ? input.stepNames.map((name, index) => ({
            id: randomUUID(),
            name,
            kind:
              input.stepRoleIds[index] !== undefined ||
              index !== input.stepNames.length - 1
                ? "agent"
                : "human",
            ...(input.stepRoleIds[index] === undefined
              ? {}
              : { roleId: input.stepRoleIds[index] }),
            ...(stepAgentIds[index] === undefined
              ? {}
              : { agentId: stepAgentIds[index] }),
          }))
        : [...metadata.steps];
    const result = await this.database.query<WorkflowRow>(
      `INSERT INTO workflow_definitions (
         id, project_id, name, description, steps, source_md, graph,
         status, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, 'active', NOW(), NOW()
       )
       RETURNING *`,
      [
        randomUUID(),
        input.projectId,
        input.name,
        input.description,
        JSON.stringify(steps),
        metadata.sourceMarkdown ?? "",
        metadata.graph === undefined || metadata.graph === null
          ? null
          : JSON.stringify(metadata.graph),
      ],
    );
    return workflowFromRow(result.rows[0]!);
  }

  async get(id: string): Promise<WorkflowDefinition | undefined> {
    const result = await this.database.query<WorkflowRow>(
      "SELECT * FROM workflow_definitions WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : workflowFromRow(row);
  }

  async setGraphIfMissing(id: string, graph: WorkflowGraph): Promise<void> {
    await this.database.query(
      `UPDATE workflow_definitions
       SET graph = $2::jsonb, updated_at = NOW()
       WHERE id = $1 AND graph IS NULL`,
      [id, JSON.stringify(graph)],
    );
  }

  async start(
    workflow: WorkflowDefinition,
    title: string,
  ): Promise<WorkflowInstance> {
    const steps: WorkflowStepState[] = workflow.steps.map((step, index) => ({
      stepId: step.id,
      name: step.name,
      kind: step.kind,
      status: index === 0 ? "active" : "pending",
      completedAt: null,
    }));
    const result = await this.database.query<WorkflowInstanceRow>(
      `INSERT INTO workflow_instances (
         id, workflow_id, project_id, title, status,
         current_step, steps, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'active', 0, $5::jsonb, NOW(), NOW())
       RETURNING *`,
      [
        randomUUID(),
        workflow.id,
        workflow.projectId,
        title,
        JSON.stringify(steps),
      ],
    );
    return workflowInstanceFromRow(result.rows[0]!);
  }

  async getInstance(id: string): Promise<WorkflowInstance | undefined> {
    const result = await this.database.query<WorkflowInstanceRow>(
      "SELECT * FROM workflow_instances WHERE id = $1",
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : workflowInstanceFromRow(row);
  }

  async advance(id: string): Promise<WorkflowInstance | undefined> {
    const current = await this.getInstance(id);
    if (current === undefined || current.status === "completed") return current;
    const steps = current.steps.map((step) => ({ ...step }));
    const active = steps[current.currentStep];
    if (active === undefined) return current;
    active.status = "completed";
    active.completedAt = new Date().toISOString();
    const next = current.currentStep + 1;
    const completed = next >= steps.length;
    if (!completed) {
      const nextStep = steps[next];
      if (nextStep !== undefined) nextStep.status = "active";
    }
    const result = await this.database.query<WorkflowInstanceRow>(
      `UPDATE workflow_instances
       SET current_step = $2, steps = $3::jsonb, status = $4, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id,
        completed ? current.currentStep : next,
        JSON.stringify(steps),
        completed ? "completed" : "active",
      ],
    );
    return workflowInstanceFromRow(result.rows[0]!);
  }

  async setStepExecution(
    id: string,
    stepIndex: number,
    taskId: string,
    runId: string,
  ): Promise<WorkflowInstance | undefined> {
    const current = await this.getInstance(id);
    if (current === undefined) return undefined;
    const steps = current.steps.map((step, index) =>
      index === stepIndex ? { ...step, taskId, runId } : step,
    );
    const result = await this.database.query<WorkflowInstanceRow>(
      `UPDATE workflow_instances
       SET steps = $2::jsonb, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, JSON.stringify(steps)],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : workflowInstanceFromRow(row);
  }
}

interface MeetingRow {
  id: string;
  project_id: string;
  title: string;
  agenda: string;
  status: Meeting["status"];
  participants: Meeting["participants"];
  summary: string;
  created_at: Date;
  updated_at: Date;
}

interface MeetingMessageRow {
  id: string;
  meeting_id: string;
  author_type: MeetingMessage["authorType"];
  author_id: string;
  author_name: string;
  content: string;
  turn_id: string | null;
  policy_id: string | null;
  policy_revision: number | null;
  trigger_kind: MeetingMessage["triggerKind"];
  trigger_reason: string | null;
  run_id: string | null;
  trace_id: string | null;
  status: MeetingMessage["status"];
  error_code: string | null;
  error_message: string | null;
  client_message_id: string | null;
  delegate_id: string | null;
  sender_principal_id: string | null;
  created_at: Date;
}

export class MeetingRepository {
  constructor(private readonly database: Database) {}

  async list(
    projectId: string,
    includeArchived = false,
  ): Promise<Meeting[]> {
    const result = await this.database.query<MeetingRow>(
      `SELECT meeting.*
       FROM meetings AS meeting
       LEFT JOIN meeting_collaboration_states AS state
         ON state.meeting_id = meeting.id
       WHERE meeting.project_id = $1
         AND ($2::boolean OR COALESCE(state.lifecycle_status, 'active') = 'active')
       ORDER BY meeting.updated_at DESC`,
      [projectId, includeArchived],
    );
    return result.rows.map(meetingFromRow);
  }

  async create(
    input: CreateMeetingInput,
    agents: readonly { id: string; name: string }[],
    actorId = "local-admin",
    actorName = "Local Admin",
  ): Promise<Meeting> {
    const meetingId = randomUUID();
    const participants = [
      { id: actorId, name: actorName, kind: "human" as const },
      ...agents
        .filter((agent) => input.agentIds.includes(agent.id))
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          kind: "agent" as const,
        })),
    ];
    return this.database.transaction(async (client) => {
      const result = await client.query<MeetingRow>(
        `INSERT INTO meetings (
           id, project_id, title, agenda, status, participants,
           summary, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'open', $5::jsonb, '', NOW(), NOW())
         RETURNING *`,
        [
          meetingId,
          input.projectId,
          input.title,
          input.agenda,
          JSON.stringify(participants),
        ],
      );
      await client.query(
        `INSERT INTO meeting_minutes_drafts (
           id, meeting_id, project_id, content, decisions, source_message_ids,
           revision, updated_by, created_at, updated_at
         ) VALUES (
           $1, $2, $3, '', '[]'::jsonb, '{}'::uuid[], 0,
           'local-admin', NOW(), NOW()
         )`,
        [randomUUID(), meetingId, input.projectId],
      );
      await client.query(
        `INSERT INTO meeting_ai_policies (
           id, meeting_id, project_id, status, trigger_kinds,
           cooldown_seconds, max_rounds, max_messages, run_budget_ms,
           revision, created_by, updated_by, created_at, updated_at
         ) VALUES (
           $1, $2, $3, 'paused', '["mention"]'::jsonb,
           30, 6, 12, 60000, 1, 'local-admin', 'local-admin', NOW(), NOW()
         )`,
        [randomUUID(), meetingId, input.projectId],
      );
      await client.query(
        `INSERT INTO meeting_collaboration_states (
           meeting_id, project_id, facilitator_principal_id, lifecycle_status,
           revision, facilitator_assigned_by, facilitator_assigned_at,
           created_at, updated_at
         ) VALUES ($1, $2, $3, 'active', 1, $3, NOW(), NOW(), NOW())`,
        [meetingId, input.projectId, actorId],
      );
      await client.query(
        `INSERT INTO meeting_facilitator_handoffs (
           id, meeting_id, from_principal_id, to_principal_id,
           actor_principal_id, reason, resulting_revision, created_at
         ) VALUES (
           $1, $2, NULL, $3, $3, 'Initial facilitator assignment', 1, NOW()
         )`,
        [randomUUID(), meetingId, actorId],
      );
      await client.query(
        `INSERT INTO meeting_collaboration_events (
           id, meeting_id, seq, kind, actor_principal_id, summary, data,
           created_at
         ) VALUES (
           $1, $2, 1, 'facilitator', $3,
           'Meeting facilitator assigned', $4::jsonb, NOW()
         )`,
        [
          randomUUID(),
          meetingId,
          actorId,
          JSON.stringify({ facilitatorPrincipalId: actorId }),
        ],
      );
      for (const participant of participants) {
        if (participant.kind !== "agent") continue;
        await client.query(
          `INSERT INTO meeting_ai_participants (
             meeting_id, project_id, agent_id, status, joined_at, updated_at
           ) VALUES ($1, $2, $3, 'active', NOW(), NOW())`,
          [meetingId, input.projectId, participant.id],
        );
      }
      return meetingFromRow(result.rows[0]!);
    });
  }

  async detail(id: string): Promise<MeetingDetail | undefined> {
    const meetingResult = await this.database.query<MeetingRow>(
      "SELECT * FROM meetings WHERE id = $1",
      [id],
    );
    const meeting = meetingResult.rows[0];
    if (meeting === undefined) return undefined;
    const messages = await this.database.query<MeetingMessageRow>(
      "SELECT * FROM meeting_messages WHERE meeting_id = $1 ORDER BY created_at",
      [id],
    );
    return {
      meeting: meetingFromRow(meeting),
      messages: messages.rows.map(meetingMessageFromRow),
    };
  }

  async postMessage(
    input: {
      readonly meetingId: string;
      readonly authorType: MeetingMessage["authorType"];
      readonly authorId: string;
      readonly authorName: string;
      readonly content: string;
      readonly clientMessageId?: string;
      readonly delegateId?: string;
      readonly senderPrincipalId?: string;
    },
  ): Promise<{ readonly message: MeetingMessage; readonly reused: boolean }> {
    return this.database.transaction(async (client) => {
      if (input.clientMessageId !== undefined) {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [
            `meeting-message:${input.meetingId}:${input.clientMessageId}`,
          ],
        );
        const existing = await client.query<MeetingMessageRow>(
          `SELECT * FROM meeting_messages
           WHERE meeting_id = $1 AND client_message_id = $2`,
          [input.meetingId, input.clientMessageId],
        );
        const row = existing.rows[0];
        if (row !== undefined) {
          if (
            row.content !== input.content ||
            row.author_id !== input.authorId ||
            row.delegate_id !== (input.delegateId ?? null)
          ) {
            throw new Error("meeting client message id conflict");
          }
          return { message: meetingMessageFromRow(row), reused: true };
        }
      }
      const result = await client.query<MeetingMessageRow>(
        `INSERT INTO meeting_messages (
           id, meeting_id, author_type, author_id, author_name, content,
           client_message_id, delegate_id, sender_principal_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         RETURNING *`,
        [
          randomUUID(),
          input.meetingId,
          input.authorType,
          input.authorId,
          input.authorName,
          input.content,
          input.clientMessageId ?? null,
          input.delegateId ?? null,
          input.senderPrincipalId ?? input.authorId,
        ],
      );
      await client.query(
        "UPDATE meetings SET updated_at = NOW() WHERE id = $1",
        [input.meetingId],
      );
      return { message: meetingMessageFromRow(result.rows[0]!), reused: false };
    });
  }

  async getMessage(
    meetingId: string,
    messageId: string,
  ): Promise<MeetingMessage | undefined> {
    const result = await this.database.query<MeetingMessageRow>(
      `SELECT * FROM meeting_messages
       WHERE meeting_id = $1 AND id = $2`,
      [meetingId, messageId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : meetingMessageFromRow(row);
  }

  async close(id: string, summary: string): Promise<Meeting | undefined> {
    const result = await this.database.query<MeetingRow>(
      `UPDATE meetings
       SET status = 'closed', summary = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, summary],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : meetingFromRow(row);
  }
}

export class WorkbenchRepository {
  constructor(private readonly database: Database) {}

  async summary(): Promise<WorkbenchSummary> {
    const result = await this.database.query<{
      projects: string;
      active_tasks: string;
      review_tasks: string;
      active_runs: string;
      memory_topics: string;
      workflows: string;
      meetings: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM projects WHERE status = 'active') AS projects,
         (SELECT COUNT(*) FROM tasks WHERE status IN ('queued', 'in_progress')) AS active_tasks,
         (SELECT COUNT(*) FROM tasks WHERE status = 'review') AS review_tasks,
         (SELECT COUNT(*) FROM runs WHERE status IN ('queued', 'running', 'waiting_approval')) AS active_runs,
         (SELECT COUNT(*) FROM memory_topics) AS memory_topics,
         (SELECT COUNT(*) FROM workflow_instances
          WHERE status IN ('active', 'waiting', 'blocked', 'paused')) AS workflows,
         (SELECT COUNT(*) FROM meetings WHERE status = 'open') AS meetings`,
    );
    const row = result.rows[0]!;
    return {
      projects: Number(row.projects),
      activeTasks: Number(row.active_tasks),
      reviewTasks: Number(row.review_tasks),
      activeRuns: Number(row.active_runs),
      memoryTopics: Number(row.memory_topics),
      workflows: Number(row.workflows),
      meetings: Number(row.meetings),
    };
  }
}

function artifactFromRow(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    runId: row.run_id,
    projectId: row.project_id,
    name: row.name,
    mimeType: row.mime_type,
    size: Number(row.size),
    sha256: row.sha256,
    storageKey: row.storage_key,
    createdAt: row.created_at.toISOString(),
  };
}

function workflowFromRow(row: WorkflowRow): WorkflowDefinition {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    steps: row.steps,
    sourceMarkdown: row.source_md ?? "",
    graph: row.graph ?? null,
    status: row.status,
    sourceTemplateId: row.source_template_id,
    sourceTemplateVersion: row.source_template_version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function workflowInstanceFromRow(row: WorkflowInstanceRow): WorkflowInstance {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    definitionKey: "legacy-workflow",
    definitionVersion: 1,
    parentInstanceId: null,
    parentNodeId: null,
    failureReason: null,
    pausedAt: null,
    lastReconciledAt: null,
    revision: 1,
    runtime: { nodes: [], edges: [], context: {} },
    graph: null,
    currentStep: row.current_step,
    steps: row.steps,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function meetingFromRow(row: MeetingRow): Meeting {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    agenda: row.agenda,
    status: row.status,
    participants: row.participants,
    summary: row.summary,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function meetingMessageFromRow(row: MeetingMessageRow): MeetingMessage {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    content: row.content,
    turnId: row.turn_id,
    policyId: row.policy_id,
    policyRevision: row.policy_revision,
    triggerKind: row.trigger_kind,
    triggerReason: row.trigger_reason,
    runId: row.run_id,
    traceId: row.trace_id,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    clientMessageId: row.client_message_id,
    delegateId: row.delegate_id,
    senderPrincipalId: row.sender_principal_id,
    createdAt: row.created_at.toISOString(),
  };
}
