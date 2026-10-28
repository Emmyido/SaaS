// Standalone marketplace sync worker, for deployments that run it outside the API process.
import { startOutboxLoop } from "./modules/marketplace/worker.js";

startOutboxLoop(3000);
console.log("GreenRev marketplace worker running");
setInterval(() => {}, 1 << 30);
