import { z } from "zod";

export const WORKBENCH_V2_FLAG = "workbench.v2";
export const MARKET_FLAG = "market";

export const WORKBENCH_HOST_VERSION = "2.0.0";

export const trustedWorkbenchPanelDefinitionSchema = z.object({
  pluginId: z.string().trim().min(1).max(120),
  version: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(160),
  defaultWidth: z.number().int().min(1).max(6),
  minHeight: z.number().int().min(190).max(900),
  maxHeight: z.number().int().min(190).max(900),
  refreshable: z.boolean(),
  requiresEntitlement: z.boolean(),
});
export type TrustedWorkbenchPanelDefinition = z.infer<
  typeof trustedWorkbenchPanelDefinitionSchema
>;

export const TRUSTED_WORKBENCH_PANELS = [
  {
    pluginId: "metrics",
    version: "1.0.0",
    title: "核心指标",
    defaultWidth: 6,
    minHeight: 190,
    maxHeight: 360,
    refreshable: true,
    requiresEntitlement: false,
  },
  {
    pluginId: "brief",
    version: "1.0.0",
    title: "每日简报",
    defaultWidth: 6,
    minHeight: 260,
    maxHeight: 900,
    refreshable: true,
    requiresEntitlement: false,
  },
  {
    pluginId: "todo",
    version: "1.0.0",
    title: "我的待办",
    defaultWidth: 4,
    minHeight: 260,
    maxHeight: 900,
    refreshable: true,
    requiresEntitlement: false,
  },
  {
    pluginId: "focus",
    version: "1.0.0",
    title: "重点关注",
    defaultWidth: 2,
    minHeight: 260,
    maxHeight: 900,
    refreshable: true,
    requiresEntitlement: false,
  },
  {
    pluginId: "meeting-minutes",
    version: "1.0.0",
    title: "会议结论",
    defaultWidth: 3,
    minHeight: 240,
    maxHeight: 900,
    refreshable: true,
    requiresEntitlement: false,
  },
  {
    pluginId: "control",
    version: "1.0.0",
    title: "运行异常",
    defaultWidth: 3,
    minHeight: 240,
    maxHeight: 900,
    refreshable: true,
    requiresEntitlement: false,
  },
  {
    pluginId: "supply",
    version: "1.0.0",
    title: "供给例外",
    defaultWidth: 3,
    minHeight: 240,
    maxHeight: 900,
    refreshable: true,
    requiresEntitlement: false,
  },
  {
    pluginId: "supplier",
    version: "1.0.0",
    title: "供应商风险",
    defaultWidth: 3,
    minHeight: 240,
    maxHeight: 900,
    refreshable: true,
    requiresEntitlement: false,
  },
  {
    pluginId: "reports",
    version: "1.0.0",
    title: "项目报告",
    defaultWidth: 6,
    minHeight: 240,
    maxHeight: 900,
    refreshable: true,
    requiresEntitlement: false,
  },
  {
    pluginId: "market.sample",
    version: "1.0.0",
    title: "市场示例面板",
    defaultWidth: 3,
    minHeight: 240,
    maxHeight: 600,
    refreshable: true,
    requiresEntitlement: true,
  },
] as const satisfies ReadonlyArray<TrustedWorkbenchPanelDefinition>;

export type TrustedWorkbenchPanelId =
  (typeof TRUSTED_WORKBENCH_PANELS)[number]["pluginId"];

const trustedPanelById = new Map<string, TrustedWorkbenchPanelDefinition>(
  TRUSTED_WORKBENCH_PANELS.map((panel) => [panel.pluginId, panel]),
);

export function trustedWorkbenchPanel(
  pluginId: string,
): TrustedWorkbenchPanelDefinition | undefined {
  return trustedPanelById.get(pluginId);
}

export function isTrustedWorkbenchPanelId(
  pluginId: string,
): pluginId is TrustedWorkbenchPanelId {
  return trustedPanelById.has(pluginId);
}

export const workbenchStatusSchema = z.enum(["active", "archived"]);
export type WorkbenchStatus = z.infer<typeof workbenchStatusSchema>;

export const workbenchPanelHeightSchema = z
  .number()
  .int()
  .min(190)
  .max(900)
  .nullable();

export const workbenchPanelConfigSchema = z
  .record(z.string(), z.unknown())
  .default({});

