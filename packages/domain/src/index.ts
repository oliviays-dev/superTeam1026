import type { RunStatus, TaskStatus } from "@pluginmax/contracts";

const taskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["in_progress", "cancelled"],
  in_progress: ["review", "cancelled"],
  review: ["done", "in_progress"],
  done: [],
  cancelled: [],
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return taskTransitions[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new Error(`invalid task transition: ${from} -> ${to}`);
  }
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "timeout" ||
    status === "interrupted"
  );
}

export function projectCode(name: string, sequence: number): string {
  const normalized = name
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase()
    .slice(0, 20);
  const prefix = normalized === "" ? "PROJECT" : normalized;
  return `${prefix}-${String(sequence).padStart(4, "0")}`;
}
