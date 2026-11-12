import { describe, expect, it } from "vitest";
import type { FootageRef } from "../src/footage/types.js";
import type { Compilation } from "../src/highlights/types.js";
import { AI_DISCLOSURE_LINE, buildPlatformMetadata, footageCreditLines } from "../src/publish/metadata.js";
import { checkCompilation } from "../src/qa/compilation.js";
import { checkPolicy } from "../src/qa/policy.js";
import { footageFilter, planSpans } from "../src/render/montage.js";
import { buildVisualAss } from "../src/render/visuals.js";
import { ILLUSTRATIVE_NOTE } from "../src/footage/query.js";
import type { ScriptDoc } from "../src/script/types.js";

const clip = (id: string, over: Partial<FootageRef> = {}): FootageRef => ({
  provider: "pexels",
  externalId: id,
  title: `clip ${id}`,
  pageUrl: `https://www.pexels.com/video/${id}/`,
  downloadUrl: `https://v.test/${id}.mp4`,
  license: "pexels",
  licenseLabel: "Pexels License",
  author: `Author ${id}`,
  attributionRequired: false,
  durationS: 10,
  width: 1080,
  height: 1920,
  localPath: `/tmp/${id}.mp4`,
  credit: `Footage: Author ${id} / Pexels`,
  ...over,
});

const compilation = (footage: Array<FootageRef | null>): Compilation => ({
  date: "2026-11-12",
  introBeatIds: ["b1"],
  outroBeatIds: [`b${footage.length + 2}`],
  segments: footage.map((f, i) => ({ storyIndex: i, headline: `Story ${i + 1} title`, beatIds: [`b${i + 2}`], footage: f })),
});

const script = (c: Compilation | undefined): ScriptDoc => ({
  title: "Today's sports highlights",
  hookStyle: "news",
  beats: [{ id: "b1", text: "Here are today's top sports stories.", onScreen: "", claimIds: [] }, ...(c?.segments ?? []).map((s) => ({ id: s.beatIds[0]!, text: "A story beat.", onScreen: s.headline, claimIds: [] }))],
  claims: [],
  visual: { headline: "Today's sports highlights", stat: null, statLabel: null, items: [] },
  variants: { tiktok: { caption: "Top stories", hashtags: ["sports"] }, instagram: { caption: "Top stories", hashtags: ["sports"] }, youtube: { title: "Today's sports highlights", description: "Top stories.", hashtags: ["sports"] } },
  sourceAliases: {},
  estimatedDurationS: 40,
  removed: [],
  generator: "live",
  ...(c ? { compilation: c } : {}),
});

describe("planSpans", () => {
  const beats = [
    { id: "b1", start: 0.1 },
    { id: "b2", start: 4 },
    { id: "b3", start: 14 },
    { id: "b4", start: 25 },
    { id: "b5", start: 36 },
  ];
  it("covers [0, total] exactly: the first story also covers the hook, the last the sign-off", () => {
    const spans = planSpans(compilation([clip("1"), clip("2"), null]), beats, 40);
    expect(spans.map((s) => [s.start, s.end])).toEqual([[0, 14], [14, 25], [25, 40]]);
    expect(spans[2]!.footage).toBeNull();
    for (let i = 1; i < spans.length; i++) expect(spans[i]!.start).toBe(spans[i - 1]!.end);
  });
  it("ignores segments whose beats have no timing, and orders by time", () => {
    const c = compilation([clip("1"), clip("2"), clip("3")]);
    c.segments[1]!.beatIds = ["missing"];
    const spans = planSpans(c, beats, 40);
    expect(spans.map((s) => s.segment)).toEqual([0, 2]);
    expect(spans[0]!.start).toBe(0);
    expect(spans.at(-1)!.end).toBe(40);
  });
  it("is empty when nothing can be timed", () => {
    expect(planSpans(compilation([clip("1")]), [], 40)).toEqual([]);
  });
});

describe("footage filter", () => {
  it("cover-crops to 1080x1920 at 30 fps and dims the clip with a soft vignette (no hard-edged bands)", () => {
    const f = footageFilter();
    expect(f).toContain("scale=1080:1920:force_original_aspect_ratio=increase");
    expect(f).toContain("crop=1080:1920");
    expect(f).toContain("fps=30");
    expect(f).toContain("vignette=");
    expect(f).not.toContain("drawbox");
    expect(f.endsWith("format=yuv420p")).toBe(true);
  });
});

