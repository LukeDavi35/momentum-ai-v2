import { getContent, transition } from "../db/content.js";
import { SpendCapExceeded } from "../safety/spend.js";
import { probe, run, workDir } from "../media/exec.js";
import type { Deps, JobData } from "../queue/types.js";
import { narrationOf, type ScriptDoc } from "../script/types.js";
import { beatTimings, estimateWordTimings } from "./align.js";
import { buildTtsChain } from "./providers.js";
import type { WordTiming } from "./types.js";

export interface VoiceDoc {
  provider: string;
  fallbackUsed: boolean;
  attempts: Array<{ provider: string; error: string }>;
  audioPath: string;
  durationS: number;
  words: WordTiming[];
  timingSource: "provider" | "estimated";
  beats: ReturnType<typeof beatTimings>;
  chars: number;
  devVoice: boolean;
}

export type VoiceOutcome = "voiced" | "skipped";

export async function runVoice(deps: Deps, data: JobData): Promise<VoiceOutcome> {
  const { db, cfg, log, spend } = deps;
  if (!data.contentId) throw new Error("voice job needs contentId");
  const content = await getContent(db, data.contentId);
  if (!content) throw new Error(`content ${data.contentId} not found`);
  if (content.status !== "scripted") {
    log.info({ contentId: content.id, status: content.status }, "voice: not in scripted, skipping (idempotent)");
    return "skipped";
  }
  const script = content.script as unknown as ScriptDoc;
  const text = narrationOf(script);
  const chain = deps.tts ?? buildTtsChain(cfg, deps.fetchImpl);
  if (chain.length === 0) throw new Error("No TTS provider configured (set ELEVENLABS_API_KEY+ELEVENLABS_VOICE_ID or OPENAI_API_KEY)");

  const dir = workDir(cfg, content.id, content.regenCount);
  const attempts: VoiceDoc["attempts"] = [];
  let used: { name: string; audioPath: string; words?: WordTiming[]; dev: boolean } | undefined;
  let capErr: SpendCapExceeded | undefined;

  for (const tts of chain) {
    try {
      if (tts.spendProvider) await spend.guard(tts.spendProvider, spend.ttsCost(tts.spendProvider, text.length));
      const out = await tts.synthesize(text, `${dir}/voice`);
      if (tts.spendProvider) {
        await spend.record({ provider: tts.spendProvider, category: "tts", usd: spend.ttsCost(tts.spendProvider, text.length), units: text.length, contentId: content.id, correlationId: content.correlationId });
      }
      used = { name: tts.name, audioPath: out.audioPath, words: out.words, dev: tts.spendProvider === null };
      break;
    } catch (e) {
      if (e instanceof SpendCapExceeded) capErr = e;
      attempts.push({ provider: tts.name, error: (e as Error).message.slice(0, 300) });
      log.warn({ contentId: content.id, correlationId: content.correlationId, provider: tts.name, err: (e as Error).message }, "TTS provider failed; trying next");
    }
  }
  if (!used) {
    // every provider failed: if the cause was spend caps the worker pauses the voice queue, otherwise BullMQ retries with backoff
    if (capErr && attempts.every((a) => /Spend cap exceeded/.test(a.error))) throw capErr;
    throw new Error(`All TTS providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join(" | ")}`);
  }

  const info = await probe(cfg, used.audioPath, deps.runner ?? run);
  if (!info.hasAudio || info.durationS < 3) throw new Error(`TTS audio looks wrong (duration ${info.durationS}s, audio=${info.hasAudio})`);
  const words = used.words && used.words.length > 0 ? used.words : estimateWordTimings(text, info.durationS);
  const doc: VoiceDoc = {
    provider: used.name,
    fallbackUsed: attempts.length > 0,
    attempts,
    audioPath: used.audioPath,
    durationS: info.durationS,
    words,
    timingSource: used.words && used.words.length > 0 ? "provider" : "estimated",
    beats: beatTimings(script.beats, words),
    chars: text.length,
    devVoice: used.dev,
  };
  const moved = await transition(db, content.id, "scripted", "voiced", { voice: doc }, { stage: "voice", detail: { provider: doc.provider, fallbackUsed: doc.fallbackUsed, durationS: doc.durationS, timingSource: doc.timingSource } });
  if (!moved) return "skipped";
  await deps.enqueue("render", { contentId: content.id, correlationId: content.correlationId, regen: content.regenCount });
  log.info({ contentId: content.id, correlationId: content.correlationId, provider: doc.provider, fallbackUsed: doc.fallbackUsed, durationS: doc.durationS }, "voiceover done");
  return "voiced";
}
