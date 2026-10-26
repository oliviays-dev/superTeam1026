import { loadConfig, loadLocalEnv } from "@pluginmax/config";
import { buildApi } from "./app.js";

loadLocalEnv();
const config = loadConfig();
const { app } = buildApi({
  databaseUrl: config.databaseUrl,
  fileStoreRoot: config.fileStoreRoot,
  localActorId: config.localActorId,
  workerHeartbeatStaleAfterSeconds: config.workerHeartbeatStaleAfterSeconds,
  logger: { level: config.logLevel },
});

const close = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGINT", () => void close("SIGINT"));
process.on("SIGTERM", () => void close("SIGTERM"));

await app.listen({ host: config.apiHost, port: config.apiPort });
