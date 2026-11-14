import { createHash } from "node:crypto";
import type {
  AcceptanceEvidenceRef,
  Task,
  TaskAcceptanceEvidenceProjection,
  TaskExecutionAnomaly,
  TaskExecutionHealthProjection,
  TaskExecutionAnomalyCode,
  SubmitTaskAcceptanceEvidenceInput,
} from "@pluginmax/contracts";
import type { PlatformRepositories } from "@pluginmax/database";
import { ApplicationError } from "./errors.js";

export type OwnerRunCompletionDecision =
  | { readonly kind: "legacy" }
  | { readonly kind: "shadow"; readonly ready: boolean }
  | { readonly kind: "manual" }
  | {
      readonly kind: "blocked";
      readonly missingAcceptanceCount: number;
    }
  | { readonly kind: "review" }
  | { readonly kind: "automatic_accept_disabled" };

interface RunReadiness {
  readonly ready: boolean;
  readonly ownerRun: Awaited<
    ReturnType<PlatformRepositories["runs"]["get"]>
  > | null;
  readonly projection: TaskAcceptanceEvidenceProjection;
  readonly missingAcceptanceCount: number;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class TaskAcceptanceService {
  constructor(private readonly repositories: PlatformRepositories) {}

  async syncAcceptance(
    taskId: string,
    requirements: readonly string[],
  ): Promise<void> {
    await this.repositories.taskAcceptance.syncItems(taskId, requirements);
  }

  async currentOwnerRun(taskId: string) {
    const runs = await this.repositories.runs.listByTask(taskId);
    return runs.find((run) => run.taskExecutionKind === "owner") ?? null;
  }

  private async evaluateReadiness(taskId: string): Promise<RunReadiness> {
    const task = await this.requireTask(taskId);
    let items = await this.repositories.taskAcceptance.listItems(taskId);
    if (items.length === 0 && task.acceptance.length > 0) {
      await this.syncAcceptance(taskId, task.acceptance);
      items = await this.repositories.taskAcceptance.listItems(taskId);
    }
    const mode = await this.repositories.featureFlags.evidenceReviewMode(
      task.projectId,
    );
    const [confirmations, ownerRun] = await Promise.all([
      this.repositories.taskAcceptance.listCurrentConfirmations(taskId),
      this.currentOwnerRun(taskId),
    ]);
    const confirmationByItem = new Map(
      confirmations
        .filter(
          (confirmation) =>
            ownerRun !== null && confirmation.runId === ownerRun.id,
        )
        .map((confirmation) => [confirmation.acceptanceItemId, confirmation]),
    );
    const itemsWithConfirmation = items.map((item) => {
      const confirmation = confirmationByItem.get(item.id);
      return {
        ...item,
        currentConfirmation:
          confirmation !== undefined &&
          confirmation.acceptanceItemRevision === item.revision
            ? confirmation
            : null,
      };
    });
    const requiredItems = itemsWithConfirmation.filter((item) => item.required);
    const confirmedRequired = requiredItems.filter(
      (item) => item.currentConfirmation !== null,
    );
    const projection: TaskAcceptanceEvidenceProjection = {
      taskId,
      mode,
      items: itemsWithConfirmation,
      allRequiredConfirmed:
        ownerRun?.status === "completed" &&
        confirmedRequired.length === requiredItems.length,
      currentOwnerRunId: ownerRun?.id ?? null,
    };
    return {
      ready: projection.allRequiredConfirmed && ownerRun?.status === "completed",
      ownerRun,
      projection,
      missingAcceptanceCount:
        requiredItems.length - confirmedRequired.length,
    };
  }

  async getAcceptanceEvidence(
    taskId: string,
  ): Promise<TaskAcceptanceEvidenceProjection> {
    await this.requireTask(taskId);
    return (await this.evaluateReadiness(taskId)).projection;
  }

  async getExecutionHealth(
    taskId: string,
  ): Promise<TaskExecutionHealthProjection> {
    const task = await this.requireTask(taskId);
    const [evidenceMode, anomalyMode, readiness, activeAnomalies] =
      await Promise.all([
        this.repositories.featureFlags.evidenceReviewMode(task.projectId),
        this.repositories.featureFlags.anomalyMode(task.projectId),
        this.evaluateReadiness(taskId),
        this.repositories.taskAnomalies.listActive(taskId),
      ]);
    const visibleAnomalies = anomalyMode === "off" ? [] : activeAnomalies;
    const requiredItems = readiness.projection.items.filter(
      (item) => item.required,
    );
    const confirmed = requiredItems.filter(
      (item) => item.currentConfirmation !== null,
    );
    const missingAcceptanceCount =
      evidenceMode === "off"
        ? 0
        : requiredItems.length - confirmed.length;
    return {
      taskId,
      health:
        visibleAnomalies.length > 0
          ? "anomaly"
          : missingAcceptanceCount > 0
            ? "attention"
            : "healthy",
      activeAnomalies: visibleAnomalies,
      requiredAcceptanceTotal: requiredItems.length,
      requiredAcceptanceConfirmed: confirmed.length,
      missingAcceptanceCount,
      mode: {
        evidenceReview: evidenceMode,
        anomaly: anomalyMode,
      },
    };
  }

  async confirmExecutionEvidence(input: {
    readonly taskId: string;
    readonly actorPrincipalId: string;
    readonly evidence: SubmitTaskAcceptanceEvidenceInput;
  }): Promise<TaskAcceptanceEvidenceProjection> {
    const task = await this.requireTask(input.taskId);
    const mode = await this.repositories.featureFlags.evidenceReviewMode(
      task.projectId,
    );
    if (mode !== "enforce") {
      throw new ApplicationError(
        "feature_mode_mismatch",
        "Acceptance evidence writes require task.evidence_review=enforce",
        409,
        { mode },
      );
    }
    const run = await this.repositories.runs.get(input.evidence.runId);
    if (run === undefined || run.taskId !== task.id) {
      throw new ApplicationError(
        "acceptance_evidence_invalid",
        "Run does not belong to this Task",
        409,
      );
    }
    if (run.taskExecutionKind !== "owner") {
      throw new ApplicationError(
        "acceptance_evidence_stale_run",
        "Collaborator Runs cannot be used as acceptance evidence",
        409,
      );
    }
    if (run.status !== "completed") {
      throw new ApplicationError(
        "acceptance_evidence_stale_run",
        "Only a completed owner Run can support acceptance evidence",
        409,
      );
    }
    const currentOwner = await this.currentOwnerRun(task.id);
    if (currentOwner?.id !== run.id) {
      throw new ApplicationError(
        "acceptance_evidence_stale_run",
        "Only the latest valid owner Run can support current acceptance",
        409,
      );
    }
    const items = await this.repositories.taskAcceptance.listItems(task.id);
    const itemById = new Map(items.map((item) => [item.id, item]));
    for (const evidence of input.evidence.items) {
      const item = itemById.get(evidence.acceptanceItemId);
      if (
        item === undefined ||
        item.revision !== evidence.acceptanceItemRevision
      ) {
        throw new ApplicationError(
          "acceptance_item_not_current",
          "Acceptance item is missing or no longer current",
          409,
          {
            acceptanceItemId: evidence.acceptanceItemId,
            expectedRevision: item?.revision ?? null,
          },
        );
      }
      await this.validateEvidenceRefs(run, evidence.evidenceRefs);
    }
    for (const evidence of input.evidence.items) {
      const confirmation = await this.repositories.taskAcceptance.saveConfirmation(
        {
          acceptanceItemId: evidence.acceptanceItemId,
          acceptanceItemRevision: evidence.acceptanceItemRevision,
          taskId: task.id,
          runId: run.id,
          runAttempt: run.attempt,
          confirmedByPrincipalId: input.actorPrincipalId,
          evidenceRefs: evidence.evidenceRefs,
        },
      );
      await this.appendAudit({
        action: "task.acceptance.confirmed",
        actorPrincipalId: input.actorPrincipalId,
        taskId: task.id,
        metadata: {
          acceptanceItemId: confirmation.acceptanceItemId,
          acceptanceItemRevision: confirmation.acceptanceItemRevision,
          runId: confirmation.runId,
        },
      });
      await this.repositories.runs.appendEvent(
        run.id,
        "task.acceptance_confirmed",
        "验收项已提交带归属校验的执行证据",
        {
          acceptanceItemId: confirmation.acceptanceItemId,
          acceptanceItemRevision: confirmation.acceptanceItemRevision,
          confirmedByPrincipalId: confirmation.confirmedByPrincipalId,
        },
      );
    }
    const projection = await this.getAcceptanceEvidence(task.id);
    if (projection.allRequiredConfirmed && projection.currentOwnerRunId !== null) {
      await this.clearReviewReadinessAnomalies({
        taskId: task.id,
        runId: projection.currentOwnerRunId,
        runAttempt: run.attempt,
        reason: "acceptance_evidence_completed",
      });
    }
    return projection;
  }

  async assertReadyForReview(taskId: string): Promise<void> {
    const task = await this.requireTask(taskId);
    const mode = await this.repositories.featureFlags.evidenceReviewMode(
      task.projectId,
    );
    if (mode !== "enforce") return;
    const readiness = await this.evaluateReadiness(taskId);
    if (readiness.ownerRun?.status !== "completed") {
      await this.detectAnomaly({
        taskId,
        code: "missing_execution_evidence",
        message: "A completed current owner Run is required before review",
        runId: readiness.ownerRun?.id ?? null,
        runAttempt: readiness.ownerRun?.attempt ?? null,
      });
      throw new ApplicationError(
        "acceptance_evidence_incomplete",
        "A completed current owner Run is required before review",
        409,
      );
    }
    if (!readiness.projection.allRequiredConfirmed) {
      await this.detectAnomaly({
        taskId,
        code: "missing_acceptance",
        message: `${readiness.missingAcceptanceCount} required acceptance item(s) lack current evidence`,
        runId: readiness.ownerRun.id,
        runAttempt: readiness.ownerRun.attempt,
      });
      throw new ApplicationError(
        "acceptance_evidence_incomplete",
        "Every required acceptance item needs a current confirmation",
        409,
        {
          missingAcceptanceCount: readiness.missingAcceptanceCount,
          runId: readiness.ownerRun.id,
        },
      );
    }
    await this.clearReviewReadinessAnomalies({
      taskId,
      runId: readiness.ownerRun.id,
      runAttempt: readiness.ownerRun.attempt,
      reason: "acceptance_ready_for_review",
    });
  }

  async assertIndependentReviewer(task: Task, actorPrincipalId: string) {
    const [principal, agent, confirmations] = await Promise.all([
      this.repositories.authorization.getPrincipal(actorPrincipalId),
      this.repositories.agents.get(task.agentId, true),
      this.repositories.taskAcceptance.listCurrentConfirmations(task.id),
    ]);
    if (
      principal?.kind === "ai" &&
      (actorPrincipalId === agent?.principalId || actorPrincipalId === agent?.id)
    ) {
      await this.appendAudit({
        action: "task.review.agent_self_approval_denied",
        actorPrincipalId,
        taskId: task.id,
        decision: "denied",
        metadata: { agentId: task.agentId },
      });
      throw new ApplicationError(
        "agent_self_approval_denied",
        "An Agent cannot approve its own Task",
        403,
      );
    }
    if (
      confirmations.some(
        (confirmation) =>
          confirmation.confirmedByPrincipalId === actorPrincipalId,
      )
    ) {
      await this.appendAudit({
        action: "task.review.independence_denied",
        actorPrincipalId,
        taskId: task.id,
        decision: "denied",
        metadata: {
          reason: "same_principal_confirmed_execution",
        },
      });
      throw new ApplicationError(
        "acceptance_reviewer_conflict",
        "The execution confirmer cannot independently approve the Task",
        403,
      );
    }
    return principal;
  }

  async handleCompletedOwnerRun(
    task: Task,
    runId: string,
  ): Promise<OwnerRunCompletionDecision> {
    const mode = await this.repositories.featureFlags.evidenceReviewMode(
      task.projectId,
    );
    if (mode === "off") return { kind: "legacy" };
    const readiness = await this.evaluateReadiness(task.id);
    if (mode === "observe") {
      await this.repositories.runs.appendEvent(
        runId,
        "task.evidence_shadow_evaluated",
        "验收证据门禁完成影子判定，未写确认事实或改变任务状态",
        {
          ready: readiness.ready,
          missingAcceptanceCount: readiness.missingAcceptanceCount,
          requiredAcceptanceTotal: readiness.projection.items.filter(
            (item) => item.required,
          ).length,
        },
      );
      return { kind: "shadow", ready: readiness.ready };
    }
    if (!task.autoSubmit) {
      await this.repositories.tasks.setStatus(task.id, "in_progress");
      return { kind: "manual" };
    }
    if (!readiness.ready) {
      await this.repositories.tasks.setStatus(task.id, "in_progress");
      await this.detectAnomaly({
        taskId: task.id,
        code: "missing_acceptance",
        message: `${readiness.missingAcceptanceCount} required acceptance item(s) lack current evidence`,
        runId,
        runAttempt: readiness.ownerRun?.attempt ?? null,
      });
      await this.repositories.taskCollaboration.appendEvent({
        taskId: task.id,
        kind: "review",
        actorId: "system:evidence-review",
        actorName: "Pluginmax",
        summary: "自动提交被验收证据门禁阻止",
        data: {
          runId,
          missingAcceptanceCount: readiness.missingAcceptanceCount,
        },
      });
      return {
        kind: "blocked",
        missingAcceptanceCount: readiness.missingAcceptanceCount,
      };
    }
    if (task.autoAccept) {
      await this.repositories.tasks.setStatus(task.id, "review");
      await this.repositories.meetingDecisions.syncTaskStatus(task.id, "review");
      await this.repositories.taskCollaboration.appendEvent({
        taskId: task.id,
        kind: "review",
        actorId: "system:auto-accept",
        actorName: "Pluginmax",
        summary: "自动验收请求已降级为人工独立 Review",
        data: {
          runId,
          automatic: true,
          reason: "independent_review_required",
        },
      });
      return { kind: "automatic_accept_disabled" };
    }
    await this.repositories.tasks.setStatus(task.id, "review");
    await this.repositories.meetingDecisions.syncTaskStatus(task.id, "review");
    await this.repositories.taskCollaboration.appendEvent({
      taskId: task.id,
      kind: "review",
      actorId: "system:auto-submit",
      actorName: "Pluginmax",
      summary: "Run 已完成，证据完整，自动提交人工验收",
      data: { runId, automatic: true },
    });
    return { kind: "review" };
  }

  async detectRunFailure(input: {
    readonly taskId: string;
    readonly runId: string;
    readonly runAttempt: number;
    readonly code: Extract<
      TaskExecutionAnomalyCode,
      "run_failed" | "run_timeout" | "run_interrupted" | "tool_failed"
    >;
    readonly message: string;
    readonly eventId?: string | null;
  }): Promise<TaskExecutionAnomaly | undefined> {
    return this.detectAnomaly(input);
  }

  async clearRunAttemptAnomalies(input: {
    readonly taskId: string;
    readonly runId: string;
    readonly runAttempt: number;
    readonly reason: string;
  }): Promise<void> {
    const task = await this.requireTask(input.taskId);
    const mode = await this.repositories.featureFlags.anomalyMode(
      task.projectId,
    );
    if (mode === "off") return;
    const cleared = await this.repositories.taskAnomalies.clearForRunAttempt(
      input,
    );
    for (const anomaly of cleared) {
      await this.appendAudit({
        action: "task.anomaly.cleared",
        actorPrincipalId: null,
        taskId: task.id,
        decision: "allowed",
        metadata: {
          anomalyId: anomaly.id,
          code: anomaly.code,
          runId: anomaly.runId,
          runAttempt: anomaly.runAttempt,
          reason: input.reason,
        },
      });
      await this.repositories.runs.appendEvent(
        input.runId,
        "task.anomaly.cleared",
        `执行异常已清除：${anomaly.code}`,
        {
          anomalyId: anomaly.id,
          code: anomaly.code,
          reason: input.reason,
        },
      );
    }
  }

  private async clearReviewReadinessAnomalies(input: {
    readonly taskId: string;
    readonly runId: string;
    readonly runAttempt: number;
    readonly reason: string;
  }): Promise<void> {
    const task = await this.requireTask(input.taskId);
    const mode = await this.repositories.featureFlags.anomalyMode(
      task.projectId,
    );
    if (mode === "off") return;
    const cleared =
      await this.repositories.taskAnomalies.clearReadinessForRun(input);
    for (const anomaly of cleared) {
      await this.appendAudit({
        action: "task.anomaly.cleared",
        actorPrincipalId: null,
        taskId: task.id,
        decision: "allowed",
        metadata: {
          anomalyId: anomaly.id,
          code: anomaly.code,
          runId: anomaly.runId,
          runAttempt: anomaly.runAttempt,
          reason: input.reason,
        },
      });
      await this.repositories.runs.appendEvent(
        input.runId,
        "task.anomaly.cleared",
        `执行异常已清除：${anomaly.code}`,
        {
          anomalyId: anomaly.id,
          code: anomaly.code,
          reason: input.reason,
        },
      );
    }
  }

  private async detectAnomaly(input: {
    readonly taskId: string;
    readonly code: TaskExecutionAnomalyCode;
    readonly message: string;
    readonly runId?: string | null;
    readonly runAttempt?: number | null;
    readonly eventId?: string | null;
  }): Promise<TaskExecutionAnomaly | undefined> {
    const task = await this.requireTask(input.taskId);
    const mode = await this.repositories.featureFlags.anomalyMode(
      task.projectId,
    );
    if (mode === "off") return undefined;
    const anomaly = await this.repositories.taskAnomalies.detect(input);
    await this.appendAudit({
      action: "task.anomaly.detected",
      actorPrincipalId: null,
      taskId: task.id,
      decision: "allowed",
      metadata: {
        anomalyId: anomaly.id,
        code: anomaly.code,
        runId: anomaly.runId,
        runAttempt: anomaly.runAttempt,
        occurrence: anomaly.occurrence,
      },
    });
    if (input.runId !== undefined && input.runId !== null) {
      await this.repositories.runs.appendEvent(
        input.runId,
        "task.anomaly.detected",
        `执行异常已记录：${anomaly.code}`,
        {
          anomalyId: anomaly.id,
          code: anomaly.code,
          occurrence: anomaly.occurrence,
        },
      );
    }
    return anomaly;
  }

  private async validateEvidenceRefs(
    run: NonNullable<Awaited<ReturnType<PlatformRepositories["runs"]["get"]>>>,
    evidenceRefs: readonly AcceptanceEvidenceRef[],
  ): Promise<void> {
    for (const evidence of evidenceRefs) {
      switch (evidence.kind) {
        case "artifact": {
          const artifact = await this.repositories.artifacts.get(
            evidence.refId,
          );
          if (
            artifact === undefined ||
            artifact.runId !== run.id ||
            artifact.projectId !== run.projectId ||
            (evidence.digest !== undefined &&
              evidence.digest !== artifact.sha256)
          ) {
            throw new ApplicationError(
              "acceptance_evidence_invalid",
              "Artifact evidence does not belong to the current Run",
              409,
            );
          }
          break;
        }
        case "tool-event": {
          const events = await this.repositories.runs.listEvents(run.id);
          const event = events.find((candidate) => candidate.id === evidence.refId);
          if (
            event === undefined ||
            (event.type !== "tool.call" && event.type !== "tool.result")
          ) {
            throw new ApplicationError(
              "acceptance_evidence_invalid",
              "Tool-event evidence does not belong to the current Run",
              409,
            );
          }
          break;
        }
        case "run-output":
          if (
            (evidence.refId !== run.id &&
              evidence.refId !== `run:${run.id}:output`) ||
            run.output === null ||
            (evidence.digest !== undefined &&
              evidence.digest !== digest(run.output))
          ) {
            throw new ApplicationError(
              "acceptance_evidence_invalid",
              "Run-output evidence does not belong to the current output",
              409,
            );
          }
          break;
        case "external-resource":
          throw new ApplicationError(
            "acceptance_evidence_invalid",
            "External-resource evidence has no verifiable ownership registry in M1a",
            409,
          );
      }
    }
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.repositories.tasks.get(taskId);
    if (task === undefined) {
      throw new ApplicationError("task_not_found", "Task not found", 404);
    }
    return task;
  }

  private async appendAudit(input: {
    readonly action: string;
    readonly actorPrincipalId: string | null;
    readonly taskId: string;
    readonly decision?: "allowed" | "denied";
    readonly metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.repositories.identityAdministration.appendAuditEvent({
      action: input.action,
      decision: input.decision ?? "allowed",
      actorPrincipalId: input.actorPrincipalId,
      subjectPrincipalId: null,
      accountId: null,
      sessionId: null,
      grantId: null,
      reason: "",
      metadata: {
        taskId: input.taskId,
        ...input.metadata,
      },
    });
  }
}
