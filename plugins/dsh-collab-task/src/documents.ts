import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import type { TaskRecord } from "./types.js";

/** A window in which an agent run could have written files. */
export interface DocumentWindow {
  readonly from: number;
  readonly to: number;
  readonly actor: string;
  readonly runId?: string | undefined;
}

export interface TaskDocumentEntry {
  readonly id: string;
  /** Producing run; absent only for legacy task-level files. */
  readonly runId?: string | undefined;
  readonly kind: "produced" | "uploaded";
  readonly name: string;
  readonly relativePath: string;
  readonly size: number;
  readonly mimeType: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
  readonly available: boolean;
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".pnpm-store",
  ".pluginmax",
  "node_modules",
  "__pycache__",
  ".venv",
]);

/** 操作系统生成的元数据文件，不属于交付物。 */
const IGNORED_FILES = new Set([
  ".DS_Store",
  ".localized",
  "Thumbs.db",
  "desktop.ini",
]);

const RUN_SETTLE_GRACE_MS = 15 * 60_000;

const MIME_TYPES: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

const TEXT_DOCUMENT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".csv",
  ".json",
  ".yml",
  ".yaml",
  ".html",
  ".css",
  ".js",
  ".mjs",
  ".ts",
  ".tsx",
  ".svg",
]);

export function mimeTypeFor(name: string): string {
  return MIME_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** Directory holding the bytes of files uploaded by task participants. */
export function uploadDirectory(root: string, taskId: string): string {
  return join(root, ".pluginmax", "task-uploads", taskId);
}

export function safeFileName(name: string): string {
  const trimmed = basename(name)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\p{Cc}/gu, "_")
    .trim();
  const safe =
    trimmed === "" || trimmed === "." || trimmed === ".." ? "file" : trimmed;
  return safe.slice(-160);
}

