import { z } from "zod";

export const templateRoleCategorySchema = z.enum([
  "management",
  "execution",
  "review",
  "approval",
  "planning",
  "procurement",
  "support",
]);
export type TemplateRoleCategory = z.infer<typeof templateRoleCategorySchema>;

export const templateRolePermissionSchema = z.enum([
  "read",
  "write",
  "approve",
  "manage_members",
  "manage_roles",
]);
export type TemplateRolePermission = z.infer<
  typeof templateRolePermissionSchema
>;

const templateRolePermissionsSchema = z
  .array(templateRolePermissionSchema)
  .min(1)
  .max(5)
  .transform((permissions) => [...new Set(permissions)]);

export const templateRoleStatusSchema = z.enum(["active", "archived"]);
export type TemplateRoleStatus = z.infer<typeof templateRoleStatusSchema>;

export const templateRoleSchema = z.object({
  id: z.string().uuid(),
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  category: templateRoleCategorySchema,
  description: z.string().trim().max(500).default(""),
  permissions: templateRolePermissionsSchema,
  status: templateRoleStatusSchema,
  revision: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type TemplateRole = z.infer<typeof templateRoleSchema>;

export const createTemplateRoleInputSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Z][A-Z0-9_]*$/),
  name: z.string().trim().min(1).max(80),
  category: templateRoleCategorySchema,
  description: z.string().trim().max(500).default(""),
  permissions: templateRolePermissionsSchema,
});
export type CreateTemplateRoleInput = z.infer<
  typeof createTemplateRoleInputSchema
>;

export const updateTemplateRoleInputSchema = createTemplateRoleInputSchema
  .partial()
  .extend({
    expectedRevision: z.number().int().positive(),
  });
export type UpdateTemplateRoleInput = z.infer<
  typeof updateTemplateRoleInputSchema
>;

export const workflowTemplateStepSchema = z.object({
  name: z.string().trim().min(1).max(160),
  kind: z.enum(["human", "agent"]).default("human"),
  roleCode: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .optional(),
});
export type WorkflowTemplateStep = z.infer<typeof workflowTemplateStepSchema>;

export const workflowTemplateDefinitionSchema = z.object({
  steps: z.array(workflowTemplateStepSchema).min(1).max(50),
});
export type WorkflowTemplateDefinition = z.infer<
  typeof workflowTemplateDefinitionSchema
>;

export const workflowTemplateStatusSchema = z.enum(["active", "archived"]);
export type WorkflowTemplateStatus = z.infer<
  typeof workflowTemplateStatusSchema
>;

export const workflowTemplateSchema = z.object({
  id: z.string().uuid(),
  key: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000),
  version: z.number().int().positive(),
  status: workflowTemplateStatusSchema,
  definition: workflowTemplateDefinitionSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;

export const createWorkflowTemplateInputSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[A-Z][A-Z0-9_-]*$/),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).default(""),
  definition: workflowTemplateDefinitionSchema,
});
export type CreateWorkflowTemplateInput = z.infer<
  typeof createWorkflowTemplateInputSchema
>;

export const updateWorkflowTemplateInputSchema =
  createWorkflowTemplateInputSchema.partial().extend({
    expectedVersion: z.number().int().positive(),
  });
export type UpdateWorkflowTemplateInput = z.infer<
  typeof updateWorkflowTemplateInputSchema
>;

export const projectTemplateWorkflowRefInputSchema = z.object({
  workflowTemplateId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
});
export type ProjectTemplateWorkflowRefInput = z.infer<
  typeof projectTemplateWorkflowRefInputSchema
>;

export const projectTemplateWorkflowRefSchema = z.object({
  workflowTemplateId: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
});
export type ProjectTemplateWorkflowRef = z.infer<
  typeof projectTemplateWorkflowRefSchema
>;

export const projectTemplateAccessPolicySchema = z.enum([
  "all-members",
  "selected-members",
]);
export type ProjectTemplateAccessPolicy = z.infer<
  typeof projectTemplateAccessPolicySchema
>;

const actorIdsSchema = z
  .array(
    z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9_.:-]{1,180}$/),
  )
  .max(200)
  .default([])
  .transform((actorIds) => [...new Set(actorIds)]);

const templateRoleIdsSchema = z
  .array(z.string().uuid())
  .max(50)
  .default([])
  .transform((roleIds) => [...new Set(roleIds)]);

const workflowRefsSchema = z
  .array(projectTemplateWorkflowRefInputSchema)
  .max(50)
  .default([])
  .transform((refs) => {
    const unique = new Map(refs.map((ref) => [ref.workflowTemplateId, ref]));
    return [...unique.values()];
  });

const projectTemplateCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Z][A-Z0-9_-]*$/);

export const projectTemplateStatusSchema = z.enum(["active", "archived"]);
export type ProjectTemplateStatus = z.infer<typeof projectTemplateStatusSchema>;

export const projectTemplateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  code: projectTemplateCodeSchema,
  type: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2_000),
  status: projectTemplateStatusSchema,
  revision: z.number().int().positive(),
  roles: z.array(templateRoleSchema).max(50),
  ownerRoleId: z.string().uuid().nullable(),
  workflowTemplates: z.array(projectTemplateWorkflowRefSchema).max(50),
  accessPolicy: projectTemplateAccessPolicySchema,
  allowedActorIds: z.array(z.string()).max(200),
  materializedProjectCount: z.number().int().nonnegative(),
  createdBy: z.string(),
  updatedBy: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ProjectTemplate = z.infer<typeof projectTemplateSchema>;

export const createProjectTemplateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    code: projectTemplateCodeSchema,
    type: z.string().trim().min(1).max(80).default("通用类"),
    description: z.string().trim().max(2_000).default(""),
    roleIds: templateRoleIdsSchema,
    ownerRoleId: z.string().uuid().optional(),
    workflowTemplates: workflowRefsSchema,
    accessPolicy: projectTemplateAccessPolicySchema.default("all-members"),
    allowedActorIds: actorIdsSchema,
  })
  .superRefine((input, context) => {
    if (
      input.ownerRoleId !== undefined &&
      !input.roleIds.includes(input.ownerRoleId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ownerRoleId"],
        message: "ownerRoleId must be included in roleIds",
      });
    }
    if (
      input.accessPolicy === "selected-members" &&
      input.allowedActorIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowedActorIds"],
        message: "Selected-member templates require at least one actor",
      });
    }
  });
export type CreateProjectTemplateInput = z.infer<
  typeof createProjectTemplateInputSchema
>;

export const updateProjectTemplateInputSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    code: projectTemplateCodeSchema.optional(),
    type: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(2_000).optional(),
    roleIds: templateRoleIdsSchema.optional(),
    ownerRoleId: z.string().uuid().nullable().optional(),
    workflowTemplates: workflowRefsSchema.optional(),
    accessPolicy: projectTemplateAccessPolicySchema.optional(),
    allowedActorIds: actorIdsSchema.optional(),
    expectedRevision: z.number().int().positive(),
    changeSummary: z.string().trim().max(500).optional(),
  })
  .superRefine((input, context) => {
    if (
      input.roleIds !== undefined &&
      input.ownerRoleId !== undefined &&
      input.ownerRoleId !== null &&
      !input.roleIds.includes(input.ownerRoleId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["ownerRoleId"],
        message: "ownerRoleId must be included in roleIds",
      });
    }
    if (
      input.accessPolicy === "selected-members" &&
      input.allowedActorIds !== undefined &&
      input.allowedActorIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowedActorIds"],
        message: "Selected-member templates require at least one actor",
      });
    }
  });
export type UpdateProjectTemplateInput = z.infer<
  typeof updateProjectTemplateInputSchema
>;

export const copyProjectTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  code: projectTemplateCodeSchema,
});
export type CopyProjectTemplateInput = z.infer<
  typeof copyProjectTemplateInputSchema
>;

export const archiveProjectTemplateInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().max(500).default(""),
});
export type ArchiveProjectTemplateInput = z.infer<
  typeof archiveProjectTemplateInputSchema
>;

export const projectTemplateRevisionSummarySchema = z.object({
  templateId: z.string().uuid(),
  revision: z.number().int().positive(),
  changeSummary: z.string(),
  status: projectTemplateStatusSchema,
  actorId: z.string(),
  roleCount: z.number().int().nonnegative(),
  workflowCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
});
export type ProjectTemplateRevisionSummary = z.infer<
  typeof projectTemplateRevisionSummarySchema
>;

export const projectTemplateMaterializationSchema = z.object({
  projectId: z.string().uuid(),
  templateId: z.string().uuid(),
  templateRevision: z.number().int().positive(),
  idempotencyKey: z.string(),
  created: z.boolean(),
});
export type ProjectTemplateMaterialization = z.infer<
  typeof projectTemplateMaterializationSchema
>;

export const viewerCapabilitiesSchema = z.object({
  actorId: z.string(),
  principalId: z.string().optional(),
  displayName: z.string().optional(),
  authSource: z.enum(["bearer", "local-development"]).optional(),
  platformAdministrator: z.boolean(),
  canManageProjectTemplates: z.boolean(),
});
export type ViewerCapabilities = z.infer<typeof viewerCapabilitiesSchema>;
