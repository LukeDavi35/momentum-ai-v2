// Runs the WHOLE loop end to end in DRY_RUN mode and prints three generated pieces.
// Forced settings come first: nothing here can reach a real publishing API.
process.env.DRY_RUN = "true";
process.env.DRY_RUN_FAST = "true";
process.env.DRY_RUN_FAST_STEP_S ??= "2";
process.env.RUN_ON_BOOT = "false";
process.env.LOG_LEVEL ??= "warn"; // keep the printed pieces readable; set LOG_LEVEL=info to see every job

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrap } from "../src/bootstrap.js";
import { getContent, listEvents, countByStatus } from "../src/db/content.js";
import { getItemsByIds } from "../src/ingest/store.js";
import { runWeeklyLearning } from "../src/learning/agent.js";
import { probe } from "../src/media/exec.js";
import { HANDLERS } from "../src/queue/handlers.js";
import { makeMaintenanceHandler } from "../src/queue/maintenance.js";
import { startWorkers } from "../src/queue/worker.js";
import { newCorrelationId } from "../src/logger.js";

const WANT = Number(process.env.DRYRUN_PIECES ?? 3);
const TIMEOUT_MS = Number(process.env.DRYRUN_TIMEOUT_MS ?? 12 * 60_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const line = (c = "─") => c.repeat(78);

async function main(): Promise<void> {
  const app = await bootstrap();
  const { cfg, db, qs, deps, log } = app;
  if (!cfg.env.DRY_RUN) throw new Error("refusing to run: DRY_RUN is not true");
  cfg.schedule.ideate.keepTopN = WANT;
  cfg.schedule.plan.inventoryTargetPieces = Math.max(cfg.schedule.plan.inventoryTargetPieces, WANT + 1);

  await qs.dlq.drain().catch(() => undefined);
  const handle = startWorkers(deps, qs, app.redis, HANDLERS, makeMaintenanceHandler(qs, app.tokens));
  const stamp = Date.now();
  console.log(`\n${line("═")}\nMOMENTUM v2 — DRY RUN (no platform is contacted)\n${line("═")}`);
  console.log(`LLM: ${deps.llm.isStub ? "STUB (no ANTHROPIC_API_KEY: extractive, deterministic, NOT a language model)" : "live Anthropic"}   renderer: ${cfg.env.RENDERER}   db: ${db.kind}`);
  console.log("1/5 ingesting real RSS feeds + Google Trends …");
  for (const kind of ["rss", "trends", "reddit"]) await qs.queues.ingest.add("ingest", { kind, correlationId: newCorrelationId() }, { jobId: `dry__ingest__${kind}__${stamp}` });

  const start = Date.now();
  for (;;) {
    const items = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM source_items`);
    if (Number(items.rows[0]!.n) >= 20 || Date.now() - start > 120_000) {
      console.log(`    ${items.rows[0]!.n} source items ingested`);
      break;
    }
    await sleep(1000);
  }
  console.log(`2/5 ideation → script → voice → render → QA → publish (dry) → analytics …  (target: ${WANT} pieces)`);
  await qs.queues.ideate.add("ideate", { kind: "cycle", correlationId: newCorrelationId() }, { jobId: `dry__ideate__${stamp}` });

  let last = "";
  for (;;) {
    const c = await countByStatus(db);
    const snap = Object.entries(c).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(" ");
    if (snap !== last) {
      console.log(`    [${Math.round((Date.now() - start) / 1000)}s] ${snap}`);
      last = snap;
    }
    const inFlight = c.idea + c.scripted + c.voiced + c.rendered + c.qa_passed + c.qa_failed + c.scheduled + c.published;
    if (inFlight === 0 && c.measured + c.held + c.failed >= 1 && (c.measured >= WANT || Date.now() - start > 30_000 + 60_000 * (c.measured + c.held + c.failed))) break;
    if (Date.now() - start > TIMEOUT_MS) {
      console.log("    timed out waiting; reporting what exists");
      break;
    }
    await sleep(1500);
  }

  console.log("3/5 weekly learning pass (dry-run: computed and reported, never saved) …");
  const learn = await runWeeklyLearning(deps);
  console.log(`    ${learn.rows} measured posts, ${learn.changes} proposed weight changes, persisted=${learn.persisted}; report: ${learn.reportPath}`);

  console.log("4/5 collecting output …\n");
  const pieces = (await db.query<{ id: string }>(`SELECT id FROM content WHERE status = 'measured' ORDER BY created_at LIMIT $1`, [WANT])).rows;
  const md: string[] = [`# Dry-run output (${new Date().toISOString()})\n`, `LLM: ${deps.llm.isStub ? "stub (deterministic, extractive)" : "live"} · renderer: ${cfg.env.RENDERER} · DRY_RUN=true\n`];
  const outDir = join(cfg.env.MEDIA_DIR, "..", "dryrun-pieces");
  mkdirSync(outDir, { recursive: true });

  let n = 0;
  for (const { id } of pieces) {
    n++;
    const c = (await getContent(db, id))!;
    const script = c.script as any;
    const voice = c.voice as any;
    const render = c.render as any;
    const qa = c.qa as any;
    const sources = await getItemsByIds(db, c.sourceItemIds);
    const events = await listEvents(db, id);
    const info = await probe(cfg, render.videoPath).catch(() => null);
    const pubs = (await db.query(`SELECT platform, status, url, external_id, metadata FROM publications WHERE content_id = $1 ORDER BY platform`, [id])).rows;
    const snaps = (await db.query(`SELECT p.platform, s.checkpoint, s.views, s.likes, s.shares, s.retention_pct FROM analytics_snapshots s JOIN publications p ON p.id = s.publication_id WHERE p.content_id = $1 ORDER BY p.platform, s.checkpoint`, [id])).rows;

    const pdir = join(outDir, `piece-${n}`);
    mkdirSync(pdir, { recursive: true });
    for (const [src, name] of [[render.videoPath, "video.mp4"], [render.coverPath, "cover.jpg"], [render.captionsPath, "captions.ass"]] as const) if (existsSync(src)) copyFileSync(src, join(pdir, name));
    writeFileSync(join(pdir, "script.json"), JSON.stringify(script, null, 2));

    const out: string[] = [];
    out.push(`${line("═")}\nPIECE ${n}/${pieces.length} — ${c.topic}\n${line("═")}`);
    out.push(`template=${c.template}  pillar=${c.pillar}  hook=${c.hookStyle}  regenerations=${c.regenCount}`);
    out.push(`correlation id: ${c.correlationId}`);
    out.push(`generator: ${script.generator}  ·  voice: ${voice.provider}${voice.devVoice ? " (DEV robotic voice — dry-run only)" : ""}  ·  caption timing: ${voice.timingSource}`);
    out.push(`\nSOURCES (facts may only come from these):`);
    for (const s of sources.filter((x) => ["news", "results"].includes(x.kind))) out.push(`  • [${s.source}] ${s.title}`);
    out.push(`\nSTATE TRANSITIONS:`);
    out.push("  " + events.filter((e) => e.to_status).map((e) => `${e.to_status}`).join(" → "));
    out.push(`\nSCRIPT  (≈${script.estimatedDurationS}s spoken, ${script.beats.length} beats):`);
    for (const b of script.beats) out.push(`  ${b.id}. "${b.text}"${b.claimIds.length ? `   [claims: ${b.claimIds.join(",")}]` : ""}`);
    out.push(`\nCLAIMS — verified against sources by the QA gate:`);
    const verdicts = new Map<string, any>((qa?.checks?.verdicts ?? []).map((v: any) => [v.id, v]));
    for (const cl of script.claims) {
      const v = verdicts.get(cl.id);
      const src = sources.find((s) => s.id === cl.sourceItemId);
      out.push(`  ${v?.verified ? "✔" : "✘"} ${cl.id} (${cl.kind}) ${cl.text}${src ? `\n       ↳ ${src.source}: "${src.title}"` : "\n       ↳ general-interest statement (no figures or names)"}  — ${v?.method}: ${v?.reason}`);
    }
    if (script.removed?.length) out.push(`  removed before voicing: ${script.removed.map((r: any) => `${r.beatId} (${r.reason})`).join("; ")}`);
    out.push(`\nQA GATE: ${qa.passed ? "PASSED" : "FAILED"}  (threshold ≥ ${qa.minScore} on every dimension)`);
    out.push(`  reviewer scores: ${qa.scores ? Object.entries(qa.scores).map(([k, v]) => `${k}=${v}`).join("  ") : "n/a"}`);
    const tech = qa.checks.technical as any[];
    out.push(`  technical: ${tech.filter((t) => t.ok).length}/${tech.length} checks ok → ${tech.map((t) => `${t.name}:${t.value ?? (t.ok ? "ok" : "FAIL")}`).join("  ")}`);
    out.push(`  policy violations: ${qa.checks.policy.length}   unsourced-narration flags: ${qa.checks.flagged.length}`);
    out.push(`\nRENDER:`);
    out.push(`  ${render.videoPath}`);
    out.push(`  ${info ? `${info.width}x${info.height} @${info.fps}fps  ${info.durationS.toFixed(1)}s  ${info.videoCodec}/${info.audioCodec}  ${(info.sizeBytes / 1e6).toFixed(2)} MB` : "(could not probe)"}   captions: ${render.cues.length} cues burned in   cover: ${render.coverPath}`);
    out.push(`  copies: ${pdir}`);
    out.push(`\nWOULD HAVE POSTED (nothing was sent):`);
    for (const p of pubs) {
      const m = p.metadata.meta;
      out.push(`  ── ${p.platform}  [${p.status}]  ${p.url}`);
      out.push(`     title: ${m.title}`);
      out.push(`     ${String(m.caption).split("\n").join("\n     ")}`);
      out.push(`     AI disclosure: native flag = ${m.aiDisclosure.nativeFlag}, caption line included`);
    }
    out.push(`\nANALYTICS (SYNTHETIC — dry-run publisher fakes, to exercise the learning loop):`);
    for (const s of snaps) out.push(`  ${s.platform} @${s.checkpoint}: views=${s.views} likes=${s.likes} shares=${s.shares} retention=${s.retention_pct}%`);
    console.log(out.join("\n") + "\n");
    md.push("```", ...out, "```\n");
  }

  const heldRows = (await db.query(`SELECT topic, error, qa FROM content WHERE status = 'held'`)).rows;
  for (const h of heldRows) console.log(`HELD (not published): "${h.topic}" — ${h.error}\n  ${(h.qa?.failures ?? []).map((f: any) => `[${f.kind}] ${f.reason}`).join("\n  ")}`);
  const dlq = (await db.query(`SELECT queue, error FROM dead_letters`)).rows;
  const held = (await countByStatus(db)).held;
  console.log(`${line("═")}\nSUMMARY: ${pieces.length}/${WANT} pieces reached "measured" · dead-lettered jobs: ${dlq.length} · held: ${held}`);
  if (dlq.length) for (const d of dlq) console.log(`  DLQ: ${d.queue}: ${d.error.slice(0, 200)}`);
  const dryFiles = (await db.query(`SELECT COUNT(*)::int AS n FROM publications WHERE dry_run = true AND status = 'published'`)).rows[0]!.n;
  console.log(`dry-run publications: ${dryFiles} (every one used the DryRunPublisher; payloads in ${join(cfg.env.MEDIA_DIR, "..", "dryrun")})`);
  writeFileSync(join(outDir, "dryrun-report.md"), md.join("\n"));
  console.log(`full report: ${join(outDir, "dryrun-report.md")}\n${line("═")}`);
  if (existsSync(learn.reportPath)) console.log("\nWEEKLY_REPORT.md (dry-run preview):\n" + readFileSync(learn.reportPath, "utf8").split("\n").slice(0, 30).join("\n"));

  log.info("dry run finished; shutting down");
  await handle.close(20_000);
  await app.close();
  process.exit(pieces.length >= WANT && dlq.length === 0 ? 0 : 2);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
