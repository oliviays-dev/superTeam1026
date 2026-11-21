import { z } from "zod";

export const secretReferenceSchemeSchema = z.enum(["env", "secret"]);
export type SecretReferenceScheme = z.infer<
  typeof secretReferenceSchemeSchema
>;

export const secretReferenceSchema = z
  .string()
  .trim()
  .min(9)
  .max(500)
  .regex(/^(env|secret):\/\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
export type SecretReference = z.infer<typeof secretReferenceSchema>;

export const secretResolutionErrorCategorySchema = z.enum([
  "not_configured",
  "invalid_reference",
  "not_found",
  "timeout",
  "cancelled",
  "authentication",
  "authorization",
  "unavailable",
  "invalid",
  "unknown",
]);
export type SecretResolutionErrorCategory = z.infer<
  typeof secretResolutionErrorCategorySchema
>;

export function parseSecretReference(reference: string): {
  readonly reference: SecretReference;
  readonly scheme: SecretReferenceScheme;
  readonly name: string;
} {
  const parsed = secretReferenceSchema.parse(reference);
  const separator = parsed.indexOf("://");
  const scheme = secretReferenceSchemeSchema.parse(
    parsed.slice(0, separator),
  );
  const name = parsed.slice(separator + 3);
  if (name.length === 0) {
    throw new Error("Secret reference name is empty");
  }
  return { reference: parsed, scheme, name };
}
