import type { SpendSummaryRow } from "../safety/spend.js";
import { groupMean, type PerfRow } from "./performance.js";
import type { WeightChange } from "./update.js";

export interface ReportInput {
  periodStart: Date;
  periodEnd: Date;
  rows: PerfRow[];
  changes: WeightChange[];
  skipped?: string;
  persisted: boolean;
  weightVersion?: number;
  dryRun: boolean;
  syntheticData: boolean;
  counts: { created: number; published: number; held: number; failed: number; qaPassRate: number | null };
  spend: SpendSummaryRow[];
  topN?: number;
}

const f = (n: number, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : "–");
const day = (d: Date) => d.toISOString().slice(0, 10);

function table(headers: string[], rows: Array<Array<string | number>>): string {
  if (rows.length === 0) return "_no data_\n";
  return `| ${headers.join(" | ")} |\n|${headers.map(() => "---").join("|")}|\n${rows.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n`;
}

/** Deterministic markdown. No LLM: a report that can hallucinate numbers defeats its purpose. */
export function renderWeeklyReport(i: ReportInput): string {
  const topN = i.topN ?? 3;
  const out: string[] = [];
  out.push(`# Weekly report — ${day(i.periodStart)} to ${day(i.periodEnd)}\n`);
  if (i.syntheticData) {
    out.push(`> ⚠️ **DRY RUN / SYNTHETIC DATA.** The analytics below come from the dry-run publisher's deterministic fake metrics. They exist to exercise the pipeline; no weights were saved from them.\n`);
  }
  out.push(`## Pipeline\n`);
  out.push(table(["Created", "Published", "Held (needs a look)", "Failed", "QA pass rate"], [[i.counts.created, i.counts.published, i.counts.held, i.counts.failed, i.counts.qaPassRate === null ? "–" : `${Math.round(i.counts.qaPassRate * 100)}%`]]));

  out.push(`## Performance (${i.rows.length} measured posts)\n`);
  if (i.rows.length === 0) out.push("_No measured posts this period._\n");
  else {
    for (const [title, fn] of [
      ["By template", (r: PerfRow) => r.template],
      ["By pillar", (r: PerfRow) => r.pillar],
      ["By hook style", (r: PerfRow) => r.hookStyle],
      ["By posting hour (local)", (r: PerfRow) => r.hour],
      ["By length", (r: PerfRow) => r.lengthBucket],
    ] as Array<[string, (r: PerfRow) => string | null]>) {
      out.push(`### ${title}\n`);
      out.push(table(["Group", "Posts", "Avg score"], groupMean(i.rows, fn).map((g) => [g.key, g.n, f(g.mean)])));
    }
    const sorted = [...i.rows].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const row = (r: PerfRow) => [r.topic.slice(0, 60), r.platform, r.template, r.views, f(r.score ?? 0)];
    out.push(`### Best ${topN}\n`);
    out.push(table(["Topic", "Platform", "Template", "Views", "Score"], sorted.slice(0, topN).map(row)));
    out.push(`### Weakest ${topN}\n`);
    out.push(table(["Topic", "Platform", "Template", "Views", "Score"], sorted.slice(-topN).reverse().map(row)));
    out.push(`_Score is 0 for "average on its platform"; see \`src/learning/performance.ts\` for the formula._\n`);
  }

  out.push(`## Weight changes\n`);
  if (i.skipped) out.push(`**No changes:** ${i.skipped}\n`);
  else if (i.changes.length === 0) out.push("No multiplier moved by more than 0.005.\n");
  else {
    out.push(table(["Dimension", "Key", "From", "To", "Posts", "Avg score"], i.changes.map((c) => [c.dimension, c.key, f(c.from, 3), f(c.to, 3), c.n, f(c.meanScore)])));
  }
  out.push(
    i.persisted
      ? `Saved as weight version **v${i.weightVersion}**. Roll back with \`npm run rollback -- <version>\` (history is append-only; nothing is deleted).\n`
      : `_Not saved${i.dryRun ? " (dry run)" : ""}._\n`,
  );

  out.push(`## Spend\n`);
  out.push(table(["Provider", "Today", "Daily cap", "Month", "Monthly cap"], i.spend.map((s) => [s.provider, `$${f(s.dailySpent)}`, `$${f(s.dailyCap)}`, `$${f(s.monthlySpent)}`, `$${f(s.monthlyCap)}`])));
  return out.join("\n");
}

/** The phone-sized version of the weekly report: what happened, what (if anything) needs the owner. */
export function renderDigest(i: ReportInput): string {
  const best = [...i.rows].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
  const lines = [
    `${i.counts.created} created · ${i.counts.published} published · ${i.counts.held} held · ${i.counts.failed} failed` + (i.counts.qaPassRate === null ? "" : ` · QA pass rate ${Math.round(i.counts.qaPassRate * 100)}%`),
    best ? `Best post: "${best.topic.slice(0, 70)}" on ${best.platform} (${best.views.toLocaleString()} views)` : "No measured posts yet.",
    i.skipped ? `Learning: no change (${i.skipped})` : i.persisted ? `Learning: ${i.changes.length} weight changes saved as v${i.weightVersion}` : `Learning: ${i.changes.length} changes proposed, not saved${i.dryRun ? " (dry run)" : ""}`,
    i.counts.held > 0 ? `⚠ ${i.counts.held} item(s) held for review — see the dashboard's Held tab.` : "Nothing needs you.",
  ];
  if (i.syntheticData) lines.unshift("(DRY RUN — synthetic analytics)");
  return lines.join("\n");
}
