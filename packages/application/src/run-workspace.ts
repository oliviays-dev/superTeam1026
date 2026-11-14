import { resolve } from "node:path";

export function runWorkspacePath(workspaceRoot: string, runId: string): string {
  return resolve(workspaceRoot, "runs", runId);
}
