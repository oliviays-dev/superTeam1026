import { describe, expect, it } from "vitest";
import {
  canTransitionTask,
  isTerminalRunStatus,
  projectCode,
} from "./index.js";

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
