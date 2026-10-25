import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MAX_MEETING_FILE_BYTES,
  meetingFileSchema,
  type MeetingFile,
} from "./phase1-models.js";
import {
  type KvTableLike,
  MeetingError,
  idSchema,
  nowIso,
  parseOrInvalid,
  tableValues,
} from "./shared.js";

export interface MeetingFileDeps {
  readonly files: KvTableLike<MeetingFile>;
  readonly now?: () => Date;
}

/**
 * Files shared into a meeting. Bytes are stored inline (base64) with a hard
 * size cap so the meeting domain stays self-contained and does not depend on
 * the workspace sharing plugin being installed.
 */
export class MeetingFileService {
  private readonly now: () => Date;

  constructor(private readonly deps: MeetingFileDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async put(input: {
    readonly meetingId: string;
    readonly uploadedBy: string;
    readonly name: string;
    readonly mime?: string;
    readonly data: string;
  }): Promise<MeetingFile> {
    const parsed = parseOrInvalid(
      z.object({
        meetingId: z.string().min(1).max(160),
        uploadedBy: idSchema,
        name: z.string().trim().min(1).max(240),
        mime: z.string().trim().max(160).optional(),
        data: z.string().min(1).max(800_000),
      }),
      input,
    );
    const size = Buffer.byteLength(parsed.data, "base64");
    if (size > MAX_MEETING_FILE_BYTES)
      throw new MeetingError(
        "invalid_input",
        `file exceeds the ${Math.round(MAX_MEETING_FILE_BYTES / 1024)}KB limit`,
      );
    const file = parseOrInvalid(meetingFileSchema, {
      id: randomUUID(),
      meetingId: parsed.meetingId,
      name: parsed.name,
      mime: parsed.mime ?? "",
      size,
      data: parsed.data,
      uploadedBy: parsed.uploadedBy,
      createdAt: nowIso(this.now),
    });
    await this.deps.files.put(file.id, file);
    return file;
  }

  get(fileId: string): MeetingFile {
    const parsed = parseOrInvalid(idSchema, fileId);
    const value = this.deps.files.get(parsed);
    if (value === undefined)
      throw new MeetingError("not_found", "meeting file not found");
    return parseOrInvalid(meetingFileSchema, value);
  }

  list(meetingId: string): MeetingFile[] {
    return tableValues(this.deps.files)
      .map((value) => parseOrInvalid(meetingFileSchema, value))
      .filter((file) => file.meetingId === meetingId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}
