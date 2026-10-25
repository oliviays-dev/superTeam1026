import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const TASK_CLIENT_PATH = resolve(
  import.meta.dirname,
  "../../dsh-collab-task/client/index.js",
);
const WORKBENCH_CLIENT_PATH = resolve(
  import.meta.dirname,
  "../client/index.js",
);

const readClient = (path: string) => readFileSync(path, "utf8");

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function effectiveDeclarations(source: string, selectors: readonly string[]) {
  const result = new Map<string, string>();
  for (const selector of selectors) {
    const match = source.match(
      new RegExp(`${escapeRegExp(selector)}\\{([^}]*)\\}`),
    );
    const body = match?.[1];
    if (!body) throw new Error(`Missing CSS rule: ${selector}`);
    for (const entry of body.split(";").filter(Boolean)) {
      const separator = entry.indexOf(":");
      result.set(
        entry.slice(0, separator).trim(),
        entry.slice(separator + 1).trim(),
      );
    }
  }
  return Object.fromEntries(
    [...result].sort(([left], [right]) => left.localeCompare(right)),
  );
}

describe("workbench client styles", () => {
  it("keeps the project scope switch visually identical to task management", () => {
    const taskClient = readClient(TASK_CLIENT_PATH);
    const workbenchClient = readClient(WORKBENCH_CLIENT_PATH);

    expect(effectiveDeclarations(workbenchClient, [".pmwb-scope-seg"])).toEqual(
      effectiveDeclarations(taskClient, [".pmtask-scope-seg"]),
    );

    const taskButton = effectiveDeclarations(taskClient, [
      ".pmtask-token",
      ".pmtask-scope-seg .pmtask-token",
    ]);
    const workbenchButton = effectiveDeclarations(workbenchClient, [
      ".pmwb-scope-seg > button",
    ]);
    expect(workbenchButton).toEqual(taskButton);

    const taskHover = effectiveDeclarations(taskClient, [
      ".pmtask-token",
      ".pmtask-scope-seg .pmtask-token",
      ".pmtask-scope-seg .pmtask-token:not(.active):hover",
    ]);
    const workbenchHover = effectiveDeclarations(workbenchClient, [
      ".pmwb-scope-seg > button",
      ".pmwb-scope-seg > button:not(.active):hover",
    ]);
    expect(workbenchHover).toEqual(taskHover);

    const taskActive = effectiveDeclarations(taskClient, [
      ".pmtask-token",
      ".pmtask-scope-seg .pmtask-token",
      ".pmtask-token.active",
    ]);
    const workbenchActive = effectiveDeclarations(workbenchClient, [
      ".pmwb-scope-seg > button",
      ".pmwb-scope-seg > button.active",
    ]);
    expect(workbenchActive).toEqual(taskActive);
  });

  it("lays out meeting minutes below the status row across the full module width", () => {
    const workbenchClient = readClient(WORKBENCH_CLIENT_PATH);
    expect(workbenchClient).toContain(
      '.pmwb-item.meeting{grid-template-areas:"name actions" "meta time" "sub sub" "owner owner";}',
    );

    const statusIndex = workbenchClient.indexOf(
      'className: "pmwb-item-meta pmwb-meeting-status"',
    );
    const summaryIndex = workbenchClient.indexOf(
      "className: `pmwb-item-sub${item.summaryText",
      statusIndex,
    );
    expect(statusIndex).toBeGreaterThan(-1);
    expect(summaryIndex).toBeGreaterThan(statusIndex);
  });
});
