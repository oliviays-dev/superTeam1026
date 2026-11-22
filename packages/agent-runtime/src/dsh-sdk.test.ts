import { describe, expect, it } from "vitest";
import { KNOWN_NOTIFICATION_METHODS, mapDshNotification } from "./dsh-sdk.js";

describe("mapDshNotification whitelist", () => {
  it("accepts exactly the documented notification methods", () => {
    expect([...KNOWN_NOTIFICATION_METHODS].sort()).toEqual([
      "session.event",
      "session.status",
      "subagent.finished",
      "subagent.started",
    ]);
  });

  it("warns with the original method name for unknown notifications", () => {
    expect(
      mapDshNotification({
        method: "runtime.renamed",
        params: { payload: "important" },
      }),
    ).toEqual([
      {
        type: "warning",
        summary: "DSH 收到未知通知 method：runtime.renamed",
      },
    ]);
  });

  it("keeps mapped behavior for all whitelisted methods", () => {
    expect(
      mapDshNotification({
        method: "session.status",
        params: { status: "running" },
      }),
    ).toEqual([{ type: "progress", summary: "DSH Runtime 正在执行任务" }]);
    expect(
      mapDshNotification({ method: "subagent.started", params: {} }),
    ).toEqual([{ type: "progress", summary: "DSH 子 Agent 已启动" }]);
    expect(
      mapDshNotification({ method: "subagent.finished", params: {} }),
    ).toEqual([{ type: "progress", summary: "DSH 子 Agent 已完成" }]);
    expect(
      mapDshNotification({
        method: "session.event",
        params: { event: { type: "turn/start" } },
      }),
    ).toEqual([{ type: "progress", summary: "DSH 开始新一轮执行" }]);
  });
});
