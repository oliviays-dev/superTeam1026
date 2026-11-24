import { randomUUID } from "node:crypto";
import {
  Database,
  WorkbenchConfigurationRepository,
} from "../packages/database/src/index.js";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("DATABASE_URL is required");
}

const database = new Database(databaseUrl);
const workbenches = new WorkbenchConfigurationRepository(database);
const actorId = "local-admin";

try {
  await database.query(
    `INSERT INTO principals (
       id, kind, display_name, status, status_authority, source,
       version, created_at, updated_at
     ) VALUES (
       $1, 'human', 'Local Admin', 'active', 'system', 'local',
       1, NOW(), NOW()
     ), (
       'm8-member', 'human', 'M8 Member', 'active', 'system', 'local',
       1, NOW(), NOW()
     )
     ON CONFLICT (id) DO NOTHING`,
    [actorId],
  );

  const clean = await workbenches.ensureDefaultWorkbench(actorId);
  await database.query(
    `UPDATE workbenches SET name = 'Layout E2E' WHERE id = $1`,
    [clean.workbench.id],
  );
  const degraded = await workbenches.createWorkbench(actorId, {
    name: "Degradation E2E",
  });
  const entitlement = await workbenches.createWorkbench(actorId, {
    name: "Entitlement E2E",
  });

  await database.query(
    `UPDATE workbench_panel_instances
     SET enabled = FALSE, updated_at = NOW()
     WHERE layout_id = $1 AND plugin_id = 'supplier'`,
    [degraded.layout.id],
  );
  await database.query(
    `INSERT INTO workbench_panels (
       plugin_id, version, title, trusted_build, status, default_width,
       min_height, max_height, refreshable, build_digest, created_at,
       updated_at
     ) VALUES (
       'legacy.removed', '0.8.0', 'Legacy Removed', TRUE, 'active', 2,
       190, 900, TRUE, repeat('a', 64), NOW(), NOW()
     )
     ON CONFLICT (plugin_id) DO NOTHING`,
  );
  await database.query(
    `INSERT INTO workbench_panel_instances (
       id, layout_id, plugin_id, position, width, height, config, enabled,
       created_at, updated_at
     ) VALUES (
       $1, $2, 'legacy.removed', 100, 2, NULL, '{}'::jsonb, TRUE,
       NOW(), NOW()
     )
     ON CONFLICT (layout_id, plugin_id) DO NOTHING`,
    [randomUUID(), degraded.layout.id],
  );
  await database.query(
    `INSERT INTO workbench_panel_instances (
       id, layout_id, plugin_id, position, width, height, config, enabled,
       created_at, updated_at
     ) VALUES (
       $1, $2, 'market.sample', 100, 3, NULL, '{}'::jsonb, TRUE,
       NOW(), NOW()
     )
     ON CONFLICT (layout_id, plugin_id) DO NOTHING`,
    [randomUUID(), entitlement.layout.id],
  );
  await writePanelSnapshot(
    degraded.workbench.id,
    degraded.layout.id,
    actorId,
  );
  await writePanelSnapshot(
    entitlement.workbench.id,
    entitlement.layout.id,
    actorId,
  );

  await database.query(
    `UPDATE feature_flag_settings
     SET mode = 'on', revision = revision + 1, updated_at = NOW()
     WHERE flag_key IN (
       'workbench.v2',
       'market',
       'market.governance_v2',
       'market.shared_supply'
     )
       AND scope_type = 'platform'
       AND scope_id = 'platform'`,
  );
  await database.query(
    `UPDATE workbenches
     SET updated_at = NOW() + interval '2 seconds'
     WHERE id = $1`,
    [clean.workbench.id],
  );

  process.stdout.write(
    JSON.stringify({
      cleanWorkbenchId: clean.workbench.id,
      degradedWorkbenchId: degraded.workbench.id,
      entitlementWorkbenchId: entitlement.workbench.id,
    }),
  );
} finally {
  await database.close();
}

async function writePanelSnapshot(
  workbenchId: string,
  layoutId: string,
  actorId: string,
): Promise<void> {
  const documentResult = await database.query<{ readonly document: unknown }>(
    `SELECT jsonb_build_object(
       'version', 1,
       'panels', COALESCE(
         jsonb_agg(
           jsonb_build_object(
             'instanceId', instance.id,
             'pluginId', instance.plugin_id,
             'position', instance.position,
             'width', instance.width,
             'height', instance.height,
             'config', instance.config,
             'enabled', instance.enabled
           )
           ORDER BY instance.position, instance.plugin_id
         ),
         '[]'::jsonb
       )
     ) AS document
     FROM workbench_panel_instances AS instance
     WHERE instance.layout_id = $1`,
    [layoutId],
  );
  const document = documentResult.rows[0]!.document;
  const heads = await database.query<{
    readonly layout_revision: number;
    readonly workbench_version: number;
  }>(
    `SELECT
       layout.revision AS layout_revision,
       workbench.current_version AS workbench_version
     FROM workbench_layouts AS layout
     JOIN workbenches AS workbench ON workbench.id = layout.workbench_id
     WHERE layout.id = $1`,
    [layoutId],
  );
  const head = heads.rows[0]!;
  const nextLayoutRevision = head.layout_revision + 1;
  const nextWorkbenchVersion = head.workbench_version + 1;
  const digest = await database.query<{ readonly digest: string }>(
    `SELECT encode(digest($1::jsonb::text, 'sha256'), 'hex') AS digest`,
    [JSON.stringify(document)],
  );
  await database.transaction(async (client) => {
    await client.query(
      `INSERT INTO workbench_layout_versions (
         id, layout_id, revision, document, digest,
         changed_by_principal_id, created_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, NOW())`,
      [
        randomUUID(),
        layoutId,
        nextLayoutRevision,
        JSON.stringify(document),
        digest.rows[0]!.digest,
        actorId,
      ],
    );
    await client.query(
      `INSERT INTO workbench_versions (
         id, workbench_id, version, layout_id, layout_revision, document,
         digest, created_by_principal_id, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW())`,
      [
        randomUUID(),
        workbenchId,
        nextWorkbenchVersion,
        layoutId,
        nextLayoutRevision,
        JSON.stringify(document),
        digest.rows[0]!.digest,
        actorId,
      ],
    );
    await client.query(
      `UPDATE workbench_layouts
       SET revision = $2, updated_at = NOW()
       WHERE id = $1`,
      [layoutId, nextLayoutRevision],
    );
    await client.query(
      `UPDATE workbenches
       SET current_version = $2, revision = revision + 1, updated_at = NOW()
       WHERE id = $1`,
      [workbenchId, nextWorkbenchVersion],
    );
  });
}
