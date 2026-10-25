import { describe, expect, it } from "vitest";
import {
  computeAwayWindow,
  localDayStamp,
  mergeBriefItems,
  priorityScore,
  type BriefCandidate,
} from "./brief.js";
import {
  briefItemKey,
  followKey,
  type BriefItemRecord,
  type BriefReader,
  type FollowRecord,
  type MetricsPreference,
} from "./models.js";
import { BriefPushHub, diffBriefItems, type BriefModuleData } from "./push.js";
import {
  WorkbenchService,
  priorityLabel,
  workflowDisplayId,
  type WorkbenchDeps,
} from "./service.js";

function memoryTable<V>() {
  const values = new Map<string, V>();
  return {
    get: (key: string) => values.get(key),
    entries: () => values.entries(),
    async put(key: string, value: V) {
      values.set(key, value);
    },
    async delete(key: string) {
      return values.delete(key);
    },
  };
}

function tables() {
  return {
    follows: memoryTable<FollowRecord>(),
    metrics: memoryTable<MetricsPreference>(),
    briefItems: memoryTable<BriefItemRecord>(),
    briefReaders: memoryTable<BriefReader>(),
  };
}

const principal = { userId: "olivia", name: "Olivia", role: "member" as const };
const tzOffsetMinutes = 480;
const now = new Date("2026-10-09T02:00:00.000Z");
const nowIso = now.toISOString();

function candidate(
  overrides: Partial<BriefCandidate> & { itemId: string },
): BriefCandidate {
  return {
    section: "risk",
    tag: "data",
    title: "A-2200 供给缺口",
    conclusion: "覆盖天数降到 4.2 天",
    reason: "入选原因：Agent Run 已失败。",
    executorName: "Peter",
    executorRole: "计划员",
    sourceDomain: "agent-run",
    sourceId: overrides.itemId,
    statusLabel: "执行失败",
    actionLabel: "查看详情",
    priorityScore: 8,
    occurredAt: nowIso,
    deepLink: { route: "task", refId: "TSK-1", label: "" },
    workspaceId: "ws-1",
    workspaceName: "供应链",
    condition: { kind: "run-terminal", refId: "run-1" },
    ...overrides,
  };
}

function priorRecord(
  overrides: Partial<BriefItemRecord> & { itemId: string },
): BriefItemRecord {
  return {
    readerId: principal.userId,
    section: "risk",
    tag: "data",
    title: "旧条目",
    conclusion: "旧结论",
    reason: "",
    executorName: "",
    executorRole: "",
    sourceDomain: "agent-run",
    sourceId: overrides.itemId,
    statusLabel: "",
    actionLabel: "查看详情",
    readState: "unread",
    priorityScore: 8,
    occurredAt: "2026-10-01T02:00:00.000Z",
    deepLink: { route: "task", refId: "TSK-1", label: "" },
    workspaceId: "ws-1",
    workspaceName: "供应链",
    condition: { kind: "run-terminal", refId: "run-1" },
    resolved: false,
    createdAt: "2026-10-01T02:00:00.000Z",
    updatedAt: "2026-10-01T02:00:00.000Z",
    ...overrides,
  };
}

describe("computeAwayWindow", () => {
  it("caps the lookback at 24 hours", () => {
    const window = computeAwayWindow({
      lastMergeAt: "2026-10-01T00:00:00.000Z",
      now,
      tzOffsetMinutes,
    });
    expect(window.truncatedTo24h).toBe(true);
    expect(Date.parse(window.to) - Date.parse(window.from)).toBe(
      24 * 3_600_000,
    );
  });

  it("falls back to local yesterday 18:00 for new readers", () => {
    const window = computeAwayWindow({
      now,
      tzOffsetMinutes,
    });
    // 2026-10-09 02:00 UTC = 10-09 10:00 +08:00; fallback = 10-08 18:00 +08:00.
    expect(window.from).toBe("2026-10-08T10:00:00.000Z");
    expect(localDayStamp(window.from, tzOffsetMinutes)).toBe("2026-10-08");
  });

  it("prefers the last merge time over the last seen time", () => {
    const window = computeAwayWindow({
      lastMergeAt: "2026-10-09T00:00:00.000Z",
      lastSeenAt: "2026-10-08T00:00:00.000Z",
      now,
      tzOffsetMinutes,
    });
    expect(window.from).toBe("2026-10-09T00:00:00.000Z");
    expect(window.truncatedTo24h).toBe(false);
  });

  it("uses a manual window before automatic fallbacks", () => {
    const window = computeAwayWindow({
      lastMergeAt: "2026-10-09T00:00:00.000Z",
      manualFrom: "2026-10-09T01:00:00.000Z",
      now,
      tzOffsetMinutes,
    });
    expect(window.from).toBe("2026-10-09T01:00:00.000Z");
    expect(window.truncatedTo24h).toBe(false);
  });
});

describe("mergeBriefItems", () => {
  it("keeps unread risk items across merges", () => {
    const existing = [priorRecord({ itemId: "A:run:run-1" })];
    const result = mergeBriefItems({
      readerId: principal.userId,
      existing,
      candidates: [],
      liveState: new Map([["A:run:run-1", { active: true, resolved: false }]]),
      now,
      tzOffsetMinutes,
    });
    expect(result.unread).toHaveLength(1);
    expect(result.removed).toEqual([]);
  });

  it("marks risk items read when the downstream run recovers, keeping them for the day", () => {
    const existing = [priorRecord({ itemId: "A:run:run-1" })];
    const result = mergeBriefItems({
      readerId: principal.userId,
      existing,
      candidates: [],
      liveState: new Map([["A:run:run-1", { active: false, resolved: true }]]),
      now,
      tzOffsetMinutes,
    });
    expect(result.unread).toHaveLength(0);
    expect(result.all).toHaveLength(1);
    expect(result.all[0]?.readVia).toBe("downstream_action");
    expect(result.markedRead).toEqual(["A:run:run-1"]);
  });

  it("drops escalation items once their condition disappears", () => {
    const existing = [
      priorRecord({
        itemId: "B:task:TSK-1",
        section: "escalation",
        tag: "decision",
        condition: { kind: "task-escalation", refId: "TSK-1" },
      }),
    ];
    const result = mergeBriefItems({
      readerId: principal.userId,
      existing,
      candidates: [],
      liveState: new Map([
        ["B:task:TSK-1", { active: false, resolved: false }],
      ]),
      now,
      tzOffsetMinutes,
    });
    expect(result.stored).toHaveLength(0);
    expect(result.removed).toEqual(["B:task:TSK-1"]);
  });

  it("removes read conclusions immediately and keeps them when downstream handled them today", () => {
    const readConclusion = priorRecord({
      itemId: "C:run:run-2",
      section: "conclusion",
      tag: "conclusion",
      readState: "read",
      readAt: "2026-10-01T02:00:00.000Z",
      readVia: "click",
      condition: { kind: "task-review", refId: "TSK-2", auxId: "run-2" },
    });
    const dropped = mergeBriefItems({
      readerId: principal.userId,
      existing: [readConclusion],
      candidates: [],
      liveState: new Map([["C:run:run-2", { active: true, resolved: false }]]),
      now,
      tzOffsetMinutes,
    });
    expect(dropped.stored).toHaveLength(0);

    const handled = mergeBriefItems({
      readerId: principal.userId,
      existing: [
        priorRecord({
          itemId: "C:run:run-3",
          section: "conclusion",
          tag: "conclusion",
          condition: { kind: "task-review", refId: "TSK-3", auxId: "run-3" },
        }),
      ],
      candidates: [],
      liveState: new Map([["C:run:run-3", { active: false, resolved: true }]]),
      now,
      tzOffsetMinutes,
    });
    expect(handled.all).toHaveLength(1);
    expect(handled.all[0]?.readVia).toBe("downstream_action");
  });

  it("sorts unread items before read ones and by priority score", () => {
    const low = priorRecord({
      itemId: "B:task:TSK-9",
      section: "escalation",
      tag: "decision",
      priorityScore: 7,
      readState: "read",
      readAt: nowIso,
      readVia: "click",
      condition: { kind: "task-escalation", refId: "TSK-9" },
    });
    const result = mergeBriefItems({
      readerId: principal.userId,
      existing: [low],
      candidates: [
        candidate({ itemId: "A:run:a", priorityScore: 8 }),
        candidate({ itemId: "A:run:b", priorityScore: 9 }),
      ],
      liveState: new Map([["B:task:TSK-9", { active: true, resolved: false }]]),
      now,
      tzOffsetMinutes,
    });
    expect(result.all.map((item) => item.itemId)).toEqual([
      "A:run:b",
      "A:run:a",
      "B:task:TSK-9",
    ]);
    expect(result.unreadCount).toBe(2);
  });

  it("keeps updatedAt stable when a candidate's content has not changed", () => {
    const first = mergeBriefItems({
      readerId: principal.userId,
      existing: [],
      candidates: [candidate({ itemId: "A:task:TSK-9" })],
      liveState: new Map(),
      now,
      tzOffsetMinutes,
    });
    const second = mergeBriefItems({
      readerId: principal.userId,
      existing: first.stored,
      candidates: [candidate({ itemId: "A:task:TSK-9" })],
      liveState: new Map(),
      now: new Date(now.getTime() + 60_000),
      tzOffsetMinutes,
    });
    expect(second.stored[0]?.updatedAt).toBe(first.stored[0]?.updatedAt);
    expect(diffBriefItems(first.stored, second.stored)).toMatchObject({
      added: [],
      updated: [],
      removed: [],
    });
  });
});

