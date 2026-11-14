import { z } from "zod";

export const CONTEXT_GROUP_POLICY_FLAG = "context.group_policy";

export const contextPolicySceneSchema = z.enum([
  "default",
  "direct-chat",
  "group",
  "meeting",
]);
export type ContextPolicyScene = z.infer<typeof contextPolicySceneSchema>;

export const contextPolicyScopeTypeSchema = z.enum(["platform", "project"]);
export type ContextPolicyScopeType = z.infer<
  typeof contextPolicyScopeTypeSchema
>;

export const contextPolicySettingsSchema = z
  .object({
    warningRatio: z.number().min(0).max(1),
    compactRatio: z.number().min(0).max(1),
    rolloverRatio: z.number().min(0).max(1),
    preserveRecentMessages: z.number().int().min(0).max(1_000),
    maxTriggerDepth: z.number().int().min(1).max(20),
    maxConcurrentAgentsPerScene: z.number().int().min(1).max(50),
    maxContextChars: z.number().int().min(1_000).max(2_000_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (!(value.warningRatio <= value.compactRatio)) {
      context.addIssue({
        code: "custom",
        path: ["compactRatio"],
        message: "compactRatio must be greater than or equal to warningRatio",
      });
    }
    if (!(value.compactRatio <= value.rolloverRatio)) {
      context.addIssue({
        code: "custom",
        path: ["rolloverRatio"],
        message: "rolloverRatio must be greater than or equal to compactRatio",
      });
    }
  });
export type ContextPolicySettings = z.infer<
  typeof contextPolicySettingsSchema
>;

export const DEFAULT_CONTEXT_POLICY_SETTINGS: ContextPolicySettings = {
  warningRatio: 0.7,
  compactRatio: 0.85,
  rolloverRatio: 0.95,
  preserveRecentMessages: 12,
  maxTriggerDepth: 3,
  maxConcurrentAgentsPerScene: 3,
  maxContextChars: 32_000,
};

export const contextPolicySchema = z.object({
  scopeType: contextPolicyScopeTypeSchema,
  scopeId: z.string().trim().min(1).max(180),
  sceneType: contextPolicySceneSchema,
  source: z.enum([
    "platform-default",
    "platform-override",
    "project-default",
    "project-override",
    "built-in-default",
  ]),
  revision: z.number().int().nonnegative(),
  settings: contextPolicySettingsSchema,
  updatedBy: z.string(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ContextPolicy = z.infer<typeof contextPolicySchema>;

export const updateContextPolicyInputSchema = z
  .object({
    scopeType: contextPolicyScopeTypeSchema,
    projectId: z.string().uuid().optional(),
    sceneType: contextPolicySceneSchema,
    expectedVersion: z.number().int().nonnegative(),
    settings: contextPolicySettingsSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.scopeType === "project" && input.projectId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["projectId"],
        message: "projectId is required for project Context Policy",
      });
    }
  });
export type UpdateContextPolicyInput = z.infer<
  typeof updateContextPolicyInputSchema
>;

export const resetContextPolicyInputSchema = z
  .object({
    scopeType: contextPolicyScopeTypeSchema,
    projectId: z.string().uuid().optional(),
    sceneType: contextPolicySceneSchema,
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.scopeType === "project" && input.projectId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["projectId"],
        message: "projectId is required for project Context Policy",
      });
    }
  });
export type ResetContextPolicyInput = z.infer<
  typeof resetContextPolicyInputSchema
>;
