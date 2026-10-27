import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CreateTeammateInput } from "@pluginmax/contracts";
import { Database, migrate } from "./index.js";
import { TeammateRepository } from "./teammate-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("TeammateRepository PostgreSQL semantics", () => {
  async function setup() {
    const database = new Database(databaseUrl!);
    await migrate(database);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const ownerId = `principal-owner-${suffix}`;
    const aiPrincipalId = `principal-ai-${suffix}`;
    const agentId = randomUUID();
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES
         ($1, 'human', 'Owner', 'active', 'system', 'local', 1, NOW(), NOW()),
         ($2, 'ai', 'AI teammate', 'active', 'system', 'agent', 1, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [ownerId, aiPrincipalId],
    );
    await database.query(
      `INSERT INTO projects (
         id, name, code, description, status, created_at, updated_at
       ) VALUES
         ($1, 'Teammate project', $3, '', 'active', NOW(), NOW()),
         ($2, 'Other project', $4, '', 'active', NOW(), NOW())`,
      [projectId, otherProjectId, `TM-${suffix}`, `TM-OTHER-${suffix}`],
    );
    await database.query(
      `INSERT INTO agents (
         id, name, description, runtime_kind, status, source, owner_id,
         principal_id, version, created_at, updated_at
       ) VALUES (
         $1, 'Execution agent', '', 'fake', 'active', 'personal', $2,
         $3, 1, NOW(), NOW()
       )`,
      [agentId, ownerId, aiPrincipalId],
    );
    const repository = new TeammateRepository(database);
    return {
      database,
      repository,
      suffix,
      projectId,
      otherProjectId,
      ownerId,
      aiPrincipalId,
      agentId,
    };
  }

  it("versions templates monotonically and rejects version mutation", async () => {
    const context = await setup();
    try {
      const template = await context.repository.createTemplate({
        projectId: context.projectId,
        workspaceId: context.projectId,
        actorPrincipalId: context.ownerId,
        template: {
          projectId: context.projectId,
          scope: "personal",
          definition: {
            name: "Research template",
            role: "Analyst",
            description: "",
            soul: "",
            scenarios: [],
            goals: [],
            tools: ["search"],
          },
        },
      });
      const revised = await context.repository.updateTemplate({
        templateId: template.id,
        actorPrincipalId: context.ownerId,
        expectedVersion: 1,
        definition: {
          ...template.definition,
          description: "revision two",
          tools: ["search", "file-read"],
        },
      });
      expect(revised).toMatchObject({ currentVersion: 2 });
      await expect(
        context.repository.updateTemplate({
          templateId: template.id,
          actorPrincipalId: context.ownerId,
          expectedVersion: 1,
          definition: template.definition,
        }),
      ).resolves.toBe("revision_conflict");
      const versions = await context.repository.listTemplateVersions(
        template.id,
      );
      expect(versions.map((version) => version.version)).toEqual([2, 1]);
      await expect(
        context.database.query(
          `UPDATE teammate_template_versions
           SET definition = '{}'::jsonb
           WHERE id = $1`,
          [versions[0]!.id],
        ),
      ).rejects.toThrow("immutable");
    } finally {
      await context.database.close();
    }
  });

  it("pins instance template scope and keeps queue order deterministic", async () => {
    const context = await setup();
    try {
      const template = await context.repository.createTemplate({
        projectId: context.projectId,
        workspaceId: context.projectId,
        actorPrincipalId: context.ownerId,
        template: {
          projectId: context.projectId,
          scope: "personal",
          definition: {
            name: "Queue template",
            role: "Operator",
            description: "",
            soul: "",
            scenarios: [],
            goals: [],
            tools: [],
          },
        },
      });
      const teammateInput: CreateTeammateInput = {
        projectId: context.projectId,
        templateId: template.id,
        agentId: context.agentId,
        autoExecute: true,
      };
      const teammate = await context.repository.createTeammate({
        teammate: teammateInput,
        workspaceId: context.projectId,
        actorPrincipalId: context.ownerId,
        agent: {
          id: context.agentId,
          principalId: context.aiPrincipalId,
        },
        name: "Queue operator",
      });
      await expect(
        context.repository.createTeammate({
          teammate: {
            ...teammateInput,
            projectId: context.otherProjectId,
            templateId: template.id,
          },
          workspaceId: context.otherProjectId,
          actorPrincipalId: context.ownerId,
          agent: {
            id: context.agentId,
            principalId: context.aiPrincipalId,
          },
          name: "Cross project",
        }),
      ).rejects.toThrow("does not match instance scope");

      const plan = await context.repository.createWorkPlan({
        teammate,
        actorPrincipalId: context.ownerId,
        instruction: "two tasks",
        autoExecuteEligible: true,
        items: [
          {
            title: "First",
            description: "First task",
            acceptance: ["Done"],
            priority: "high",
          },
          {
            title: "Second",
            description: "Second task",
            acceptance: ["Done"],
            priority: "low",
          },
        ],
      });
      const reordered = await context.repository.reorderWorkQueue(teammate.id, [
        plan.taskIds[1]!,
        plan.taskIds[0]!,
      ]);
      expect(reordered.map((item) => item.taskId)).toEqual([
        plan.taskIds[1],
        plan.taskIds[0],
      ]);
      await expect(
        context.repository.reorderWorkQueue(teammate.id, [plan.taskIds[0]!]),
      ).rejects.toThrow("every active item");
    } finally {
      await context.database.close();
    }
  });
});
