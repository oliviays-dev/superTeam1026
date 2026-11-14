import { describe, expect, it } from "vitest";
import {
  canonicalWorkbenchJson,
  marketAssetManifestSchema,
  trustedWorkbenchPanel,
  workbenchLayoutDocumentSchema,
} from "./workbench-market.js";

describe("Workbench V2 and Market contracts", () => {
  it("exports only trusted static panel metadata", () => {
    expect(trustedWorkbenchPanel("brief")).toMatchObject({
      title: "每日简报",
      requiresEntitlement: false,
    });
    expect(trustedWorkbenchPanel("market.sample")).toMatchObject({
      requiresEntitlement: true,
    });
    expect(trustedWorkbenchPanel("remote.script.panel")).toBeUndefined();
  });

  it("canonicalizes layout metadata independently of key order", () => {
    expect(
      canonicalWorkbenchJson({
        version: 1,
        panels: [{ width: 3, pluginId: "brief" }],
      }),
    ).toBe(
      canonicalWorkbenchJson({
        panels: [{ pluginId: "brief", width: 3 }],
        version: 1,
      }),
    );
  });

  it("rejects duplicate panel positions and invalid trusted heights", () => {
    const duplicate = workbenchLayoutDocumentSchema.safeParse({
      version: 1,
      panels: [
        {
          pluginId: "brief",
          position: 0,
          width: 6,
          height: null,
          config: {},
          enabled: true,
        },
        {
          pluginId: "todo",
          position: 0,
          width: 4,
          height: null,
          config: {},
          enabled: true,
        },
      ],
    });
    expect(duplicate.success).toBe(false);
    const invalidHeight = workbenchLayoutDocumentSchema.safeParse({
      version: 1,
      panels: [
        {
          pluginId: "brief",
          position: 0,
          width: 6,
          height: 120,
          config: {},
          enabled: true,
        },
      ],
    });
    expect(invalidHeight.success).toBe(false);
  });

  it("rejects remote code fields in Market manifests", () => {
    const dynamic = marketAssetManifestSchema.safeParse({
      summary: "Remote module",
      remoteScript: "https://example.test/panel.js",
    });
    expect(dynamic.success).toBe(false);
    const template = marketAssetManifestSchema.parse({
      summary: "Trusted layout",
      template: {
        version: 1,
        panels: [
          {
            pluginId: "brief",
            position: 0,
            width: 6,
            height: null,
            config: {},
            enabled: true,
          },
        ],
      },
    });
    expect(template.template?.panels[0]?.pluginId).toBe("brief");
    expect(template.dependencies).toEqual([]);
  });
});
