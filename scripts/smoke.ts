import { bootstrap } from "../src/bootstrap.js";
import { runSmoke, smokeFailed } from "../src/ops/smoke.js";

/** npm run smoke  — read-only live check of every integration. Posts nothing. Add --alert to also send a test alert. */
async function main(): Promise<void> {
  const app = await bootstrap();
  try {
    const checks = await runSmoke({ cfg: app.cfg, db: app.db, alerter: app.deps.alerter, tokens: app.tokens, redisPing: async () => (await app.redis.ping()) === "PONG", sendTestAlert: process.argv.includes("--alert") });
    const icon = { ok: "✔", fail: "✘", skipped: "–" } as const;
    for (const c of checks) console.log(`${icon[c.status]} ${c.name.padEnd(14)} ${c.detail}`);
    console.log(smokeFailed(checks) ? "\nSome checks FAILED. Fix them before switching DRY_RUN off." : "\nNo failures. (Skipped items are optional or not configured.)");
    process.exitCode = smokeFailed(checks) ? 1 : 0;
  } finally {
    await app.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
