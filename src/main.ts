import { createApp } from "./api/server.js";
import { bootstrap } from "./bootstrap.js";

/** API + dashboard process. Stateless: scale or restart freely. */
async function main(): Promise<void> {
  const app = await bootstrap();
  const { cfg, log } = app;
  const server = createApp({ deps: app.deps, qs: app.qs, tokens: app.tokens, pingRedis: async () => (await app.redis.ping()) === "PONG" }).listen(cfg.env.API_PORT, () =>
    log.info({ port: cfg.env.API_PORT, dryRun: cfg.env.DRY_RUN }, "api listening"),
  );
  const shutdown = async (signal: string) => {
    log.info({ signal }, "api shutting down");
    server.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
