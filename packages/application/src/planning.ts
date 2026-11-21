import type {
  PlanningArtifact,
  PlanningArtifactKind,
  PlanningOverview,
  PlanningQualityMetric,
  PlanningRetryInput,
  PlanningRunDetail,
  PlanningRunRevisionInput,
  PlanningRunOnceInput,
  PlanningSettings,
  PlanningStartInput,
  PlanningSubmitPlanInput,
  PlanningWorkerResult,
  TaskDispatchReadiness,
  UpdatePlanningSettingsInput,
} from "@pluginmax/contracts";
import {
  planningRetryInputSchema,
  planningReviewRequiredInputSchema,
  planningRunRevisionInputSchema,
  planningRunOnceInputSchema,
  planningStartInputSchema,
  updatePlanningSettingsInputSchema,
} from "@pluginmax/contracts";
import type { PlatformRepositories } from "@pluginmax/database";
import {
  PlanningRuntimeWorker,
  type PlanningRuntimeWorkerOptions,
} from "./planning-runtime.js";

export class PlanningApplicationService {
  private readonly worker: PlanningRuntimeWorker;

  constructor(
    private readonly repositories: PlatformRepositories,
    workerOptions: PlanningRuntimeWorkerOptions = {},
  ) {
    this.worker = new PlanningRuntimeWorker(repositories, workerOptions);
  }

  getSettings(projectId: string): Promise<PlanningSettings> {
    return this.repositories.planning.getSettings(projectId);
  }

  updateSettings(input: {
    readonly projectId: string;
    readonly actorId: string;
    readonly value: UpdatePlanningSettingsInput;
  }): Promise<PlanningSettings> {
    const parsed = updatePlanningSettingsInputSchema.parse(input.value);
    return this.repositories.planning.updateSettings({
      projectId: input.projectId,
      actorId: input.actorId,
      expectedRevision: parsed.expectedRevision,
      policy: parsed.policy,
      flags: parsed.flags,
    });
  }

  start(input: {
    readonly taskId: string;
    readonly actorId: string;
    readonly value: PlanningStartInput;
  }) {
    const parsed = planningStartInputSchema.parse(input.value);
    return this.repositories.planning.startRun({
      taskId: input.taskId,
      actorId: input.actorId,
      triggerKind: "human-manual",
      expectedTaskRevision: parsed.expectedTaskRevision,
      reason: parsed.reason,
    });
  }

  getOverview(taskId: string): Promise<PlanningOverview> {
    return this.repositories.planning.getOverview(taskId);
  }

  async getDispatchReadiness(taskId: string): Promise<TaskDispatchReadiness> {
    return this.repositories.planning.getTaskDispatchReadiness(taskId);
  }

  async runOnce(value: PlanningRunOnceInput = {}): Promise<PlanningWorkerResult> {
    const parsed = planningRunOnceInputSchema.parse(value);
    return this.worker.runOnce(parsed.limit);
  }

  processRun(runId: string) {
    return this.worker.processRun(runId);
  }

  submitPlan(input: {
    readonly runId: string;
    readonly actorId: string;
    readonly value: PlanningSubmitPlanInput;
  }): Promise<PlanningRunDetail> {
    return this.worker.submitPlan(input.runId, input.value, input.actorId);
  }

  getRun(runId: string): Promise<PlanningRunDetail> {
    return this.repositories.planning.getRunDetail(runId);
  }

  pause(input: {
    readonly runId: string;
    readonly actorId: string;
    readonly value: PlanningRunRevisionInput;
  }): Promise<PlanningRunDetail> {
    const parsed = planningRunRevisionInputSchema.parse(input.value);
    return this.repositories.planning.pauseRun({
      runId: input.runId,
      actorId: input.actorId,
      expectedRevision: parsed.expectedRevision,
      reason: parsed.reason,
    });
  }

  startPaused(input: {
    readonly runId: string;
    readonly actorId: string;
    readonly value: PlanningRunRevisionInput;
  }): Promise<PlanningRunDetail> {
    const parsed = planningRunRevisionInputSchema.parse(input.value);
    return this.repositories.planning.resumeRun({
      runId: input.runId,
      actorId: input.actorId,
      expectedRevision: parsed.expectedRevision,
      reason: parsed.reason,
    });
  }

  cancel(input: {
    readonly runId: string;
    readonly actorId: string;
    readonly value: PlanningRunRevisionInput;
  }): Promise<PlanningRunDetail> {
    const parsed = planningRunRevisionInputSchema.parse(input.value);
    return this.repositories.planning.cancelRun({
      runId: input.runId,
      actorId: input.actorId,
      expectedRevision: parsed.expectedRevision,
      reason: parsed.reason,
    });
  }

  reviewRequired(input: {
    readonly runId: string;
    readonly actorId: string;
    readonly value: PlanningRunRevisionInput;
  }): Promise<PlanningRunDetail> {
    const parsed = planningReviewRequiredInputSchema.parse(input.value);
    return this.repositories.planning.markReviewRequired({
      runId: input.runId,
      actorId: input.actorId,
      expectedRevision: parsed.expectedRevision,
      reason: parsed.reason,
    });
  }

  retry(input: {
    readonly runId: string;
    readonly actorId: string;
    readonly value: PlanningRetryInput;
  }) {
    const parsed = planningRetryInputSchema.parse(input.value);
    return this.repositories.planning.retryRun({
      runId: input.runId,
      actorId: input.actorId,
      expectedRevision: parsed.expectedRevision,
      reason: parsed.reason,
    });
  }

  recordArtifact(input: {
    readonly runId: string;
    readonly actorId: string;
    readonly kind: PlanningArtifactKind;
    readonly payload: unknown;
  }): Promise<PlanningArtifact> {
    return this.repositories.planning.recordArtifact(input);
  }

  recordQualityMetric(input: {
    readonly runId: string;
    readonly actorId: string;
    readonly criticScore: number | null;
    readonly validatorErrorCount: number;
    readonly acceptanceCoverage: number | null;
    readonly nodeCount: number;
    readonly depth: number;
    readonly humanReviewRequired: boolean;
    readonly autoApproveEligible: boolean;
  }): Promise<PlanningQualityMetric> {
    return this.repositories.planning.recordQualityMetric(input);
  }
}
