import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceFileSandbox, WorkspacePathError } from "./index.js";

function limits(overrides: Partial<ConstructorParameters<typeof WorkspaceFileSandbox>[1]> = {}) {
  return {
    maxReadBytes: 32,
    maxWriteBytes: 32,
    maxListDepth: 3,
    maxListEntries: 20,
    maxListOutputBytes: 8_192,
    ...overrides,
  };
}

async function sandboxFixture(
  overrides: Partial<ConstructorParameters<typeof WorkspaceFileSandbox>[1]> = {},
) {
  const parent = await mkdtemp(join(tmpdir(), "pluginmax-workspace-sandbox-"));
  const root = join(parent, "run");
  await mkdir(root, { recursive: true });
  return {
    parent,
    root,
    sandbox: new WorkspaceFileSandbox(root, limits(overrides)),
  };
}

async function expectPathError(
  operation: Promise<unknown>,
  code: WorkspacePathError["code"],
) {
  await expect(operation).rejects.toMatchObject({ code });
}

describe("WorkspaceFileSandbox path confinement", () => {
  it("rejects absolute paths, parent traversal, NUL, backslashes, and escapes", async () => {
    const { sandbox } = await sandboxFixture();
    for (const path of ["/etc/passwd", "C:/secret"]) {
      await expectPathError(sandbox.readFile(path), "workspace_path_absolute");
    }
    for (const path of ["../secret", ".."]) {
      await expectPathError(
        sandbox.readFile(path),
        "workspace_path_parent_traversal",
      );
    }
    await expectPathError(
      sandbox.readFile("a\u0000b"),
      "workspace_path_nul",
    );
    await expectPathError(
      sandbox.readFile("a\\b"),
      "workspace_path_backslash",
    );
    await expectPathError(
      sandbox.writeFile("../escape.txt", Buffer.from("blocked")),
      "workspace_path_parent_traversal",
    );
    await expectPathError(
      sandbox.listFiles("nested/../.", 1),
      "workspace_path_parent_traversal",
    );
  });

  it("rejects symbolic links at any path level", async () => {
    const { parent, root, sandbox } = await sandboxFixture();
    const outside = join(parent, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(outside, join(root, "linked-directory"));
    await symlink(
      join(outside, "secret.txt"),
      join(root, "linked-file.txt"),
    );

    await expectPathError(
      sandbox.readFile("linked-directory/secret.txt"),
      "workspace_symlink_rejected",
    );
    await expectPathError(
      sandbox.readFile("linked-file.txt"),
      "workspace_symlink_rejected",
    );
    await expectPathError(
      sandbox.writeFile("linked-file.txt", Buffer.from("overwrite")),
      "workspace_symlink_rejected",
    );
    await expectPathError(
      sandbox.listFiles(".", 2),
      "workspace_symlink_rejected",
    );
  });
});

describe("WorkspaceFileSandbox limits and atomic writes", () => {
  it("enforces read, write, depth, entry, and output limits", async () => {
    const { root, sandbox } = await sandboxFixture({
      maxReadBytes: 4,
      maxWriteBytes: 4,
      maxListDepth: 1,
      maxListEntries: 1,
      maxListOutputBytes: 1_000,
    });
    await writeFile(join(root, "large.txt"), "12345");
    await expectPathError(
      sandbox.readFile("large.txt"),
      "workspace_read_limit_exceeded",
    );
    await expectPathError(
      sandbox.writeFile("large.txt", Buffer.from("12345")),
      "workspace_write_limit_exceeded",
    );
    await expectPathError(
      sandbox.listFiles(".", 2),
      "workspace_list_depth_exceeded",
    );
    await writeFile(join(root, "one.txt"), "1");
    await writeFile(join(root, "two.txt"), "2");
    await expectPathError(
      sandbox.listFiles(".", 1),
      "workspace_list_entries_exceeded",
    );
    const { root: outputRoot, sandbox: outputLimited } = await sandboxFixture({
      maxListOutputBytes: 10,
    });
    await writeFile(join(outputRoot, "a.txt"), "a");
    await expectPathError(
      outputLimited.listFiles(".", 1),
      "workspace_list_output_limit_exceeded",
    );
  });

  it("writes through a same-directory temporary file and atomic rename", async () => {
    const { root, sandbox } = await sandboxFixture();
    const created = await sandbox.writeFile(
      "nested/artifact.txt",
      Buffer.from("first"),
    );
    expect(created).toMatchObject({
      relativePath: "nested/artifact.txt",
      byteCount: 5,
    });
    expect(await readFile(join(root, "nested/artifact.txt"), "utf8")).toBe(
      "first",
    );
    expect(await readdir(join(root, "nested"))).toEqual(["artifact.txt"]);

    const replaced = await sandbox.writeFile(
      "nested/artifact.txt",
      Buffer.from("second"),
    );
    expect(replaced.replaced).toBe(true);
    expect(await readFile(join(root, "nested/artifact.txt"), "utf8")).toBe(
      "second",
    );
    expect(await readdir(join(root, "nested"))).toEqual(["artifact.txt"]);
  });

  it("leaves the previous file intact when a write fails before rename", async () => {
    const { root, sandbox } = await sandboxFixture({ maxWriteBytes: 4 });
    await sandbox.writeFile("safe.txt", Buffer.from("safe"));
    await expectPathError(
      sandbox.writeFile("safe.txt", Buffer.from("partial-failure")),
      "workspace_write_limit_exceeded",
    );
    expect(await readFile(join(root, "safe.txt"), "utf8")).toBe("safe");
    expect(await readdir(root)).toEqual(["safe.txt"]);
  });
});
