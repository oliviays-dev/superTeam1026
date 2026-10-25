import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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
}

function safeSegment(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error("unsafe file path segment");
  }
  return value;
}

export class LocalFileStore implements FileStore {
  constructor(private readonly root: string) {}

  async put(input: PutFileInput): Promise<FileRef> {
    const workspaceId = safeSegment(input.workspaceId);
    const id = randomUUID();
    const storageKey = join(workspaceId, id, "content");
    const target = resolve(this.root, storageKey);
    const root = resolve(this.root);
    if (!target.startsWith(`${root}/`)) {
      throw new Error("file path escapes the storage root");
    }

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
    return readFile(resolve(this.root, ref.storageKey));
  }

  async stat(ref: FileRef): Promise<{ readonly size: number }> {
    const value = await stat(resolve(this.root, ref.storageKey));
    return { size: value.size };
  }
}
