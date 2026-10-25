import { describe, expect, it } from "vitest";
import { FakeRuntimeAdapter } from "./index.js";

describe("FakeRuntimeAdapter", () => {
  it("emits a complete deterministic run", async () => {
    const adapter = new FakeRuntimeAdapter();
    const events = [];
    for await (const event of adapter.execute(
      {
        runId: "run-1",
        title: "Analyze supplier risk",
        description: "Review current supplier risk.",
        acceptance: ["Provide a conclusion"],
        agentName: "Fake Agent",
        runtimeKind: "fake",
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
