import { bootstrap } from "../src/bootstrap.js";
import { newCorrelationId } from "../src/logger.js";

/**
 * npm run highlights
 * Queues today's highlights compilation now instead of waiting for the daily time in config/schedule.json. A running
 * worker picks it up. There is one compilation per local day: if today's already exists (and didn't fail), the job
 * logs that and does nothing.
 */
async function main(): Promise<void> {
  const app = await bootstrap();
  try {
    await app.deps.enqueue("ideate", { kind: "highlights", correlationId: newCorrelationId() }, { jobId: `ideate__highlights__manual__${Date.now()}` });
    console.log("queued: the worker will pick today's top stories, look for licensed footage, and send the compilation through script -> voice -> render -> QA.");
  } finally {
    await app.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
