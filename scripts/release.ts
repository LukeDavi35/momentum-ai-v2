import { getContent, transition } from "../src/db/content.js";
import { bootstrap } from "../src/bootstrap.js";

/**
 * npm run release -- <contentId>
 * Manually sends a HELD item back for another full attempt (fresh regeneration budget). This is the only way out of
 * `held`; nothing in the automated pipeline can move a held item toward publishing.
 */
async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) throw new Error("usage: npm run release -- <contentId>");
  const app = await bootstrap();
  try {
    const c = await getContent(app.db, id);
    if (!c) throw new Error(`no content ${id}`);
    if (c.status !== "held") throw new Error(`content is "${c.status}", not "held"`);
    await transition(app.db, id, "held", "idea", { regen_count: 0, error: null, failed_stage: null }, { stage: "manual-release", detail: { by: "operator" } });
    await app.deps.enqueue("script", { contentId: id, correlationId: c.correlationId, regen: 0 }, { jobId: `script__${id}__manual__${Date.now()}` });
    console.log(`released ${id} ("${c.topic}") — it will be rewritten and go through QA again`);
  } finally {
    await app.close();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
