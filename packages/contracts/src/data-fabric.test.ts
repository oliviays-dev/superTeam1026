import { describe, expect, it } from "vitest";
import {
  createDataAgentConversationInputSchema,
  createDataPolicyInputSchema,
  executeDataQueryInputSchema,
} from "./data-fabric.js";

describe("Data Fabric contracts", () => {
  it("rejects model-reported identity and arbitrary SQL", () => {
    expect(
      createDataAgentConversationInputSchema.safeParse({
        runId: "00000000-0000-4000-8000-000000000001",
        projectId: "00000000-0000-4000-8000-000000000002",
        userId: "forged",
      }).success,
    ).toBe(false);

    expect(
      executeDataQueryInputSchema.safeParse({
        mode: "dataset",
        datasetId: "00000000-0000-4000-8000-000000000003",
        sql: "select * from secrets",
      }).success,
    ).toBe(false);
    expect(
      executeDataQueryInputSchema.safeParse({
        mode: "dataset",
        datasetIds: [
          "00000000-0000-4000-8000-000000000003",
          "00000000-0000-4000-8000-000000000004",
        ],
      }).success,
    ).toBe(false);
  });

  it("requires a metric for metric mode and a dataset for other modes", () => {
    expect(
      executeDataQueryInputSchema.safeParse({ mode: "metric" }).success,
    ).toBe(false);
    expect(
      executeDataQueryInputSchema.safeParse({ mode: "dataset" }).success,
    ).toBe(false);
    expect(
      executeDataQueryInputSchema.safeParse({
        mode: "metric",
        metricId: "00000000-0000-4000-8000-000000000004",
      }).success,
    ).toBe(true);
  });

  it("rejects contradictory column policies", () => {
    const result = createDataPolicyInputSchema.safeParse({
      scopeType: "project",
      scopeId: "00000000-0000-4000-8000-000000000005",
      content: {
        rowFilters: [],
        allowedColumns: ["tenant_id"],
        deniedColumns: ["tenant_id"],
        maxRows: 10,
        timeoutMs: 1000,
      },
    });
    expect(result.success).toBe(false);
  });
});
