import { loadConfig } from "../src/config/index.js";
import { openDb } from "../src/db/db.js";
import { getCurrentWeights, listWeightVersions, rollbackWeights } from "../src/ideate/weights.js";

/** npm run rollback -- <version>   (no argument: list versions). History is append-only; rollback adds a new version. */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = await openDb({ databaseUrl: cfg.env.DATABASE_URL, dataDir: cfg.env.DATA_DIR });
  const arg = process.argv[2];
  if (!arg) {
    const current = await getCurrentWeights(db);
    console.log(`current: v${current.version} (${current.kind}) — ${current.reason}\n`);
    for (const v of await listWeightVersions(db, 30)) console.log(`v${String(v.version).padEnd(4)} ${v.createdAt.toISOString()}  ${v.kind.padEnd(8)} ${v.reason}`);
    console.log("\nroll back with: npm run rollback -- <version>");
  } else {
    const to = Number(arg);
    if (!Number.isInteger(to)) throw new Error(`"${arg}" is not a version number`);
    const created = await rollbackWeights(db, to);
    console.log(`restored the weights of v${to} as new version v${created}`);
  }
  await db.close();
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
