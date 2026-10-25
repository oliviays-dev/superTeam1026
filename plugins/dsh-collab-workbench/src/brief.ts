import type {
  BriefCondition,
  BriefDeepLink,
  BriefItemRecord,
} from "./models.js";

/**
 * 每日简报的纯逻辑层：离开窗口、优先级排序、已读 / 未读生命周期。
 * 方案来源：晨间简报卡-产品方案设计 v0.7（P0 口径，推送后置）。
 */

export interface BriefCandidate {
  itemId: string;
  section: BriefItemRecord["section"];
  tag: BriefItemRecord["tag"];
  title: string;
  conclusion: string;
  /** 为什么出现：触发规则 + 来源范围 + 时间窗口（面向用户的解释）。 */
  reason: string;
  executorName: string;
  executorRole: string;
  sourceDomain: BriefItemRecord["sourceDomain"];
  sourceId: string;
  statusLabel: string;
  actionLabel: string;
  escalateReason?: string;
  suggestion?: { headline: string; body: string };
  priorityScore: number;
  occurredAt: string;
  deadline?: string;
  deepLink: BriefDeepLink;
  workspaceId: string;
  workspaceName: string;
  condition: BriefCondition;
}

export interface BriefLiveState {
  /** 升级 / 待验收条件当前是否仍然成立。 */
  active: boolean;
  /** 是否已被下游闭环动作处理（验收、审批、重试、取消）。 */
  resolved: boolean;
}

