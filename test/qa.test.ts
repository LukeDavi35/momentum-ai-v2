import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContent, getContent, transition } from "../src/db/content.js";
import { listRecentItems, storeItems } from "../src/ingest/store.js";
import type { RawItem } from "../src/ingest/types.js";
import { LlmClient } from "../src/llm/client.js";
import { StubProvider } from "../src/llm/stub.js";
import type { Runner } from "../src/media/exec.js";
import { buildPlatformMetadata } from "../src/publish/metadata.js";
import { runQa } from "../src/qa/gate.js";
import { checkPolicy, TEXT_RULES } from "../src/qa/policy.js";
import { belowThreshold } from "../src/qa/reviewer.js";
import { checkBlackFrames, checkCaptionSync, checkContainer, checkHook, checkLoudness, parseBlackDetect, parseVolumeDetect } from "../src/qa/technical.js";
import { buildCaptionCues, captionsToAss } from "../src/render/captions.js";
import { runScript } from "../src/script/agent.js";
import { estimateWordTimings, beatTimings } from "../src/voice/align.js";
import { makeDeps } from "./helpers.js";

const CID = "00000000-0000-4000-8000-000000000003";
const NOW = new Date("2026-10-09T12:00:00Z");
const T = { minDurationS: 12, maxDurationS: 60, width: 1080, height: 1920, maxFileSizeMB: 100, targetLufs: -14, lufsTolerance: 3, maxTruePeakDb: -1, maxBlackSeconds: 0.5, maxHookWords: 16, captionSyncToleranceS: 0.25 };

describe("policy rules", () => {
  const hit = (text: string) => TEXT_RULES.filter((r) => r.re.test(text)).map((r) => r.rule);
  it.each([
    ["You should take 400 mg of ibuprofen before every run.", "medical_advice"],
    ["Make sure you stop taking your medication before racing.", "medical_advice"],
    ["This will cure your knee pain for good.", "medical_advice"],
    ["Just run through the pain, it builds character.", "medical_advice"],
    ["If you're injured you should just try this stretch daily.", "medical_advice"],
    ["Guaranteed results in two weeks.", "guaranteed_results"],
    ["Lose 10 pounds in a week with this plan.", "guaranteed_results"],
    ["Here is how to buy steroids online.", "doping"],
    ["That was fucking incredible.", "profanity"],
  ])("flags %j as %s", (text, rule) => {
    expect(hit(text)).toContain(rule);
  });
  it.each(["Warm up for ten minutes before a hard session.", "She won gold and set a new record in Paris.", "Most easy runs should feel conversational.", "Talk to a doctor if you are worried about an injury.", "The athlete returned from an injury to win the race."])(
    "does not flag benign text %j",
    (text) => {
      expect(hit(text)).toEqual([]);
    },
  );
});

