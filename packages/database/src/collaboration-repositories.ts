import { randomUUID } from "node:crypto";
import type {
  Artifact,
  CreateMeetingInput,
  CreateWorkflowInput,
  Meeting,
  MeetingDetail,
  MeetingMessage,
  MemoryTopic,
  MemoryTruth,
  TaskReviewInput,
  WorkbenchSummary,
  WorkflowDefinition,
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
  current_truth: MemoryTruth | null;
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
      const truth: MemoryTruth = {
        id: randomUUID(),
        topicId,
        content: input.content,
        version: 1,
        sourceType: "task",
        sourceId: input.taskId,
        createdAt: new Date().toISOString(),
      };
      await client.query(
        `INSERT INTO memory_topics (id, project_id, title, created_at, updated_at)
         VALUES ($1, $2, $3, NOW(), NOW())`,
        [topicId, input.projectId, input.title],
      );
      await client.query(
        `INSERT INTO memory_truths (
           id, topic_id, project_id, content, version,
           source_type, source_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          truth.id,
          topicId,
          input.projectId,
          truth.content,
          truth.version,
          truth.sourceType,
          truth.sourceId,
          truth.createdAt,
        ],
      );
    });
  }

  async list(projectId: string): Promise<MemoryTopic[]> {
    const result = await this.database.query<MemoryTopicRow>(
      `SELECT
         topic.*,
         truth_row AS current_truth
       FROM memory_topics AS topic
       LEFT JOIN LATERAL (
         SELECT jsonb_build_object(
           'id', truth.id,
           'topicId', truth.topic_id,
           'content', truth.content,
           'version', truth.version,
           'sourceType', truth.source_type,
           'sourceId', truth.source_id,
           'createdAt', truth.created_at
         ) AS truth_row
         FROM memory_truths AS truth
         WHERE truth.topic_id = topic.id
         ORDER BY truth.version DESC
         LIMIT 1
       ) AS current ON TRUE
       WHERE topic.project_id = $1
       ORDER BY topic.updated_at DESC`,
      [projectId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      currentTruth: row.current_truth,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }));
  }
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
  status: WorkflowDefinition["status"];
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
    const steps: WorkflowStepDefinition[] = input.stepNames.map(
      (name, index) => ({
        id: randomUUID(),
        name,
        kind: index === input.stepNames.length - 1 ? "human" : "agent",
      }),
    );
    const result = await this.database.query<WorkflowRow>(
      `INSERT INTO workflow_definitions (
         id, project_id, name, description, steps, status, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, 'active', NOW(), NOW())
       RETURNING *`,
      [
        randomUUID(),
        input.projectId,
        input.name,
        input.description,
        JSON.stringify(steps),
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
  created_at: Date;
}

export class MeetingRepository {
  constructor(private readonly database: Database) {}

  async list(projectId: string): Promise<Meeting[]> {
    const result = await this.database.query<MeetingRow>(
      "SELECT * FROM meetings WHERE project_id = $1 ORDER BY updated_at DESC",
      [projectId],
    );
    return result.rows.map(meetingFromRow);
  }

  async create(
    input: CreateMeetingInput,
    agents: readonly { id: string; name: string }[],
  ): Promise<Meeting> {
    const participants = [
      { id: "local-admin", name: "Local Admin", kind: "human" as const },
      ...agents
        .filter((agent) => input.agentIds.includes(agent.id))
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          kind: "agent" as const,
        })),
    ];
    const result = await this.database.query<MeetingRow>(
      `INSERT INTO meetings (
         id, project_id, title, agenda, status, participants,
         summary, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'open', $5::jsonb, '', NOW(), NOW())
       RETURNING *`,
      [
        randomUUID(),
        input.projectId,
        input.title,
        input.agenda,
        JSON.stringify(participants),
      ],
    );
    return meetingFromRow(result.rows[0]!);
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
    meetingId: string,
    authorType: MeetingMessage["authorType"],
    authorId: string,
    authorName: string,
    content: string,
  ): Promise<MeetingMessage> {
    const result = await this.database.query<MeetingMessageRow>(
      `INSERT INTO meeting_messages (
         id, meeting_id, author_type, author_id, author_name, content, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [randomUUID(), meetingId, authorType, authorId, authorName, content],
    );
    await this.database.query(
      "UPDATE meetings SET updated_at = NOW() WHERE id = $1",
      [meetingId],
    );
    return meetingMessageFromRow(result.rows[0]!);
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
         (SELECT COUNT(*) FROM workflow_instances WHERE status = 'active') AS workflows,
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
    status: row.status,
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
    createdAt: row.created_at.toISOString(),
  };
}
