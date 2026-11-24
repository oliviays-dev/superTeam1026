import { randomUUID } from "node:crypto";
import { beforeAll } from "vitest";
import { Database } from "@pluginmax/database";

const baseDatabaseUrl = process.env.TEST_DATABASE_URL;

if (baseDatabaseUrl !== undefined) {
  const source = new URL(baseDatabaseUrl);
  const sourceDatabase = decodeURIComponent(source.pathname.slice(1));
  const isolatedDatabase = `pluginmax_test_${process.pid}_${randomUUID()
    .replaceAll("-", "")
    .slice(0, 8)}`;
  const isolatedUrl = new URL(baseDatabaseUrl);
  isolatedUrl.pathname = `/${isolatedDatabase}`;
  const adminUrl = new URL(baseDatabaseUrl);
  adminUrl.pathname = "/postgres";

  process.env.TEST_DATABASE_URL = isolatedUrl.toString();
  process.env.DATABASE_URL = isolatedUrl.toString();

  const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

  beforeAll(async () => {
    const admin = new Database(adminUrl.toString());
    try {
      await admin.query(
        `DROP DATABASE IF EXISTS ${identifier(isolatedDatabase)} WITH (FORCE)`,
      );
      await admin.query(
        `CREATE DATABASE ${identifier(isolatedDatabase)} TEMPLATE ${identifier(sourceDatabase)}`,
      );
    } finally {
      await admin.close();
    }
  });
}