describe("priorityScore", () => {
  it("adds at most two points for overdue tasks", () => {
    expect(priorityScore.overdue(0)).toBe(9);
    expect(priorityScore.overdue(24 * 3_600_000)).toBe(10);
    expect(priorityScore.overdue(72 * 3_600_000)).toBe(11);
  });
});

describe("priorityLabel", () => {
  it("shifts stored P1–P3 to the product P0–P2 vocabulary", () => {
    expect(priorityLabel("P1")).toBe("P0");
    expect(priorityLabel("P2")).toBe("P1");
    expect(priorityLabel("P3")).toBe("P2");
    expect(priorityLabel("P0")).toBe("P0");
  });
});

describe("diffBriefItems", () => {
  it("reports added, updated and removed items with the unread count", () => {
    const base = [
      priorRecord({ itemId: "A:run:1" }),
      priorRecord({ itemId: "A:run:2" }),
    ];
    const next = [
      priorRecord({
        itemId: "A:run:2",
        updatedAt: "2026-10-09T03:00:00.000Z",
      }),
      priorRecord({ itemId: "A:run:3" }),
    ];
    const diff = diffBriefItems(base, next);
    expect(diff.added).toEqual(["A:run:3"]);
    expect(diff.updated).toEqual(["A:run:2"]);
    expect(diff.removed).toEqual(["A:run:1"]);
    expect(diff.unreadCount).toBe(2);
  });
});

describe("BriefPushHub", () => {
  it("pushes a diff frame only when the merged brief changes", async () => {
    interface PushFrame {
      type?: string;
      diff?: { added: string[] };
    }
    const frames: PushFrame[] = [];
    let items = [priorRecord({ itemId: "A:run:1" })];
    const payload = (): {
      id: "brief";
      title: string;
      updatedAt: string;
      refreshable: boolean;
      data: BriefModuleData;
    } => ({
      id: "brief",
      title: "每日简报",
      updatedAt: new Date().toISOString(),
      refreshable: true,
      data: {
        awayWindow: {
          from: "2026-10-08T10:00:00.000Z",
          to: "2026-10-09T02:00:00.000Z",
          truncatedTo24h: false,
        },
        unreadCount: items.length,
        summary: "",
        views: { unread: items, all: items },
      },
    });
    const hub = new BriefPushHub({
      debounceMs: 1,
      computeBrief: async () => payload(),
    });
    const unregister = hub.register({
      principal,
      tzOffsetMinutes,
      send: (frame) => frames.push(frame as PushFrame),
      close: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(frames[0]?.type).toBe("sync");

    hub.notify();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frames).toHaveLength(1);

    items = [
      priorRecord({ itemId: "A:run:1" }),
      priorRecord({ itemId: "A:run:2" }),
    ];
    hub.notify();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frames).toHaveLength(2);
    expect(frames[1]?.type).toBe("brief");
    expect(frames[1]?.diff?.added).toEqual(["A:run:2"]);

    unregister();
    hub.dispose();
  });
});