export const workbenchPanelPlacementSchema = z
  .object({
    instanceId: z.string().uuid().optional(),
    pluginId: z.string().trim().min(1).max(120),
    position: z.number().int().min(0).max(10_000),
    width: z.number().int().min(1).max(6),
    height: workbenchPanelHeightSchema.default(null),
    config: workbenchPanelConfigSchema,
    enabled: z.boolean().default(true),
  })
  .strict();
export type WorkbenchPanelPlacement = z.infer<
  typeof workbenchPanelPlacementSchema
>;

export const workbenchLayoutDocumentSchema = z
  .object({
    version: z.literal(1),
    panels: z.array(workbenchPanelPlacementSchema).max(100),
  })
  .strict()
  .superRefine((document, context) => {
    const positions = new Set<number>();
    const pluginIds = new Set<string>();
    for (const [index, panel] of document.panels.entries()) {
      if (positions.has(panel.position)) {
        context.addIssue({
          code: "custom",
          path: ["panels", index, "position"],
          message: "panel positions must be unique",
        });
      }
      positions.add(panel.position);
      if (pluginIds.has(panel.pluginId)) {
        context.addIssue({
          code: "custom",
          path: ["panels", index, "pluginId"],
          message: "panel pluginId must be unique in a layout",
        });
      }
      pluginIds.add(panel.pluginId);
      const trusted = trustedWorkbenchPanel(panel.pluginId);
      if (
        trusted !== undefined &&
        panel.height !== null &&
        (panel.height < trusted.minHeight || panel.height > trusted.maxHeight)
      ) {
        context.addIssue({
          code: "custom",
          path: ["panels", index, "height"],
          message: `panel height must be between ${trusted.minHeight} and ${trusted.maxHeight}`,
        });
      }
    }
  });
export type WorkbenchLayoutDocument = z.infer<
  typeof workbenchLayoutDocumentSchema
>;

export const workbenchSchema = z.object({
  id: z.string().uuid(),
  ownerPrincipalId: z.string().min(1).max(180),
  name: z.string().min(1).max(80),
  status: workbenchStatusSchema,
  currentVersion: z.number().int().positive(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type Workbench = z.infer<typeof workbenchSchema>;

export const workbenchLayoutSchema = z.object({
  id: z.string().uuid(),
  workbenchId: z.string().uuid(),
  ownerPrincipalId: z.string().min(1).max(180),
  name: z.string().min(1).max(80),
  isDefault: z.boolean(),
  isFactoryDefault: z.boolean(),
  revision: z.number().int().positive(),
  status: z.enum(["active", "archived"]),
  document: workbenchLayoutDocumentSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type WorkbenchLayout = z.infer<typeof workbenchLayoutSchema>;

export const workbenchVersionSchema = z.object({
  id: z.string().uuid(),
  workbenchId: z.string().uuid(),
  version: z.number().int().positive(),
  layoutId: z.string().uuid(),
  layoutRevision: z.number().int().positive(),
  document: workbenchLayoutDocumentSchema,
  digest: z.string().length(64),
  createdByPrincipalId: z.string().min(1).max(180),
  createdAt: z.string().datetime({ offset: true }),
});
export type WorkbenchVersion = z.infer<typeof workbenchVersionSchema>;

export const workbenchLayoutVersionSchema = z.object({
  id: z.string().uuid(),
  layoutId: z.string().uuid(),
  revision: z.number().int().positive(),
  document: workbenchLayoutDocumentSchema,
  digest: z.string().length(64),
  changedByPrincipalId: z.string().min(1).max(180),
  createdAt: z.string().datetime({ offset: true }),
});
export type WorkbenchLayoutVersion = z.infer<
  typeof workbenchLayoutVersionSchema
>;

export const workbenchPanelStateSchema = z.enum([
  "ready",
  "unknown",
  "disabled",
  "needs_entitlement",
  "forbidden",
]);
export type WorkbenchPanelState = z.infer<typeof workbenchPanelStateSchema>;

export const workbenchPanelResolutionSchema = z.object({
  instanceId: z.string().uuid(),
  pluginId: z.string().min(1).max(120),
  title: z.string().min(1).max(160),
  version: z.string().min(1).max(40).nullable(),
  position: z.number().int().nonnegative(),
  width: z.number().int().min(1).max(6),
  height: z.number().int().min(190).max(900).nullable(),
  refreshable: z.boolean(),
  state: workbenchPanelStateSchema,
  fallbackMessage: z.string().max(500).nullable(),
});
export type WorkbenchPanelResolution = z.infer<
  typeof workbenchPanelResolutionSchema
>;

export const workbenchDetailSchema = z.object({
  workbench: workbenchSchema,
  layout: workbenchLayoutSchema,
  layoutVersion: workbenchLayoutVersionSchema,
  panels: z.array(workbenchPanelResolutionSchema),
});
export type WorkbenchDetail = z.infer<typeof workbenchDetailSchema>;

export const workbenchBootstrapSchema = z.object({
  enabled: z.boolean(),
  marketEnabled: z.boolean(),
  hostVersion: z.string(),
  workbenches: z.array(workbenchSchema),
  defaultWorkbench: workbenchDetailSchema.nullable(),
});
export type WorkbenchBootstrap = z.infer<typeof workbenchBootstrapSchema>;

export const createWorkbenchInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    template: workbenchLayoutDocumentSchema.optional(),
  })
  .strict();
export type CreateWorkbenchInput = z.infer<typeof createWorkbenchInputSchema>;

export const updateWorkbenchInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    name: z.string().trim().min(1).max(80).optional(),
    status: workbenchStatusSchema.optional(),
  })
  .strict()
  .refine(
    (input) => input.name !== undefined || input.status !== undefined,
    "name or status is required",
  );
export type UpdateWorkbenchInput = z.infer<typeof updateWorkbenchInputSchema>;

export const createWorkbenchLayoutInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    document: workbenchLayoutDocumentSchema,
    makeDefault: z.boolean().default(false),
  })
  .strict();
