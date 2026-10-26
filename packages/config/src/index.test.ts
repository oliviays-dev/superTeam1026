import { describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

describe("platform authentication configuration", () => {
  it("fails closed to bearer auth outside tests", () => {
    expect(loadConfig({}).authMode).toBe("bearer");
    expect(loadConfig({ NODE_ENV: "production" }).authMode).toBe("bearer");
    expect(loadConfig({ NODE_ENV: "test" }).authMode).toBe("local-development");
    expect(
      loadConfig({
        NODE_ENV: "production",
        AUTH_MODE: "local-development",
      }).authMode,
    ).toBe("local-development");
  });

  it("requires bootstrap login and password together", () => {
    expect(() => loadConfig({ BOOTSTRAP_ADMIN_LOGIN_ID: "admin" })).toThrow(
      /configured together/,
    );
    expect(
      loadConfig({
        BOOTSTRAP_ADMIN_LOGIN_ID: "admin",
        BOOTSTRAP_ADMIN_PASSWORD: "long-enough-password",
      }).bootstrapAdmin,
    ).toMatchObject({
      principalId: "principal-human-admin",
      accountId: "account-admin",
      loginId: "admin",
    });
  });
});
