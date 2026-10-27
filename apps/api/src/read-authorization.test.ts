import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalFileStore } from "@pluginmax/files";
import {
  Database,
  IdentityRepository,
  hashIdentityPassword,
  migrate,
} from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

interface AccountFixture {
  readonly principalId: string;
  readonly accountId: string;
  readonly loginId: string;
  readonly password: string;
  readonly token: string;
}

interface ResourceFixture {
  readonly taskId: string;
  readonly runId: string;
  readonly traceId: string;
  readonly artifactId: string;
  readonly attachmentId: string;
  readonly workflowId: string;
  readonly workflowInstanceId: string;
  readonly meetingId: string;
  readonly memoryTopicId: string;
  readonly reportId: string;
  readonly handoffId: string;
}

integration("RBAC read authorization API", () => {
  let database: Database;
  let app: ReturnType<typeof buildApi>["app"];
  let fileStore: LocalFileStore;
  let suffix: string;
  let admin: AccountFixture;
  let owner: AccountFixture;
  let reader: AccountFixture;
  let outsider: AccountFixture;
  let revoked: AccountFixture;
  let expired: AccountFixture;
  let workspaceOnly: AccountFixture;
  let disabled: AccountFixture;
  let archived: AccountFixture;
  let projectId: string;
  let otherProjectId: string;
  let primary: ResourceFixture;
  let other: ResourceFixture;

  function auth(token: string): { authorization: string } {
    return { authorization: `Bearer ${token}` };
  }

  async function insertAccount(
    label: string,
    password: string,
  ): Promise<Omit<AccountFixture, "token">> {
    const principalId = `principal-human-${label}-${suffix}`;
    const accountId = `account-${label}-${suffix}`;
    const loginId = `${label}-${suffix}`;
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES ($1, 'human', $2, 'active', 'account', 'account',
                 1, NOW(), NOW())`,
      [principalId, `${label} Read Principal`],
    );
    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_at, version,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'platform', 'platform', 'MEMBER',
         '["platform.access"]'::jsonb, 'active', 'manual',
         'batch14d-read-api', NOW(), 1, NOW(), NOW()
       )`,
      [randomUUID(), principalId],
    );
    await database.query(
      `INSERT INTO accounts (
         id, principal_id, login_id, status, version, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', 1, NOW(), NOW())`,
      [accountId, principalId, loginId],
    );
    await database.query(
      `INSERT INTO account_credentials (
         id, account_id, credential_type, secret_scheme, secret_hash,
         status, expires_at, last_authenticated_at, version,
         created_at, updated_at
       ) VALUES ($1, $2, 'password', 'scrypt', $3, 'active',
                 NULL, NULL, 1, NOW(), NOW())`,
      [randomUUID(), accountId, await hashIdentityPassword(password)],
    );
    return { principalId, accountId, loginId, password };
  }

  async function login(
    fixture: Omit<AccountFixture, "token">,
  ): Promise<AccountFixture> {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        loginId: fixture.loginId,
        password: fixture.password,
      },
    });
    expect(response.statusCode).toBe(200);
    return { ...fixture, token: response.json().token as string };
  }

  async function createProject(account: AccountFixture, label: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: auth(account.token),
      payload: {
        name: `${label} ${suffix}`,
        description: "Batch 14D read authorization fixture",
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  async function addMember(
    project: string,
    account: AccountFixture,
    roleIds: readonly string[],
    label: string,
  ): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project}/members`,
      headers: auth(owner.token),
      payload: {
        kind: "human",
        actorId: account.principalId,
        name: label,
        responsibility: "Batch 14D read matrix",
        roleIds,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  }

  async function seedResources(
    project: string,
    label: string,
  ): Promise<ResourceFixture> {
    const taskId = randomUUID();
    const runId = randomUUID();
    const traceId = randomUUID().replaceAll("-", "");
    const artifactId = randomUUID();
    const attachmentId = randomUUID();
    const workflowId = randomUUID();
    const workflowInstanceId = randomUUID();
    const meetingId = randomUUID();
    const memoryTopicId = randomUUID();
    const reportId = randomUUID();
    const handoffId = randomUUID();
    const content = Buffer.from(`batch14d-${label}`);
    const stored = await fileStore.put({
      workspaceId: "batch14d-read-api",
      name: `${label}.txt`,
      mimeType: "text/plain",
      content,
    });
    await database.query(
      `INSERT INTO tasks (
         id, project_id, title, description, acceptance, status,
         agent_id, created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'Read authorization fixture', '[]'::jsonb, 'queued',
         '00000000-0000-4000-8000-000000000001', NOW(), NOW()
       )`,
      [taskId, project, `${label} task`],
    );
    await database.query(
      `INSERT INTO runs (
         id, project_id, task_id, agent_id, status, input_snapshot,
         observability, trace_id, created_at, updated_at, ended_at
       ) VALUES (
         $1, $2, $3, '00000000-0000-4000-8000-000000000001',
         'interrupted',
         '{"taskTitle":"Read fixture","taskDescription":"Read fixture","acceptance":[],"instruction":"Read fixture","agentName":"Fake Research Agent","runtimeKind":"fake"}'::jsonb,
         '{"planVisibility":"structured","toolEventCompleteness":"complete","textStreaming":"delta","subagentVisibility":"none"}'::jsonb,
         $4, NOW(), NOW(), NOW()
       )`,
      [runId, project, taskId, traceId],
    );
    await database.query(
      `INSERT INTO artifacts (
         id, run_id, project_id, name, mime_type, size, sha256,
         storage_key, created_at
       ) VALUES ($1, $2, $3, $4, 'text/plain', $5, $6, $7, NOW())`,
      [
        artifactId,
        runId,
        project,
        stored.name,
        stored.size,
        stored.sha256,
        stored.storageKey,
      ],
    );
    await database.query(
      `INSERT INTO task_attachments (
         id, task_id, project_id, name, mime_type, size, sha256,
         storage_key, uploaded_by, archived_at, created_at
       ) VALUES ($1, $2, $3, $4, 'text/plain', $5, $6, $7, $8, NULL, NOW())`,
      [
        attachmentId,
        taskId,
        project,
        stored.name,
        stored.size,
        stored.sha256,
        stored.storageKey,
        owner.principalId,
      ],
    );
    await database.query(
      `INSERT INTO workflow_definitions (
         id, project_id, name, description, steps, status,
         created_at, updated_at
       ) VALUES ($1, $2, $3, '', '[]'::jsonb, 'active', NOW(), NOW())`,
      [workflowId, project, `${label} workflow`],
    );
    await database.query(
      `INSERT INTO workflow_instances (
         id, workflow_id, project_id, title, status, current_step,
         steps, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, 'active', 0, '[]'::jsonb, NOW(), NOW())`,
      [workflowInstanceId, workflowId, project, `${label} workflow instance`],
    );
    await database.query(
      `INSERT INTO meetings (
         id, project_id, title, agenda, status, participants, summary,
         created_at, updated_at
       ) VALUES ($1, $2, $3, '', 'open', '[]'::jsonb, '', NOW(), NOW())`,
      [meetingId, project, `${label} meeting`],
    );
    await database.query(
      `INSERT INTO meeting_minutes_drafts (
         id, meeting_id, project_id, content, decisions, source_message_ids,
         revision, updated_by, created_at, updated_at
       ) VALUES (
         $1, $2, $3, '', '[]'::jsonb, '{}'::uuid[], 0,
         $4, NOW(), NOW()
       )`,
      [randomUUID(), meetingId, project, owner.principalId],
    );
    await database.query(
      `INSERT INTO memory_topics (
         id, project_id, title, created_at, updated_at
       ) VALUES ($1, $2, $3, NOW(), NOW())`,
      [memoryTopicId, project, `${label} memory`],
    );
    await database.query(
      `INSERT INTO project_reports (
         id, project_id, report_date, version, content_hash, snapshot,
         generated_by, generated_at
       ) VALUES (
         $1, $2, '2026-10-26', 1, $3, '{"items":[]}'::jsonb,
         $4, NOW()
       )`,
      [
        reportId,
        project,
        createHash("sha256").update(label).digest("hex"),
        owner.principalId,
      ],
    );
    await database.query(
      `INSERT INTO handoff_cards (
         id, project_id, title, summary, status, version, source_refs,
         created_by, confirmed_by, confirmed_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, 'Read authorization handoff', 'draft', 1,
         '[]'::jsonb, $4, NULL, NULL, NOW(), NOW()
       )`,
      [handoffId, project, `${label} handoff`, owner.principalId],
    );
    return {
      taskId,
      runId,
      traceId,
      artifactId,
      attachmentId,
      workflowId,
      workflowInstanceId,
      meetingId,
      memoryTopicId,
      reportId,
      handoffId,
    };
  }

  async function expectForbidden(
    path: string,
    token: string,
    method = "GET",
  ): Promise<void> {
    const response = await app.inject({
      method: method as "GET",
      url: path,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      code: "forbidden",
      details: { permission: "read" },
    });
  }

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    await migrate(database);
    suffix = randomUUID().slice(0, 8);
    const password = `read-password-${suffix}`;
    const identity = new IdentityRepository(database);
    await identity.bootstrapAdministrator({
      principalId: `principal-human-admin-${suffix}`,
      accountId: `account-admin-${suffix}`,
      loginId: `admin-${suffix}`,
      displayName: "Read Matrix Admin",
      password,
    });
    const adminBase = {
      principalId: `principal-human-admin-${suffix}`,
      accountId: `account-admin-${suffix}`,
      loginId: `admin-${suffix}`,
      password,
    };
    const ownerBase = await insertAccount("owner", password);
    const readerBase = await insertAccount("reader", password);
    const outsiderBase = await insertAccount("outsider", password);
    const revokedBase = await insertAccount("revoked", password);
    const expiredBase = await insertAccount("expired", password);
    const workspaceBase = await insertAccount("workspace", password);
    const disabledBase = await insertAccount("disabled", password);
    const archivedBase = await insertAccount("archived", password);
    const directory = join(
      process.cwd(),
      ".tmp",
      "read-authorization-tests",
      suffix,
    );
    await mkdir(directory, { recursive: true });
    fileStore = new LocalFileStore(join(directory, "files"));
    const built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: join(directory, "files"),
      logger: false,
      authMode: "bearer",
      expectedMigrationVersion: 27,
    });
    app = built.app;
    await app.ready();
    admin = await login(adminBase);
    owner = await login(ownerBase);
    reader = await login(readerBase);
    outsider = await login(outsiderBase);
    revoked = await login(revokedBase);
    expired = await login(expiredBase);
    workspaceOnly = await login(workspaceBase);
    disabled = await login(disabledBase);
    archived = await login(archivedBase);

    projectId = await createProject(owner, "Readable project");
    otherProjectId = await createProject(owner, "Other project");
    const role = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/roles`,
      headers: auth(owner.token),
      payload: {
        code: "READER",
        name: `Reader ${suffix}`,
        category: "execution",
        description: "Read-only Batch 14D role",
        permissions: ["read"],
      },
    });
    expect(role.statusCode).toBe(201);
    const roleId = role.json().id as string;
    await addMember(projectId, reader, [roleId], "Read Member");
    await addMember(projectId, revoked, [roleId], "Revoked Reader");
    await addMember(projectId, expired, [roleId], "Expired Reader");
    await addMember(projectId, workspaceOnly, [], "No Project Grant");
    await addMember(projectId, disabled, [roleId], "Disabled Reader");
    await addMember(projectId, archived, [roleId], "Archived Reader");
    await database.query(
      `UPDATE role_grants
       SET status = 'revoked', revoked_at = NOW(), updated_at = NOW()
       WHERE principal_id = $1 AND scope_type = 'project' AND scope_id = $2
         AND status = 'active'`,
      [revoked.principalId, projectId],
    );
    await database.query(
      `UPDATE role_grants
       SET status = 'expired', granted_at = NOW() - INTERVAL '2 days',
           expires_at = NOW() - INTERVAL '1 day',
           updated_at = GREATEST(NOW(), created_at + INTERVAL '1 millisecond')
       WHERE principal_id = $1 AND scope_type = 'project' AND scope_id = $2
         AND status = 'active'`,
      [expired.principalId, projectId],
    );
    await database.query(
      `INSERT INTO workspace_members (
         id, workspace_id, principal_id, status, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', NOW(), NOW())`,
      [randomUUID(), `workspace-${suffix}`, workspaceOnly.principalId],
    );
    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_at, version,
         created_at, updated_at
       ) VALUES (
         $1, $2, 'workspace', $3, 'MEMBER', '["read"]'::jsonb,
         'active', 'manual', 'batch14d-read-api', NOW(), 1, NOW(), NOW()
       )`,
      [randomUUID(), workspaceOnly.principalId, `workspace-${suffix}`],
    );
    primary = await seedResources(projectId, "primary");
    other = await seedResources(otherProjectId, "other");
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("filters project lists and exposes a consistent capability projection", async () => {
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: auth(reader.token),
    });
    expect(listed.statusCode).toBe(200);
    expect(
      (listed.json().items as Array<{ id: string }>).map((item) => item.id),
    ).toEqual([projectId]);

    const capability = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/capability`,
      headers: auth(reader.token),
    });
    expect(capability.statusCode).toBe(200);
    expect(capability.json()).toMatchObject({
      projectId,
      principalId: reader.principalId,
      capabilities: {
        read: true,
        write: false,
        approve: false,
        manage_members: false,
        manage_roles: false,
      },
      ownerSources: {
        legacy: false,
        grant: false,
        consistent: true,
      },
      grantSource: "grant",
    });

    const ownerCapability = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/capability`,
      headers: auth(owner.token),
    });
    expect(ownerCapability.statusCode).toBe(200);
    expect(ownerCapability.json()).toMatchObject({
      capabilities: {
        read: true,
        write: true,
        approve: true,
        manage_members: true,
        manage_roles: true,
      },
      ownerSources: {
        legacy: true,
        grant: true,
        consistent: true,
      },
    });

    const adminProjects = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: auth(admin.token),
    });
    expect(adminProjects.statusCode).toBe(200);
    expect(adminProjects.json().items).toEqual([]);
    await expectForbidden(`/api/v1/projects/${projectId}`, admin.token);
    await expectForbidden(`/api/v1/projects/${projectId}`, outsider.token);
  });

  it("applies the read matrix to every project-scoped resource", async () => {
    const readable = [
      `/api/v1/projects/${projectId}`,
      `/api/v1/tasks/${primary.taskId}`,
      `/api/v1/tasks/${primary.taskId}/detail`,
      `/api/v1/tasks/${primary.taskId}/runs`,
      `/api/v1/runs/${primary.runId}`,
      `/api/v1/runs/${primary.runId}/events`,
      `/api/v1/runs/${primary.runId}/artifacts`,
      `/api/v1/artifacts/${primary.artifactId}/download`,
      `/api/v1/attachments/${primary.attachmentId}/download`,
      `/api/v1/traces/${primary.traceId}`,
      `/api/v1/workflows?projectId=${projectId}`,
      `/api/v1/workflow-instances?projectId=${projectId}`,
      `/api/v1/workflow-instances/${primary.workflowInstanceId}`,
      `/api/v1/workflow-instances/${primary.workflowInstanceId}/detail`,
      `/api/v1/meetings?projectId=${projectId}`,
      `/api/v1/meetings/${primary.meetingId}`,
      `/api/v1/projects/${projectId}/memory`,
      `/api/v1/projects/${projectId}/reports`,
      `/api/v1/projects/${projectId}/reports/${primary.reportId}`,
      `/api/v1/projects/${projectId}/handoffs`,
      `/api/v1/projects/${projectId}/handoffs/${primary.handoffId}`,
      `/api/v1/runs/${primary.runId}/stream`,
    ];
    for (const path of readable) {
      const response = await app.inject({
        method: "GET",
        url: path,
        headers: auth(reader.token),
      });
      expect(response.statusCode, path).toBe(200);
    }

    const crossProject = [
      `/api/v1/tasks/${other.taskId}`,
      `/api/v1/runs/${other.runId}`,
      `/api/v1/artifacts/${other.artifactId}/download`,
      `/api/v1/attachments/${other.attachmentId}/download`,
      `/api/v1/traces/${other.traceId}`,
      `/api/v1/workflow-instances/${other.workflowInstanceId}`,
      `/api/v1/meetings/${other.meetingId}`,
      `/api/v1/projects/${otherProjectId}/memory`,
      `/api/v1/projects/${otherProjectId}/reports`,
      `/api/v1/projects/${otherProjectId}/handoffs`,
      `/api/v1/runs/${other.runId}/stream`,
    ];
    for (const path of crossProject) {
      await expectForbidden(path, reader.token);
      await expectForbidden(path, admin.token);
    }
    for (const path of readable.slice(0, -1)) {
      await expectForbidden(path, outsider.token);
    }
  });

  it("filters unscoped batches and denies cross-project searches", async () => {
    const tasks = await app.inject({
      method: "GET",
      url: "/api/v1/tasks",
      headers: auth(reader.token),
    });
    expect(tasks.statusCode).toBe(200);
    expect(
      (tasks.json().items as Array<{ projectId: string }>).map(
        (task) => task.projectId,
      ),
    ).toEqual([projectId]);

    await expectForbidden(
      `/api/v1/tasks?projectId=${otherProjectId}`,
      reader.token,
    );
    await expectForbidden(
      `/api/v1/workflows?projectId=${otherProjectId}`,
      reader.token,
    );
    await expectForbidden(
      `/api/v1/meetings?projectId=${otherProjectId}`,
      reader.token,
    );
    await expectForbidden(
      `/api/v1/projects/${otherProjectId}/reports?query=fixture`,
      reader.token,
    );
    const readableFollow = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/follows",
      headers: auth(reader.token),
      payload: {
        targetType: "task",
        targetId: primary.taskId,
        projectId,
        followed: true,
      },
    });
    expect(readableFollow.statusCode).toBe(200);
    const crossProjectFollow = await app.inject({
      method: "POST",
      url: "/api/v1/workbench/follows",
      headers: auth(reader.token),
      payload: {
        targetType: "task",
        targetId: other.taskId,
        projectId: otherProjectId,
        followed: true,
      },
    });
    expect(crossProjectFollow.statusCode).toBe(403);
  });

  it("honors revoked, expired, workspace-only and inactive principals", async () => {
    const readerDashboard = await app.inject({
      method: "GET",
      url: "/api/v1/workbench/dashboard",
      headers: auth(reader.token),
    });
    expect(readerDashboard.statusCode).toBe(200);
    expect(readerDashboard.json()).toMatchObject({ readOnly: false });
    expect(
      (readerDashboard.json().todos as Array<{ projectId: string }>).every(
        (item) => item.projectId === projectId,
      ),
    ).toBe(true);

    for (const [account, reason] of [
      [revoked, "grant_missing"],
      [expired, "grant_missing"],
      [workspaceOnly, "grant_missing"],
    ] as const) {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}`,
        headers: auth(account.token),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: "forbidden",
        details: { reason },
      });
      const dashboard = await app.inject({
        method: "GET",
        url: "/api/v1/workbench/dashboard",
        headers: auth(account.token),
      });
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.json()).toMatchObject({
        readOnly: true,
        todos: [],
        focus: [],
        meetingConclusions: [],
        runExceptions: [],
        projectReports: [],
      });
      const brief = await app.inject({
        method: "GET",
        url: "/api/v1/workbench/brief",
        headers: auth(account.token),
      });
      expect(brief.statusCode).toBe(200);
      const snapshot = brief.json().snapshot as {
        items: Array<{ sourceRefs: unknown[] }>;
        sourceCount: number;
      };
      expect(snapshot.sourceCount).toBe(0);
      expect(snapshot.items.every((item) => item.sourceRefs.length === 0)).toBe(
        true,
      );
    }

    const disable = await app.inject({
      method: "POST",
      url: `/api/v1/accounts/${disabled.accountId}/status`,
      headers: auth(admin.token),
      payload: { status: "disabled" },
    });
    expect(disable.statusCode).toBe(200);
    const disabledRead = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: auth(disabled.token),
    });
    expect(disabledRead.statusCode).toBe(401);

    await database.query(
      `UPDATE principals
       SET status = 'archived', status_authority = 'hrm', updated_at = NOW()
       WHERE id = $1`,
      [archived.principalId],
    );
    const archivedRead = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: auth(archived.token),
    });
    expect(archivedRead.statusCode).toBe(401);
  });

  it("does not accept x-pluginmax-actor as a Bearer substitute", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: {
        ...auth(outsider.token),
        "x-pluginmax-actor": reader.principalId,
      },
    });
    expect(response.statusCode).toBe(403);
  });
});