export type CreateWorkbenchLayoutInput = z.infer<
  typeof createWorkbenchLayoutInputSchema
>;

export const saveWorkbenchLayoutInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    name: z.string().trim().min(1).max(80).optional(),
    document: workbenchLayoutDocumentSchema,
  })
  .strict();
export type SaveWorkbenchLayoutInput = z.infer<
  typeof saveWorkbenchLayoutInputSchema
>;

export const setDefaultWorkbenchLayoutInputSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type SetDefaultWorkbenchLayoutInput = z.infer<
  typeof setDefaultWorkbenchLayoutInputSchema
>;

export const workbenchPanelDataSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ready"),
    panelInstanceId: z.string().uuid(),
    pluginId: z.string(),
    data: z.unknown(),
    updatedAt: z.string().datetime({ offset: true }),
  }),
  z.object({
    state: z.literal("unknown"),
    panelInstanceId: z.string().uuid(),
    pluginId: z.string(),
    data: z.null(),
    fallbackMessage: z.string(),
  }),
  z.object({
    state: z.literal("disabled"),
    panelInstanceId: z.string().uuid(),
    pluginId: z.string(),
    data: z.null(),
    fallbackMessage: z.string(),
  }),
  z.object({
    state: z.literal("needs_entitlement"),
    panelInstanceId: z.string().uuid(),
    pluginId: z.string(),
    data: z.null(),
    fallbackMessage: z.string(),
  }),
  z.object({
    state: z.literal("forbidden"),
    panelInstanceId: z.string().uuid(),
    pluginId: z.string(),
    data: z.null(),
    fallbackMessage: z.string(),
  }),
]);
export type WorkbenchPanelData = z.infer<typeof workbenchPanelDataSchema>;

export const marketAssetKindSchema = z.enum([
  "panel",
  "skill",
  "mcp",
  "workbench-template",
  "plugin",
]);
export type MarketAssetKind = z.infer<typeof marketAssetKindSchema>;

export const marketTrustLevelSchema = z.enum([
  "official",
  "verified",
  "private",
]);
export type MarketTrustLevel = z.infer<typeof marketTrustLevelSchema>;

export const marketVisibilitySchema = z.enum([
  "public",
  "private",
  "workspace",
  "project",
]);
export type MarketVisibility = z.infer<typeof marketVisibilitySchema>;

export const marketAssetStatusSchema = z.enum([
  "active",
  "delisted",
  "archived",
]);
export type MarketAssetStatus = z.infer<typeof marketAssetStatusSchema>;

