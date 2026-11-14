import { describe, expect, it } from "vitest";
import {
  canonicalSkillJson,
  skillVersionDigestPayload,
  type SkillVersionContentValue,
} from "./skill.js";

describe("Skill Contract", () => {
  const content: SkillVersionContentValue = {
    trustLevel: "official",
    instructions: "Summarize the project using verified source facts.",
    manifest: {
      output: { format: "markdown", sections: ["summary", "risks"] },
      capability: "project-reporting",
    },
    permissions: ["project.read"],
    triggers: ["project.daily-report"],
    status: "published",
    protected: true,
  };

  it("canonicalizes object key order for stable digests", () => {
    expect(canonicalSkillJson({ b: 2, a: { d: 4, c: 3 } })).toBe(
      '{"a":{"c":3,"d":4},"b":2}',
    );
    expect(
      canonicalSkillJson({
        manifest: {
          capability: "project-reporting",
          output: { sections: ["summary", "risks"], format: "markdown" },
        },
      }),
    ).toBe(
      '{"manifest":{"capability":"project-reporting","output":{"format":"markdown","sections":["summary","risks"]}}}',
    );
  });

  it("builds one digest payload regardless of manifest insertion order", () => {
    const ordered = skillVersionDigestPayload({
      skillId: "00000000-0000-4000-8000-000000004001",
      version: 1,
      publisherPrincipalId: "local-admin",
      trustLevel: content.trustLevel,
      instructions: content.instructions,
      manifest: content.manifest,
      permissions: content.permissions,
      triggers: content.triggers,
      status: content.status,
      protected: content.protected,
    });
    const reordered = skillVersionDigestPayload({
      skillId: "00000000-0000-4000-8000-000000004001",
      version: 1,
      publisherPrincipalId: "local-admin",
      trustLevel: "official",
      instructions: content.instructions,
      manifest: {
        capability: "project-reporting",
        output: { sections: ["summary", "risks"], format: "markdown" },
      },
      permissions: ["project.read"],
      triggers: ["project.daily-report"],
      status: "published",
      protected: true,
    });
    expect(reordered).toBe(ordered);
  });
});
