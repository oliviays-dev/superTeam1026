import { describe, expect, it } from "vitest";
import {
  ProjectMembershipRuleError,
  assertProjectMemberCanBeRemoved,
  assertValidTaskDependencies,
  canTransitionTask,
  isTerminalRunStatus,
  normalizeProjectRoleIds,
  projectCode,
  TaskDependencyRuleError,
  unresolvedTaskDependencies,
} from "./index.js";
import type { ProjectMember, ProjectRole } from "@pluginmax/contracts";

describe("task transitions", () => {
  it("allows the task execution path", () => {
    expect(canTransitionTask("queued", "in_progress")).toBe(true);
    expect(canTransitionTask("in_progress", "review")).toBe(true);
    expect(canTransitionTask("review", "done")).toBe(true);
  });

  it("rejects terminal task changes", () => {
    expect(canTransitionTask("done", "in_progress")).toBe(false);
    expect(canTransitionTask("cancelled", "queued")).toBe(false);
  });
});

describe("run status", () => {
  it("recognizes terminal states", () => {
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("running")).toBe(false);
  });
});

describe("project code", () => {
  it("creates a stable visible code", () => {
    expect(projectCode("Supply Chain", 7)).toBe("SUPPLY-CHAIN-0007");
  });
});

const projectRole: ProjectRole = {
  id: "00000000-0000-4000-8000-000000000101",
  projectId: "00000000-0000-4000-8000-000000000001",
  code: "DEVELOPER",
  name: "Developer",
  category: "execution",
  description: "",
  permissions: ["read"],
  libraryRoleId: null,
  createdAt: "2026-10-25T08:00:00.000Z",
  updatedAt: "2026-10-25T08:00:00.000Z",
};

const ownerMember: ProjectMember = {
  id: "00000000-0000-4000-8000-000000000201",
  projectId: projectRole.projectId,
  kind: "human",
  actorId: "local-admin",
  name: "Local Admin",
  responsibility: "Project owner",
  status: "active",
  owner: true,
  roles: [projectRole],
  createdAt: "2026-10-25T08:00:00.000Z",
  updatedAt: "2026-10-25T08:00:00.000Z",
};

describe("project membership rules", () => {
  it("deduplicates role assignments while preserving their order", () => {
    expect(
      normalizeProjectRoleIds(
        projectRole.projectId,
        [projectRole.id, projectRole.id],
        [projectRole],
      ),
    ).toEqual([projectRole.id]);
  });

  it("rejects roles owned by another project", () => {
    expect(() =>
      normalizeProjectRoleIds(
        "00000000-0000-4000-8000-000000000002",
        [projectRole.id],
        [projectRole],
      ),
    ).toThrow(ProjectMembershipRuleError);
  });

  it("protects the project owner", () => {
    expect(() => assertProjectMemberCanBeRemoved(ownerMember)).toThrow(
      "project owner cannot be removed",
    );
  });
});

describe("task dependency rules", () => {
  const task = (
    id: string,
    dependsOn: string[] = [],
    status: "queued" | "done" = "queued",
  ) => ({
    id,
    projectId: "00000000-0000-4000-8000-000000000001",
    status,
    dependsOn,
  });

  it("accepts an acyclic dependency graph in one project", () => {
    const tasks = [task("A"), task("B", ["A"]), task("C", ["B"])];
    expect(() =>
      assertValidTaskDependencies({
        taskId: "C",
        projectId: tasks[0]!.projectId,
        dependsOn: ["B"],
        tasks,
      }),
    ).not.toThrow();
  });

  it("rejects self, missing and cyclic dependencies", () => {
    const tasks = [task("A"), task("B", ["A"]), task("C", ["B"])];
    expect(() =>
      assertValidTaskDependencies({
        taskId: "A",
        projectId: tasks[0]!.projectId,
        dependsOn: ["A"],
        tasks,
      }),
    ).toThrow(TaskDependencyRuleError);
    expect(() =>
      assertValidTaskDependencies({
        taskId: "A",
        projectId: tasks[0]!.projectId,
        dependsOn: ["missing"],
        tasks,
      }),
    ).toThrow(TaskDependencyRuleError);
    expect(() =>
      assertValidTaskDependencies({
        taskId: "A",
        projectId: tasks[0]!.projectId,
        dependsOn: ["C"],
        tasks,
      }),
    ).toThrow(TaskDependencyRuleError);
  });

  it("reports unresolved prerequisites until all are done", () => {
    const current = task("C", ["A", "B"]);
    expect(
      unresolvedTaskDependencies(current, [
        task("A", [], "done"),
        task("B"),
        current,
      ]),
    ).toEqual(["B"]);
    expect(
      unresolvedTaskDependencies(current, [
        task("A", [], "done"),
        task("B", [], "done"),
        current,
      ]),
    ).toEqual([]);
  });
});
