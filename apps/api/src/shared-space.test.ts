import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InjectOptions } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  legacyTaskExecutionPolicy,
  taskExecutionPolicySchema,
  type Agent,
  type Project,
  type SharedSpaceEntry,
  type SharedSpaceFileContent,
  type SharedSpaceFileList,
  type SharedSpacePermissionPreview,
  type SharedSpacePolicy,
  type SharedSpaceVersion,
  type SharedSpaceWorkspace,
  type SharedSpaceWriteRequest,
  type Task,
  type WorkspaceDetail,
} from "@pluginmax/contracts";
import { Database, PlatformRepositories, migrate } from "@pluginmax/database";
import { buildApi } from "./app.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl === undefined ? describe.skip : describe;

integration("Shared Space API and controlled writes", () => {
  let database: Database;
  let repositories: PlatformRepositories;
  let built: ReturnType<typeof buildApi>;
  let app: ReturnType<typeof buildApi>["app"];

  beforeAll(async () => {
    database = new Database(databaseUrl!);
    repositories = new PlatformRepositories(database);
    await migrate(database);
    built = buildApi({
      databaseUrl: databaseUrl!,
      database,
      fileStoreRoot: await mkdtemp(join(tmpdir(), "pluginmax-shared-space-")),
      logger: false,
      localActorId: "local-admin",
      authMode: "local-development",
    });
    app = built.app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  async function request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    actorId = "local-admin",
  ): Promise<{
    statusCode: number;
    body: T;
    headers: Record<string, unknown>;
  }> {
    const options: InjectOptions = {
      method,
      url,
      headers: { "x-pluginmax-actor": actorId },
    };
    if (payload !== undefined) {
      options.payload = payload as Record<string, unknown>;
    }
    const response = await app.inject(options);
    return {
      statusCode: response.statusCode,
      body:
        response.headers["content-type"]
          ?.toString()
          .includes("application/json") === true
          ? (response.json() as T)
          : (response.body as T),
      headers: response.headers,
    };
  }

  async function createWorkspace(
    displayName = `Shared ${randomUUID().slice(0, 8)}`,
    id?: string,
  ): Promise<WorkspaceDetail> {
    const response = await request<WorkspaceDetail>(
      "POST",
      "/api/v1/workspaces",
      {
        displayName,
        ...(id === undefined ? {} : { id }),
      },
    );
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  async function ensureActor(actorId: string): Promise<void> {
    const response = await request("GET", "/api/v1/viewer", undefined, actorId);
    expect(response.statusCode).toBe(200);
  }

  async function createPolicy(
    workspaceId: string,
    input: {
      readonly pathPattern: string;
      readonly permissions?: Array<"list" | "read" | "write" | "delete">;
      readonly effect?: "allow" | "deny";
      readonly subjectKind?: "principal" | "workspace-role";
      readonly subjectId?: string;
    },
  ): Promise<SharedSpacePolicy> {
    const response = await request<SharedSpacePolicy>(
      "POST",
      `/api/v1/workspaces/${workspaceId}/shared-space/policies`,
      {
        subjectKind: input.subjectKind ?? "workspace-role",
        subjectId: input.subjectId ?? "ADMIN",
        pathPattern: input.pathPattern,
        permissions: input.permissions ?? ["list", "read", "write", "delete"],
        effect: input.effect ?? "allow",
        expiresAt: null,
      },
    );
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  async function upload(
    workspaceId: string,
    path: string,
    content: string,
    expectedVersion = 0,
  ): Promise<SharedSpaceEntry> {
    const response = await request<SharedSpaceEntry>(
      "POST",
      `/api/v1/workspaces/${workspaceId}/shared-space/files`,
      {
        path,
        name: path.split("/").at(-1),
        mimeType: "text/markdown",
        contentBase64: Buffer.from(content).toString("base64"),
        expectedVersion,
      },
    );
    expect(response.statusCode, JSON.stringify(response.body)).toBe(201);
    return response.body;
  }

  it("defaults to read-only and preserves revision, download, version and lock boundaries", async () => {
    const workspace = await createWorkspace();
    const workspaceId = workspace.workspace.id;
    const initial = await request<SharedSpaceWorkspace>(
      "GET",
      `/api/v1/workspaces/${workspaceId}/shared-space`,
    );
    expect(initial.statusCode).toBe(200);
    expect(initial.body.root.defaultRead).toBe(true);
    expect(initial.body.root.defaultWrite).toBe(false);
    expect(initial.body.canWrite).toBe(false);

    const deniedDirectory = await request(
      "POST",
      `/api/v1/workspaces/${workspaceId}/shared-space/directories`,
      { path: "plans" },
    );
    expect(deniedDirectory.statusCode).toBe(403);
    expect(deniedDirectory.body).toMatchObject({
      code: "shared_space_forbidden",
    });

    await createPolicy(workspaceId, { pathPattern: "plans/**" });
    const directory = await request<SharedSpaceEntry>(
      "POST",
      `/api/v1/workspaces/${workspaceId}/shared-space/directories`,
      { path: "plans" },
    );
    expect(directory.statusCode).toBe(201);

    const first = await upload(
      workspaceId,
      "plans/status.md",
      "# Status\nv1\n",
    );
    expect(first.currentVersion).toBe(1);
    const updated = await request<SharedSpaceEntry>(
      "PUT",
      `/api/v1/workspaces/${workspaceId}/shared-space/files/${first.id}/content`,
      {
        contentBase64: Buffer.from("# Status\nv2\n").toString("base64"),
        expectedVersion: 1,
        lockId: null,
      },
    );
    expect(updated.statusCode).toBe(200);
    expect(updated.body.currentVersion).toBe(2);

    const conflict = await request(
      "PUT",
      `/api/v1/workspaces/${workspaceId}/shared-space/files/${first.id}/content`,
      {
        contentBase64: Buffer.from("# Status\nstale\n").toString("base64"),
        expectedVersion: 1,
        lockId: null,
      },
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).toMatchObject({
      code: "shared_space_version_conflict",
    });

    const content = await request<SharedSpaceFileContent>(
      "GET",
      `/api/v1/workspaces/${workspaceId}/shared-space/files/${first.id}/content`,
    );
    expect(content.statusCode).toBe(200);
    expect(
      Buffer.from(content.body.contentBase64, "base64").toString("utf8"),
    ).toBe("# Status\nv2\n");

    const versions = await request<{ items: SharedSpaceVersion[] }>(
      "GET",
      `/api/v1/workspaces/${workspaceId}/shared-space/files/${first.id}/versions`,
    );
    expect(versions.body.items.map((version) => version.version)).toEqual([
      2, 1,
    ]);

    const downloaded = await request<string>(
      "GET",
      `/api/v1/workspaces/${workspaceId}/shared-space/files/${first.id}/download`,
    );
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.body).toBe("# Status\nv2\n");
    expect(downloaded.headers["content-disposition"]).toContain("attachment");

    const lock = await request<{ id: string }>(
      "POST",
      `/api/v1/workspaces/${workspaceId}/shared-space/locks`,
      {
        path: "plans/status.md",
        mode: "exclusive",
        leaseSeconds: 60,
        sessionId: "browser:local-admin",
      },
    );
    expect(lock.statusCode).toBe(201);

    await ensureActor("reviewer-admin");
    const member = await request(
      "POST",
      `/api/v1/workspaces/${workspaceId}/members`,
      {
        principalId: "reviewer-admin",
      },
    );
    expect(member.statusCode).toBe(201);
    const grant = await request(
      "POST",
      `/api/v1/workspaces/${workspaceId}/grants`,
      {
        principalId: "reviewer-admin",
        roleKey: "ADMIN",
        expiresAt: null,
      },
    );
    expect(grant.statusCode).toBe(201);
    const competingLock = await request(
      "POST",
      `/api/v1/workspaces/${workspaceId}/shared-space/locks`,
      {
        path: "plans/status.md",
        mode: "exclusive",
        leaseSeconds: 60,
        sessionId: "browser:reviewer-admin",
      },
      "reviewer-admin",
    );
    expect(competingLock.statusCode).toBe(409);
    expect(competingLock.body).toMatchObject({
      code: "shared_space_lock_conflict",
    });

    const release = await request(
      "DELETE",
      `/api/v1/workspaces/${workspaceId}/shared-space/locks/${lock.body.id}`,
    );
    expect(release.statusCode).toBe(200);

    const audit = await request<{
      items: Array<{ action: string; metadata: Record<string, unknown> }>;
    }>("GET", `/api/v1/workspaces/${workspaceId}/shared-space/audit?limit=100`);
    expect(audit.statusCode).toBe(200);
    expect(audit.body.items.map((event) => event.action)).toContain(
      "file.write",
    );
    expect(JSON.stringify(audit.body)).not.toContain("# Status");
  });

  it("enforces deny-wins, path escape, symlink-safe storage, secret scan and MIME rules", async () => {
    const workspace = await createWorkspace();
    const workspaceId = workspace.workspace.id;
    await createPolicy(workspaceId, { pathPattern: "research/**" });
    await createPolicy(workspaceId, {
      pathPattern: "research/confidential.md",
      permissions: ["read"],
      effect: "deny",
    });
    const researchDirectory = await request(
      "POST",
      `/api/v1/workspaces/${workspaceId}/shared-space/directories`,
      { path: "research" },
    );
    expect(researchDirectory.statusCode).toBe(201);
    const secretFile = await upload(
      workspaceId,
      "research/confidential.md",
      "internal only",
    );
    const deniedRead = await request(
      "GET",
      `/api/v1/workspaces/${workspaceId}/shared-space/files/${secretFile.id}/content`,
    );
    expect(deniedRead.statusCode).toBe(403);
    expect(deniedRead.body).toMatchObject({ code: "shared_space_forbidden" });

    const traversal = await request(
      "POST",
      `/api/v1/workspaces/${workspaceId}/shared-space/directories`,
      { path: "../escape" },
    );
    expect(traversal.statusCode).toBe(403);
    expect(traversal.body).toMatchObject({ code: "shared_space_path_escape" });

    const secret = await request(
      "POST",
      `/api/v1/workspaces/${workspaceId}/shared-space/files`,
      {
        path: "research/leak.md",
        name: "leak.md",
        mimeType: "text/markdown",
        contentBase64: Buffer.from(
          "password=super-secret-password\nAKIAABCDEFGHIJKLMNOP",
        ).toString("base64"),
        expectedVersion: 0,
      },
    );
    expect(secret.statusCode).toBe(422);
    expect(secret.body).toMatchObject({ code: "shared_space_secret_detected" });

    const active = await request(
      "POST",
      `/api/v1/workspaces/${workspaceId}/shared-space/files`,
      {
        path: "research/script.js",
        name: "script.js",
        mimeType: "text/plain",
        contentBase64: Buffer.from("alert(1)").toString("base64"),
        expectedVersion: 0,
      },
    );
    expect(active.statusCode).toBe(415);
    expect(active.body).toMatchObject({ code: "shared_space_mime_rejected" });

    const preview = await request<SharedSpacePermissionPreview>(
      "POST",
      `/api/v1/workspaces/${workspaceId}/shared-space/policy-preview`,
      {
        principalId: "local-admin",
        path: "research/confidential.md",
      },
    );
    expect(preview.statusCode).toBe(200);
    expect(preview.body.permissions.read).toBe(false);
    expect(preview.body.deniedPolicyIds.length).toBe(1);
  });

  it("fails closed across Workspaces, non-members and revoked Grants without ADMIN bypass", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    await createPolicy(workspaceA.workspace.id, { pathPattern: "**" });
    const file = await upload(workspaceA.workspace.id, "shared.md", "A only");

    const crossWorkspace = await request(
      "GET",
      `/api/v1/workspaces/${workspaceB.workspace.id}/shared-space/files/${file.id}`,
    );
    expect(crossWorkspace.statusCode).toBe(404);

    const nonMember = await request(
      "GET",
      `/api/v1/workspaces/${workspaceA.workspace.id}/shared-space`,
      undefined,
      "outside-member",
    );
    expect(nonMember.statusCode).toBe(403);

    const platformAdminWithoutGrant = await request(
      "GET",
      `/api/v1/workspaces/${workspaceA.workspace.id}/shared-space`,
      undefined,
      "outside-member",
    );
    expect(platformAdminWithoutGrant.statusCode).toBe(403);

    await ensureActor("revoked-member");
    await request(
      "POST",
      `/api/v1/workspaces/${workspaceA.workspace.id}/members`,
      { principalId: "revoked-member" },
    );
    const grant = await request<{ id: string; version: number }>(
      "POST",
      `/api/v1/workspaces/${workspaceA.workspace.id}/grants`,
      {
        principalId: "revoked-member",
        roleKey: "ADMIN",
        expiresAt: null,
      },
    );
    const beforeRevoke = await request(
      "GET",
      `/api/v1/workspaces/${workspaceA.workspace.id}/shared-space`,
      undefined,
      "revoked-member",
    );
    expect(beforeRevoke.statusCode).toBe(200);
    const revoked = await request(
      "POST",
      `/api/v1/workspaces/${workspaceA.workspace.id}/grants/${grant.body.id}/revoke`,
      { expectedVersion: grant.body.version, reason: "test revoke" },
    );
    expect(revoked.statusCode).toBe(200);
    const afterRevoke = await request(
      "GET",
      `/api/v1/workspaces/${workspaceA.workspace.id}/shared-space`,
      undefined,
      "revoked-member",
    );
    expect(afterRevoke.statusCode).toBe(403);

    await ensureActor("expired-member");
    await request(
      "POST",
      `/api/v1/workspaces/${workspaceA.workspace.id}/members`,
      { principalId: "expired-member" },
    );
    const expiringGrant = await request<{ id: string }>(
      "POST",
      `/api/v1/workspaces/${workspaceA.workspace.id}/grants`,
      {
        principalId: "expired-member",
        roleKey: "ADMIN",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    );
    expect(expiringGrant.statusCode).toBe(201);
    await database.query(
      `UPDATE role_grants
       SET granted_at = created_at - INTERVAL '2 hours',
           expires_at = created_at - INTERVAL '1 hour',
           updated_at = GREATEST(updated_at, created_at, NOW())
       WHERE id = $1`,
      [expiringGrant.body.id],
    );
    const afterExpiry = await request(
      "GET",
      `/api/v1/workspaces/${workspaceA.workspace.id}/shared-space`,
      undefined,
      "expired-member",
    );
    expect(afterExpiry.statusCode).toBe(403);

    const platformOnlyWorkspaceId = `platform-only-${randomUUID().slice(0, 8)}`;
    const platformOnlyOwner = `platform-owner-${randomUUID().slice(0, 8)}`;
    await database.query(
      `INSERT INTO principals (
         id, kind, display_name, status, status_authority, source,
         version, created_at, updated_at
       ) VALUES ($1, 'human', 'Platform-only Owner', 'active',
                 'account', 'account', 1, NOW(), NOW())`,
      [platformOnlyOwner],
    );
    await database.query(
      `INSERT INTO workspaces (
         id, display_name, status, created_by_principal_id, version,
         created_at, updated_at
       ) VALUES ($1, 'Platform-only Workspace', 'active', $2, 1, NOW(), NOW())`,
      [platformOnlyWorkspaceId, platformOnlyOwner],
    );
    await database.query(
      `INSERT INTO workspace_members (
         id, workspace_id, principal_id, status, version, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', 1, NOW(), NOW())`,
      [randomUUID(), platformOnlyWorkspaceId, platformOnlyOwner],
    );
    await database.query(
      `INSERT INTO role_grants (
         id, principal_id, scope_type, scope_id, role_key, permissions,
         status, source_kind, source_ref, granted_by_principal_id,
         revoked_by_principal_id, granted_at, expires_at, revoked_at,
         version, created_at, updated_at
       ) VALUES (
         $1, $2, 'workspace', $3, 'ADMIN',
         '["read","manage_roles"]'::jsonb, 'active', 'workspace-role',
         'platform-bypass-fixture', NULL, NULL, NOW(), NULL, NULL, 1,
         NOW(), NOW()
       )`,
      [randomUUID(), platformOnlyOwner, platformOnlyWorkspaceId],
    );
    const platformAdminDenied = await request(
      "GET",
      `/api/v1/workspaces/${platformOnlyWorkspaceId}/shared-space`,
      undefined,
      "local-admin",
    );
    expect(platformAdminDenied.statusCode).toBe(403);
  });

  it("approves and consumes a Global Write request exactly once", async () => {
    await ensureActor("outside-member");
    const workspace = await createWorkspace();
    const workspaceId = workspace.workspace.id;
    const submitted = await request<{ request: SharedSpaceWriteRequest }>(
      "POST",
      "/api/v1/shared-space/global-write-requests",
      {
        workspaceId,
        path: `reports/global-${randomUUID().slice(0, 8)}.md`,
        name: "global-summary.md",
        mimeType: "text/markdown",
        contentBase64: Buffer.from("# Global summary\n").toString("base64"),
        expectedVersion: 0,
        purpose: "Cross-workspace summary",
        scope: "global",
        lockId: null,
      },
    );
    expect(submitted.statusCode).toBe(201);
    expect(submitted.body.request.status).toBe("pending");
    expect(submitted.body.request.gateId).toBeNull();

    const approved = await request<SharedSpaceWriteRequest>(
      "POST",
      `/api/v1/workspaces/${workspaceId}/shared-space/write-requests/${submitted.body.request.id}/decision`,
      { decision: "approve", basis: "Verified Global Write scope" },
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.body.status).toBe("approved");

    const firstRecovery = await built.sharedSpace.recoverApprovedWrites();
    expect(firstRecovery.written).toBe(1);
    const secondRecovery = await built.sharedSpace.recoverApprovedWrites();
    expect(secondRecovery.written).toBe(0);
    const global = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM shared_space_global_files
       WHERE request_id = $1`,
      [submitted.body.request.id],
    );
    expect(global.rows[0]?.count).toBe(1);
  });

  it("binds Agent writes to Scene, Action Ticket, Gate and Worker recovery", async () => {
    const projectResponse = await request<Project>("POST", "/api/v1/projects", {
      name: `Shared agent ${randomUUID().slice(0, 8)}`,
      description: "Shared Space Agent Gate fixture",
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.body;
    const workspace = await createWorkspace("Agent Shared Space", project.id);

    const agentResponse = await request<Agent>("POST", "/api/v1/agents", {
      name: `Shared agent ${randomUUID().slice(0, 8)}`,
      runtimeKind: "fake",
    });
    expect(agentResponse.statusCode).toBe(201);
    const agent = agentResponse.body;
    const member = await request(
      "POST",
      `/api/v1/projects/${project.id}/members`,
      {
        kind: "agent",
        agentId: agent.id,
        responsibility: "Shared Space writer",
        roleIds: [],
      },
    );
    expect(member.statusCode).toBe(201);

    const principal = await database.query<{ principal_id: string }>(
      "SELECT principal_id FROM agents WHERE id = $1",
      [agent.id],
    );
    const agentPrincipalId = principal.rows[0]?.principal_id;
    expect(agentPrincipalId).toBeTruthy();

    await request(
      "POST",
      `/api/v1/workspaces/${workspace.workspace.id}/members`,
      { principalId: agentPrincipalId },
    );
    const grant = await request(
      "POST",
      `/api/v1/workspaces/${workspace.workspace.id}/grants`,
      {
        principalId: agentPrincipalId,
        roleKey: "ADMIN",
        expiresAt: null,
      },
    );
    expect(grant.statusCode).toBe(201);
    await createPolicy(workspace.workspace.id, {
      subjectKind: "principal",
      subjectId: agentPrincipalId!,
      pathPattern: "agent/**",
    });
    await createPolicy(workspace.workspace.id, {
      pathPattern: "agent/**",
    });
    const agentDirectory = await request(
      "POST",
      `/api/v1/workspaces/${workspace.workspace.id}/shared-space/directories`,
      { path: "agent" },
    );
    expect(agentDirectory.statusCode).toBe(201);

    const taskResponse = await request<Task>("POST", "/api/v1/tasks", {
      projectId: project.id,
      title: `Shared Space write ${randomUUID().slice(0, 8)}`,
      description: "Request an approved Agent file write",
      agentId: agent.id,
    });
    expect(taskResponse.statusCode).toBe(201);
    const task = taskResponse.body;
    const policy = taskExecutionPolicySchema.parse({
      ...legacyTaskExecutionPolicy(),
      runtime: {
        selection: "recommended",
        allowedRuntimeIds: ["builtin:fake"],
        requiredCapabilities: [],
      },
      budget: { timeoutMs: 30_000 },
    });
    const setPolicy = await request(
      "PUT",
      `/api/v1/tasks/${task.id}/execution-policy`,
      { expectedRevision: 0, policy },
    );
    expect(setPolicy.statusCode).toBe(200);
    const dispatched = await request<{ runId: string }>(
      "POST",
      `/api/v1/tasks/${task.id}/dispatch`,
    );
    expect(dispatched.statusCode).toBe(202);
    const ticket = await repositories.actionTickets.getByRun(
      dispatched.body.runId,
    );
    expect(ticket?.executionEnvelope.agentPrincipalId).toBe(agentPrincipalId);

    const sceneSessionId = randomUUID();
    await database.query(
      `INSERT INTO scene_sessions (
         id, scene_type, scene_id, project_id, agent_id, agent_principal_id,
         owner_principal_id, principal_scope, channel_id, session_handle,
         generation, status, created_at, updated_at
       ) VALUES (
         $1, 'task', $2, $3, $4, $5, 'local-admin', '', NULL, $6,
         0, 'active', NOW(), NOW()
       )`,
      [
        sceneSessionId,
        task.id,
        project.id,
        agent.id,
        agentPrincipalId,
        `shared-space-scene-${sceneSessionId}`,
      ],
    );
    await expect(
      built.sharedSpace.invokeAgentTool({
        tool: "shared_space_list",
        context: {
          principalId: agentPrincipalId!,
          runId: dispatched.body.runId,
          sceneSessionId,
          ticketId: ticket!.ticketId,
        },
        payload: {
          workspaceId: workspace.workspace.id,
          path: "agent",
          storageKey: "must-not-be-accepted",
        },
        idempotencyKey: `agent-list-${task.id}`,
      }),
    ).rejects.toThrow();
    const requestResult = (await built.sharedSpace.invokeAgentTool({
      tool: "shared_space_write",
      context: {
        principalId: agentPrincipalId!,
        runId: dispatched.body.runId,
        sceneSessionId,
        ticketId: ticket!.ticketId,
      },
      payload: {
        workspaceId: workspace.workspace.id,
        path: "agent/report.md",
        name: "report.md",
        mimeType: "text/markdown",
        contentBase64: Buffer.from("# Agent report\n").toString("base64"),
        expectedVersion: 0,
        purpose: "Publish approved Agent report",
        lockId: null,
      },
      idempotencyKey: `agent-write-${task.id}`,
    })) as { request: SharedSpaceWriteRequest };
    expect(requestResult.request.status).toBe("pending");
    expect(requestResult.request.gateId).toBeTruthy();

    const approved = await request<SharedSpaceWriteRequest>(
      "POST",
      `/api/v1/workspaces/${workspace.workspace.id}/shared-space/write-requests/${requestResult.request.id}/decision`,
      { decision: "approve", basis: "Verified Scene and Action Ticket" },
    );
    expect(approved.statusCode, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body.status).toBe("approved");

    const recovery = await built.sharedSpace.recoverApprovedWrites();
    expect(recovery.written).toBe(1);
    const list = await request<SharedSpaceFileList>(
      "GET",
      `/api/v1/workspaces/${workspace.workspace.id}/shared-space/files?path=agent`,
    );
    expect(list.statusCode).toBe(200);
    expect(list.body.entries).toHaveLength(1);
    expect(list.body.entries[0]?.path).toBe("agent/report.md");
  });
});
