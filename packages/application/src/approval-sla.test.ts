import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database, PlatformRepositories, migrate } from "@pluginmax/database";
import { PlatformApplication } from "./index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("approval SLA lifecycle", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let application: PlatformApplication;

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    repositories = new PlatformRepositories(database);
    application = new PlatformApplication(repositories);
  });

  afterAll(async () => {
    await database.close();
  });

  it("reminds, escalates and expires with concurrent idempotent sweeps", async () => {
    const project = await application.createProject({
      name: `SLA ${randomUUID().slice(0, 8)}`,
      description: "approval SLA integration",
    });
    const escalationRole = await application.createProjectRole(project.id, {
      name: `SLA escalation ${randomUUID().slice(0, 5)}`,
      description: "fallback reviewers",
    });
    await repositories.projectMemberships.createMember(project.id, {
      kind: "human",
      actorId: "escalation-user",
      name: "Escalation User",
      responsibility: "SLA escalation reviewer",
      roleIds: [escalationRole.id],
    });
    const workflow = await application.importWorkflowMarkdown({
      projectId: project.id,
      markdown: `# 工作流：SLA

## 元信息

- key: sla-${randomUUID().slice(0, 8).toLowerCase()}
- version: 1
- description: approval SLA integration

## 节点

### 审批

- id: approval
- type: approval
- executor: user:local-admin
- approver: user:local-admin
- policy: all
- approval-due: 1h
- approval-remind: 1h
- approval-escalate-after: 2h
- approval-escalation-role: ${escalationRole.id}
- approval-expire-after: 3h
- approval-expire-action: block

## 连接
`,
    });
    const instance = await application.startWorkflow(
      workflow.id,
      { title: "SLA workflow", context: {} },
      "local-admin",
    );
    expect(instance.status).toBe("waiting");
    const initial = await repositories.workflowRuntime.listApprovals(
      instance.id,
    );
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      kind: "primary",
      status: "pending",
      escalationRoleId: escalationRole.id,
    });
    expect(initial[0]?.dueAt).not.toBeNull();

    await database.query(
      "UPDATE workflow_approvals SET remind_at = NOW() - INTERVAL '1 second' WHERE instance_id = $1",
      [instance.id],
    );
    const reminderResults = await Promise.all([
      application.sweepApprovalSla("sla-worker", 20),
      application.sweepApprovalSla("sla-worker", 20),
    ]);
    expect(
      reminderResults.reduce((sum, result) => sum + result.reminded, 0),
    ).toBe(1);
    const reminded = await repositories.workflowRuntime.listApprovals(
      instance.id,
    );
    expect(reminded[0]?.remindedAt).not.toBeNull();

    await database.query(
      `UPDATE workflow_approvals
       SET escalate_at = NOW() - INTERVAL '1 second'
       WHERE instance_id = $1`,
      [instance.id],
    );
    const escalationResults = await Promise.all([
      application.sweepApprovalSla("sla-worker", 20),
      application.sweepApprovalSla("sla-worker", 20),
    ]);
    expect(
      escalationResults.reduce((sum, result) => sum + result.escalated, 0),
    ).toBeGreaterThan(0);
    const escalated = await repositories.workflowRuntime.listApprovals(
      instance.id,
    );
    expect(
      escalated.filter(
        (approval) =>
          approval.kind === "escalation" &&
          approval.approverId === "escalation-user",
      ),
    ).toHaveLength(1);

    await database.query(
      `UPDATE workflow_approvals
       SET expires_at = NOW() - INTERVAL '1 second'
       WHERE instance_id = $1 AND status = 'pending'`,
      [instance.id],
    );
    const expirationResults = await Promise.all([
      application.sweepApprovalSla("sla-worker", 20),
      application.sweepApprovalSla("sla-worker", 20),
    ]);
    expect(
      expirationResults.reduce((sum, result) => sum + result.expired, 0),
    ).toBeGreaterThan(0);
    const expired = await repositories.workflowRuntime.listApprovals(
      instance.id,
    );
    expect(expired.every((approval) => approval.status === "expired")).toBe(
      true,
    );
    const detail = await application.getWorkflowInstanceDetail(instance.id);
    expect(detail.instance.status).toBe("blocked");
    expect(detail.audit.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        "approval.reminded",
        "approval.escalated",
        "approval.expired",
      ]),
    );
  });
});
