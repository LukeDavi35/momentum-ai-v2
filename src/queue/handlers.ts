import { runAnalytics } from "../analytics/agent.js";
import { runIdeation } from "../ideate/agent.js";
import { runIngest, type IngestSource } from "../ingest/index.js";
import { topPerformingItems } from "../learning/performance.js";
import { runPublish } from "../publish/agent.js";
import { runQa } from "../qa/gate.js";
import { runRender } from "../render/agent.js";
import { runScript } from "../script/agent.js";
import { runVoice } from "../voice/agent.js";
import { housekeeping } from "./maintenance.js";
import type { QueueName } from "./names.js";
import type { Deps } from "./types.js";
import type { Handler } from "./worker.js";

/** One handler per pipeline queue. Each is a plain function of (Deps, JobData) — testable without Redis. */
export const HANDLERS: Record<QueueName, Handler> = {
  ingest: (deps, data) =>
    runIngest(
      {
        db: deps.db,
        cfg: deps.cfg,
        embedder: deps.embedder,
        log: deps.log,
        fetchImpl: deps.fetchImpl,
        internalItems: async () =>
          (await topPerformingItems(deps.db, deps.cfg.schedule.timezone, deps.cfg.env.DRY_RUN)).map((t) => ({
            source: "internal",
            kind: "internal" as const,
            pillar: t.pillar,
            title: t.topic,
            summary: `Our own post (${t.template}) that outperformed: score ${t.score}`,
            metrics: { perf: t.score },
          })),
      },
      (data.kind ?? "rss") as IngestSource,
    ),
  ideate: (deps, data) => (data.kind === "housekeeping" ? housekeeping(deps) : runIdeation(deps as Deps, data)),
  script: runScript,
  voice: runVoice,
  render: runRender,
  qa: runQa,
  publish: runPublish,
  analytics: runAnalytics,
};
