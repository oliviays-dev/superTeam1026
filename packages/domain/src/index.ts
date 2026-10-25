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

export interface TaskDependencyNode {
  readonly id: string;
  readonly projectId: string;
  readonly status: TaskStatus;
  readonly dependsOn: readonly string[];
}

export class TaskDependencyRuleError extends Error {
  constructor(
    readonly code:
      | "task_dependency_self"
      | "task_dependency_scope"
      | "task_dependency_cycle",
    message: string,
    readonly path: readonly string[] = [],
  ) {
    super(message);
    this.name = "TaskDependencyRuleError";
  }
}

export function assertValidTaskDependencies(input: {
  readonly taskId: string;
  readonly projectId: string;
  readonly dependsOn: readonly string[];
  readonly tasks: readonly TaskDependencyNode[];
}): void {
  const byId = new Map(input.tasks.map((task) => [task.id, task]));
  for (const dependencyId of input.dependsOn) {
    if (dependencyId === input.taskId) {
      throw new TaskDependencyRuleError(
        "task_dependency_self",
        "A task cannot depend on itself",
        [input.taskId, input.taskId],
      );
    }
    const dependency = byId.get(dependencyId);
    if (dependency === undefined) {
      throw new TaskDependencyRuleError(
        "task_dependency_scope",
        "Every prerequisite must exist in the same project",
        [input.taskId, dependencyId],
      );
    }
    if (dependency.projectId !== input.projectId) {
      throw new TaskDependencyRuleError(
        "task_dependency_scope",
        "Every prerequisite must exist in the same project",
        [input.taskId, dependencyId],
      );
    }
  }

  const visited = new Set<string>();
  const visit = (taskId: string, path: readonly string[]): void => {
    if (taskId === input.taskId) {
      throw new TaskDependencyRuleError(
        "task_dependency_cycle",
        "Task dependencies cannot contain a cycle",
        [...path, input.taskId],
      );
    }
    if (visited.has(taskId)) return;
    visited.add(taskId);
    for (const next of byId.get(taskId)?.dependsOn ?? []) {
      visit(next, [...path, taskId]);
    }
  };
  for (const dependencyId of input.dependsOn) {
    visit(dependencyId, [input.taskId]);
  }
}

export function unresolvedTaskDependencies(
  task: Pick<TaskDependencyNode, "dependsOn">,
  tasks: readonly TaskDependencyNode[],
): string[] {
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  return task.dependsOn.filter(
    (dependencyId) => byId.get(dependencyId)?.status !== "done",
  );
}

export * from "./workflow-markdown.js";