describe("metadata + policy", () => {
  const script: any = {
    title: "T",
    hookStyle: "stat",
    beats: [{ id: "b1", text: "Faith Kipyegon ran 3:49.04.", onScreen: "", claimIds: ["c1"] }],
    claims: [{ id: "c1", text: "x", source: "S1", kind: "fact", sourceItemId: "s1" }],
    visual: { headline: "H", items: [] },
    variants: {
      tiktok: { caption: "Record night in Paris", hashtags: ["#running", "track field!", "running"] },
      instagram: { caption: "Record night", hashtags: ["athletics"] },
      youtube: { title: "A new 1500m world record", description: "It happened.", hashtags: ["athletics"] },
    },
  };
  const sources: any[] = [{ id: "s1", source: "bbc-athletics", kind: "news", url: "https://bbc.test/a" }];
  const content: any = { pillar: "track_and_field", topic: "Record" };

  it("builds per-platform metadata with deduped, sanitised hashtags, source credit and the AI disclosure line", () => {
    const tt = buildPlatformMetadata("tiktok", content, script, sources);
    expect(tt.hashtags).toEqual(["running", "trackfield"]);
    expect(tt.caption).toContain("Source: BBC Sport");
    expect(tt.caption).toContain("AI-assisted video with a synthetic voiceover.");
    expect(tt.aiDisclosure.nativeFlag).toBe("is_aigc");
    const yt = buildPlatformMetadata("youtube", content, script, sources);
    expect(yt.aiDisclosure.nativeFlag).toBe("containsSyntheticMedia");
    expect(yt.caption).toContain("https://bbc.test/a");
    expect(buildPlatformMetadata("instagram", content, script, sources).aiDisclosure.nativeFlag).toBe("none");
  });

  it("passes clean content and fails when the AI disclosure is missing or a limit is exceeded", () => {
    const meta = {
      tiktok: buildPlatformMetadata("tiktok", content, script, sources),
      instagram: buildPlatformMetadata("instagram", content, script, sources),
      youtube: buildPlatformMetadata("youtube", content, script, sources),
    };
    expect(checkPolicy(script, meta).passed).toBe(true);
    const noDisclosure = { ...meta, tiktok: { ...meta.tiktok, caption: "no disclosure here" } };
    expect(checkPolicy(script, noDisclosure).violations).toContainEqual(expect.objectContaining({ rule: "ai_disclosure", where: "metadata:tiktok" }));
    const longTitle = { ...meta, youtube: { ...meta.youtube, title: "x".repeat(101) } };
    expect(checkPolicy(script, longTitle).violations.some((v) => v.rule === "limits")).toBe(true);
    expect(checkPolicy(script, { tiktok: meta.tiktok }).violations.some((v) => v.where === "metadata:youtube")).toBe(true); // missing metadata for an enabled platform
  });

  it("catches policy violations inside the narration and on-screen text", () => {
    const bad = { ...script, beats: [{ id: "b1", text: "You should take 500 mg of ibuprofen first.", onScreen: "Guaranteed results", claimIds: [] }] };
    const meta = { tiktok: buildPlatformMetadata("tiktok", content, bad, sources), instagram: buildPlatformMetadata("instagram", content, bad, sources), youtube: buildPlatformMetadata("youtube", content, bad, sources) };
    const v = checkPolicy(bad, meta).violations;
    expect(v.map((x) => x.where)).toEqual(expect.arrayContaining(["narration", "onScreen:b1"]));
  });
});

describe("technical checks (pure)", () => {
  const good = { durationS: 31, width: 1080, height: 1920, fps: 30, videoCodec: "h264", audioCodec: "aac", sizeBytes: 5e6, hasAudio: true };
  it("container: passes a compliant file, flags each defect", () => {
    expect(checkContainer(good, T).every((c) => c.ok)).toBe(true);
    const fails = (o: object) => checkContainer({ ...good, ...o }, T).filter((c) => !c.ok).map((c) => c.name);
    expect(fails({ durationS: 5 })).toEqual(["duration"]);
    expect(fails({ durationS: 75 })).toEqual(["duration"]);
    expect(fails({ width: 720, height: 1280 })).toEqual(["resolution"]);
    expect(fails({ videoCodec: "vp9" })).toEqual(["video_codec"]);
    expect(fails({ hasAudio: false, audioCodec: undefined })).toEqual(["audio_present"]);
    expect(fails({ sizeBytes: 200e6 })).toEqual(["file_size"]);
  });
  it("loudness: target ±tolerance and true-peak ceiling", () => {
    expect(checkLoudness(-14.3, -1.8, T).every((c) => c.ok)).toBe(true);
    expect(checkLoudness(-22, -3, T).find((c) => c.name === "loudness")!.ok).toBe(false);
    expect(checkLoudness(-14, 0.5, T).find((c) => c.name === "true_peak")!.ok).toBe(false);
  });
  it("black frames: total budget and black-at-start", () => {
    expect(checkBlackFrames(0, false, T).every((c) => c.ok)).toBe(true);
    expect(checkBlackFrames(1.2, false, T)[0]!.ok).toBe(false);
    expect(checkBlackFrames(0.3, true, T)[1]!.ok).toBe(false);
    expect(parseBlackDetect("[blackdetect @ 0x1] black_start:0 black_end:0.8 black_duration:0.8\n[blackdetect @ 0x1] black_start:5 black_end:5.2 black_duration:0.2")).toEqual({ total: 1, startsBlack: true });
    expect(parseVolumeDetect("[Parsed_volumedetect_0] mean_volume: -19.4 dB")).toBe(-19.4);
    expect(parseVolumeDetect("nothing")).toBeNull();
  });
  it("hook: length cap and prompt start", () => {
    expect(checkHook(10, 0.2, T).every((c) => c.ok)).toBe(true);
    expect(checkHook(20, 0.2, T)[0]!.ok).toBe(false);
    expect(checkHook(10, 1.5, T)[1]!.ok).toBe(false);
  });
  it("threshold helper lists every dimension below the minimum", () => {
    expect(belowThreshold({ accuracy: 9, brand_voice: 6, hook_strength: 7, clarity: 8, policy_safety: 5 }, 7)).toEqual([
      { key: "brand_voice", value: 6 },
      { key: "policy_safety", value: 5 },
    ]);
  });
});

