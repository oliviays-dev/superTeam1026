import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EnvironmentSecretStoreAdapter,
  ManagedSecretResolver,
  MountedFileSecretStoreAdapter,
  SecretResolutionError,
  type SecretStoreAdapter,
} from "./secret-resolver.js";

describe("M13d Secret Resolver", () => {
  it("fails closed for secret:// when no Secret Store adapter is configured", async () => {
    const resolver = new ManagedSecretResolver(
      {},
      [new EnvironmentSecretStoreAdapter()],
    );
    await expect(
      resolver.resolve(`secret://mcp/${randomUUID()}`),
    ).rejects.toMatchObject({
      category: "not_configured",
      code: "secret_store_not_configured",
    });
  });

  it("uses a mounted Secret Store file without leaking values into errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pluginmax-secret-store-"));
    const path = join(directory, "secrets.json");
    const reference = `secret://mcp/provider/${randomUUID()}`;
    const value = `raw-secret-${randomUUID()}`;
    await writeFile(
      path,
      JSON.stringify({ secrets: { [reference]: value } }),
      { mode: 0o600 },
    );
    await chmod(path, 0o600);
    const resolver = new ManagedSecretResolver({}, [
      new EnvironmentSecretStoreAdapter(),
      new MountedFileSecretStoreAdapter(path),
    ]);
    await expect(resolver.resolve(reference)).resolves.toBe(value);

    await chmod(path, 0o644);
    resolver.invalidate(reference);
    const error = await resolver.resolve(reference).catch((reason) => reason);
    expect(error).toBeInstanceOf(SecretResolutionError);
    expect((error as SecretResolutionError).code).toBe(
      "secret_store_file_permissions",
    );
    expect(String((error as Error).message)).not.toContain(value);
  });

  it("caches bounded values and invalidates explicitly at a rotation boundary", async () => {
    let calls = 0;
    let generation = 1;
    let value = "token-one";
    const adapter: SecretStoreAdapter = {
      id: "test-store",
      async load() {
        calls += 1;
        return {
          value,
          generation: String(generation),
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
    };
    const resolver = new ManagedSecretResolver(
      { cacheTtlMs: 60_000 },
      [new EnvironmentSecretStoreAdapter(), adapter],
    );
    const reference = `secret://mcp/${randomUUID()}`;
    await expect(resolver.resolve(reference)).resolves.toBe("token-one");
    await expect(resolver.resolve(reference)).resolves.toBe("token-one");
    expect(calls).toBe(1);

    generation = 2;
    value = "token-two";
    resolver.invalidate(reference);
    await expect(resolver.resolve(reference)).resolves.toBe("token-two");
    expect(calls).toBe(2);
  });

  it("reloads a mounted Secret Store after atomic file rotation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pluginmax-secret-rotate-"));
    const path = join(directory, "secrets.json");
    const reference = `secret://mcp/rotating/${randomUUID()}`;
    await writeFile(
      path,
      JSON.stringify({ secrets: { [reference]: "rotation-one" } }),
      { mode: 0o600 },
    );
    await chmod(path, 0o600);
    const resolver = new ManagedSecretResolver(
      { cacheTtlMs: 60_000 },
      [
        new EnvironmentSecretStoreAdapter(),
        new MountedFileSecretStoreAdapter(path),
      ],
    );
    await expect(resolver.resolve(reference)).resolves.toBe("rotation-one");
    await writeFile(
      path,
      JSON.stringify({ secrets: { [reference]: "rotation-two" } }),
      { mode: 0o600 },
    );
    await chmod(path, 0o600);
    await expect(resolver.resolveUncached(reference)).resolves.toBe(
      "rotation-two",
    );
  });

  it("classifies timeout and cancellation without exposing reference values", async () => {
    const adapter: SecretStoreAdapter = {
      id: "blocked-store",
      async load({ signal }) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        });
      },
    };
    const resolver = new ManagedSecretResolver(
      { timeoutMs: 10, cacheTtlMs: 0 },
      [new EnvironmentSecretStoreAdapter(), adapter],
    );
    const reference = `secret://mcp/timeout-${randomUUID()}`;
    await expect(resolver.resolve(reference)).rejects.toMatchObject({
      category: "timeout",
      code: "secret_resolution_timeout",
      retryable: true,
    });

    const controller = new AbortController();
    const pending = resolver.resolve(reference, {
      signal: controller.signal,
    });
    controller.abort();
    const cancelled = await pending.catch((reason) => reason);
    expect(cancelled).toMatchObject({
      category: "cancelled",
      code: "secret_resolution_cancelled",
    });
    expect(JSON.stringify(cancelled)).not.toContain("timeout-");
  });
});
