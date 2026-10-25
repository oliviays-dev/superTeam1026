import { resolve } from "node:path";
import { Database } from "./database.js";
import { migrate } from "./migrate.js";

const root = resolve(process.env.PLUGINMAX_ROOT ?? process.env.INIT_CWD ?? ".");
try {
  process.loadEnvFile(resolve(root, ".env"));
} catch (error) {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== "ENOENT"
  ) {
    throw error;
  }
}

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://pluginmax:pluginmax@127.0.0.1:54329/pluginmax";
const database = new Database(databaseUrl);
const targetValue = process.env.MIGRATION_TARGET_VERSION;
const targetVersion =
  targetValue === undefined || targetValue === ""
    ? Number.POSITIVE_INFINITY
    : Number(targetValue);
if (
  targetValue !== undefined &&
  targetValue !== "" &&
  (!Number.isInteger(targetVersion) || targetVersion < 1)
) {
  throw new Error("MIGRATION_TARGET_VERSION must be an integer");
}

try {
  await migrate(database, targetVersion);
  process.stdout.write("database migrations applied\n");
} finally {
  await database.close();
}
