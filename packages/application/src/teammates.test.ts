import { describe, expect, it } from "vitest";
import type { Teammate } from "@pluginmax/contracts";
import { parseTeammateWorkPlan, weekRange } from "./teammates.js";

const teammate: Teammate = {
  id: "00000000-0000-4000-8000-000000000100",
  projectId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000001",
  templateId: "00000000-0000-4000-8000-000000000101",
  templateVersionId: "00000000-0000-4000-8000-000000000102",
  templateVersion: 1,
  agent: {
    id: "00000000-0000-4000-8000-000000000103",
    name: "Research agent",
    description: "",
    soul: "",
    scenarios: [],
    goals: [],
    tools: [],
    runtimeKind: "fake",
    status: "active",
    source: "personal",
    ownerId: "owner",
    principalId: "principal-ai",
    version: 1,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  },
  aiPrincipalId: "principal-ai",
  ownerPrincipalId: "owner",
  name: "Researcher",
  status: "active",
  version: 1,
  autoExecute: true,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};

describe("AI Teammate work plans", () => {
  it("parses deterministic restricted tasks with priority and due date", () => {
    const plan = parseTeammateWorkPlan({
      teammate,
      instruction: "请明天 P1 整理竞品证据\nP2 输出对比表",
      now: new Date("2026-10-27T08:00:00.000Z"),
    });
    expect(plan.restricted).toEqual({
      assignee: "teammate",
      projectId: teammate.projectId,
      autoAccept: false,
      maxItems: 20,
    });
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]).toMatchObject({
      title: "明天 整理竞品证据",
      priority: "high",
      due: "2026-10-28",
    });
    expect(plan.items[1]).toMatchObject({
      title: "输出对比表",
      priority: "medium",
    });
  });

  it("normalizes weekly ranges to Monday through Sunday", () => {
    const range = weekRange("2026-10-28");
    expect(range.startText).toBe("2026-10-26");
    expect(range.endText).toBe("2026-11-01");
    expect(range.endExclusive.toISOString()).toBe("2026-11-02T00:00:00.000Z");
  });
});
