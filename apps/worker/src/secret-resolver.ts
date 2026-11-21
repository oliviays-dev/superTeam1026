import { readFile, stat } from "node:fs/promises";
import {
  parseSecretReference,
  type SecretReference,
} from "@pluginmax/contracts";

const MAX_SECRET_FILE_BYTES = 1024 * 1024;
const MAX_SECRET_VALUE_BYTES = 64 * 1024;

export interface McpCredentialResolver {
  resolve(credentialRef: string): Promise<string | undefined>;
}

export interface SecretStoreAdapterInput {
  readonly reference: SecretReference;
  readonly name: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly now: Date;
}

export interface SecretStoreAdapterValue {
  readonly value: string;
  /** A changed generation invalidates the resolver cache. */
  readonly generation?: string | undefined;
  readonly expiresAt?: Date | undefined;
}

export interface SecretStoreAdapter {
  readonly id: string;
  load(
    input: SecretStoreAdapterInput,
  ): Promise<SecretStoreAdapterValue | undefined>;
}

export class SecretResolutionError extends Error {
  constructor(
    readonly category:
      | "not_configured"
      | "invalid_reference"
      | "not_found"
      | "timeout"
      | "cancelled"
      | "authentication"
      | "authorization"
      | "unavailable"
      | "invalid"
      | "unknown",
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SecretResolutionError";
  }
}

export class EnvironmentSecretStoreAdapter implements SecretStoreAdapter {
  readonly id = "env";

  async load(
    input: SecretStoreAdapterInput,
  ): Promise<SecretStoreAdapterValue | undefined> {
    if (!input.reference.startsWith("env://")) return undefined;
    const value = process.env[input.name];
    return value === undefined || value === ""
      ? undefined
      : { value, generation: `env:${input.name}` };
  }
}

/**
 * Reads an explicitly configured, deployment-mounted JSON secret file. The
 * file must not be group/world-readable and is intended to be backed by the
 * platform's Secret Store integration (for example a Vault agent or projected
 * Kubernetes Secret volume).
 */
export class MountedFileSecretStoreAdapter implements SecretStoreAdapter {
  readonly id = "mounted-file";

  constructor(
    private readonly path: string,
    private readonly options: {
      readonly allowLoosePermissions?: boolean;
    } = {},
  ) {}

  async load(
    input: SecretStoreAdapterInput,
  ): Promise<SecretStoreAdapterValue | undefined> {
    if (!input.reference.startsWith("secret://")) return undefined;
    const metadata = await stat(this.path);
    if (metadata.size > MAX_SECRET_FILE_BYTES) {
      throw new SecretResolutionError(
        "invalid",
        "secret_store_file_too_large",
        "The configured Secret Store file exceeds the size limit",
      );
    }
    if (
      this.options.allowLoosePermissions !== true &&
      process.platform !== "win32" &&
      (metadata.mode & 0o077) !== 0
    ) {
      throw new SecretResolutionError(
        "authentication",
        "secret_store_file_permissions",
        "The configured Secret Store file must not be group or world readable",
      );
    }
    const text = await readFile(this.path, {
      encoding: "utf8",
      signal: input.signal,
    });
    const parsed = parseSecretStoreFile(text);
    const value = parsed.secrets[input.reference] ?? parsed.secrets[input.name];
    if (value === undefined) return undefined;
    if (Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) {
      throw new SecretResolutionError(
        "invalid",
        "secret_value_too_large",
        "The resolved Secret Store value exceeds the size limit",
      );
    }
    return {
      value,
      generation: `${metadata.mtimeMs}:${metadata.size}`,
      ...(parsed.expiresAt === undefined
        ? {}
        : { expiresAt: parsed.expiresAt }),
    };
  }
}

export interface ManagedSecretResolverOptions {
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly now?: () => Date;
}

interface CachedSecret {
  readonly value: string;
  readonly generation: string | undefined;
  readonly expiresAtMs: number;
}

export class ManagedSecretResolver implements McpCredentialResolver {
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => Date;
  private readonly cache = new Map<string, CachedSecret>();
  private readonly adapters: readonly SecretStoreAdapter[];

