import { Database } from "./database.js";
import { migrate } from "./migrate.js";

try {
  process.loadEnvFile(".env");
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
