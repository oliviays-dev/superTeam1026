import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type { AgentToolWorkspaceLimits } from "@pluginmax/contracts";

export type WorkspacePathErrorCode =
  | "workspace_path_empty"
  | "workspace_path_absolute"
  | "workspace_path_parent_traversal"
  | "workspace_path_nul"
  | "workspace_path_backslash"
  | "workspace_path_control_character"
  | "workspace_path_escape"
  | "workspace_symlink_rejected"
  | "workspace_entry_not_file"
  | "workspace_entry_not_directory"
  | "workspace_read_limit_exceeded"
  | "workspace_write_limit_exceeded"
  | "workspace_list_depth_exceeded"
  | "workspace_list_entries_exceeded"
  | "workspace_list_output_limit_exceeded";

export class WorkspacePathError extends Error {
  constructor(
    readonly code: WorkspacePathErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export interface WorkspaceReadResult {
  readonly content: Uint8Array;
  readonly byteCount: number;
  readonly sha256: string;
  readonly pathDigest: string;
  readonly pathSummary: string;
  readonly relativePath: string;
}

export interface WorkspaceWriteResult {
  readonly byteCount: number;
  readonly sha256: string;
  readonly pathDigest: string;
  readonly pathSummary: string;
  readonly relativePath: string;
  readonly replaced: boolean;
}

export interface WorkspaceListEntry {
  readonly path: string;
  readonly type: "file" | "directory";
  readonly size: number | null;
}

export interface WorkspaceListResult {
  readonly pathDigest: string;
  readonly pathSummary: string;
  readonly entries: readonly WorkspaceListEntry[];
  readonly entryCount: number;
  readonly byteCount: number;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathSummary(segments: readonly string[]): string {
  if (segments.length === 0) return ".";
  const summary =
    segments.length <= 2 ? segments.join("/") : `.../${segments.slice(-2).join("/")}`;
  return summary.slice(0, 500);
}

function normalizedRelativePath(
  value: string,
  options: { readonly allowRoot: boolean },
): { readonly relativePath: string; readonly segments: string[] } {
  if (value.length === 0) {
    throw new WorkspacePathError(
      "workspace_path_empty",
      "Workspace path must not be empty",
    );
  }
  if (value.includes("\u0000")) {
    throw new WorkspacePathError(
      "workspace_path_nul",
      "Workspace path must not contain NUL",
    );
  }
  if (value.includes("\\")) {
    throw new WorkspacePathError(
      "workspace_path_backslash",
      "Workspace path must use forward slashes",
    );
  }
  if ([...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  })) {
    throw new WorkspacePathError(
      "workspace_path_control_character",
      "Workspace path must not contain control characters",
    );
  }
  if (isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    throw new WorkspacePathError(
      "workspace_path_absolute",
      "Workspace path must be relative",
    );
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new WorkspacePathError(
      "workspace_path_parent_traversal",
      "Workspace path must not contain parent traversal",
    );
  }
  if (segments.some((segment) => segment.length === 0)) {
    throw new WorkspacePathError(
      "workspace_path_escape",
      "Workspace path segments must not be empty",
    );
  }
  if (
    segments.length === 1 &&
    segments[0] === "." &&
    !options.allowRoot
  ) {
    throw new WorkspacePathError(
      "workspace_path_escape",
      "Workspace root is only allowed for listing",
    );
  }
  if (segments.length > 1 && segments.includes(".")) {
    throw new WorkspacePathError(
      "workspace_path_escape",
      "Workspace path must not contain dot segments",
    );
  }
  return {
    relativePath: segments.join("/"),
    segments,
  };
}

export class WorkspaceFileSandbox {
  constructor(
    private readonly configuredRoot: string,
    private readonly limits: AgentToolWorkspaceLimits,
  ) {}

  private async root(): Promise<string> {
    await mkdir(this.configuredRoot, { recursive: true });
    const rootStat = await lstat(this.configuredRoot);
    if (rootStat.isSymbolicLink()) {
      throw new WorkspacePathError(
        "workspace_symlink_rejected",
        "Workspace root must not be a symbolic link",
      );
    }
    if (!rootStat.isDirectory()) {
      throw new WorkspacePathError(
        "workspace_entry_not_directory",
        "Workspace root is not a directory",
      );
    }
    return resolve(this.configuredRoot);
  }

  private withinRoot(root: string, candidate: string): void {
    const outside = relative(root, candidate);
    if (outside.startsWith("..") || isAbsolute(outside)) {
      throw new WorkspacePathError(
        "workspace_path_escape",
        "Workspace path escapes its Run root",
      );
    }
  }

  private async assertExistingPathSafe(
    root: string,
    segments: readonly string[],
    options: { readonly includeLeaf: boolean },
  ): Promise<string> {
    let current = root;
    const upperBound = options.includeLeaf ? segments.length : segments.length - 1;
    for (let index = 0; index < upperBound; index += 1) {
      current = join(current, segments[index]!);
      try {
        const value = await lstat(current);
        if (value.isSymbolicLink()) {
          throw new WorkspacePathError(
            "workspace_symlink_rejected",
            "Workspace path contains a symbolic link",
            { segment: segments[index] },
          );
        }
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          break;
        }
        throw error;
      }
    }
    this.withinRoot(root, current);
    return current;
  }

  private async target(
    value: string,
    options: { readonly allowRoot: boolean; readonly includeLeaf: boolean },
  ): Promise<{
    readonly root: string;
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly segments: string[];
  }> {
    const normalized = normalizedRelativePath(value, {
      allowRoot: options.allowRoot,
    });
    const root = await this.root();
    const segments =
      normalized.segments.length === 1 && normalized.segments[0] === "."
        ? []
        : normalized.segments;
    const absolutePath = resolve(root, ...segments);
    this.withinRoot(root, absolutePath);
    await this.assertExistingPathSafe(root, segments, {
      includeLeaf: options.includeLeaf,
    });
    return {
      root,
      absolutePath,
      relativePath: segments.length === 0 ? "." : normalized.relativePath,
      segments,
    };
  }

  async readFile(relativePath: string): Promise<WorkspaceReadResult> {
    const target = await this.target(relativePath, {
      allowRoot: false,
      includeLeaf: false,
    });
    const handle = await open(
      target.absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ELOOP"
      ) {
        throw new WorkspacePathError(
          "workspace_symlink_rejected",
          "Workspace read target is a symbolic link",
        );
      }
      throw error;
    });
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw new WorkspacePathError(
          "workspace_entry_not_file",
          "Workspace read target is not a regular file",
        );
      }
      if (metadata.size > this.limits.maxReadBytes) {
        throw new WorkspacePathError(
          "workspace_read_limit_exceeded",
          "Workspace file exceeds the read byte limit",
          { size: metadata.size, limit: this.limits.maxReadBytes },
        );
      }
      const buffer = Buffer.allocUnsafe(this.limits.maxReadBytes + 1);
      let offset = 0;
      while (offset < buffer.byteLength) {
        const result = await handle.read(
          buffer,
          offset,
          buffer.byteLength - offset,
          offset,
        );
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      if (offset > this.limits.maxReadBytes) {
        throw new WorkspacePathError(
          "workspace_read_limit_exceeded",
          "Workspace file exceeds the read byte limit",
          { limit: this.limits.maxReadBytes },
        );
      }
      const content = buffer.subarray(0, offset);
      return {
        content,
        byteCount: content.byteLength,
        sha256: digest(content),
        pathDigest: digest(target.relativePath),
        pathSummary: pathSummary(target.segments),
        relativePath: target.relativePath,
      };
    } finally {
      await handle.close();
    }
  }

  async writeFile(
    relativePath: string,
    content: Uint8Array,
  ): Promise<WorkspaceWriteResult> {
    if (content.byteLength > this.limits.maxWriteBytes) {
      throw new WorkspacePathError(
        "workspace_write_limit_exceeded",
        "Workspace write exceeds the byte limit",
        { size: content.byteLength, limit: this.limits.maxWriteBytes },
      );
    }
    const target = await this.target(relativePath, {
      allowRoot: false,
      includeLeaf: true,
    });
    const parent = dirname(target.absolutePath);
    await mkdir(parent, { recursive: true });
    await this.assertExistingPathSafe(
      target.root,
      target.segments.slice(0, -1),
      { includeLeaf: true },
    );
    this.withinRoot(target.root, parent);

    let replaced = false;
    try {
      const current = await lstat(target.absolutePath);
      if (current.isSymbolicLink()) {
        throw new WorkspacePathError(
          "workspace_symlink_rejected",
          "Workspace write target is a symbolic link",
        );
      }
      replaced = true;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      )) {
        throw error;
      }
    }

    const temporaryPath = join(
      parent,
      `.${basename(target.absolutePath)}.${randomUUID()}.tmp`,
    );
    let handle:
      | Awaited<ReturnType<typeof open>>
      | undefined;
    try {
      handle = await open(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, target.absolutePath);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return {
      byteCount: content.byteLength,
      sha256: digest(content),
      pathDigest: digest(target.relativePath),
      pathSummary: pathSummary(target.segments),
      relativePath: target.relativePath,
      replaced,
    };
  }

  async listFiles(
    relativePath: string,
    depth: number,
  ): Promise<WorkspaceListResult> {
    if (depth > this.limits.maxListDepth) {
      throw new WorkspacePathError(
        "workspace_list_depth_exceeded",
        "Workspace list depth exceeds the configured limit",
        { depth, limit: this.limits.maxListDepth },
      );
    }
    const target = await this.target(relativePath, {
      allowRoot: true,
      includeLeaf: true,
    });
    const rootStat = await lstat(target.absolutePath);
    if (rootStat.isSymbolicLink()) {
      throw new WorkspacePathError(
        "workspace_symlink_rejected",
        "Workspace list target is a symbolic link",
      );
    }
    if (!rootStat.isDirectory()) {
      throw new WorkspacePathError(
        "workspace_entry_not_directory",
        "Workspace list target is not a directory",
      );
    }
    const entries: WorkspaceListEntry[] = [];
    let outputBytes = 0;
    const walk = async (absoluteDirectory: string, currentDepth: number) => {
      const children = await readdir(absoluteDirectory, {
        withFileTypes: true,
      });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        const absoluteChild = join(absoluteDirectory, child.name);
        const childRelative = relative(target.root, absoluteChild)
          .split(sep)
          .join("/");
        const childStat = await lstat(absoluteChild);
        if (childStat.isSymbolicLink()) {
          throw new WorkspacePathError(
            "workspace_symlink_rejected",
            "Workspace list encountered a symbolic link",
            { path: pathSummary(childRelative.split("/")) },
          );
        }
        if (entries.length >= this.limits.maxListEntries) {
          throw new WorkspacePathError(
            "workspace_list_entries_exceeded",
            "Workspace list exceeds the configured entry limit",
            { limit: this.limits.maxListEntries },
          );
        }
        const entry: WorkspaceListEntry = {
          path: childRelative,
          type: childStat.isDirectory() ? "directory" : "file",
          size: childStat.isFile() ? childStat.size : null,
        };
        outputBytes += Buffer.byteLength(JSON.stringify(entry), "utf8");
        if (outputBytes > this.limits.maxListOutputBytes) {
          throw new WorkspacePathError(
            "workspace_list_output_limit_exceeded",
            "Workspace list exceeds the configured output byte limit",
            { limit: this.limits.maxListOutputBytes },
          );
        }
        entries.push(entry);
        if (entry.type === "directory" && currentDepth < depth) {
          await walk(absoluteChild, currentDepth + 1);
        }
      }
    };
    await walk(target.absolutePath, 0);
    return {
      pathDigest: digest(target.relativePath),
      pathSummary: pathSummary(target.segments),
      entries,
      entryCount: entries.length,
      byteCount: outputBytes,
    };
  }
}