  constructor(
    options: ManagedSecretResolverOptions = {},
    adapters: readonly SecretStoreAdapter[] = [
      new EnvironmentSecretStoreAdapter(),
    ],
  ) {
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? 5_000,
      "secret resolver timeoutMs",
    );
    this.cacheTtlMs = nonNegativeInteger(
      options.cacheTtlMs ?? 30_000,
      "secret resolver cacheTtlMs",
    );
    this.now = options.now ?? (() => new Date());
    this.adapters = adapters;
  }

  async resolve(
    credentialRef: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<string | undefined> {
    const parsed = this.parse(credentialRef);
    if (parsed.scheme === "secret" && !this.hasSecretStoreAdapter()) {
      throw new SecretResolutionError(
        "not_configured",
        "secret_store_not_configured",
        "No Secret Store adapter is configured for secret:// references",
      );
    }
    const cached = this.cache.get(parsed.reference);
    const nowMs = this.now().getTime();
    if (cached !== undefined && cached.expiresAtMs > nowMs) {
      return cached.value;
    }
    if (cached !== undefined) this.cache.delete(parsed.reference);
    if (options.signal?.aborted === true) {
      throw new SecretResolutionError(
        "cancelled",
        "secret_resolution_cancelled",
        "Secret resolution was cancelled",
      );
    }

    const controller = new AbortController();
    const relayAbort = () =>
      controller.abort(
        new SecretResolutionError(
          "cancelled",
          "secret_resolution_cancelled",
          "Secret resolution was cancelled",
        ),
      );
    options.signal?.addEventListener("abort", relayAbort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new SecretResolutionError(
            "timeout",
            "secret_resolution_timeout",
            "Secret resolution timed out",
            true,
          ),
        ),
      this.timeoutMs,
    );
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        const rejectAbort = () => reject(controller.signal.reason);
        if (controller.signal.aborted) {
          rejectAbort();
          return;
        }
        controller.signal.addEventListener("abort", rejectAbort, {
          once: true,
        });
      });
      const value = await Promise.race([
        this.load(parsed, controller.signal, nowMs),
        aborted,
      ]);
      if (value === undefined) return undefined;
      const cacheUntil = Math.min(
        nowMs + this.cacheTtlMs,
        value.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
      );
      if (this.cacheTtlMs > 0 && cacheUntil > nowMs) {
        this.cache.set(parsed.reference, {
          value: value.value,
          generation: value.generation,
          expiresAtMs: cacheUntil,
        });
      }
      return value.value;
    } catch (error) {
      const reason = controller.signal.reason;
      if (reason instanceof SecretResolutionError) throw reason;
      throw classifySecretError(error);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", relayAbort);
    }
  }

  invalidate(reference?: string): void {
    if (reference === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(secretReference(reference));
  }

  async resolveUncached(
    credentialRef: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<string | undefined> {
    this.invalidate(credentialRef);
    return this.resolve(credentialRef, options);
  }

  private async load(
    parsed: ReturnType<typeof parseSecretReference>,
    signal: AbortSignal,
    nowMs: number,
  ): Promise<SecretStoreAdapterValue | undefined> {
    for (const adapter of this.adapters) {
      const value = await adapter.load({
        reference: parsed.reference,
        name: parsed.name,
        signal,
        timeoutMs: this.timeoutMs,
        now: new Date(nowMs),
      });
      if (value !== undefined) return value;
    }
    return undefined;
  }

  private parse(reference: string): ReturnType<typeof parseSecretReference> {
    try {
      return parseSecretReference(reference);
    } catch {
      throw new SecretResolutionError(
        "invalid_reference",
        "secret_reference_invalid",
        "The credential reference is invalid",
      );
    }
  }

  private hasSecretStoreAdapter(): boolean {
    return this.adapters.some((adapter) => adapter.id !== "env");
  }
}

function parseSecretStoreFile(text: string): {
  readonly secrets: Record<string, string>;
  readonly expiresAt: Date | undefined;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SecretResolutionError(
      "invalid",
      "secret_store_file_invalid",
      "The configured Secret Store file is not valid JSON",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SecretResolutionError(
      "invalid",
      "secret_store_file_invalid",
      "The configured Secret Store file must contain a JSON object",
    );
  }
  const record = parsed as Record<string, unknown>;
  const candidate =
    record.secrets !== undefined &&
    typeof record.secrets === "object" &&
    record.secrets !== null &&
    !Array.isArray(record.secrets)
      ? (record.secrets as Record<string, unknown>)
      : record;
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (key === "expiresAt" || key === "version") continue;
    if (typeof value !== "string" || value === "") continue;
    secrets[key] = value;
  }
  const expiresAt =
    typeof record.expiresAt === "string" &&
    Number.isFinite(Date.parse(record.expiresAt))
      ? new Date(record.expiresAt)
      : undefined;
  return { secrets, expiresAt };
}

function classifySecretError(error: unknown): SecretResolutionError {
  if (error instanceof SecretResolutionError) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code?: unknown }).code)
      : undefined;
  if (code === "ENOENT") {
    return new SecretResolutionError(
      "not_found",
      "secret_store_file_missing",
      "The configured Secret Store is unavailable",
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return new SecretResolutionError(
      "authorization",
      "secret_store_access_denied",
      "The configured Secret Store denied access",
    );
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { readonly name?: unknown }).name === "AbortError"
  ) {
    return new SecretResolutionError(
      "cancelled",
      "secret_resolution_cancelled",
      "Secret resolution was cancelled",
    );
  }
  return new SecretResolutionError(
    "unknown",
    "secret_resolution_failed",
    "Secret resolution failed",
  );
}

function secretReference(value: string): string {
  return parseSecretReference(value).reference;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}
