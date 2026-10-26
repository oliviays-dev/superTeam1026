import { loadConfig, loadLocalEnv } from "@pluginmax/config";
import { IdentityRepository } from "@pluginmax/database";
import { buildApi } from "./app.js";

loadLocalEnv();
const config = loadConfig();
const { app, database } = buildApi({
  databaseUrl: config.databaseUrl,
  fileStoreRoot: config.fileStoreRoot,
  localActorId: config.localActorId,
  authMode: config.authMode,
  authSessionTtlSeconds: config.authSessionTtlSeconds,
  workerHeartbeatStaleAfterSeconds: config.workerHeartbeatStaleAfterSeconds,
  logger: { level: config.logLevel },
});
if (config.bootstrapAdmin !== undefined) {
  await new IdentityRepository(database).bootstrapAdministrator(
    config.bootstrapAdmin,
  );
}

const close = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => void close("SIGINT"));
process.on("SIGTERM", () => void close("SIGTERM"));

await app.listen({ host: config.apiHost, port: config.apiPort });
