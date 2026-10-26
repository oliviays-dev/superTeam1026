import type { PlatformApplication } from "@pluginmax/application";
import type { PlatformRepositories } from "@pluginmax/database";
import { describe, expect, it, vi } from "vitest";
import { RuntimeMaintenanceService } from "./maintenance-service.js";

function service(input: {
  readonly claims: Awaited<
    ReturnType<
      PlatformRepositories["runtimeReliability"]["claimDueMaintenance"]
    >
  >;
  readonly rejection?: Error;
}) {
  const complete = vi.fn(async () => true);
  const fail = vi.fn(async () => true);
  const repositories = {
    runtimeReliability: {
      claimDueMaintenance: vi.fn(async () => input.claims),
      completeMaintenanceClaim: complete,
      failMaintenanceClaim: fail,
      cleanupIdempotencyReceipts: vi.fn(async () => ({
        processedCount: 0,
        archivedCount: 0,
        deletedCount: 0,
        cutoff: new Date().toISOString(),
        maintenanceId: null,
      })),
      recordMaintenance: vi.fn(async () => ({})),
    },
    runtimeEffects: {
      reconcileExpired: vi.fn(async () => ({ cancelled: 0, failed: 0 })),
    },
  } as unknown as PlatformRepositories;
  const sweepApprovalSla = vi.fn(async () => {
    if (input.rejection !== undefined) throw input.rejection;
    return {
      reminded: 0,
      escalated: 0,
      expired: 0,
      affectedInstances: 0,
    };
  });
  const application = { sweepApprovalSla } as unknown as PlatformApplication;
  return {
    maintenance: new RuntimeMaintenanceService(repositories, application, {
      owner: "worker-test",
      claimLeaseSeconds: 30,
      approvalSlaBatchSize: 100,
      recoveryBatchSize: 20,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 100,
      idempotencyRetentionSeconds: 3_600,
      idempotencyCleanupBatchSize: 50,
    }),
    complete,
    fail,
    sweepApprovalSla,
  };
}

describe("RuntimeMaintenanceService", () => {
  it("executes a due approval SLA schedule under its database lease", async () => {
    const scheduledFor = new Date(Date.now() - 1_000).toISOString();
    const { maintenance, complete, fail, sweepApprovalSla } = service({
      claims: [
        {
          kind: "approval_sla",
          leaseToken: "00000000-0000-4000-8000-000000000001",
          scheduledFor,
          intervalSeconds: 60,
          consecutiveFailures: 0,
        },
      ],
    });
    await expect(maintenance.runOnce()).resolves.toBe(1);
    expect(sweepApprovalSla).toHaveBeenCalledWith("worker-test", 100, {
      triggerSource: "scheduler",
      scheduledFor: new Date(scheduledFor),
    });
    expect(complete).toHaveBeenCalledWith(
      "approval_sla",
      "worker-test",
      "00000000-0000-4000-8000-000000000001",
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it("releases a failed schedule with backoff instead of dropping it", async () => {
    const { maintenance, complete, fail } = service({
      claims: [
        {
          kind: "approval_sla",
          leaseToken: "00000000-0000-4000-8000-000000000002",
          scheduledFor: new Date().toISOString(),
          intervalSeconds: 60,
          consecutiveFailures: 2,
        },
      ],
      rejection: new Error("approval store unavailable"),
    });
    await maintenance.runOnce();
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      "approval_sla",
      "worker-test",
      "00000000-0000-4000-8000-000000000002",
      "approval store unavailable",
    );
  });
});