export const marketAssetVersionStatusSchema = z.enum([
  "published",
  "deprecated",
  "revoked",
]);
export type MarketAssetVersionStatus = z.infer<
  typeof marketAssetVersionStatusSchema
>;

export const marketTemplateDependencyInputSchema = z.object({
  dependencyAssetKey: z
    .string()
    .trim()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]+$/),
  minimumVersion: z.number().int().positive().default(1),
  required: z.boolean().default(true),
});
export type MarketTemplateDependencyInput = z.infer<
  typeof marketTemplateDependencyInputSchema
>;

export const marketAssetManifestSchema = z
  .object({
    summary: z.string().trim().max(4_000).default(""),
    panelPluginId: z.string().trim().min(1).max(120).optional(),
    template: workbenchLayoutDocumentSchema.optional(),
    dependencies: z.array(marketTemplateDependencyInputSchema).max(100).default([]),
    permissions: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(120)
          .regex(/^[a-z][a-z0-9_.:-]*$/),
      )
      .max(100)
      .default([]),
    capabilities: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(120)
          .regex(/^[a-z][a-z0-9_.:-]*$/),
      )
      .max(100)
      .default([]),
  })
  .strict();
export type MarketAssetManifest = z.infer<typeof marketAssetManifestSchema>;

export const marketCompatibilitySchema = z
  .object({
    minHostVersion: z.string().trim().min(1).max(40),
    maxHostVersion: z.string().trim().min(1).max(40).optional(),
  })
  .strict();
export type MarketCompatibility = z.infer<typeof marketCompatibilitySchema>;

export const marketAssetVersionSchema = z.object({
  id: z.string().uuid(),
  assetId: z.string().uuid(),
  version: z.number().int().positive(),
  digest: z.string().length(64),
  publisherPrincipalId: z.string().min(1).max(180),
  manifest: marketAssetManifestSchema,
  compatibility: marketCompatibilitySchema,
  status: marketAssetVersionStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
});
export type MarketAssetVersion = z.infer<typeof marketAssetVersionSchema>;

export const marketAssetSchema = z.object({
  id: z.string().uuid(),
  assetKey: z.string().min(2).max(120),
  kind: marketAssetKindSchema,
  name: z.string().min(1).max(160),
  description: z.string().max(4_000),
  publisherPrincipalId: z.string().min(1).max(180),
  trustLevel: marketTrustLevelSchema,
  visibility: marketVisibilitySchema,
  visibilityScopeId: z.string().max(180).nullable(),
  status: marketAssetStatusSchema,
  currentVersion: z.number().int().positive(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type MarketAsset = z.infer<typeof marketAssetSchema>;

export const marketAssetDetailSchema = marketAssetSchema.extend({
  versions: z.array(marketAssetVersionSchema),
});
export type MarketAssetDetail = z.infer<typeof marketAssetDetailSchema>;

export const createMarketAssetInputSchema = z
  .object({
    assetKey: z
      .string()
      .trim()
      .min(2)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9._-]+$/),
    kind: marketAssetKindSchema,
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(4_000).default(""),
    trustLevel: marketTrustLevelSchema.default("private"),
    visibility: marketVisibilitySchema.default("private"),
    visibilityScopeId: z.string().trim().min(1).max(180).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      (input.visibility === "workspace" || input.visibility === "project") &&
      input.visibilityScopeId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["visibilityScopeId"],
        message: "workspace/project visibility requires a scope id",
      });
    }
    if (
      input.visibility !== "workspace" &&
      input.visibility !== "project" &&
      input.visibilityScopeId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["visibilityScopeId"],
        message: "scope id is only valid for workspace/project visibility",
      });
    }
  });
export type CreateMarketAssetInput = z.infer<
  typeof createMarketAssetInputSchema
>;

export const publishMarketAssetVersionInputSchema = z
  .object({
    manifest: marketAssetManifestSchema,
    compatibility: marketCompatibilitySchema,
    expectedDigest: z.string().length(64).optional(),
  })
  .strict();
export type PublishMarketAssetVersionInput = z.infer<
  typeof publishMarketAssetVersionInputSchema
>;

export const setMarketAssetStatusInputSchema = z
  .object({
    status: marketAssetStatusSchema,
    expectedRevision: z.number().int().positive(),
  })
  .strict();
