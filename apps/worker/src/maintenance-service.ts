import type { PlatformApplication } from "@pluginmax/application";
import type { ClaimedMaintenance } from "@pluginmax/contracts";
import type { PlatformRepositories } from "@pluginmax/database";

export interface RuntimeMaintenanceServiceOptions {
  readonly owner: string;
  readonly claimLeaseSeconds: number;
  readonly approvalSlaBatchSize: number;
  readonly recoveryBatchSize: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly idempotencyRetentionSeconds: number;
  readonly idempotencyCleanupBatchSize: number;
}

export class RuntimeMaintenanceService {
  constructor(
    private readonly repositories: PlatformRepositories,
    private readonly application: PlatformApplication,
    private readonly options: RuntimeMaintenanceServiceOptions,
    private readonly log?: (
      event: string,
      data?: Record<string, unknown>,
    ) => void,
  ) {}

  async runOnce(limit = 4): Promise<number> {
    const claims =
      await this.repositories.runtimeReliability.claimDueMaintenance({
        owner: this.options.owner,
        leaseSeconds: this.options.claimLeaseSeconds,
        limit,
      });
    for (const claim of claims) {
      this.log?.("maintenance.claimed", {
        kind: claim.kind,
        traceId: claim.traceId,
        traceparent: `00-${claim.traceId}-${claim.spanId}-01`,
      });
    }
    await Promise.all(claims.map((claim) => this.execute(claim)));
    return claims.length;
  }

  private async execute(claim: ClaimedMaintenance): Promise<void> {
    const startedAt = new Date(claim.scheduledFor);
    try {
      await this.dispatch(claim, startedAt);
      const completed =
        await this.repositories.runtimeReliability.completeMaintenanceClaim(
          claim.kind,
          this.options.owner,
          claim.leaseToken,
        );
      if (!completed) {
        this.log?.("maintenance.claim_lost", {
          kind: claim.kind,
          traceId: claim.traceId,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log?.("maintenance.failed", {
        kind: claim.kind,
        traceId: claim.traceId,
        error: message,
      });
      await this.repositories.runtimeReliability.failMaintenanceClaim(
        claim.kind,
        this.options.owner,
        claim.leaseToken,
        message,
      );
    }
  }

  private async dispatch(
    claim: ClaimedMaintenance,
    startedAt: Date,
  ): Promise<void> {
    const trace = {
      traceId: claim.traceId,
      spanId: claim.spanId,
      parentSpanId: null,
      traceFlags: 1,
    } as const;
    switch (claim.kind) {
      case "approval_sla": {
        const result = await this.application.sweepApprovalSla(
          this.options.owner,
          this.options.approvalSlaBatchSize,
          {
            triggerSource: "scheduler",
            scheduledFor: new Date(claim.scheduledFor),
            trace,
          },
        );
        if (result.reminded + result.escalated + result.expired > 0) {
          this.log?.("workflow.approval_sla", result);
        }
        return;
      }
      case "idempotency_cleanup": {
        const result =
          await this.repositories.runtimeReliability.cleanupIdempotencyReceipts(
            {
              olderThanSeconds: this.options.idempotencyRetentionSeconds,
              batchSize: this.options.idempotencyCleanupBatchSize,
            },
            {
              triggerSource: "scheduler",
              scheduledFor: new Date(claim.scheduledFor),
              trace,
            },
          );
        if (result.deletedCount > 0) {
          this.log?.("idempotency.cleanup", result);
        }
        return;
      }
      case "lease_recovery": {
        const recovered = await this.repositories.jobs.recoverExpiredLeases(
          this.options.recoveryBatchSize,
          {
            baseBackoffMs: this.options.retryBaseDelayMs,
            maxBackoffMs: this.options.retryMaxDelayMs,
          },
        );
        if (recovered.length > 0) {
          await this.repositories.runtimeReliability.recordMaintenance({
            kind: claim.kind,
            status: "completed",
            processedCount: recovered.length,
            metrics: { recovered },
            triggerSource: "scheduler",
            scheduledFor: new Date(claim.scheduledFor),
            startedAt,
            trace,
          });
          this.log?.("jobs.expired_leases_recovered", {
            count: recovered.length,
          });
        }
        return;
      }
      case "effect_recovery": {
        const reconciled =
          await this.repositories.runtimeEffects.reconcileExpired(
            this.options.recoveryBatchSize,
          );
        if (reconciled.cancelled + reconciled.failed > 0) {
          await this.repositories.runtimeReliability.recordMaintenance({
            kind: claim.kind,
            status: "completed",
            processedCount: reconciled.cancelled + reconciled.failed,
            metrics: reconciled,
            triggerSource: "scheduler",
            scheduledFor: new Date(claim.scheduledFor),
            startedAt,
            trace,
          });
          this.log?.("runtime_effects.reconciled", reconciled);
        }
        return;
      }
      case "teammate_queue": {
        const autoRun = await this.application.teammates.runAutoQueue(
          this.options.recoveryBatchSize,
        );
        const reports =
          await this.application.teammates.generateDueWeeklyReports();
        if (autoRun.attempted > 0 || reports.generated > 0) {
          await this.repositories.runtimeReliability.recordMaintenance({
            kind: claim.kind,
            status: "completed",
            processedCount: autoRun.attempted + reports.generated,
            metrics: { autoRun, reports },
            triggerSource: "scheduler",
            scheduledFor: new Date(claim.scheduledFor),
            startedAt,
            trace,
          });
          this.log?.("teammates.auto_run", { ...autoRun, ...reports });
        }
        return;
      }
      default:
        claim.kind satisfies never;
        throw new Error(`unsupported maintenance kind: ${claim.kind}`);
    }
  }
}
