import { buildApp } from "./app.js";
import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { startOutboxLoop } from "./modules/marketplace/worker.js";

const app = await buildApp();
await migrate();
if (config.runWorkerInProcess) startOutboxLoop();
await app.listen({ port: config.port, host: "0.0.0.0" });
