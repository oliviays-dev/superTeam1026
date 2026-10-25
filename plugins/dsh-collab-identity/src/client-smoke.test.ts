import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

function read(plugin: string): string {
  return readFileSync(
    resolve(root, "plugins", plugin, "client/index.js"),
    "utf8",
  );
}

describe("identity access settings composition", () => {
  it("registers one account access section without employee navigation", () => {
    const identity = read("dsh-collab-identity");
    const employee = read("dsh-collab-employee");
    const roles = read("dsh-collab-roles");

    expect(identity).toContain('id: "pluginmax-account-access"');
    expect(identity).toContain('label: () => "账号与权限"');
    expect(identity).toContain(
      '[ACCESS_TAB_SLOT]: { kind: "list", scope: "root" }',
    );
    expect(identity).toContain('id: "accounts"');
    expect(identity).toContain('label: () => "登录账号"');
    expect(identity).toContain('rows.filter((row) => row.id === "accounts")');
    expect(identity).toContain('result.user?.role === "admin"');

    expect(employee).not.toContain('id: "employee"');
    expect(employee).not.toContain('label: () => "企业员工"');
    expect(employee).not.toContain(
      'ctx.slots.inject("pluginmax.account-access.tab"',
    );
    expect(identity).toContain('id: "audit"');
    expect(identity).toContain('label: () => "审计"');
    expect(identity).toContain("/api/collab/team/audit?limit=200");
    expect(identity).not.toContain("真人员工");
    expect(identity).not.toContain("Employee ID");

    expect(roles).toContain('ctx.slots.inject("pluginmax.account-access.tab"');
    expect(roles).toContain('id: "roles"');
    expect(roles).toContain("order: 20");
  });

  it("opens the login tab from the account button without employee links", () => {
    const identity = read("dsh-collab-identity");
    const shell = read("dsh-collab-shell");

    expect(identity).not.toContain('request("/api/collab/employee")');
    expect(identity).not.toContain('"关联员工"');
    expect(identity).not.toContain('"查看员工"');
    expect(identity).not.toContain('"pluginmax:employee-focus"');
    expect(shell).toContain('openSettings("账号与权限", "accounts")');
    expect(shell).toContain('"pluginmax.accountAccess.activeTab"');
  });
});
