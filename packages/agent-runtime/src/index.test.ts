import { describe, expect, it } from "vitest";
import { FakeRuntimeAdapter, mapDshNotification } from "./index.js";

describe("FakeRuntimeAdapter", () => {
  it("emits a complete deterministic run", async () => {
    const adapter = new FakeRuntimeAdapter();
    const events = [];
    for await (const event of adapter.execute(
      {
        runId: "run-1",
        effectKey: "run:run-1:agent.execute:v1",
        title: "Analyze supplier risk",
        description: "Review current supplier risk.",
        acceptance: ["Provide a conclusion"],
        instruction: "Review current supplier risk.",
        agentName: "Fake Agent",
        runtimeKind: "fake",
        workspacePath: ".tmp/workspace",
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events[0]?.type).toBe("plan");
    expect(events.some((event) => event.type === "tool.started")).toBe(true);
    expect(events.at(-1)?.type).toBe("completed");
  });
});

describe("mapDshNotification", () => {
  it("maps DSH tool events to platform runtime events", () => {
    expect(
      mapDshNotification({
        method: "session.event",
        params: {
          event: {
            type: "tool/call",
            data: { name: "web_search" },
          },
        },
      }),
    ).toEqual([
      {
        type: "tool.started",
        summary: "DSH 正在调用工具 web_search",
        tool: "web_search",
      },
    ]);
  });
});
