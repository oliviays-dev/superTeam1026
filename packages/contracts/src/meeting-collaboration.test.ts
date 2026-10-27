import { describe, expect, it } from "vitest";
import {
  archiveMeetingInputSchema,
  confirmMeetingMinutesInputSchema,
  createMeetingDelegateInputSchema,
  createMeetingPrivateBriefingInputSchema,
  createMeetingTaskInputSchema,
  meetingCollaborationOverviewSchema,
  meetingMessageSchema,
  uploadMeetingFileInputSchema,
} from "./index.js";

describe("meeting collaboration contracts", () => {
  it("normalizes delegate actions and validates task idempotency keys", () => {
    const delegate = createMeetingDelegateInputSchema.parse({
      representativeKind: "agent",
      agentId: "00000000-0000-4000-8000-000000000001",
      allowedActions: ["speak", "speak", "read_private"],
      reason: "Represent the facilitator",
    });
    expect(delegate.allowedActions).toEqual(["speak", "read_private"]);

    const task = createMeetingTaskInputSchema.parse({
      title: "Follow up",
      assigneeAgentId: "00000000-0000-4000-8000-000000000001",
      idempotencyKey: "meeting-task:1",
    });
    expect(task.priority).toBe("medium");
    expect(task.dispatch).toBe(false);
    expect(() =>
      createMeetingTaskInputSchema.parse({
        title: "Invalid key",
        assigneeAgentId: "00000000-0000-4000-8000-000000000001",
        idempotencyKey: "contains spaces",
      }),
    ).toThrow();
  });

  it("keeps collaboration and delivery states explicit", () => {
    const now = new Date().toISOString();
    expect(
      meetingCollaborationOverviewSchema.parse({
        meetingId: "00000000-0000-4000-8000-000000000010",
        projectId: "00000000-0000-4000-8000-000000000011",
        lifecycleStatus: "active",
        revision: 1,
        facilitator: {
          principalId: "local-admin",
          displayName: "Local Admin",
          assignedBy: "local-admin",
          assignedAt: now,
          revision: 1,
        },
        archivedBy: null,
        archivedAt: null,
        archiveReason: null,
        createdAt: now,
        updatedAt: now,
      }).lifecycleStatus,
    ).toBe("active");

    expect(
      meetingMessageSchema.parse({
        id: "00000000-0000-4000-8000-000000000012",
        meetingId: "00000000-0000-4000-8000-000000000010",
        authorType: "agent",
        authorId: "agent-principal",
        authorName: "AI Delegate",
        content: "Represented statement",
        turnId: null,
        policyId: null,
        policyRevision: null,
        triggerKind: null,
        triggerReason: null,
        runId: null,
        traceId: null,
        status: "sent",
        errorCode: null,
        errorMessage: null,
        clientMessageId: "delegate:1",
        delegateId: "00000000-0000-4000-8000-000000000013",
        senderPrincipalId: "human-owner",
        createdAt: now,
      }),
    ).toMatchObject({
      delegateId: "00000000-0000-4000-8000-000000000013",
      senderPrincipalId: "human-owner",
    });
  });

  it("validates private content, file payloads, minutes confirmation and archive reason", () => {
    expect(
      createMeetingPrivateBriefingInputSchema.parse({
        content: "  private instruction  ",
      }).content,
    ).toBe("private instruction");
    expect(
      uploadMeetingFileInputSchema.parse({
        name: "agenda.txt",
        mimeType: "text/plain",
        contentBase64: "YWdlbmRh",
      }).name,
    ).toBe("agenda.txt");
    expect(
      confirmMeetingMinutesInputSchema.parse({ expectedRevision: 2 }),
    ).toMatchObject({ expectedRevision: 2, note: "" });
    expect(() =>
      archiveMeetingInputSchema.parse({
        expectedRevision: 1,
        reason: "",
      }),
    ).toThrow();
  });
});
