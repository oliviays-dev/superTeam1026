import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalFileStore } from "./index.js";

describe("LocalFileStore path confinement", () => {
  it("rejects a storage key symlink that escapes the configured root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pluginmax-file-store-"));
    const root = join(directory, "root");
    const outside = join(directory, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(root, "escape"));
    const store = new LocalFileStore(root);
    await expect(
      store.read({
        id: "escape",
        storageKey: "escape/secret.txt",
        name: "secret.txt",
        mimeType: "text/plain",
        size: 7,
        sha256: "a".repeat(64),
      }),
    ).rejects.toThrow(/symlink/u);
  });

  it("rejects absolute and backslash storage keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "pluginmax-file-store-"));
    const store = new LocalFileStore(root);
    for (const storageKey of ["/etc/passwd", "..\\secret", "a\\b"]) {
      await expect(
        store.read({
          id: "bad",
          storageKey,
          name: "bad",
          mimeType: "text/plain",
          size: 1,
          sha256: "a".repeat(64),
        }),
      ).rejects.toThrow(/unsafe file storage key/u);
    }
  });
});