describe("compilation overlay", () => {
  const c = compilation([clip("1"), clip("2"), null]);
  const s = script(c);
  const timing = [
    { id: "b1", start: 0.1, end: 3.5, wordStart: 0, wordEnd: 6 },
    { id: "b2", start: 4, end: 13, wordStart: 6, wordEnd: 10 },
    { id: "b3", start: 14, end: 24, wordStart: 10, wordEnd: 14 },
    { id: "b4", start: 25, end: 35, wordStart: 14, wordEnd: 18 },
    { id: "b5", start: 36, end: 39, wordStart: 18, wordEnd: 22 },
  ];
  const ass = buildVisualAss("daily_highlights", s, timing, 40, planSpans(c, timing, 40));

  it("numbers each story, titles it from when its beat starts, and credits the clip for as long as it plays", () => {
    expect(ass).toContain("1 / 3");
    expect(ass).toContain("3 / 3");
    expect(ass).toMatch(/Dialogue: 0,0:00:04\.00,0:00:14\.00,StoryTitle,.*Story 1 title/);
    expect(ass).toMatch(/Dialogue: 0,0:00:00\.00,0:00:14\.00,Credit,.*Footage: Author 1 \/ Pexels · Footage is illustrative b-roll/);
    expect(ass).toContain("Footage: Author 2 / Pexels");
  });
  it("shows no footage credit for a story drawn on a generated background", () => {
    expect(ass.match(/,Credit,/g)).toHaveLength(2);
  });
  it("keeps the AI disclosure and brand tag", () => {
    expect(ass).toContain("AI-assisted video");
    expect(ass).toContain("DAILY HIGHLIGHTS");
  });
  it("falls back to the plain layout for a script without a compilation", () => {
    const plain = buildVisualAss("daily_highlights", script(undefined), timing, 40);
    expect(plain).not.toMatch(/Dialogue:.*StoryTitle/);
  });
});

describe("post text and QA for a compilation", () => {
  const withFootage = script(compilation([clip("1"), clip("2"), clip("3")]));
  const meta = (s: ScriptDoc) => ({
    tiktok: buildPlatformMetadata("tiktok", { pillar: "sports_news", topic: "Sports highlights" }, s, []),
    instagram: buildPlatformMetadata("instagram", { pillar: "sports_news", topic: "Sports highlights" }, s, []),
    youtube: buildPlatformMetadata("youtube", { pillar: "sports_news", topic: "Sports highlights" }, s, []),
  });
  const ALL = ["tiktok", "instagram", "youtube"] as const;

  it("credits every clip once, says the footage is illustrative, and keeps the AI disclosure", () => {
    expect(footageCreditLines(withFootage)).toEqual(["Footage: Author 1 / Pexels", "Footage: Author 2 / Pexels", "Footage: Author 3 / Pexels", ILLUSTRATIVE_NOTE]);
    for (const m of Object.values(meta(withFootage))) {
      expect(m.caption).toContain("Footage: Author 2 / Pexels");
      expect(m.caption).toContain(ILLUSTRATIVE_NOTE);
      expect(m.caption).toContain(AI_DISCLOSURE_LINE);
    }
  });
  it("adds nothing for a video with no footage", () => {
    expect(footageCreditLines(script(compilation([null, null])))).toEqual([]);
    expect(meta(script(compilation([null, null]))).youtube.caption).not.toContain("Footage");
  });
  it("de-duplicates a clip used by two segments", () => {
    expect(footageCreditLines(script(compilation([clip("1"), clip("1")])))).toEqual(["Footage: Author 1 / Pexels", ILLUSTRATIVE_NOTE]);
  });

  it("passes a well-formed compilation", () => {
    expect(checkCompilation(withFootage, meta(withFootage), ALL)).toEqual([]);
    expect(checkPolicy(withFootage, meta(withFootage), ALL).violations).toEqual([]);
  });
  it("fails a compilation with no plan or too few stories", () => {
    expect(checkCompilation(script(undefined), meta(script(undefined)), ALL)[0]).toMatchObject({ rule: "compilation" });
    const one = script(compilation([clip("1")]));
    expect(checkCompilation(one, meta(one), ALL).some((v) => v.rule === "compilation" && /at least 2/.test(v.excerpt))).toBe(true);
  });
  it("fails a clip whose licence is not accepted, or that has no credit", () => {
    const bad = script(compilation([clip("1", { licenseLabel: "CC BY-NC 2.0" }), clip("2", { credit: "" }), clip("3")]));
    const rules = checkCompilation(bad, meta(bad), ALL).map((v) => v.rule);
    expect(rules).toContain("footage_license");
    expect(rules).toContain("footage_credit");
  });
  it("fails when the post text lacks a credit or the illustrative note", () => {
    const m = meta(withFootage);
    m.youtube = { ...m.youtube, caption: m.youtube.caption.replace("Footage: Author 2 / Pexels", "").replace(ILLUSTRATIVE_NOTE, "") };
    const v = checkCompilation(withFootage, m, ALL);
    expect(v.filter((x) => x.where === "metadata:youtube").map((x) => x.excerpt).join("|")).toMatch(/Author 2/);
    expect(v.some((x) => x.where === "metadata:youtube" && /illustrative/.test(x.excerpt))).toBe(true);
    expect(v.some((x) => x.where === "metadata:tiktok")).toBe(false);
  });
});
