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

try {
  await migrate(database);
  process.stdout.write("database migrations applied\n");
} finally {
  await database.close();
}