describe("caption sync check", () => {
  const words = estimateWordTimings("Faith Kipyegon ran three minutes and forty nine seconds in Paris tonight", 6);
  const cues = buildCaptionCues(words, 6.7);
  const ass = captionsToAss(cues, "00E5FF");
  const args = { assText: ass, cues, words, timingSource: "provider" as const, videoDurationS: 6.7, audioDurationS: 6, tol: 0.25 };

  it("passes when captions on disk match the spoken words and cues", () => {
    const failed = checkCaptionSync(args).filter((c) => !c.ok);
    expect(failed).toEqual([]);
  });
  it("fails when a word is missing from the burned-in captions", () => {
    const tampered = ass.replace(/Paris/, "");
    expect(checkCaptionSync({ ...args, assText: tampered }).find((c) => c.name === "captions_match_speech")!.ok).toBe(false);
  });
  it("fails when a caption is shifted away from the cue it should match", () => {
    const shifted = ass.replace(/Dialogue: 1,0:00:00\.\d\d/, "Dialogue: 1,0:00:01.50");
    expect(checkCaptionSync({ ...args, assText: shifted }).some((c) => !c.ok)).toBe(true);
  });
  it("fails when captions run past the end of the video", () => {
    expect(checkCaptionSync({ ...args, videoDurationS: 3 }).find((c) => c.name === "captions_in_range")!.ok).toBe(false);
  });
  it("fails non-monotonic word timings", () => {
    const bad = [...words];
    bad[3] = { ...bad[3]!, s: 0.01, e: 0.02 };
    expect(checkCaptionSync({ ...args, words: bad }).find((c) => c.name === "word_timings_valid")!.ok).toBe(false);
  });
  it("uses a wider tolerance for estimated (non-provider) timing", () => {
    const late = cues.map((c, i) => (i === 0 ? { ...c, start: c.start + 0.4 } : c));
    const lateAss = captionsToAss(late, "00E5FF");
    expect(checkCaptionSync({ ...args, cues: late, assText: lateAss, timingSource: "provider" }).find((c) => c.name === "first_caption_sync")!.ok).toBe(false);
    expect(checkCaptionSync({ ...args, cues: late, assText: lateAss, timingSource: "estimated" }).find((c) => c.name === "first_caption_sync")!.ok).toBe(true);
  });
});

// --------------------------------------------------------------------------- gate

const NEWS: RawItem[] = [
  {
    source: "bbc-athletics",
    kind: "news",
    pillar: "track_and_field",
    title: "Kipyegon breaks 1500m world record in Paris",
    summary: "Kenya's Faith Kipyegon ran 3:49.04 in Paris on Thursday night. The time took 0.38 seconds off her own world record.",
    bodyText: "The two-time Olympic champion led from the front and kicked clear over the final lap. Organisers said the crowd of 40000 stayed on its feet.",
    url: "https://ex.test/1",
    publishedAt: new Date("2026-10-09T10:00:00Z"),
  },
];

