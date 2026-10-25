import { z } from "zod";

/**
 * Primitive schemas, error type, and storage helpers shared by the meeting
 * plugin's cohesive modules. Kept dependency-free so services can import them
 * without pulling in the plugin entry point (and without cycles).
 */

export const idSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const isoTimeSchema = z.string().datetime({ precision: 3 });

export const displayNameSchema = z.string().trim().min(1).max(80);

export class MeetingError extends Error {
  constructor(
    readonly code:
      | "invalid_input"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "MeetingError";
  }
}

export function parseOrInvalid<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new MeetingError(
      "invalid_input",
      result.error.issues
        .map((issue) => `${issue.path.join(".") || "input"} is invalid`)
        .join("; "),
    );
  }
  return result.data;
}

export function nowIso(now: () => Date): string {
  return now().toISOString();
}

export interface KvTableLike<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  keys(): IterableIterator<string>;
  get size(): number;
  put(key: string, value: V): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export function tableValues<V>(table: KvTableLike<V>): V[] {
  return [...table.entries()].map(([, value]) => value);
}

/**
 * Process-local serialization by key. Used as the default for services whose
 * invariants (one active facilitator, monotonic minutes versions, one active
 * delegate per principal) must hold under concurrent HTTP handlers.
 *
 * A host-provided lock can replace this when the runtime exposes a shared lock
 * primitive; the contract is intentionally small so the swap is mechanical.
 */
export function createKeyedMutex(): <T>(
  key: string,
  task: () => Promise<T>,
) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = chains.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settle = () => {
      if (chains.get(key) === run) chains.delete(key);
    };
    void run.then(settle, settle);
    chains.set(key, run);
    return run;
  };
}
