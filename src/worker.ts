import { bootstrap } from "./bootstrap.js";
import { HANDLERS } from "./queue/handlers.js";
import { makeMaintenanceHandler } from "./queue/maintenance.js";
import { bootKick, installSchedules } from "./queue/scheduler.js";
import { startWorkers } from "./queue/worker.js";

/** Worker process: installs the schedules, runs every queue's worker, and drains in-flight jobs on SIGTERM/SIGINT. */
async function main(): Promise<void> {
  const app = await bootstrap();
  const { log, cfg } = app;
  const installed = await installSchedules(app.qs, cfg);
  log.info({ schedules: installed }, "schedules installed");
  const handle = startWorkers(app.deps, app.qs, app.redis, HANDLERS, makeMaintenanceHandler(app.qs, app.tokens));
  if (process.env.RUN_ON_BOOT !== "false") await bootKick(app.qs);
  log.info({ queues: handle.workers.map((w) => w.name), dryRun: cfg.env.DRY_RUN }, "workers running");

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down: finishing in-flight jobs (no new jobs are taken)");
    await handle.close(Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 60_000));
    await app.close();
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
