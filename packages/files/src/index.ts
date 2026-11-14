import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export * from "./workspace-sandbox.js";

export interface FileRef {
  readonly id: string;
  readonly storageKey: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly sha256: string;
}

export interface PutFileInput {
  readonly workspaceId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly content: Uint8Array;
}

export interface FileStore {
  put(input: PutFileInput): Promise<FileRef>;
  read(ref: FileRef): Promise<Uint8Array>;
  stat(ref: FileRef): Promise<{ readonly size: number }>;
  delete?(ref: FileRef): Promise<void>;
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error("unsafe file path segment");
  }
  return value;
}

export class LocalFileStore implements FileStore {
  constructor(private readonly root: string) {}

  private async storageRoot(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    return realpath(resolve(this.root));
  }

  private async safeTarget(storageKey: string): Promise<string> {
    const hasControl = [...storageKey].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    });
    if (
      storageKey === "" ||
      isAbsolute(storageKey) ||
      storageKey.includes("\\") ||
      hasControl
    ) {
      throw new Error("unsafe file storage key");
    }
    const root = await this.storageRoot();
    const candidate = resolve(root, storageKey);
    const outside = relative(root, candidate);
    if (outside.startsWith("..") || isAbsolute(outside)) {
      throw new Error("file path escapes the storage root");
    }
    try {
      const actual = await realpath(candidate);
      const actualOutside = relative(root, actual);
      if (actualOutside.startsWith("..") || isAbsolute(actualOutside)) {
        throw new Error("file path escapes the storage root through a symlink");
      }
      return actual;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return candidate;
      }
      throw error;
    }
  }

  async put(input: PutFileInput): Promise<FileRef> {
    const workspaceId = safeSegment(input.workspaceId);
    const id = randomUUID();
    const storageKey = join(workspaceId, id, "content");
    const target = await this.safeTarget(storageKey);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.content, { mode: 0o600 });
    return {
      id,
      storageKey,
      name: input.name,
      mimeType: input.mimeType,
      size: input.content.byteLength,
      sha256: createHash("sha256").update(input.content).digest("hex"),
    };
  }

  async read(ref: FileRef): Promise<Uint8Array> {
    return readFile(await this.safeTarget(ref.storageKey));
  }

  async stat(ref: FileRef): Promise<{ readonly size: number }> {
    const value = await stat(await this.safeTarget(ref.storageKey));
    return { size: value.size };
  }

  async delete(ref: FileRef): Promise<void> {
    const target = await this.safeTarget(ref.storageKey);
    await rm(target, { force: true });
  }
}