function normalizedDocumentName(value: string): string | undefined {
  const trimmed = value
    .trim()
    .replace(/^[`"'“”]+/, "")
    .replace(/[`"'“”]+$/, "");
  const candidate = safeFileName(basename(trimmed));
  if (!TEXT_DOCUMENT_EXTENSIONS.has(extname(candidate).toLowerCase())) {
    return undefined;
  }
  return candidate;
}

function withoutMarkdownFence(content: string): string {
  const trimmed = content.trim();
  const fenced =
    /^```(?:markdown|md|text|txt)?[^\r\n]*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(
      trimmed,
    );
  return (fenced?.[1] ?? trimmed).trim();
}

function contentForNamedOutput(output: string, nameEnd: number): string {
  const remainder = output.slice(nameEnd);
  const firstHeading = /^#{1,6}\s+\S/m.exec(remainder);
  const body =
    firstHeading !== null && firstHeading.index <= 1_000
      ? remainder.slice(firstHeading.index)
      : remainder;
  return withoutMarkdownFence(body);
}

export interface AgentOutputDocument {
  readonly name: string;
  readonly content: string;
}

/**
 * Read-only runtimes cannot write files into the workspace. They can still
 * return complete document bodies in the final message, so retain an explicit
 * machine-readable protocol and a legacy natural-language filename fallback.
 */
export function extractAgentOutputDocuments(
  output: string,
): AgentOutputDocument[] {
  const value = output.trim();
  if (value === "") return [];
  const documents: AgentOutputDocument[] = [];
  const marker = /<!--\s*pluginmax-document\s*:\s*([^\r\n>]+?)\s*-->/gi;
  let markerMatch: RegExpExecArray | null;
  while ((markerMatch = marker.exec(value)) !== null) {
    const endMarker = /<!--\s*\/pluginmax-document\s*-->/gi.exec(
      value.slice(marker.lastIndex),
    );
    if (endMarker === null) continue;
    const name = normalizedDocumentName(markerMatch[1] ?? "");
    const content = withoutMarkdownFence(
      value.slice(marker.lastIndex, marker.lastIndex + endMarker.index),
    );
    if (name !== undefined && content !== "") {
      documents.push({ name, content });
    }
    marker.lastIndex += endMarker.index + endMarker[0].length;
  }
  if (documents.length > 0) return documents.slice(0, 20);

  const fenced =
    /^```(?:markdown|md|text|txt)?[ \t]+(?:filename|file|name)\s*=\s*["'`]?([^"'`\r\n]+?)(?:["'`])?[ \t]*\r?\n([\s\S]*?)\r?\n```/gimu;
  let fencedMatch: RegExpExecArray | null;
  while ((fencedMatch = fenced.exec(value)) !== null) {
    const name = normalizedDocumentName(fencedMatch[1] ?? "");
    const content = (fencedMatch[2] ?? "").trim();
    if (name !== undefined && content !== "") {
      documents.push({ name, content });
    }
  }
  if (documents.length > 0) return documents.slice(0, 20);

  const patterns = [
    /(?:名为|文件名(?:称)?(?:为|是)?|文档名(?:称)?(?:为|是)?|保存为|保存到|输出为|输出到|下载文件名(?:为)?)\s*[：:]?\s*[`"'“”]([^`"'“”\r\n]+?\.(?:md|markdown|txt|csv|json|yml|yaml|html|css|js|mjs|ts|tsx|svg))[`"'“”]/iu,
    /(?:名为|文件名(?:称)?(?:为|是)?|文档名(?:称)?(?:为|是)?|保存为|保存到|输出为|输出到|下载文件名(?:为)?)\s*[：:]?\s*([^\s`"'“”<>:：，。；;]+?\.(?:md|markdown|txt|csv|json|yml|yaml|html|css|js|mjs|ts|tsx|svg))/iu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match === null) continue;
    const name = normalizedDocumentName(match[1] ?? "");
    if (name === undefined) continue;
    const content = contentForNamedOutput(
      value,
      (match.index ?? 0) + match[0].length,
    );
    if (content !== "") return [{ name, content }];
  }
  return [];
}

export function toRelativePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

export interface AgentOutputRun {
  readonly id: string;
  readonly status?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly endedAt?: string | undefined;
  readonly updatedAt?: string | undefined;
  readonly actor: string;
  readonly output?: { readonly summary: string } | undefined;
}

export interface MaterializeAgentOutputOptions {
  readonly root: string;
  readonly taskId: string;
  readonly runs: readonly AgentOutputRun[];
  readonly now?: Date;
}

/**
 * Persists named documents returned in successful run output. Per-run folders
 * keep retries idempotent and avoid overwriting files from earlier rounds.
 */
export async function materializeAgentOutputDocuments(
  options: MaterializeAgentOutputOptions,
): Promise<TaskDocumentEntry[]> {
  const now = options.now ?? new Date();
  const entries: TaskDocumentEntry[] = [];
  for (const run of options.runs) {
    if (run.status !== undefined && run.status !== "succeeded") continue;
    const documents = extractAgentOutputDocuments(run.output?.summary ?? "");
    if (documents.length === 0) continue;
    const directory = join(
      options.root,
      ".pluginmax",
      "task-outputs",
      safeFileName(options.taskId),
      safeFileName(run.id),
    );
    await mkdir(directory, { recursive: true });
    for (const document of documents) {
      const name = safeFileName(document.name);
      const absolute = join(directory, name);
      const content = document.content.endsWith("\n")
        ? document.content
        : `${document.content}\n`;
      try {
        await writeFile(absolute, content, { encoding: "utf8", flag: "wx" });
      } catch (cause) {
        if (
          typeof cause !== "object" ||
          cause === null ||
          (cause as { code?: unknown }).code !== "EEXIST"
        ) {
          throw cause;
        }
      }
      const info = await stat(absolute);
      const candidateTime =
        run.endedAt ?? run.updatedAt ?? run.createdAt ?? now.toISOString();
      const updatedAt = Number.isNaN(Date.parse(candidateTime))
        ? now.toISOString()
        : candidateTime;
      const relativePath = toRelativePath(options.root, absolute);
      entries.push({
        id: `produced:${relativePath}`,
        runId: run.id,
        kind: "produced",
        name,
        relativePath,
        size: info.size,
        mimeType: mimeTypeFor(name),
        updatedBy: run.actor,
        updatedAt,
        available: true,
      });
    }
  }
  return entries.sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.name.localeCompare(right.name),
  );
}

export interface CollectDocumentsOptions {
  readonly root: string;
  readonly windows: readonly DocumentWindow[];
  readonly maxFiles?: number;
  readonly maxEntries?: number;
}

/**
 * Lists files written inside the workspace while one of the given agent runs
 * was active. Newest first; each entry carries the run owner as `updatedBy`.
 */
export async function collectDocuments(
  options: CollectDocumentsOptions,
): Promise<TaskDocumentEntry[]> {
  const { root, windows } = options;
  if (windows.length === 0) return [];
  const maxFiles = options.maxFiles ?? 200;
  const maxEntries = options.maxEntries ?? 6000;
  const found = new Map<string, TaskDocumentEntry>();
  const queue: string[] = [""];
  let visited = 0;
  while (queue.length > 0 && found.size < maxFiles && visited < maxEntries) {
    const directory = queue.shift() ?? "";
    let dirents;
    try {
      dirents = await readdir(join(root, directory), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      visited += 1;
      if (visited > maxEntries) break;
      const childRelative =
        directory === "" ? dirent.name : `${directory}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(dirent.name)) queue.push(childRelative);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (IGNORED_FILES.has(dirent.name)) continue;
      let info;
      try {
        info = await stat(join(root, childRelative));
      } catch {
        continue;
      }
      const window = windows
        .filter((item) => info.mtimeMs >= item.from && info.mtimeMs <= item.to)
        .sort((left, right) => right.from - left.from)[0];
      if (window === undefined) continue;
      const updatedAt = new Date(info.mtimeMs).toISOString();
      const timestamp = Date.parse(updatedAt);
      const entry: TaskDocumentEntry = {
        id: `produced:${childRelative}`,
        ...(window.runId === undefined ? {} : { runId: window.runId }),
        kind: "produced",
        name: basename(childRelative),
        relativePath: childRelative,
        size: info.size,
        mimeType: mimeTypeFor(childRelative),
        updatedBy: window.actor,
        updatedAt,
        available: true,
      };
      const current = found.get(childRelative);
      if (current === undefined || Date.parse(current.updatedAt) < timestamp) {
        found.set(childRelative, entry);
      }
    }
  }
  return [...found.values()].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.name.localeCompare(right.name),
  );
}

export function windowsFromRuns(
  runs: readonly {
    readonly id?: string | undefined;
    readonly startedAt?: string | undefined;
    readonly endedAt?: string | undefined;
    readonly createdAt?: string | undefined;
    readonly actor: string;
  }[],
  fallbackActor: string,
  now: number,
): DocumentWindow[] {
  const windows: DocumentWindow[] = [];
  const sorted = runs
    .map((run) => ({
      id: run.id,
      start: Date.parse(run.startedAt ?? run.createdAt ?? ""),
      end: Date.parse(run.endedAt ?? ""),
      actor: run.actor,
    }))
    .filter((run) => !Number.isNaN(run.start))
    .sort((left, right) => left.start - right.start);
  sorted.forEach((run, index) => {
    const nextStart = sorted[index + 1]?.start;
    const ended = Number.isNaN(run.end) ? now : run.end + RUN_SETTLE_GRACE_MS;
    windows.push({
      from: run.start - 5_000,
      // 子代理可能在父 run settle 后短暂继续写文件，但不能把窗口无限延伸到
      // 后续任务运行期间，否则同工作区的其他任务产出会被错误串台。
      to: Math.min(ended, nextStart ?? Number.POSITIVE_INFINITY),
      actor: run.actor === "" ? fallbackActor : run.actor,
      ...(run.id === undefined ? {} : { runId: run.id }),
    });
  });
  return windows;
}

/** Uploaded attachments recorded on task messages, newest message first. */
export function attachmentDocuments(
  task: Pick<TaskRecord, "messages">,
  workspaceReady: boolean,
  runIdByMessageId: ReadonlyMap<string, string> = new Map(),
): TaskDocumentEntry[] {
  const documents: TaskDocumentEntry[] = [];
  for (const message of task.messages) {
    const runId = runIdByMessageId.get(message.id);
    message.attachments.forEach((attachment, index) => {
      const storedPath = attachment.storedPath;
      documents.push({
        id: `uploaded:${message.id}:${index}`,
        ...(runId === undefined ? {} : { runId }),
        kind: "uploaded",
        name: attachment.name,
        relativePath: storedPath ?? "",
        size: attachment.size ?? 0,
        mimeType: attachment.mimeType ?? mimeTypeFor(attachment.name),
        updatedBy: message.authorName,
        updatedAt: message.at,
        available: storedPath !== undefined && workspaceReady,
      });
    });
  }
  return documents;
}

/** Merges entries that point at the same file, keeping the newest one. */
export function mergeDocuments(
  documents: readonly TaskDocumentEntry[],
): TaskDocumentEntry[] {
  const merged = new Map<string, TaskDocumentEntry>();
  for (const document of documents) {
    const key =
      document.relativePath === "" ? document.id : document.relativePath;
    const current = merged.get(key);
    if (
      current === undefined ||
      Date.parse(current.updatedAt) <= Date.parse(document.updatedAt)
    ) {
      merged.set(key, document);
    }
  }
  return [...merged.values()].sort(
    (left, right) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.name.localeCompare(right.name),
  );
}