export type SetMarketAssetStatusInput = z.infer<
  typeof setMarketAssetStatusInputSchema
>;

export const setMarketAssetVersionStatusInputSchema = z
  .object({
    status: marketAssetVersionStatusSchema,
  })
  .strict();
export type SetMarketAssetVersionStatusInput = z.infer<
  typeof setMarketAssetVersionStatusInputSchema
>;

export const marketEntitlementSchema = z.object({
  id: z.string().uuid(),
  principalId: z.string().min(1).max(180),
  assetId: z.string().uuid(),
  status: z.enum(["active", "revoked"]),
  revision: z.number().int().positive(),
  grantedByPrincipalId: z.string().min(1).max(180),
  grantedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  grantsAuthorization: z.literal(false),
});
export type MarketEntitlement = z.infer<typeof marketEntitlementSchema>;

export const grantMarketEntitlementInputSchema = z
  .object({
    principalId: z.string().trim().min(1).max(180),
    assetId: z.string().uuid(),
  })
  .strict();
export type GrantMarketEntitlementInput = z.infer<
  typeof grantMarketEntitlementInputSchema
>;

export const installMarketAssetInputSchema = z
  .object({
    assetId: z.string().uuid(),
    version: z.number().int().positive(),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type InstallMarketAssetInput = z.infer<
  typeof installMarketAssetInputSchema
>;

export const rollbackMarketAssetInputSchema = z
  .object({
    assetId: z.string().uuid(),
    version: z.number().int().positive(),
  })
  .strict();
export type RollbackMarketAssetInput = z.infer<
  typeof rollbackMarketAssetInputSchema
>;

export const marketInstallationSchema = z.object({
  id: z.string().uuid(),
  principalId: z.string().min(1).max(180),
  assetId: z.string().uuid(),
  assetVersionId: z.string().uuid(),
  assetVersion: z.number().int().positive(),
  entitlementId: z.string().uuid(),
  status: z.enum(["active", "uninstalled"]),
  revision: z.number().int().positive(),
  config: z.record(z.string(), z.unknown()),
  installedByPrincipalId: z.string().min(1).max(180),
  installedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  grantsAuthorization: z.literal(false),
});
export type MarketInstallation = z.infer<typeof marketInstallationSchema>;

export const marketInstallResultSchema = z.object({
  installation: marketInstallationSchema,
  created: z.boolean(),
  deduplicated: z.boolean(),
});
export type MarketInstallResult = z.infer<typeof marketInstallResultSchema>;

export const marketTemplateSchema = z.object({
  id: z.string().uuid(),
  assetId: z.string().uuid(),
  templateKey: z.string().min(2).max(120),
  name: z.string().min(1).max(160),
  status: z.enum(["active", "archived"]),
  currentVersion: z.number().int().positive(),
  createdByPrincipalId: z.string().min(1).max(180),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  dependencies: z.array(
    z.object({
      dependencyAssetId: z.string().uuid(),
      dependencyAssetKey: z.string(),
      minimumVersion: z.number().int().positive(),
      required: z.boolean(),
    }),
  ),
});
export type MarketTemplate = z.infer<typeof marketTemplateSchema>;

export const copyMarketTemplateInputSchema = z
  .object({
    templateId: z.string().uuid(),
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(80),
  })
  .strict();
export type CopyMarketTemplateInput = z.infer<
  typeof copyMarketTemplateInputSchema
>;

export const marketTemplateCopySchema = z.object({
  id: z.string().uuid(),
  principalId: z.string().min(1).max(180),
  templateId: z.string().uuid(),
  assetVersionId: z.string().uuid(),
  assetVersion: z.number().int().positive(),
  workbenchId: z.string().uuid(),
  status: z.enum(["active", "uninstalled"]),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type MarketTemplateCopy = z.infer<typeof marketTemplateCopySchema>;

export const marketTemplateCopyResultSchema = z.object({
  copy: marketTemplateCopySchema,
  workbenchId: z.string().uuid(),
  created: z.boolean(),
  deduplicated: z.boolean(),
});
export type MarketTemplateCopyResult = z.infer<
  typeof marketTemplateCopyResultSchema
>;

export const canonicalWorkbenchJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalWorkbenchJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${canonicalWorkbenchJson(item)}`,
    )
    .join(",")}}`;
};
