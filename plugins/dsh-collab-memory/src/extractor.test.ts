import { describe, expect, it } from "vitest";
import { createAgentMemoryExecutor } from "./extractor.ts";
import type { IngestJob } from "./models.ts";

const job: IngestJob = {
  id: "ingest-model-1",
  sourceKey: "meeting:meeting-1:v1",
  sourceType: "meeting",
  sourceId: "meeting-1",
  version: "v1",
  workspaceId: "project-a",
  payload: {
    title: "上线评审",
    content: "会议决定在 10 月 30 日上线。",
    actorPrincipalId: "owner-a",
    projectId: "project-a",
    occurredAt: "2026-10-22T00:00:00.000Z",
    sourceRefs: [{ type: "meeting", id: "meeting-1" }],
    metadata: {},
  },
  status: "processing",
  attempts: 1,
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
};

describe("createAgentMemoryExecutor", () => {
  it("runs an isolated JSON-only extraction session", async () => {
    const created: Array<Record<string, unknown>> = [];
    const restrictions: Array<{ readonly allow: readonly string[] }> = [];
    const followups: unknown[] = [];
    const events: Array<{ readonly type: string; readonly data?: unknown }> = [];
    let disposed = 0;
    const executor = createAgentMemoryExecutor({
      agents: () => ({
        create: async (options) => {
          created.push(options);
          await options.setup?.({
            tools: {
              restrict: (input) => restrictions.push(input),
            },
          });
          return {
            agent: {
              session: {
                id: options.sessionId,
                snapshotEvents: () => events,
              },
              followup: (message) => {
                followups.push(message);
                events.push({
                    type: "assistant/message",
                    data: {
                      message: {
                        content: [
                          {
                            type: "text",
                            text: [
                              "```json",
                              JSON.stringify({
                                topics: [
                                  {
                                    title: "上线决策",
                                    aliases: [],
                                    claims: [
                                      {
                                        kind: "decision",
                                        statement: "确定在 10 月 30 日上线",
                                        judgmentKey: "primary-decision",
                                        confidence: 0.94,
                                        effectiveAt:
                                          "2026-10-22T00:00:00.000Z",
                                        conditions: [],
                                      },
                                    ],
                                  },
                                ],
                              }),
                              "```",
                            ].join("\n"),
                          },
                        ],
                      },
                    },
                  });
              },
              whenIdle: async () => undefined,
            },
            dispose: async () => {
              disposed += 1;
            },
          };
        },
      }),
      defaultModel: () => ({
        currentSelection: () => ({
          provider: "test-provider",
          model: "test-model",
        }),
      }),
      workspaces: () => ({
        get: () => ({ path: "/tmp/project-a" }),
      }),
    });

    const result = await executor!(job);

    expect(result.topics[0]).toMatchObject({
      title: "上线决策",
      claims: [{ statement: "确定在 10 月 30 日上线" }],
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      sessionId: expect.stringMatching(/^de-memory-/),
      meta: { cwd: "/tmp/project-a" },
      agentOptions: {
        provider: "test-provider",
        model: "test-model",
      },
    });
    expect(restrictions).toEqual([{ allow: [] }]);
    expect(JSON.stringify(followups[0])).toContain("只输出 JSON");
    expect(JSON.stringify(followups[0])).toContain("会议决定在 10 月 30 日上线");
    expect(disposed).toBe(1);
  });

  it("returns no executor when the Agent registry is unavailable", () => {
    expect(
      createAgentMemoryExecutor({
        agents: () => undefined,
        defaultModel: () => undefined,
        workspaces: () => undefined,
      }),
    ).toBeUndefined();
  });
});
