import { describe, expect, it } from "vitest";
import {
  SharedSpacePathError,
  normalizeSharedSpacePath,
  normalizeSharedSpacePathPattern,
  sharedSpacePolicyMatchesPath,
} from "./shared-space.js";

describe("Shared Space path contract", () => {
  it("normalizes safe relative paths", () => {
    expect(normalizeSharedSpacePath("research/drafts/report.md")).toBe(
      "research/drafts/report.md",
    );
    expect(normalizeSharedSpacePath("docs/report.md")).toBe("docs/report.md");
  });

  it.each([
    "/etc/passwd",
    "C:/secrets.txt",
    "..\\windows\\system32",
    "research/../secret.md",
    "research//report.md",
    "research/\u0000report.md",
    ".env",
    "credentials/api-key.txt",
    "CON",
    "folder/name.",
    "docs/café.md",
  ])("rejects unsafe or ambiguous path %s", (path) => {
    expect(() => normalizeSharedSpacePath(path)).toThrow(SharedSpacePathError);
  });

  it("accepts only full-segment wildcard policy patterns", () => {
    expect(normalizeSharedSpacePathPattern("research/**")).toBe("research/**");
    expect(normalizeSharedSpacePathPattern("docs/*")).toBe("docs/*");
    expect(() => normalizeSharedSpacePathPattern("docs/*.md")).toThrow(
      SharedSpacePathError,
    );
    expect(() => normalizeSharedSpacePathPattern("**/drafts")).toThrow(
      SharedSpacePathError,
    );
  });

  it("matches the directory itself and descendants for **", () => {
    expect(sharedSpacePolicyMatchesPath("research/**", "research")).toBe(true);
    expect(
      sharedSpacePolicyMatchesPath("research/**", "research/drafts/a.md"),
    ).toBe(true);
    expect(sharedSpacePolicyMatchesPath("research/**", "archive/a.md")).toBe(
      false,
    );
  });
});