/** Fake ffprobe/ffmpeg so the gate's technical stage can run without real media. */
function fakeRunner(over: { loudI?: number; durationS?: number; black?: string } = {}): Runner {
  return async (cmd, args) => {
    if (cmd.includes("ffprobe")) {
      return { stdout: JSON.stringify({ format: { duration: String(over.durationS ?? 31), size: "5000000" }, streams: [{ codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30/1" }, { codec_type: "audio", codec_name: "aac" }] }), stderr: "" };
    }
    const a = args.join(" ");
    if (a.includes("loudnorm")) return { stdout: "", stderr: `{ "input_i" : "${over.loudI ?? -14.2}", "input_tp" : "-2.0", "input_lra" : "5", "input_thresh" : "-24", "target_offset" : "0" }` };
    if (a.includes("volumedetect")) return { stdout: "", stderr: "mean_volume: -19.0 dB" };
    if (a.includes("blackdetect")) return { stdout: "", stderr: over.black ?? "" };
    return { stdout: "", stderr: "" };
  };
}

async function renderedContent(opts: { reply?: (r: any) => unknown; runner?: Runner; mutateScript?: (s: any) => any; regen?: number } = {}) {
  const ctx = await makeDeps({ ...(opts.reply ? { reply: opts.reply, billable: true } : { provider: new StubProvider() }), now: NOW });
  ctx.deps.runner = opts.runner ?? fakeRunner();
  const { deps, db } = ctx;
  await storeItems(db, deps.embedder, NEWS, NOW);
  const ids = (await listRecentItems(db, 48, NOW)).map((i) => i.id);
  const c = await createContent(db, { pillar: "track_and_field", template: "stat_spotlight", topic: "Kipyegon's record time", hookStyle: "stat", idea: { angle: "x" }, sourceItemIds: ids, correlationId: CID });
  // script via the stub (no custom reply), so QA runs against a genuinely grounded script
  const scriptDeps = { ...deps, llm: new LlmClient(new StubProvider(), deps.spend, deps.cfg.env, deps.log) };
  await runScript(scriptDeps, { contentId: c.id, correlationId: CID, regen: 0 });
  const row = (await getContent(db, c.id))!;
  let script: any = row.script;
  if (opts.mutateScript) script = opts.mutateScript(script);

  const text = script.beats.map((b: any) => b.text).join(" ");
  const D = 22;
  const words = estimateWordTimings(text, D);
  const cues = buildCaptionCues(words, D + 0.7);
  const dir = mkdtempSync(join(tmpdir(), "qa-"));
  const captionsPath = join(dir, "captions.ass");
  writeFileSync(captionsPath, captionsToAss(cues, "00E5FF"));
  const voice = { provider: "dev", fallbackUsed: false, attempts: [], audioPath: join(dir, "v.mp3"), durationS: D, words, timingSource: "provider", beats: beatTimings(script.beats, words), chars: text.length, devVoice: false };
  const render = { renderer: "ffmpeg", videoPath: join(dir, "video.mp4"), coverPath: join(dir, "cover.jpg"), captionsPath, durationS: D + 0.7, cues };
  await transition(db, c.id, "scripted", "voiced", { voice, script }, { stage: "t" });
  await transition(db, c.id, "voiced", "rendered", { render }, { stage: "t" });
  if (opts.regen) await db.query(`UPDATE content SET regen_count = $2 WHERE id = $1`, [c.id, opts.regen]);
  return { ...ctx, id: c.id };
}

describe("runQa gate", () => {
  it("passes a grounded, compliant piece and hands it to the publish scheduler", async () => {
    const { deps, db, id, enqueued } = await renderedContent();
    expect(await runQa(deps, { contentId: id, correlationId: CID })).toBe("passed");
    const row = (await getContent(db, id))!;
    expect(row.status).toBe("qa_passed");
    expect((row.qa as any).passed).toBe(true);
    expect((row.qa as any).scores).toMatchObject({ accuracy: 9, policy_safety: 9 });
    expect(enqueued.at(-1)).toMatchObject({ queue: "publish", data: { kind: "schedule", contentId: id } });
    expect((await db.query(`SELECT passed FROM qa_results`)).rows).toEqual([{ passed: true }]);
  });

  it("is idempotent: a redelivered QA job on an already-judged item does nothing", async () => {
    const { deps, id, enqueued } = await renderedContent();
    await runQa(deps, { contentId: id, correlationId: CID });
    const before = enqueued.length;
    expect(await runQa(deps, { contentId: id, correlationId: CID })).toBe("skipped");
    expect(enqueued.length).toBe(before);
  });

  it("FAILS a piece whose narration carries an unsourced figure and regenerates the script with that feedback", async () => {
    const { deps, db, id, enqueued } = await renderedContent({
      mutateScript: (s) => ({ ...s, beats: [...s.beats.slice(0, -1), { id: "bx", text: "That is 12 percent faster than before.", onScreen: "", claimIds: [] }, s.beats.at(-1)] }),
    });
    expect(await runQa(deps, { contentId: id, correlationId: CID })).toBe("regenerating");
    const row = (await getContent(db, id))!;
    expect(row).toMatchObject({ status: "idea", regenCount: 1 });
    expect(row.qaFeedback).toContain('unsourced figure "12"');
    expect(enqueued.at(-1)).toMatchObject({ queue: "script", data: { regen: 1, contentId: id } });
    expect((row.qa as any).reviewerSkipped).toBe(true); // no LLM review is paid for when deterministic checks already failed
  });

  it("a render-side technical failure (loudness) re-renders only: the paid voiceover and the script are kept", async () => {
    const { deps, db, id, enqueued } = await renderedContent({ runner: fakeRunner({ loudI: -24 }) });
    expect(await runQa(deps, { contentId: id, correlationId: CID })).toBe("rerendering");
    const row = (await getContent(db, id))!;
    expect(row).toMatchObject({ status: "voiced", regenCount: 1, render: null });
    expect(row.voice).not.toBeNull(); // no second TTS bill
    expect(row.script).not.toBeNull();
    expect(enqueued.at(-1)).toMatchObject({ queue: "render", data: { regen: 1 } });
  });

  it("a voice-side technical failure (speech too long for the platform) re-voices and re-renders, keeping the script", async () => {
    const { deps, db, id, enqueued } = await renderedContent({ runner: fakeRunner({ durationS: 75 }) });
    expect(await runQa(deps, { contentId: id, correlationId: CID })).toBe("rerendering");
    const row = (await getContent(db, id))!;
    expect(row).toMatchObject({ status: "scripted", regenCount: 1, voice: null, render: null });
    expect(row.script).not.toBeNull();
    expect(enqueued.at(-1)).toMatchObject({ queue: "voice", data: { regen: 1 } });
  });

  it("holds the piece (never publishes) once the regeneration budget is spent, and alerts", async () => {
    const { deps, db, id, enqueued } = await renderedContent({ regen: 2, runner: fakeRunner({ loudI: -30 }) });
    expect(await runQa(deps, { contentId: id, correlationId: CID })).toBe("held");
    const row = (await getContent(db, id))!;
    expect(row.status).toBe("held");
    expect(row.error).toMatch(/QA failed after 3 attempts/);
    expect(enqueued.filter((e) => e.queue === "publish")).toEqual([]);
    expect((await db.query(`SELECT 1 FROM alerts_log WHERE key = $1`, [`held:${id}`])).rowCount).toBe(1);
  });

  it("fails when the independent reviewer scores any dimension under the threshold, with its feedback", async () => {
    const reply = (r: any) => {
      if (r.task === "qa.review") return { scores: { accuracy: 9, brand_voice: 8, hook_strength: 5, clarity: 8, policy_safety: 9 }, feedback: ["Open with the record time."] };
      if (r.task === "qa.verify_claims") return { verdicts: r.input.claims.map((c: any) => ({ id: c.id, verdict: "supported", note: "" })) };
      return {};
    };
    const { deps, db, id } = await renderedContent({ reply });
    expect(await runQa(deps, { contentId: id, correlationId: CID })).toBe("regenerating");
    const row = (await getContent(db, id))!;
    expect(row.qaFeedback).toContain("hook_strength scored 5/7 minimum");
    expect(row.qaFeedback).toContain("[reviewer] Open with the record time.");
  });

  it("HOLDS a sensitive story immediately: no regeneration, no publish, warning alert", async () => {
    const { deps, db, id, enqueued } = await renderedContent();
    await db.query(`UPDATE content SET topic = 'Tributes paid after sprinter dies aged 24' WHERE id = $1`, [id]);
    expect(await runQa(deps, { contentId: id, correlationId: CID })).toBe("held");
    const row = (await getContent(db, id))!;
    expect(row).toMatchObject({ status: "held", regenCount: 0 });
    expect(row.error).toMatch(/sensitive topic/);
    expect((row.qa as any).failures.some((f: any) => f.reason.startsWith("sensitive_topic: death"))).toBe(true);
    expect(enqueued.filter((e) => e.queue === "publish" || e.queue === "script")).toEqual([]);
    expect((await db.query(`SELECT title FROM alerts_log WHERE key = $1`, [`held:${id}`])).rows[0].title).toMatch(/sensitive topic/);
  });

  it("alerts after 3 consecutive QA failures", async () => {
    const { deps, db, id } = await renderedContent({ runner: fakeRunner({ loudI: -30 }) });
    await db.query(`INSERT INTO qa_results (content_id, attempt, passed) SELECT $1, 0, false FROM generate_series(1,2)`, [id]);
    await runQa(deps, { contentId: id, correlationId: CID });
    expect((await db.query(`SELECT 1 FROM alerts_log WHERE key = 'qa_consecutive_failures' AND suppressed = false`)).rowCount).toBe(1);
  });

  it("treats an ffmpeg analysis crash as a technical failure rather than throwing", async () => {
    const { deps, db, id } = await renderedContent({
      runner: async (cmd) => {
        throw new Error(`${cmd} exploded`);
      },
    });
    expect(await runQa(deps, { contentId: id, correlationId: CID })).toBe("rerendering");
    expect(((await getContent(db, id))!.qa as any).failures[0].reason).toContain("analysis");
    // an unanalysable video is not provably a render-side problem, so it falls back to the safe full redo
    expect((await getContent(db, id))!.status).toBe("scripted");
  });
});
