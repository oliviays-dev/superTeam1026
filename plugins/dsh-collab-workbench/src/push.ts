import type { BriefItemRecord } from "./models.js";
import type {
  WorkbenchModule,
  WorkbenchPrincipal,
} from "./service.js";

/**
 * 简报的事件驱动推送（P0 补齐部分）。
 *
 * 约束（来自晨间简报卡产品方案 §5.1）：
 * - 事件发生 → 对该读者重新执行增量合并 → 计算 diff → 推给「当前打开简报的页面会话」；
 * - 页面未打开时不做任何触达，下次打开按拉取式合并取数；
 * - 不产生任何通知记录（不做通知中心、不做站外推送）。
 */

export interface BriefModuleData {
  awayWindow: { from: string; to: string; truncatedTo24h: boolean };
  unreadCount: number;
  summary: string;
  views: { unread: BriefItemRecord[]; all: BriefItemRecord[] };
}

export type BriefPayload = WorkbenchModule<BriefModuleData>;

export interface BriefDiff {
  added: string[];
  updated: string[];
  removed: string[];
  unreadCount: number;
}

export function diffBriefItems(
  previous: readonly BriefItemRecord[],
  next: readonly BriefItemRecord[],
): BriefDiff {
  const before = new Map(previous.map((item) => [item.itemId, item]));
  const after = new Map(next.map((item) => [item.itemId, item]));
  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  for (const [itemId, item] of after) {
    const prior = before.get(itemId);
    if (prior === undefined) {
      added.push(itemId);
      continue;
    }
    if (
      prior.updatedAt !== item.updatedAt ||
      prior.readState !== item.readState ||
      prior.priorityScore !== item.priorityScore
    ) {
      updated.push(itemId);
    }
  }
  for (const itemId of before.keys()) {
    if (!after.has(itemId)) removed.push(itemId);
  }
  return {
    added,
    updated,
    removed,
    unreadCount: next.filter((item) => item.readState === "unread").length,
  };
}

export interface BriefStreamClient {
  readonly principal: WorkbenchPrincipal;
  readonly tzOffsetMinutes: number;
  send(payload: unknown): void;
  close(): void;
}

interface ClientState {
  readonly client: BriefStreamClient;
  snapshot: BriefItemRecord[] | null;
}

export interface BriefPushHubOptions {
  computeBrief(
    principal: WorkbenchPrincipal,
    tzOffsetMinutes: number,
  ): Promise<BriefPayload>;
  debounceMs?: number;
  onError?: (error: unknown) => void;
}

export class BriefPushHub {
  private readonly clients = new Set<ClientState>();
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private queued = false;
  private disposed = false;

  constructor(private readonly options: BriefPushHubOptions) {
    this.debounceMs = options.debounceMs ?? 400;
  }

  /** 页面会话接入：注册后立即做一次增量合并，作为后续 diff 的基线。 */
  register(client: BriefStreamClient): () => void {
    const state: ClientState = { client, snapshot: null };
    this.clients.add(state);
    void this.deliver(state, { initial: true });
    return () => {
      this.clients.delete(state);
    };
  }

  /** 领域事件到达：合并同一批触发，避免事件风暴反复重算。 */
  notify(): void {
    if (this.disposed || this.clients.size === 0) return;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const state of this.clients) state.client.close();
    this.clients.clear();
  }

  private async flush(): Promise<void> {
    if (this.flushing !== undefined) {
      this.queued = true;
      return;
    }
    const run = (async () => {
      // 交付过程中连接可能被移除，先固定本轮客户端列表。
      const clients = [...this.clients];
      for (const state of clients) {
        await this.deliver(state, { initial: false });
      }
    })();
    this.flushing = run;
    try {
      await run;
    } finally {
      this.flushing = undefined;
      if (this.queued) {
        this.queued = false;
        this.notify();
      }
    }
  }

  private async deliver(
    state: ClientState,
    options: { initial: boolean },
  ): Promise<void> {
    try {
      const payload = await this.options.computeBrief(
        state.client.principal,
        state.client.tzOffsetMinutes,
      );
      if (this.disposed || !this.clients.has(state)) return;
      if (payload.error !== undefined) {
        state.client.send({ type: "error", message: payload.error });
        return;
      }
      const items = payload.data?.views.all ?? [];
      const diff = diffBriefItems(state.snapshot ?? [], items);
      state.snapshot = items;
      if (options.initial) {
        state.client.send({ type: "sync", diff, module: payload });
        return;
      }
      if (
        diff.added.length === 0 &&
        diff.updated.length === 0 &&
        diff.removed.length === 0
      ) {
        return;
      }
      state.client.send({ type: "brief", diff, module: payload });
    } catch (error) {
      this.options.onError?.(error);
      state.client.send({
        type: "error",
        message: error instanceof Error ? error.message : "简报推送失败",
      });
    }
  }
}
