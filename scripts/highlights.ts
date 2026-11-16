import { bootstrap } from "../src/bootstrap.js";
import { newCorrelationId } from "../src/logger.js";

/**
 * npm run highlights [-- <profile>]
 * Queues one compilation profile now instead of waiting for its cron time in config/schedule.json -> compilations.
 * Defaults to the first configured profile ("daily" out of the box). A running worker picks the job up. There is one
 * run per profile per local day: if today's for that profile already exists (and didn't fail), the job logs that and
 * does nothing.
 */
async function main(): Promise<void> {
  const app = await bootstrap();
  try {
    const profiles = Object.keys(app.cfg.schedule.compilations);
    const profile = process.argv[2] ?? profiles[0];
    if (!profile) throw new Error("no compilation profiles are configured (config/schedule.json -> compilations)");
    if (!profiles.includes(profile)) throw new Error(`unknown profile "${profile}" - configured profiles: ${profiles.join(", ")}`);
    await app.deps.enqueue("ideate", { kind: "highlights", profile, correlationId: newCorrelationId() }, { jobId: `ideate__highlights__${profile}__manual__${Date.now()}` });
    console.log(`queued "${profile}": the worker will pick its top stories, look for licensed footage, and send the compilation through script -> voice -> render -> QA -> publish.`);
  } finally {
    await app.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
