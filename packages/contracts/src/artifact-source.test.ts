import { describe, expect, it } from "vitest";
import { artifactSchema } from "./index.js";

const artifact = {
  id: "00000000-0000-4000-8000-000000000001",
  runId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
  name: "result.md",
  mimeType: "text/markdown",
  size: 10,
  sha256: "a".repeat(64),
  storageKey: "projects/result.md",
  createdAt: "2026-11-21T00:00:00.000Z",
} as const;

describe("M13e artifact source association", () => {
  it("keeps old artifacts compatible with an empty source list", () => {
    expect(artifactSchema.parse(artifact).sourceRefs).toEqual([]);
  });

  it("carries immutable project source references", () => {
    expect(
      artifactSchema.parse({
        ...artifact,
        sourceRefs: [
          {
            kind: "project-source",
            id: "erp:order:42",
            projectId: artifact.projectId,
            label: "ERP · order",
            route: "project",
            targetId: artifact.projectId,
            available: true,
            cutoffAt: "2026-11-21T00:00:00.000Z",
          },
        ],
      }).sourceRefs,
    ).toHaveLength(1);
  });
});
