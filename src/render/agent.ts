import { getContent, transition } from "../db/content.js";
import { run, workDir } from "../media/exec.js";
import type { Deps, JobData } from "../queue/types.js";
import type { ScriptDoc } from "../script/types.js";
import type { VoiceDoc } from "../voice/agent.js";
import { renderWithFfmpeg, TAIL_S, type RenderResult } from "./ffmpegRenderer.js";

export type Renderer = (input: { deps: Deps; template: import("../config/index.js").Template; script: ScriptDoc; voice: VoiceDoc; dir: string; attempt?: number }) => Promise<RenderResult>;

const ffmpegRenderer: Renderer = ({ deps, template, script, voice, dir, attempt }) => renderWithFfmpeg({ cfg: deps.cfg, template, script, voice, dir, runner: deps.runner ?? run, attempt });

/** Chooses the configured renderer. Remotion is optional and loaded lazily so the worker doesn't need its (heavy) deps otherwise. */
export async function pickRenderer(deps: Deps): Promise<Renderer> {
  if (deps.cfg.env.RENDERER === "remotion") {
    const mod = await import("./remotionRenderer.js");
    return mod.remotionRenderer;
  }
  return ffmpegRenderer;
}

export type RenderOutcome = "rendered" | "skipped";

export async function runRender(deps: Deps, data: JobData): Promise<RenderOutcome> {
  const { db, cfg, log, spend } = deps;
  if (!data.contentId) throw new Error("render job needs contentId");
  const content = await getContent(db, data.contentId);
  if (!content) throw new Error(`content ${data.contentId} not found`);
  if (content.status !== "voiced") {
    log.info({ contentId: content.id, status: content.status }, "render: not in voiced, skipping (idempotent)");
    return "skipped";
  }
  const script = content.script as unknown as ScriptDoc;
  const voice = content.voice as unknown as VoiceDoc;

  const projected = spend.renderCost(voice.durationS + TAIL_S);
  await spend.guard("render", projected);

  const dir = workDir(cfg, content.id, content.regenCount);
  const started = Date.now();
  const render = await (await pickRenderer(deps))({ deps, template: content.template, script, voice, dir, attempt: content.regenCount });
  const elapsedS = (Date.now() - started) / 1000;

  await spend.record({ provider: "render", category: render.renderer, usd: projected, units: render.durationS, contentId: content.id, correlationId: content.correlationId });
  const moved = await transition(db, content.id, "voiced", "rendered", { render: { ...render, renderSeconds: Math.round(elapsedS * 10) / 10 } }, { stage: "render", detail: { renderer: render.renderer, durationS: render.durationS, sizeBytes: render.sizeBytes, renderSeconds: elapsedS } });
  if (!moved) return "skipped";
  await deps.enqueue("qa", { contentId: content.id, correlationId: content.correlationId, regen: content.regenCount });
  log.info({ contentId: content.id, correlationId: content.correlationId, renderer: render.renderer, durationS: render.durationS, sizeMB: Math.round(render.sizeBytes / 1e5) / 10, renderSeconds: elapsedS }, "render done");
  return "rendered";
}