describe("WorkbenchService", () => {
  function serviceWith(overrides: WorkbenchDeps = {}) {
    return new WorkbenchService(tables(), {
      now: () => now,
      workspaces: () => ({
        list: () => [{ id: "ws-1", path: "/tmp/supply", title: "供应链" }],
      }),
      team: () => ({
        users: () => [{ id: "olivia", name: "Olivia" }],
        members: () => [{ userId: "olivia", role: "owner" }],
        resolveToken: () => ({ userId: "olivia", role: "member" as const }),
      }),
      ...overrides,
    });
  }

  it("toggles task and workflow follows per user", async () => {
    const service = serviceWith();
    await expect(
      service.toggleFollow(principal, { type: "task", targetId: "TSK-1" }),
    ).resolves.toEqual({ followed: true });
    expect(service.follows(principal)).toHaveLength(1);
    await expect(
      service.toggleFollow(principal, { type: "task", targetId: "TSK-1" }),
    ).resolves.toEqual({ followed: false });
    expect(service.follows(principal)).toHaveLength(0);
    expect(followKey("olivia", "task", "TSK-1")).toContain("TSK-1");
  });

  it("lists followed meetings in the focus module", async () => {
    // 会议纪要卡片上的星标写的是 type=meeting；重点关注必须能读回来，
    // 否则「关注会议纪要 → 刷新重点关注」永远是空的。
    const meeting = {
      id: "MTG-1",
      workspaceId: "ws-1",
      title: "供应商切换评审",
      status: "closed",
      agenda: "",
      summary: "散会摘要：先小批量切换，保留回滚预案。",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const service = serviceWith({
      meetings: () => ({
        list: (workspaceId: string) => (workspaceId === "ws-1" ? [meeting] : []),
        participants: () => [
          {
            kind: "human" as const,
            refId: "olivia",
            displayName: "Olivia",
            status: "active",
            leader: true,
          },
        ],
      }),
    });
    await service.toggleFollow(principal, {
      type: "meeting",
      targetId: "MTG-1",
    });
    const items = service.focusModule(principal).data?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("meeting");
    expect(items[0]?.id).toBe("MTG-1");
    expect(items[0]?.title).toBe("供应商切换评审");
    expect(items[0]?.displayId).toBe("会议");
    expect(items[0]?.statusLabel).toBe("已散会");
    expect(items[0]?.receiverName).toBe("Olivia");
    expect(items[0]?.summary).toContain("小批量切换");
    expect(items[0]?.coveredBy).toEqual([{ type: "meeting", id: "MTG-1" }]);
    expect(items[0]?.deepLink).toEqual({
      route: "meeting",
      refId: "MTG-1",
      workspaceId: "ws-1",
    });

    // 取消关注后不再出现在重点关注。
    await service.toggleFollow(principal, {
      type: "meeting",
      targetId: "MTG-1",
    });
    expect(service.focusModule(principal).data?.items).toHaveLength(0);
  });

  it("sorts todos by priority, due date and id", () => {
    const tasks = [
      {
        id: "TSK-2",
        workspaceId: "ws-1",
        title: "P2 任务",
        type: "任务",
        status: "todo" as const,
        priority: "P2" as const,
        receiverType: "human" as const,
        receiverId: "olivia",
        receiverName: "Olivia",
        description: "",
        acceptance: ["a"],
        agentRunIds: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
      {
        id: "TSK-1",
        workspaceId: "ws-1",
        title: "P1 逾期任务",
        type: "任务",
        status: "review" as const,
        priority: "P1" as const,
        receiverType: "human" as const,
        receiverId: "olivia",
        receiverName: "Olivia",
        due: "2026-10-08",
        description: "",
        acceptance: ["a"],
        agentRunIds: [],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ];
    const service = serviceWith({
      tasks: () => ({
        list: () => tasks,
        get: (taskId: string) => {
          const task = tasks.find((item) => item.id === taskId);
          if (task === undefined) throw new Error("not found");
          return task;
        },
      }),
    });
    const module = service.todoModule(principal);
    expect((module.data?.items ?? []).map((item) => item.id)).toEqual([
      "TSK-1",
      "TSK-2",
    ]);
  });

  it("counts tasks assigned to my AI Teammate instances, in both id forms", () => {
    const task = (
      id: string,
      receiverId: string,
      priority: "P1" | "P2",
      status: "todo" | "review",
    ) => ({
      id,
      workspaceId: "ws-1",
      title: id,
      type: "任务",
      status,
      priority,
      receiverType: "agent" as const,
      receiverId,
      receiverName: "Research Agent",
      description: "",
      acceptance: ["a"],
      agentRunIds: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    const tasks = [
      // 新形态：责任人 = teammate 实例 id
      task("TSK-A", "tm-1", "P1", "todo"),
      // 历史形态：责任人 = 同一实例的员工身份 id
      task("TSK-B", "emp-1", "P2", "review"),
      // 别人的实例
      task("TSK-C", "tm-9", "P2", "todo"),
    ];
    const service = serviceWith({
      tasks: () => ({
        list: () => tasks,
        get: (taskId: string) => {
          const found = tasks.find((item) => item.id === taskId);
          if (found === undefined) throw new Error("not found");
          return found;
        },
      }),
      teammates: () => ({
        list: () => [
          { id: "tm-1", ownerUserId: "olivia", employeeId: "emp-1" },
          { id: "tm-9", ownerUserId: "peter", employeeId: "emp-9" },
        ],
      }),
    });
    const module = service.todoModule(principal);
    expect((module.data?.items ?? []).map((item) => item.id)).toEqual([
      "TSK-A",
      "TSK-B",
    ]);
  });

  it("rejects an empty metrics selection and persists at most five", async () => {
    const service = serviceWith();
    await expect(service.setMetrics(principal, [])).rejects.toThrow();
    const selected = await service.setMetrics(principal, [
      "otif",
      "otif",
      "supply-risk",
      "inventory-turn",
      "supplier-otd",
      "price-achievement",
    ]);
    expect(selected).toEqual([
      "otif",
      "supply-risk",
      "inventory-turn",
      "supplier-otd",
      "price-achievement",
    ]);
    expect(service.metricsModule(principal).data?.selected).toEqual(selected);
  });

  it("brings a nudged task into the receiver's brief", async () => {
    const tasks = [
      {
        id: "TSK-NUDGE",
        workspaceId: "ws-1",
        title: "等我这周给出报价",
        type: "任务",
        status: "todo" as const,
        priority: "P3" as const,
        receiverType: "human" as const,
        receiverId: "olivia",
        receiverName: "Olivia",
        description: "",
        acceptance: ["a"],
        agentRunIds: [],
        createdAt: nowIso,
        updatedAt: "2026-10-09T01:30:00.000Z",
        // 派出方刚催过：这条任务要出现在「被催办的人」的简报里。
        events: [
          {
            id: "event-nudge",
            at: "2026-10-09T01:30:00.000Z",
            actorId: "admin",
            actorName: "平台Admin",
            kind: "nudge",
            message: "平台Admin 发送了催办提醒",
          },
        ],
      },
    ];
    const service = serviceWith({
      tasks: () => ({
        list: () => tasks,
        get: (taskId: string) => {
          const task = tasks.find((item) => item.id === taskId);
          if (task === undefined) throw new Error("not found");
          return task;
        },
      }),
    });
    const module = await service.briefModule(principal, { tzOffsetMinutes });
    const item = (module.data?.views.unread ?? []).find(
      (candidate) => candidate.itemId === "B:task:TSK-NUDGE",
    );
    expect(item, "被催办的任务应出现在被催办人的简报里").toBeDefined();
    expect(item?.reason ?? "").toContain("催办");
    expect(item?.escalateReason ?? "").toContain("催办");
    // 标签要一眼看出是催办，而不是笼统的「待决策」。
    expect(item?.tag).toBe("nudge");
    expect(item?.section).toBe("escalation");
  });

  it("keeps the 待决策 tag when an overdue task was also nudged", async () => {
    const tasks = [
      {
        id: "TSK-NUDGE-OVERDUE",
        workspaceId: "ws-1",
        title: "已经逾期的报价",
        type: "任务",
        status: "todo" as const,
        priority: "P2" as const,
        receiverType: "human" as const,
        receiverId: "olivia",
        receiverName: "Olivia",
        description: "",
        acceptance: ["a"],
        agentRunIds: [],
        due: "2026-10-01",
        createdAt: nowIso,
        updatedAt: "2026-10-09T01:30:00.000Z",
        events: [
          {
            id: "event-nudge",
            at: "2026-10-09T01:30:00.000Z",
            actorId: "admin",
            actorName: "平台Admin",
            kind: "nudge",
            message: "平台Admin 发送了催办提醒",
          },
        ],
      },
    ];
    const service = serviceWith({
      tasks: () => ({
        list: () => tasks,
        get: (taskId: string) => {
          const task = tasks.find((item) => item.id === taskId);
          if (task === undefined) throw new Error("not found");
          return task;
        },
      }),
    });
    const module = await service.briefModule(principal, { tzOffsetMinutes });
    const item = (module.data?.views.unread ?? []).find(
      (candidate) => candidate.itemId === "B:task:TSK-NUDGE-OVERDUE",
    );
    expect(item).toBeDefined();
    // 逾期规则先命中：标签仍是「待决策」，只有纯催办才换「被催办」。
    expect(item?.tag).toBe("decision");
    expect(item?.escalateReason ?? "").toContain("已逾期");
  });

  it("merges a night conclusion when a reviewed deliverable came from an authorized run", async () => {
    const runs = [
      {
        id: "run-1",
        workspaceId: "ws-1",
        agentProfileId: "profile-1",
        employeeId: "emp-1",
        principalType: "digital-employee" as const,
        source: "task" as const,
        instanceId: "TSK-1",
        nodeId: "node-1",
        status: "succeeded" as const,
        output: { summary: "替代供应商交付周期核实完成：12 天。" },
        endedAt: "2026-10-09T01:00:00.000Z",
        createdAt: "2026-10-09T00:00:00.000Z",
        updatedAt: "2026-10-09T01:00:00.000Z",
      },
    ];
    const tasks = [
      {
        id: "TSK-1",
        workspaceId: "ws-1",
        title: "确认替代供应商交付周期",
        type: "任务",
        status: "review" as const,
        priority: "P2" as const,
        receiverType: "agent" as const,
        receiverId: "emp-1",
        receiverName: "采购数字同事",
        description: "",
        acceptance: ["a"],
        agentRunIds: ["run-1"],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ];
    const service = serviceWith({
      tasks: () => ({
        list: () => tasks,
        get: (taskId: string) => {
          const task = tasks.find((item) => item.id === taskId);
          if (task === undefined) throw new Error("not found");
          return task;
        },
      }),
      agents: () => ({
        runs: () => runs,
        profile: () => ({ id: "profile-1", name: "采购执行 Profile" }),
      }),
      employees: () => ({
        list: () => [
          {
            id: "emp-1",
            kind: "digital" as const,
            displayName: "采购数字同事",
            authUserId: "olivia",
          },
        ],
        getByAuthUserId: () => ({
          id: "emp-human",
          kind: "human" as const,
          displayName: "Olivia",
          authUserId: "olivia",
        }),
        get: () => ({
          id: "emp-1",
          kind: "digital" as const,
          displayName: "采购数字同事",
          authUserId: "olivia",
        }),
        activeProfile: () => ({ name: "采购执行 Profile" }),
      }),
    });
    const module = await service.briefModule(principal, { tzOffsetMinutes });
    const items = module.data?.views.unread ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.section).toBe("conclusion");
    // 待验收条目标签固定「待我验收」，不再按结论文本猜进展/结论。
    expect(items[0]?.tag).toBe("review");
    expect(items[0]?.actionLabel).toBe("前往验收");
    expect(items[0]?.statusLabel).toBe("待我验收");
    // 条目必须说明「为什么出现在简报里」
    expect(items[0]?.reason).toContain("待验收");
    expect(items[0]?.reason).toContain("你是它的责任人");
    expect(items[0]?.deepLink.refId).toBe("TSK-1");
    expect(briefItemKey(principal.userId, items[0]?.itemId ?? "")).toContain(
      "C:task:TSK-1",
    );

    // 点击条目落地 → 已读 → 下一条目不再出现在未读视图
    await service.markBriefRead(principal, items[0]?.itemId ?? "", {
      tzOffsetMinutes,
    });
    const afterRead = await service.briefModule(principal, {
      tzOffsetMinutes,
    });
    expect(afterRead.data?.views.unread).toHaveLength(0);
    expect(afterRead.data?.views.all).toHaveLength(0);
  });

  it("keeps one pending-review entry per task even after the task is re-run", async () => {
    // 同一任务重跑会再产生一次成功的 run。条目身份若按 run 记，
    // 待验收会出现两条重复条目，验收一次会让未读数连着掉两条。
    const runs = [
      {
        id: "run-old",
        workspaceId: "ws-1",
        agentProfileId: "profile-1",
        employeeId: "emp-1",
        principalType: "digital-employee" as const,
        source: "task" as const,
        instanceId: "TSK-1",
        nodeId: "node-1",
        status: "succeeded" as const,
        output: { summary: "第一次交付已完成，等待验收。" },
        endedAt: "2026-10-09T01:00:00.000Z",
        createdAt: "2026-10-09T00:00:00.000Z",
        updatedAt: "2026-10-09T01:00:00.000Z",
      },
    ];
    const tasks = [
      {
        id: "TSK-1",
        workspaceId: "ws-1",
        title: "确认替代供应商交付周期",
        type: "任务",
        status: "review" as const,
        priority: "P2" as const,
        receiverType: "agent" as const,
        receiverId: "emp-1",
        receiverName: "采购数字同事",
        description: "",
        acceptance: ["a"],
        agentRunIds: ["run-old"],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ];
    const service = serviceWith({
      tasks: () => ({
        list: () => tasks,
        get: (taskId: string) => {
          const task = tasks.find((item) => item.id === taskId);
          if (task === undefined) throw new Error("not found");
          return task;
        },
      }),
      agents: () => ({
        runs: () => runs,
        profile: () => ({ id: "profile-1", name: "采购执行 Profile" }),
      }),
      employees: () => ({
        list: () => [
          {
            id: "emp-1",
            kind: "digital" as const,
            displayName: "采购数字同事",
            authUserId: "olivia",
          },
        ],
        getByAuthUserId: () => ({
          id: "emp-human",
          kind: "human" as const,
          displayName: "Olivia",
          authUserId: "olivia",
        }),
        get: () => ({
          id: "emp-1",
          kind: "digital" as const,
          displayName: "采购数字同事",
          authUserId: "olivia",
        }),
        activeProfile: () => ({ name: "采购执行 Profile" }),
      }),
    });
    const first = await service.briefModule(principal, { tzOffsetMinutes });
    expect(first.data?.views.unread).toHaveLength(1);

    // 任务重跑一次：追加一条新的成功 run，并把它挂到同一个任务上。
    runs.push({
      id: "run-new",
      workspaceId: "ws-1",
      agentProfileId: "profile-1",
      employeeId: "emp-1",
      principalType: "digital-employee" as const,
      source: "task" as const,
      instanceId: "TSK-1",
      nodeId: "node-1",
      status: "succeeded" as const,
      output: { summary: "重跑后交付已完成并补齐证据，等待验收。" },
      endedAt: "2026-10-09T01:30:00.000Z",
      createdAt: "2026-10-09T01:20:00.000Z",
      updatedAt: "2026-10-09T01:30:00.000Z",
    });
    tasks[0]!.agentRunIds = ["run-old", "run-new"];

    const second = await service.briefModule(principal, { tzOffsetMinutes });
    const items = second.data?.views.unread ?? [];
    // 旧实现按 run 记身份，这里会同时出现 run-old / run-new 两条。
    expect(items).toHaveLength(1);
    expect(items[0]?.itemId).toBe("C:task:TSK-1");
    expect(items[0]?.conclusion).toContain("重跑后");
  });

  it("labels every pending-review conclusion as 待我验收 regardless of wording", async () => {
    // 旧逻辑按结论文本里的「完成 / 已同步」等字样区分进展与结论，
    // 于是「…核实完成」会被标成「进展」，右边却挂「前往验收」，标签与按钮打架。
    const summaries = [
      "替代供应商交付周期核实完成：12 天。",
      "交付物已就绪，等待责任人确认。",
    ];
    for (const summary of summaries) {
      const runs = [
        {
          id: "run-1",
          workspaceId: "ws-1",
          agentProfileId: "profile-1",
          employeeId: "emp-1",
          principalType: "digital-employee" as const,
          source: "task" as const,
          instanceId: "TSK-1",
          nodeId: "node-1",
          status: "succeeded" as const,
          output: { summary },
          endedAt: "2026-10-09T01:00:00.000Z",
          createdAt: "2026-10-09T00:00:00.000Z",
          updatedAt: "2026-10-09T01:00:00.000Z",
        },
      ];
      const tasks = [
        {
          id: "TSK-1",
          workspaceId: "ws-1",
          title: "确认替代供应商交付周期",
          type: "任务",
          status: "review" as const,
          priority: "P2" as const,
          receiverType: "agent" as const,
          receiverId: "emp-1",
          receiverName: "采购数字同事",
          description: "",
          acceptance: ["a"],
          agentRunIds: ["run-1"],
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      ];
      const service = serviceWith({
        tasks: () => ({
          list: () => tasks,
          get: (taskId: string) => {
            const task = tasks.find((item) => item.id === taskId);
            if (task === undefined) throw new Error("not found");
            return task;
          },
        }),
        agents: () => ({
          runs: () => runs,
          profile: () => ({ id: "profile-1", name: "采购执行 Profile" }),
        }),
        employees: () => ({
          list: () => [
            {
              id: "emp-1",
              kind: "digital" as const,
              displayName: "采购数字同事",
              authUserId: "olivia",
            },
          ],
          getByAuthUserId: () => ({
            id: "emp-human",
            kind: "human" as const,
            displayName: "Olivia",
            authUserId: "olivia",
          }),
          get: () => ({
            id: "emp-1",
            kind: "digital" as const,
            displayName: "采购数字同事",
            authUserId: "olivia",
          }),
          activeProfile: () => ({ name: "采购执行 Profile" }),
        }),
      });
      const module = await service.briefModule(principal, { tzOffsetMinutes });
      const item = (module.data?.views.unread ?? [])[0];
      expect(item?.tag).toBe("review");
      expect(item?.statusLabel).toBe("待我验收");
      expect(item?.actionLabel).toBe("前往验收");
    }
  });

  it("folds legacy per-run conclusions of one task into a single item", async () => {
    // 历史数据里同一任务可能留下 C:run:<id> 多条；合并后只应剩一条，
    // 且「有一条未读就算未读」。
    const customTables = tables();
    const legacy = (runId: string, readState: "read" | "unread", at: string) => ({
      readerId: "olivia",
      itemId: `C:run:${runId}`,
      section: "conclusion" as const,
      tag: "progress" as const,
      title: "确认替代供应商交付周期",
      conclusion: `来自 ${runId} 的结论`,
      reason: "入选原因：任务 TSK-1 已由采购数字同事完成并进入待验收。",
      executorName: "采购数字同事",
      executorRole: "采购执行 Profile",
      sourceDomain: "agent-run" as const,
      sourceId: runId,
      statusLabel: "待我验收",
      actionLabel: "前往验收",
      readState,
      ...(readState === "read"
        ? { readAt: at, readVia: "click" as const }
        : {}),
      priorityScore: 5,
      occurredAt: at,
      deepLink: {
        route: "task" as const,
        refId: "TSK-1",
        workspaceId: "ws-1",
        label: "待验收任务 TSK-1",
      },
      condition: { kind: "task-review" as const, refId: "TSK-1" },
      workspaceId: "ws-1",
      workspaceName: "供应链",
      resolved: false,
      createdAt: at,
      updatedAt: at,
    });
    await customTables.briefItems.put(
      briefItemKey("olivia", "C:run:run-old"),
      legacy("run-old", "read", "2026-10-09T01:00:00.000Z"),
    );
    await customTables.briefItems.put(
      briefItemKey("olivia", "C:run:run-new"),
      legacy("run-new", "unread", "2026-10-09T01:30:00.000Z"),
    );
    const runs = [
      {
        id: "run-new",
        workspaceId: "ws-1",
        agentProfileId: "profile-1",
        employeeId: "emp-1",
        principalType: "digital-employee" as const,
        source: "task" as const,
        instanceId: "TSK-1",
        nodeId: "node-1",
        status: "succeeded" as const,
        output: { summary: "重跑后交付已完成并补齐证据。" },
        endedAt: "2026-10-09T01:30:00.000Z",
        createdAt: "2026-10-09T01:20:00.000Z",
        updatedAt: "2026-10-09T01:30:00.000Z",
      },
    ];
    const tasks = [
      {
        id: "TSK-1",
        workspaceId: "ws-1",
        title: "确认替代供应商交付周期",
        type: "任务",
        status: "review" as const,
        priority: "P2" as const,
        receiverType: "agent" as const,
        receiverId: "emp-1",
        receiverName: "采购数字同事",
        description: "",
        acceptance: ["a"],
        agentRunIds: ["run-new"],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ];
    const service = new WorkbenchService(customTables, {
      now: () => now,
      workspaces: () => ({
        list: () => [{ id: "ws-1", path: "/tmp/supply", title: "供应链" }],
      }),
      team: () => ({
        users: () => [{ id: "olivia", name: "Olivia" }],
        members: () => [{ userId: "olivia", role: "owner" }],
        resolveToken: () => ({ userId: "olivia", role: "member" as const }),
      }),
      tasks: () => ({
        list: () => tasks,
        get: (taskId: string) => {
          const task = tasks.find((item) => item.id === taskId);
          if (task === undefined) throw new Error("not found");
          return task;
        },
      }),
      agents: () => ({
        runs: () => runs,
        profile: () => ({ id: "profile-1", name: "采购执行 Profile" }),
      }),
      employees: () => ({
        list: () => [
          {
            id: "emp-1",
            kind: "digital" as const,
            displayName: "采购数字同事",
            authUserId: "olivia",
          },
        ],
        getByAuthUserId: () => ({
          id: "emp-human",
          kind: "human" as const,
          displayName: "Olivia",
          authUserId: "olivia",
        }),
        get: () => ({
          id: "emp-1",
          kind: "digital" as const,
          displayName: "采购数字同事",
          authUserId: "olivia",
        }),
        activeProfile: () => ({ name: "采购执行 Profile" }),
      }),
    });
    const module = await service.briefModule(principal, { tzOffsetMinutes });
    const all = module.data?.views.all ?? [];
    expect(all.some((item) => item.itemId.startsWith("C:run:"))).toBe(false);
    const merged = all.filter((item) => item.itemId === "C:task:TSK-1");
    expect(merged).toHaveLength(1);
    expect(merged[0]?.readState).toBe("unread");
    expect(merged[0]?.conclusion).toContain("补齐证据");
  });

  it("keeps the full run conclusion in the brief so 展开全文 has content", async () => {
    // 600 字上限会把 Markdown 结论截成半句话，展开后看不到新内容。
    const longSummary = `## 执行情况\n\n${"缺失项：接口契约、测试环境。\n".repeat(80)}结论：需补齐 4 项硬阻塞。`;
    const runs = [
      {
        id: "run-1",
        workspaceId: "ws-1",
        agentProfileId: "profile-1",
        employeeId: "emp-1",
        principalType: "digital-employee" as const,
        source: "task" as const,
        instanceId: "TSK-1",
        nodeId: "node-1",
        status: "succeeded" as const,
        output: { summary: longSummary },
        endedAt: "2026-10-09T01:00:00.000Z",
        createdAt: "2026-10-09T00:00:00.000Z",
        updatedAt: "2026-10-09T01:00:00.000Z",
      },
    ];
    const tasks = [
      {
        id: "TSK-1",
        workspaceId: "ws-1",
        title: "确认替代供应商交付周期",
        type: "任务",
        status: "review" as const,
        priority: "P2" as const,
        receiverType: "agent" as const,
        receiverId: "emp-1",
        receiverName: "采购数字同事",
        description: "",
        acceptance: ["a"],
        agentRunIds: ["run-1"],
        createdAt: nowIso,
        updatedAt: nowIso,
      },
    ];
    const service = serviceWith({
      tasks: () => ({
        list: () => tasks,
        get: (taskId: string) => {
          const task = tasks.find((item) => item.id === taskId);
          if (task === undefined) throw new Error("not found");
          return task;
        },
      }),
      agents: () => ({
        runs: () => runs,
        profile: () => ({ id: "profile-1", name: "采购执行 Profile" }),
      }),
      employees: () => ({
        list: () => [
          {
            id: "emp-1",
            kind: "digital" as const,
            displayName: "采购数字同事",
            authUserId: "olivia",
          },
        ],
        getByAuthUserId: () => ({
          id: "emp-human",
          kind: "human" as const,
          displayName: "Olivia",
          authUserId: "olivia",
        }),
        get: () => ({
          id: "emp-1",
          kind: "digital" as const,
          displayName: "采购数字同事",
          authUserId: "olivia",
        }),
        activeProfile: () => ({ name: "采购执行 Profile" }),
      }),
    });
    const module = await service.briefModule(principal, { tzOffsetMinutes });
    const items = module.data?.views.unread ?? [];
    expect(items).toHaveLength(1);
    const conclusion = items[0]?.conclusion ?? "";
    expect(conclusion.length).toBeGreaterThan(600);
    expect(conclusion.endsWith("结论：需补齐 4 项硬阻塞。")).toBe(true);
  });

  it("backfills the full conclusion for an already stored brief item", async () => {
    const customTables = tables();
    const longSummary = `## 执行情况\n\n${"缺失项：接口契约、测试环境。\n".repeat(60)}结论：需补齐 4 项硬阻塞。`;
    // 历史条目里存的是旧的 600 字截断版本。
    await customTables.briefItems.put(
      briefItemKey("olivia", "C:run:run-1"),
      {
        readerId: "olivia",
        itemId: "C:run:run-1",
        section: "conclusion",
        tag: "progress",
        title: "确认替代供应商交付周期",
        conclusion: `${longSummary.slice(0, 599)}…`,
        reason: "入选原因：任务 TSK-1 已由采购数字同事完成并进入待验收。",
        executorName: "采购数字同事",
        executorRole: "采购执行 Profile",
        sourceDomain: "agent-run",
        sourceId: "run-1",
        statusLabel: "待我验收",
        actionLabel: "前往验收",
        readState: "unread",
        priorityScore: 8,
        occurredAt: "2026-08-01T01:00:00.000Z",
        deepLink: {
          route: "task",
          refId: "TSK-1",
          workspaceId: "ws-1",
          label: "待验收任务 TSK-1",
        },
        condition: { kind: "task-review", refId: "TSK-1" },
        workspaceId: "ws-1",
        workspaceName: "供应链",
        resolved: false,
        createdAt: "2026-08-01T01:00:00.000Z",
        updatedAt: "2026-08-01T01:00:00.000Z",
      },
    );
    // 源 Run 早于当前简报窗口，不会重新生成候选项，只能靠回填补齐结论。
    const runs = [
      {
        id: "run-1",
        workspaceId: "ws-1",
        agentProfileId: "profile-1",
        employeeId: "emp-1",
        principalType: "digital-employee" as const,
        source: "task" as const,
        instanceId: "TSK-1",
        nodeId: "node-1",
        status: "succeeded" as const,
        output: { summary: longSummary },
        endedAt: "2026-08-01T01:00:00.000Z",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T01:00:00.000Z",
      },
    ];
    const tasks = [
      {
        id: "TSK-1",
        workspaceId: "ws-1",
        title: "确认替代供应商交付周期",
        type: "任务",
        status: "review" as const,
        priority: "P2" as const,
        receiverType: "agent" as const,
        receiverId: "emp-1",
        receiverName: "采购数字同事",
        description: "",
        acceptance: ["a"],
        agentRunIds: ["run-1"],
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T01:00:00.000Z",
      },
    ];
    const service = new WorkbenchService(customTables, {
      now: () => now,
      workspaces: () => ({
        list: () => [{ id: "ws-1", path: "/tmp/supply", title: "供应链" }],
      }),
      team: () => ({
        users: () => [{ id: "olivia", name: "Olivia" }],
        members: () => [{ userId: "olivia", role: "owner" }],
        resolveToken: () => ({ userId: "olivia", role: "member" as const }),
      }),
      tasks: () => ({
        list: () => tasks,
        get: (taskId: string) => {
          const task = tasks.find((item) => item.id === taskId);
          if (task === undefined) throw new Error("not found");
          return task;
        },
      }),
      agents: () => ({
        runs: () => runs,
        profile: () => ({ id: "profile-1", name: "采购执行 Profile" }),
      }),
      employees: () => ({
        list: () => [
          {
            id: "emp-1",
            kind: "digital" as const,
            displayName: "采购数字同事",
            authUserId: "olivia",
          },
        ],
        getByAuthUserId: () => ({
          id: "emp-human",
          kind: "human" as const,
          displayName: "Olivia",
          authUserId: "olivia",
        }),
        get: () => ({
          id: "emp-1",
          kind: "digital" as const,
          displayName: "采购数字同事",
          authUserId: "olivia",
        }),
        activeProfile: () => ({ name: "采购执行 Profile" }),
      }),
    });
    const module = await service.briefModule(principal, { tzOffsetMinutes });
    const items = [
      ...(module.data?.views.unread ?? []),
      ...(module.data?.views.all ?? []),
    ];
    const target = items.find((item) => item.itemId === "C:task:TSK-1");
    expect(target?.conclusion).toBe(longSummary);
  });

  it("aggregates several risk events of one workflow instance into a single item", async () => {
    const instance = {
      id: "WF-1",
      workspaceId: "ws-1",
      title: "客户迁移发布",
      status: "blocked" as const,
      updatedAt: "2026-10-09T01:50:00.000Z",
      nodes: { rollback: { status: "blocked" } },
    };
    const events = [
      {
        id: "ev-1",
        instanceId: "WF-1",
        nodeId: "rollback",
        kind: "agent.failed",
        actorId: "agent-1",
        actorKind: "agent" as const,
        actorName: "后端开发 Agent",
        message: "Agent 运行未完成：交付报告格式不合格",
        at: "2026-10-09T01:00:00.000Z",
      },
      {
        id: "ev-2",
        instanceId: "WF-1",
        nodeId: "rollback",
        kind: "approval.rejected",
        actorId: "admin",
        actorKind: "user" as const,
        actorName: "Admin",
        message: "否决审批：回滚确认",
        at: "2026-10-09T01:30:00.000Z",
      },
    ];
    const service = serviceWith({
      workflows: () => ({
        instances: () => [instance],
        instance: (instanceId: string) =>
          instanceId === "WF-1" ? instance : undefined,
        events: () => events,
      }),
    });
    const module = await service.briefModule(principal, { tzOffsetMinutes });
    const items = module.data?.views.unread ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.itemId).toBe("A:workflow:WF-1");
    expect(items[0]?.title).toContain("异常 2 项");
    expect(items[0]?.conclusion).toContain("2 条异常记录");
    expect(items[0]?.conclusion).toContain("Agent 执行失败");
    expect(items[0]?.conclusion).toContain("审批否决");
    expect(items[0]?.reason).toContain("入选原因");
    expect(items[0]?.reason).toContain("2 条异常");
    expect(items[0]?.condition).toEqual({
      kind: "workflow-blocked",
      refId: "WF-1",
    });
  });

  it("migrates legacy per-run risk items into the per-instance aggregate", async () => {
    const tableSet = tables();
    const instance = {
      id: "WF-9",
      workspaceId: "ws-1",
      title: "迁移验证流程",
      status: "blocked" as const,
      updatedAt: "2026-10-09T01:50:00.000Z",
      nodes: {},
    };
    const run = {
      id: "run-legacy",
      workspaceId: "ws-1",
      agentProfileId: "profile-1",
      source: "workflow" as const,
      instanceId: "WF-9",
      nodeId: "build",
      status: "failed" as const,
      error: "执行失败",
      endedAt: "2026-10-01T01:00:00.000Z",
      createdAt: "2026-10-01T00:50:00.000Z",
      updatedAt: "2026-10-01T01:00:00.000Z",
    };
    await tableSet.briefItems.put(
      briefItemKey(principal.userId, "A:run:run-legacy"),
      priorRecord({
        itemId: "A:run:run-legacy",
        condition: { kind: "run-terminal", refId: "run-legacy" },
      }),
    );
    const service = new WorkbenchService(tableSet, {
      now: () => now,
      workspaces: () => ({
        list: () => [{ id: "ws-1", path: "/tmp/supply", title: "供应链" }],
      }),
      team: () => ({
        users: () => [{ id: "olivia", name: "Olivia" }],
        members: () => [{ userId: "olivia", role: "owner" }],
        resolveToken: () => ({ userId: "olivia", role: "member" as const }),
      }),
      workflows: () => ({
        instances: () => [instance],
        instance: (instanceId: string) =>
          instanceId === "WF-9" ? instance : undefined,
        events: () => [],
      }),
      agents: () => ({
        runs: () => [run],
        profile: () => undefined,
      }),
    });
    const module = await service.briefModule(principal, { tzOffsetMinutes });
    const itemIds = (module.data?.views.all ?? []).map((item) => item.itemId);
    expect(itemIds).toEqual(["A:workflow:WF-9"]);
    const storedKeys = [...tableSet.briefItems.entries()].map(([key]) => key);
    expect(storedKeys.some((key) => key.endsWith("A:workflow:WF-9"))).toBe(
      true,
    );
    expect(storedKeys.some((key) => key.endsWith("A:run:run-legacy"))).toBe(
      false,
    );
  });

  it("surfaces the latest status update for focus items", async () => {
    const task = {
      id: "TSK-FOCUS-1",
      workspaceId: "ws-1",
      title: "确认替代供应商",
      type: "任务",
      status: "review" as const,
      priority: "P2" as const,
      receiverType: "human" as const,
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "",
      acceptance: ["a"],
      agentRunIds: [],
      events: [
        {
          at: "2026-10-09T01:00:00.000Z",
          kind: "status",
          message: "已提交验收：等待人工确认",
        },
      ],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const service = serviceWith({
      tasks: () => ({
        list: () => [task],
        get: () => task,
      }),
    });
    await service.toggleFollow(principal, {
      type: "task",
      targetId: task.id,
    });
    const module = service.focusModule(principal);
    expect(module.data?.items).toHaveLength(1);
    expect(module.data?.items[0]?.summary).toBe("已提交验收：等待人工确认");
    expect(module.data?.items[0]?.priorityLabel).toBe("P1");
    expect(module.data?.items[0]?.displayId).toBe("TSK-FOCUS-1");
  });

  it("derives a readable short id for workflow instances", () => {
    expect(workflowDisplayId("e83735ee-8ce6-40f5-9074-f13cfa37bbbf")).toBe(
      "WF-E83735",
    );
    expect(workflowDisplayId("")).toBe("WF-UNKNOWN");
  });

  function twoWorkspaceDeps(overrides: WorkbenchDeps = {}): WorkbenchDeps {
    return {
      workspaces: () => ({
        list: () => [
          { id: "ws-1", path: "/tmp/supply", title: "供应链" },
          { id: "ws-2", path: "/tmp/delivery", title: "交付" },
        ],
      }),
      team: () => ({
        users: () => [{ id: "olivia", name: "Olivia" }],
        members: () => [
          { userId: "olivia", role: "owner" },
          { userId: "admin", role: "member" },
        ],
        resolveToken: () => ({ userId: "olivia", role: "member" as const }),
      }),
      ...overrides,
    };
  }

  it("covers workflow tasks and project items in focus", async () => {
    const task = (
      id: string,
      workspaceId: string,
      workflowInstanceId?: string,
    ) => ({
      id,
      workspaceId,
      title: `任务 ${id}`,
      type: "任务",
      status: "progress" as const,
      priority: "P2" as const,
      receiverType: "human" as const,
      receiverId: "olivia",
      receiverName: "Olivia",
      description: "",
      acceptance: [],
      agentRunIds: [],
      ...(workflowInstanceId === undefined
        ? {}
        : {
            workflow: {
              instanceId: workflowInstanceId,
              nodeId: "build",
              instanceTitle: `流程 ${workflowInstanceId}`,
              nodeName: "构建",
              reviewRequired: false,
            },
          }),
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    const instance = (id: string, workspaceId: string) => ({
      id,
      workspaceId,
      title: `流程 ${id}`,
      status: "running" as const,
      updatedAt: nowIso,
      createdBy: "olivia",
      nodes:
        id === "WF-1"
          ? {
              安全复核: {
                status: "running",
                assignedTo: "olivia",
              },
            }
          : {},
    });
    const tasks = [
      task("TSK-1", "ws-1", "WF-1"),
      task("TSK-2", "ws-1"),
      task("TSK-3", "ws-2", "WF-2"),
    ];
    const instances = [instance("WF-1", "ws-1"), instance("WF-2", "ws-2")];
    const service = new WorkbenchService(
      tables(),
      twoWorkspaceDeps({
        tasks: () => ({
          list: (workspaceId: string) =>
            tasks.filter((item) => item.workspaceId === workspaceId),
          get: (taskId: string) => {
            const found = tasks.find((item) => item.id === taskId);
            if (found === undefined) throw new Error("not found");
            return found;
          },
        }),
        workflows: () => ({
          instances: (workspaceId: string) =>
            instances.filter((item) => item.workspaceId === workspaceId),
          instance: (instanceId: string) =>
            instances.find((item) => item.id === instanceId),
          events: () => [],
        }),
      }),
    );
    await service.toggleFollow(principal, {
      type: "workflow",
      targetId: "WF-1",
    });
    const workflowCovered = service.focusModule(principal).data?.items ?? [];
    expect(workflowCovered.map((item) => item.id).sort()).toEqual([
      "TSK-1",
      "WF-1",
    ]);
    expect(
      workflowCovered.find((item) => item.id === "TSK-1")?.coveredBy,
    ).toEqual([{ type: "workflow", id: "WF-1" }]);
    expect(workflowCovered.find((item) => item.id === "WF-1")).toMatchObject({
      statusLabel: "运行中",
      currentNodeLabel: "安全复核",
    });

    await service.toggleFollow(principal, {
      type: "project",
      targetId: "ws-2",
    });
    const projectCovered = service.focusModule(principal).data?.items ?? [];
    expect(projectCovered.map((item) => item.id).sort()).toEqual([
      "TSK-1",
      "TSK-3",
      "WF-1",
      "WF-2",
    ]);
    expect(
      projectCovered.find((item) => item.id === "TSK-3")?.coveredBy,
    ).toEqual([{ type: "project", id: "ws-2" }]);
  });

  it("surfaces only meetings I follow, join, dispatch into, or followed projects", async () => {
    const meeting = (id: string, workspaceId: string, summary?: string) => ({
      id,
      workspaceId,
      title: `会议 ${id}`,
      status: "closed" as const,
      agenda: "",
      ...(summary === undefined ? {} : { summary }),
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    const meetingFollowed = meeting(
      "MTG-1",
      "ws-2",
      "供给缺口已确认。替代产能需在 11 月底锁定。第三句不应出现在摘要里。",
    );
    const meetingJoined = meeting("MTG-2", "ws-2");
    const meetingAvatar = meeting("MTG-3", "ws-2");
    const meetingProject = meeting("MTG-4", "ws-1");
    const meetingHidden = meeting("MTG-5", "ws-2");
    const participantsFor = (meetingId: string) => {
      if (meetingId === "MTG-2") {
        return [
          {
            kind: "human",
            refId: principal.userId,
            displayName: "Olivia",
            status: "active",
          },
        ];
      }
      if (meetingId === "MTG-3") {
        return [
          {
            kind: "agent",
            refId: "tm-1",
            displayName: "采购数字同事",
            status: "active",
            ownerId: principal.userId,
          },
        ];
      }
      if (meetingId === "MTG-1") {
        return [
          {
            kind: "agent",
            refId: "teammate-1",
            displayName: "采购数字同事",
            status: "active",
            leader: true,
          },
          {
            kind: "agent",
            refId: "seat-x",
            displayName: "待入场同事",
            status: "pending",
          },
        ];
      }
      return [
        {
          kind: "human",
          refId: "admin",
          displayName: "Admin",
          status: "active",
        },
      ];
    };
    const all = [
      meetingFollowed,
      meetingJoined,
      meetingAvatar,
      meetingProject,
      meetingHidden,
    ];
    const service = new WorkbenchService(
      tables(),
      twoWorkspaceDeps({
        meetings: () => ({
          list: (workspaceId: string) =>
            all.filter((item) => item.workspaceId === workspaceId),
          participants: (meetingId: string) => participantsFor(meetingId),
        }),
      }),
    );
    await service.toggleFollow(principal, {
      type: "meeting",
      targetId: "MTG-1",
    });
    await service.toggleFollow(principal, {
      type: "project",
      targetId: "ws-1",
    });
    const module = service.meetingsModule(principal);
    expect((module.data?.items ?? []).map((item) => item.id).sort()).toEqual([
      "MTG-1",
      "MTG-2",
      "MTG-3",
      "MTG-4",
    ]);
    const followed = module.data?.items.find((item) => item.id === "MTG-1");
    expect(followed?.summaryText).toBe(
      "供给缺口已确认。 替代产能需在 11 月底锁定。",
    );
    expect(followed?.agents).toEqual([
      {
        refId: "teammate-1",
        name: "采购数字同事",
        kind: "agent",
        owned: false,
        isFacilitator: false,
        status: "active",
        isHost: true,
      },
      {
        refId: "seat-x",
        name: "待入场同事",
        kind: "agent",
        owned: false,
        isFacilitator: false,
        status: "pending",
        isHost: false,
      },
    ]);
    expect(followed?.statusLabel).toBe("已散会");
  });

  it("keeps meeting participant display names and prefers the active duplicate", () => {
    const meeting = {
      id: "MTG-PART",
      workspaceId: "ws-1",
      title: "参会者会议",
      status: "active" as const,
      agenda: "",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const participants = [
      {
        kind: "agent",
        refId: "worker-old",
        displayName: "张三（数字员工）",
        status: "left",
      },
      {
        kind: "agent",
        refId: "worker-1",
        displayName: "张三（数字员工）",
        status: "active",
      },
      {
        kind: "agent",
        refId: "facilitator-1",
        displayName: "会议 Facilitator",
        status: "pending",
      },
      {
        kind: "human",
        refId: principal.userId,
        displayName: "Olivia",
        status: "active",
      },
      {
        kind: "human",
        refId: principal.userId,
        displayName: "Olivia\u200B",
        status: "left",
      },
    ];
    const service = new WorkbenchService(
      tables(),
      twoWorkspaceDeps({
        meetings: () => ({
          list: () => [meeting],
          participants: () => participants,
        }),
      }),
    );
    const item = service
      .meetingsModule(principal)
      .data?.items.find((entry) => entry.id === "MTG-PART");
    expect(item?.agents).toEqual([
      {
        refId: "worker-1",
        name: "张三（数字员工）",
        kind: "agent",
        owned: false,
        isFacilitator: false,
        status: "active",
        isHost: false,
      },
      {
        refId: "facilitator-1",
        name: "会议 Facilitator",
        kind: "agent",
        owned: false,
        isFacilitator: true,
        status: "pending",
        isHost: false,
      },
      {
        refId: principal.userId,
        name: "Olivia",
        kind: "human",
        owned: true,
        isFacilitator: false,
        status: "active",
        isHost: false,
      },
    ]);
  });

  it("uses the meeting-source agent run summary and falls back on failure", async () => {
    const meeting = {
      id: "MTG-RUN",
      workspaceId: "ws-1",
      title: "纪要会议",
      status: "closed" as const,
      agenda: "",
      summary: "手填散会摘要原文。",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const run = (
      source: "workflow" | "task" | "meeting",
      status: "succeeded" | "failed",
      summary: string,
      createdAt: string,
    ) => ({
      id: `run-${createdAt}`,
      workspaceId: "ws-1",
      agentProfileId: "profile-1",
      source,
      instanceId: meeting.id,
      nodeId: "meeting-minutes",
      status,
      output: { summary },
      createdAt,
      updatedAt: createdAt,
    });
    const service = new WorkbenchService(
      tables(),
      twoWorkspaceDeps({
        meetings: () => ({
          list: () => [meeting],
          participants: () => [
            {
              kind: "human",
              refId: principal.userId,
              displayName: "Olivia",
              status: "active",
            },
          ],
        }),
        agents: () => ({
          runs: () => [
            run(
              "meeting",
              "succeeded",
              "  替代产能锁定在 11 月底。\n风险已确认。 ",
              "2026-10-09T01:00:00.000Z",
            ),
            run(
              "task",
              "succeeded",
              "不应采用的摘要",
              "2026-10-09T02:00:00.000Z",
            ),
          ],
          profile: () => undefined,
        }),
      }),
    );
    const succeeded = service.meetingsModule(principal);
    expect(
      succeeded.data?.items.find((entry) => entry.id === meeting.id),
    ).toMatchObject({
      summaryText: "替代产能锁定在 11 月底。 风险已确认。",
      aiSummary: true,
    });

    const failedService = new WorkbenchService(
      tables(),
      twoWorkspaceDeps({
        meetings: () => ({
          list: () => [meeting],
          participants: () => [
            {
              kind: "human",
              refId: principal.userId,
              displayName: "Olivia",
              status: "active",
            },
          ],
        }),
        agents: () => ({
          runs: () => [
            run("meeting", "failed", "失败的纪要", "2026-10-09T01:00:00.000Z"),
          ],
          profile: () => undefined,
        }),
      }),
    );
    expect(
      failedService
        .meetingsModule(principal)
        .data?.items.find((entry) => entry.id === meeting.id),
    ).toMatchObject({
      summaryText: "手填散会摘要原文。",
      aiSummary: false,
    });
  });

  it("prefers the single minutes object and marks unconfirmed versions", () => {
    type MinutesVersion = {
      id: string;
      version: number;
      content: string;
      status: string;
      updatedAt: string;
    };
    type MinutesService = {
      activeVersion(meetingId: string): MinutesVersion | undefined;
      versions(meetingId: string): readonly MinutesVersion[];
    };
    const meeting = {
      id: "MTG-MIN",
      workspaceId: "ws-1",
      title: "纪要收敛",
      status: "closed" as const,
      agenda: "",
      summary: "手填散会摘要原文。",
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    const version = (over: {
      version: number;
      status: string;
      content?: string;
    }): MinutesVersion => ({
      id: `v-${over.version}`,
      version: over.version,
      content: over.content ?? "",
      status: over.status,
      updatedAt: nowIso,
    });
    const deps = (minutes: MinutesService): WorkbenchDeps =>
      twoWorkspaceDeps({
        meetings: () => ({
          list: () => [meeting],
          participants: () => [
            {
              kind: "human",
              refId: principal.userId,
              displayName: "Olivia",
              status: "active",
            },
          ],
        }),
        meetingMinutes: () => minutes,
        agents: () => ({
          runs: () => [
            {
              id: "run-legacy",
              workspaceId: "ws-1",
              agentProfileId: "profile-1",
              source: "meeting" as const,
              instanceId: meeting.id,
              nodeId: "meeting-minutes",
              status: "succeeded" as const,
              output: { summary: "旧 run 摘要。" },
              createdAt: nowIso,
              updatedAt: nowIso,
            },
          ],
          profile: () => undefined,
        }),
      });
    const itemFor = (minutes: MinutesService) =>
      new WorkbenchService(tables(), deps(minutes))
        .meetingsModule(principal)
        .data?.items.find((entry) => entry.id === meeting.id);

    // 1) confirmed 生效版本优先于旧 run 与散会摘要
    expect(
      itemFor({
        activeVersion: () =>
          version({ version: 3, status: "confirmed", content: "确认版纪要正文。" }),
        versions: () => [
          version({ version: 3, status: "confirmed", content: "确认版纪要正文。" }),
        ],
      }),
    ).toMatchObject({
      summaryText: "确认版纪要正文。",
      minutesSource: "confirmed",
      minutesPending: false,
      aiSummary: true,
    });

    // 2) 无生效版本时取最新待确认版本，并标记待确认
    expect(
      itemFor({
        activeVersion: () => undefined,
        versions: () => [
          version({ version: 1, status: "superseded", content: "旧版本。" }),
          version({ version: 2, status: "pending_confirm", content: "待确认正文。" }),
        ],
      }),
    ).toMatchObject({
      summaryText: "待确认正文。",
      minutesSource: "pending_confirm",
      minutesPending: true,
      aiSummary: true,
    });

    // 3) 纪要服务异常时回退旧 run，再回退散会摘要
    expect(
      itemFor({
        activeVersion: () => {
          throw new Error("minutes unavailable");
        },
        versions: () => [],
      }),
    ).toMatchObject({
      summaryText: "旧 run 摘要。",
      minutesSource: "legacy_run",
      minutesPending: false,
      aiSummary: true,
    });
  });
});

describe("方案 B：工作台工作区范围", () => {
  const scopeDeps = (): WorkbenchDeps => ({
    now: () => now,
    workspaces: () => ({
      list: () => [
        { id: "ws-1", path: "/tmp/joined", title: "已加入项目" },
        { id: "ws-2", path: "/tmp/others", title: "未加入项目" },
      ],
    }),
    team: () => ({
      users: () => [{ id: "admin", name: "平台管理员" }],
      members: (workspaceId: string) =>
        workspaceId === "ws-1"
          ? [{ userId: "admin", role: "member" }]
          : [{ userId: "owner", role: "owner" }],
    }),
  });

  it("管理员默认只看已加入，显式 scopeAll 才聚合全量", () => {
    const service = new WorkbenchService(tables(), scopeDeps());
    const admin = { userId: "admin", name: "平台管理员", role: "admin" as const };
    // 普通视图：平台管理员与成员一致，只包含已加入的工作区。
    expect(service.projects(admin).map((item) => item.id)).toEqual(["ws-1"]);
    // 全量视图：只有显式打开开关（scope=all）才聚合全部宿主工作区。
    expect(
      service
        .projects({ ...admin, scopeAll: true })
        .map((item) => item.id)
        .sort(),
    ).toEqual(["ws-1", "ws-2"]);
  });

  it("非管理员即使带上 scopeAll 也不能看到未加入的工作区", () => {
    const service = new WorkbenchService(tables(), scopeDeps());
    const member = {
      userId: "olivia",
      name: "Olivia",
      role: "member" as const,
      scopeAll: true,
    };
    expect(service.projects(member)).toEqual([]);
  });
});
