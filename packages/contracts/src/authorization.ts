import { z } from "zod";

export const projectCapabilityFlagsSchema = z.object({
  read: z.boolean(),
  write: z.boolean(),
  approve: z.boolean(),
  manage_members: z.boolean(),
  manage_roles: z.boolean(),
});
export type ProjectCapabilityFlags = z.infer<
  typeof projectCapabilityFlagsSchema
>;

export const projectOwnerSourcesSchema = z.object({
  legacy: z.boolean(),
  grant: z.boolean(),
  consistent: z.boolean(),
});
export type ProjectOwnerSources = z.infer<typeof projectOwnerSourcesSchema>;

export const projectCapabilitySchema = z.object({
  projectId: z.string().uuid(),
  principalId: z.string().trim().min(1).max(180),
  capabilities: projectCapabilityFlagsSchema,
  ownerSources: projectOwnerSourcesSchema,
  effectivePermissions: z.array(
    z.enum(["read", "write", "approve", "manage_members", "manage_roles"]),
  ),
  grantSource: z.enum(["grant", "legacy-owner", "legacy-role", "none"]),
  membershipId: z.string().uuid().optional(),
  membershipStatus: z.enum(["active", "inactive"]).optional(),
});
export type ProjectCapability = z.infer<typeof projectCapabilitySchema>;
