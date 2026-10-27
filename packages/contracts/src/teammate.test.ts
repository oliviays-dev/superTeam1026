import { describe, expect, it } from "vitest";
import {
  addRuntimeUsageSummaries,
  createTeammateTemplateInputSchema,
  createTeammateWorkPlanInputSchema,
  parsedTeammateWorkPlanSchema,
} from "./teammate.js";

describe("AI Teammate contracts", () => {
  it("requires a scoped template definition", () => {
    const parsed = createTeammateTemplateInputSchema.parse({
      projectId: "00000000-0000-4000-8000-000000000001",
      scope: "personal",
      definition: {
        name: "Research partner",
        tools: ["search"],
      },
    });
    expect(parsed.definition).toMatchObject({
      name: "Research partner",
      role: "",
      scenarios: [],
      tools: ["search"],
    });
    expect(
      parsedTeammateWorkPlanSchema.safeParse({
        instruction: "one",
        summary: "one task",
        items: [],
        restricted: {
          assignee: "teammate",
          projectId: "00000000-0000-4000-8000-000000000001",
          autoAccept: false,
          maxItems: 20,
        },
      }).success,
    ).toBe(false);
  });

  it("caps generated work plans at twenty tasks", () => {
    const item = {
      title: "Task",
      description: "Do the work",
      acceptance: ["Verified"],
      priority: "medium" as const,
    };
    expect(
      createTeammateWorkPlanInputSchema.safeParse({
        instruction: "bulk",
        items: Array.from({ length: 21 }, () => item),
      }).success,
    ).toBe(false);
  });

  it("sums known usage without converting unknown samples into zero cost", () => {
    const base = {
      sampleCount: 1,
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      costAmount: 0.25,
      costCurrencies: ["USD"],
      unknownSampleCount: 0,
      unknownFields: ["model"],
    };
    const merged = addRuntimeUsageSummaries(base, {
      ...base,
      inputTokens: 20,
      outputTokens: 8,
      totalTokens: 28,
      costCurrencies: ["USD", "CNY"],
      unknownSampleCount: 1,
      unknownFields: ["costAmount"],
    });
    expect(merged).toMatchObject({
      sampleCount: 2,
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      costAmount: 0.5,
      costCurrencies: ["CNY", "USD"],
      unknownSampleCount: 1,
    });
    expect(merged.unknownFields).toEqual(["costAmount", "model"]);
  });
});
