import type {
  ProjectMember,
  ProjectRole,
  RunStatus,
  TaskStatus,
} from "@pluginmax/contracts";

const taskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["in_progress", "cancelled"],
  in_progress: ["review", "cancelled"],
  review: ["done", "queued"],
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

export class ProjectMembershipRuleError extends Error {
  constructor(
    readonly code: "project_role_scope_mismatch" | "project_owner_required",
    message: string,
  ) {
    super(message);
    this.name = "ProjectMembershipRuleError";
  }
}

export function normalizeProjectRoleIds(
  projectId: string,
  roleIds: readonly string[],
  projectRoles: readonly ProjectRole[],
): string[] {
  const roleById = new Map(projectRoles.map((role) => [role.id, role]));
  return [...new Set(roleIds)].map((roleId) => {
    const role = roleById.get(roleId);
    if (role === undefined || role.projectId !== projectId) {
      throw new ProjectMembershipRuleError(
        "project_role_scope_mismatch",
        "All selected roles must belong to the project",
      );
    }
    return role.id;
  });
}

export function assertProjectMemberCanBeRemoved(member: ProjectMember): void {
  if (member.owner) {
    throw new ProjectMembershipRuleError(
      "project_owner_required",
      "The project owner cannot be removed or deactivated",
    );
  }
}