export interface AwayWindow {
  from: string;
  to: string;
  truncatedTo24h: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LOOKBACK_MS = DAY_MS;

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 读者本地时间的日期戳（YYYY-MM-DD），tzOffsetMinutes 为东八区偏移（+480）。 */
export function localDayStamp(
  value: string | Date,
  tzOffsetMinutes: number,
): string {
  const millis =
    value instanceof Date
      ? value.getTime()
      : (parseTime(value) ?? Date.now());
  const shifted = new Date(millis + tzOffsetMinutes * 60_000);
  return [
    shifted.getUTCFullYear().toString().padStart(4, "0"),
    (shifted.getUTCMonth() + 1).toString().padStart(2, "0"),
    shifted.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

/** 读者本地时间「昨日 18:00」对应的绝对时刻。 */
export function localYesterdayEvening(
  now: Date,
  tzOffsetMinutes: number,
  hour = 18,
): Date {
  const shifted = new Date(now.getTime() + tzOffsetMinutes * 60_000);
  const localMidnightUtc =
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ) -
    tzOffsetMinutes * 60_000;
  return new Date(localMidnightUtc - DAY_MS + hour * 60 * 60 * 1000);
}

export function computeAwayWindow(input: {
  lastMergeAt?: string | undefined;
  lastSeenAt?: string | undefined;
  manualFrom?: string | undefined;
  now: Date;
  tzOffsetMinutes: number;
}): AwayWindow {
  const nowMs = input.now.getTime();
  const manualMs = parseTime(input.manualFrom);
  const automaticMs =
    parseTime(input.lastMergeAt) ?? parseTime(input.lastSeenAt) ?? undefined;
  const base =
    manualMs !== undefined && manualMs < nowMs ? manualMs : automaticMs;
  const fallback = localYesterdayEvening(
    input.now,
    input.tzOffsetMinutes,
  ).getTime();
  const candidate = base === undefined || base >= nowMs ? fallback : base;
  const truncated = nowMs - candidate > MAX_LOOKBACK_MS;
  const fromMs = truncated ? nowMs - MAX_LOOKBACK_MS : candidate;
  return {
    from: new Date(fromMs).toISOString(),
    to: input.now.toISOString(),
    truncatedTo24h: truncated,
  };
}

export const priorityScore = {
  /** 预算耗尽 / 越权被拒。 */
  permissionOrBudget(): number {
    return 9;
  },
  /** Agent Run 失败 / 超时 / 取消。 */
  runTerminal(): number {
    return 8;
  },
  /** 逾期任务：每满 24h +1，封顶 +2。 */
  overdue(overdueMs: number): number {
    const days = Math.max(0, Math.floor(overdueMs / DAY_MS));
    return 9 + Math.min(2, days);
  },
  /** 高优先级 / 今日截止任务。 */
  priorityTask(waitingMs: number): number {
    return waitingMs > DAY_MS ? 9 : 8;
  },
  /** 被派出方催办：别人在等我，与高优先级同档，超过一天再抬一档。 */
  nudged(waitingMs: number): number {
    return waitingMs > DAY_MS ? 9 : 8;
  },
  /** 流程实例阻塞 / 审批等待。 */
  blocked(waitingMs: number): number {
    return waitingMs > DAY_MS ? 8 : 7;
  },
  /** 夜间关键结论。 */
  conclusion(blockedRelated: boolean): number {
    return blockedRelated ? 6 : 5;
  },
} as const;

function sameLocalDay(
  left: string | undefined,
  right: Date,
  tzOffsetMinutes: number,
): boolean {
  if (left === undefined) return false;
  return (
    localDayStamp(left, tzOffsetMinutes) ===
    localDayStamp(right, tzOffsetMinutes)
  );
}

function candidateRecord(input: {
  readerId: string;
  candidate: BriefCandidate;
  now: Date;
  prior?: BriefItemRecord | undefined;
}): BriefItemRecord {
  const { candidate, now, prior } = input;
  const timestamp = now.toISOString();
  return {
    readerId: input.readerId,
    itemId: candidate.itemId,
    section: candidate.section,
    tag: candidate.tag,
    title: candidate.title,
    conclusion: candidate.conclusion,
    reason: candidate.reason,
    executorName: candidate.executorName,
    executorRole: candidate.executorRole,
    sourceDomain: candidate.sourceDomain,
    sourceId: candidate.sourceId,
    statusLabel: candidate.statusLabel,
    actionLabel: candidate.actionLabel,
    ...(candidate.escalateReason === undefined
      ? {}
      : { escalateReason: candidate.escalateReason }),
    ...(candidate.suggestion === undefined
      ? {}
      : { suggestion: candidate.suggestion }),
    readState: prior?.readState ?? "unread",
    ...(prior?.readAt === undefined ? {} : { readAt: prior.readAt }),
    ...(prior?.readVia === undefined ? {} : { readVia: prior.readVia }),
    priorityScore: candidate.priorityScore,
    occurredAt: candidate.occurredAt,
    ...(candidate.deadline === undefined ? {} : { deadline: candidate.deadline }),
    deepLink: candidate.deepLink,
    workspaceId: candidate.workspaceId,
    workspaceName: candidate.workspaceName,
    condition: candidate.condition,
    resolved: false,
    createdAt: prior?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

export interface BriefMergeResult {
  /** 需要持久化的全部条目（含当日保留的已读条目）。 */
  stored: BriefItemRecord[];
  /** 未读视图：仅 unread，按优先级排序。 */
  unread: BriefItemRecord[];
  /** 全部视图：未读置顶，已读按生命周期跟随。 */
  all: BriefItemRecord[];
  unreadCount: number;
  created: string[];
  removed: string[];
  markedRead: string[];
}

function sortItems(items: BriefItemRecord[]): BriefItemRecord[] {
  return [...items].sort((left, right) => {
    if (left.readState !== right.readState) {
      return left.readState === "unread" ? -1 : 1;
    }
    if (left.priorityScore !== right.priorityScore) {
      return right.priorityScore - left.priorityScore;
    }
    return right.occurredAt.localeCompare(left.occurredAt);
  });
}

/**
 * 判断条目内容是否真的变化；只有变化的条目才刷新 updatedAt，
 * 否则每次合并都会把全部条目标成「已更新」，diff 就失去意义。
 */
function contentChanged(
  left: BriefItemRecord,
  right: BriefItemRecord,
): boolean {
  return (
    left.tag !== right.tag ||
    left.title !== right.title ||
    left.conclusion !== right.conclusion ||
    left.reason !== right.reason ||
    left.statusLabel !== right.statusLabel ||
    left.escalateReason !== right.escalateReason ||
    left.actionLabel !== right.actionLabel ||
    left.priorityScore !== right.priorityScore ||
    left.readState !== right.readState ||
    left.occurredAt !== right.occurredAt ||
    left.deadline !== right.deadline ||
    JSON.stringify(left.suggestion ?? null) !==
      JSON.stringify(right.suggestion ?? null) ||
    JSON.stringify(left.deepLink) !== JSON.stringify(right.deepLink) ||
    JSON.stringify(left.condition) !== JSON.stringify(right.condition)
  );
}

export function mergeBriefItems(input: {
  readerId: string;
  existing: readonly BriefItemRecord[];
  candidates: readonly BriefCandidate[];
  liveState: ReadonlyMap<string, BriefLiveState>;
  now: Date;
  tzOffsetMinutes: number;
}): BriefMergeResult {
  const { readerId, candidates, liveState, now, tzOffsetMinutes } = input;
  const priorByItem = new Map(
    input.existing.map((item) => [item.itemId, item]),
  );
  const next: BriefItemRecord[] = [];
  const created: string[] = [];
  const removed: string[] = [];
  const markedRead: string[] = [];

  for (const candidate of candidates) {
    const prior = priorByItem.get(candidate.itemId);
    priorByItem.delete(candidate.itemId);
    // 结论是新闻：读后即走（下游闭环当日保留的除外）。
    if (
      prior !== undefined &&
      prior.section === "conclusion" &&
      prior.readState === "read" &&
      !(
        prior.readVia === "downstream_action" &&
        sameLocalDay(prior.readAt, now, tzOffsetMinutes)
      )
    ) {
      removed.push(candidate.itemId);
      continue;
    }
    if (prior === undefined) created.push(candidate.itemId);
    const record = candidateRecord({ readerId, candidate, now, prior });
    if (prior !== undefined && !contentChanged(prior, record)) {
      next.push(prior);
      continue;
    }
    next.push(record);
  }

  for (const prior of priorByItem.values()) {
    const state = liveState.get(prior.itemId);
    const resolved = state?.resolved === true;
    if (prior.section === "risk") {
      if (!resolved) {
        next.push(prior);
        continue;
      }
      if (prior.readState === "unread") {
        markedRead.push(prior.itemId);
        next.push({
          ...prior,
          readState: "read",
          readAt: now.toISOString(),
          readVia: "downstream_action",
          resolved: true,
          updatedAt: now.toISOString(),
        });
        continue;
      }
      if (sameLocalDay(prior.readAt, now, tzOffsetMinutes)) {
        next.push({ ...prior, resolved: true, updatedAt: now.toISOString() });
      } else {
        removed.push(prior.itemId);
      }
      continue;
    }
    if (prior.section === "escalation") {
      if (state?.active === true) {
        next.push(prior);
        continue;
      }
      if (!resolved) {
        removed.push(prior.itemId);
        continue;
      }
      if (prior.readState === "unread") {
        markedRead.push(prior.itemId);
        next.push({
          ...prior,
          readState: "read",
          readAt: now.toISOString(),
          readVia: "downstream_action",
          resolved: true,
          updatedAt: now.toISOString(),
        });
        continue;
      }
      if (sameLocalDay(prior.readAt, now, tzOffsetMinutes)) {
        next.push({ ...prior, resolved: true, updatedAt: now.toISOString() });
      } else {
        removed.push(prior.itemId);
      }
      continue;
    }
    // conclusion：读完即走；未读遇到下游闭环时保留到当日结束。
    if (prior.readState === "read") {
      if (
        prior.readVia === "downstream_action" &&
        sameLocalDay(prior.readAt, now, tzOffsetMinutes)
      ) {
        next.push({ ...prior, resolved: true, updatedAt: now.toISOString() });
      } else {
        removed.push(prior.itemId);
      }
      continue;
    }
    if (resolved) {
      markedRead.push(prior.itemId);
      next.push({
        ...prior,
        readState: "read",
        readAt: now.toISOString(),
        readVia: "downstream_action",
        resolved: true,
        updatedAt: now.toISOString(),
      });
      continue;
    }
    next.push(prior);
  }

  const sorted = sortItems(next);
  const unread = sorted.filter((item) => item.readState === "unread");
  return {
    stored: sorted,
    unread,
    all: sorted,
    unreadCount: unread.length,
    created,
    removed,
    markedRead,
  };
}

const TAG_LABEL: Record<BriefItemRecord["tag"], string> = {
  progress: "进展",
  data: "数据异常",
  conclusion: "结论",
  decision: "待决策",
  review: "待我验收",
  nudge: "被催办",
};

export function briefTagLabel(tag: BriefItemRecord["tag"]): string {
  return TAG_LABEL[tag];
}

/**
 * 卡片头部的一句话摘要：只统计仍未读的条目，读完即从摘要中收敛。
 */
export function briefSummary(input: {
  awayWindow: AwayWindow;
  items: readonly BriefItemRecord[];
}): string {
  const hours = Math.max(
    1,
    Math.round(
      (Date.parse(input.awayWindow.to) - Date.parse(input.awayWindow.from)) /
        3_600_000,
    ),
  );
  const counts = {
    data: 0,
    decision: 0,
    review: 0,
    conclusion: 0,
    progress: 0,
    nudge: 0,
  };
  for (const item of input.items) {
    if (item.readState !== "unread") continue;
    counts[item.tag] += 1;
  }
  const parts = [
    ["data", "数据异常"],
    ["nudge", "被催办"],
    ["decision", "升级关注"],
    ["review", "待我验收"],
    ["conclusion", "结论"],
    ["progress", "进展"],
  ]
    .map(([key, label]) =>
      counts[key as keyof typeof counts] > 0
        ? `${counts[key as keyof typeof counts]} 项${label}`
        : "",
    )
    .filter(Boolean);
  if (parts.length === 0) {
    return `过去 ${hours} 小时没有需要你处理的新增事项。`;
  }
  return `过去 ${hours} 小时有 ${parts.join("、")} 需要你知晓或处置。`;
}
