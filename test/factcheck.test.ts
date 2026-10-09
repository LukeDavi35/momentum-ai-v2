import { describe, expect, it } from "vitest";
import { applyVerification, auditNarration, containsNumber, deterministicCheck, extractNames, extractNumbers, verifyClaims } from "../src/qa/factcheck.js";
import type { SourceItem } from "../src/ingest/types.js";
import type { Claim, ScriptDoc } from "../src/script/types.js";
import { makeDeps } from "./helpers.js";

const src = (over: Partial<SourceItem> = {}): SourceItem => ({
  id: "s1-uuid",
  source: "bbc",
  kind: "news",
  pillar: "track_and_field",
  url: "https://x",
  title: "Faith Kipyegon breaks 1500m world record",
  summary: "Kenya's Faith Kipyegon ran 3:49.04 in Paris on Thursday, taking 0.38 seconds off her own mark.",
  bodyText: 'She said: "I felt the crowd lift me over the last lap" after the race.',
  publishedAt: new Date(),
  fetchedAt: new Date(),
  metrics: {},
  embedding: null,
  ...over,
});
const claim = (over: Partial<Claim> = {}): Claim => ({ id: "c1", text: "Faith Kipyegon ran 3:49.04 in Paris.", source: "S1", sourceItemId: "s1-uuid", kind: "fact", ...over });

describe("anchor extraction", () => {
  it("extracts figures, ignoring incidental small integers, normalising thousands commas", () => {
    expect(extractNumbers("ran 3:49.04 and 1,500m in 2026")).toEqual(["3:49.04", "1500", "2026"]);
    expect(extractNumbers("Here are 3 tips, number 10")).toEqual([]);
    expect(extractNumbers("a time of 9.58 seconds")).toEqual(["9.58"]);
  });
  it("matches numbers on boundaries only (3:49 must not match inside 13:49.04)", () => {
    expect(containsNumber("ran 13:49.04 today", "3:49")).toBe(false);
    expect(containsNumber("ran 3:49.04 today", "3:49")).toBe(true);
    expect(containsNumber("ran 3:49.04 today", "3:49.04")).toBe(true);
    expect(containsNumber("1500m", "150")).toBe(false);
  });
  it("extracts names but skips common sentence words and a lone sentence-initial word", () => {
    expect(extractNames("Faith Kipyegon won in Paris on Thursday.")).toEqual(["Faith", "Kipyegon", "Paris"]);
    expect(extractNames("She won. The race was fast.")).toEqual([]);
    expect(extractNames("Today Kipyegon ran quickly, beating Jakob Ingebrigtsen.")).toEqual(expect.arrayContaining(["Kipyegon", "Jakob", "Ingebrigtsen"]));
  });
});

describe("deterministicCheck", () => {
  it("passes when every figure and name is in the cited source", () => {
    expect(deterministicCheck(claim(), src(), "stat_spotlight").ok).toBe(true);
  });
  it("fails a wrong figure", () => {
    const r = deterministicCheck(claim({ text: "Faith Kipyegon ran 3:48.00 in Paris." }), src(), "stat_spotlight");
    expect(r).toMatchObject({ ok: false });
    expect(r.reason).toContain("3:48.00");
  });
  it("fails a hallucinated name", () => {
    const r = deterministicCheck(claim({ text: "Faith Kipyegon beat Jakob Ingebrigtsen in Paris." }), src(), "news_flash");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Jakob|Ingebrigtsen/);
  });
  it("fails a claim with no valid source", () => {
    expect(deterministicCheck(claim(), undefined, "news_flash")).toMatchObject({ ok: false, reason: expect.stringContaining("no valid source") });
  });
  it("accepts only verbatim quotes and rejects fabricated ones", () => {
    const q = (quote: string) => claim({ kind: "quote", text: `She said she felt the crowd`, quote });
    expect(deterministicCheck(q("I felt the crowd lift me over the last lap"), src(), "news_flash").ok).toBe(true);
    expect(deterministicCheck(q("I felt the crowd lift me over the line forever"), src(), "news_flash")).toMatchObject({ ok: false, reason: expect.stringContaining("fabricated") });
    expect(deterministicCheck(q("too short"), src(), "news_flash").ok).toBe(false);
  });
  it("only allows unsourced general claims in evergreen templates, and only without figures/names", () => {
    const g = (text: string) => claim({ kind: "general", source: null, sourceItemId: null, text });
    expect(deterministicCheck(g("Warming up before a run helps you ease into the session."), undefined, "training_tip").ok).toBe(true);
    expect(deterministicCheck(g("Warming up before a run helps you ease into the session."), undefined, "news_flash").ok).toBe(false);
    expect(deterministicCheck(g("Studies show 40% fewer injuries."), undefined, "training_tip").ok).toBe(false);
    expect(deterministicCheck(g("Eliud Kipchoge swears by easy runs."), undefined, "training_tip").ok).toBe(false);
  });
});

describe("verifyClaims (deterministic + LLM judge)", () => {
  const script = (claims: Claim[]) => ({ claims, sourceAliases: { S1: "s1-uuid" } });

  it("sends only deterministic survivors to the judge and combines the results", async () => {
    const { deps, provider } = await makeDeps({ reply: () => ({ verdicts: [{ id: "c1", verdict: "supported", note: "stated" }] }) });
    const claims = [claim(), claim({ id: "c2", text: "Faith Kipyegon ran 3:40.00 in Paris." })];
    const v = await verifyClaims(deps, script(claims), [src()], "stat_spotlight", {});
    expect(v.map((x) => [x.id, x.verified, x.method])).toEqual([["c1", true, "llm"], ["c2", false, "deterministic"]]);
    expect(provider.calls).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(provider.calls[0]!.input)).claims.map((c: any) => c.id)).toEqual(["c1"]);
  });

  it("an LLM 'unsupported' verdict makes the claim unverified even if anchors matched", async () => {
    const { deps } = await makeDeps({ reply: () => ({ verdicts: [{ id: "c1", verdict: "unsupported", note: "source doesn't say Paris was a meeting" }] }) });
    const [v] = await verifyClaims(deps, script([claim()]), [src()], "stat_spotlight", {});
    expect(v).toMatchObject({ verified: false, method: "llm" });
  });

  it("treats a missing verdict as unverified (never defaults to verified)", async () => {
    const { deps } = await makeDeps({ reply: () => ({ verdicts: [] }) });
    const [v] = await verifyClaims(deps, script([claim()]), [src()], "stat_spotlight", {});
    expect(v!.verified).toBe(false);
  });

  it("fails CLOSED: if the judge cannot run, the error propagates instead of passing claims", async () => {
    const { deps } = await makeDeps({ reply: () => "this is not json at all" });
    await expect(verifyClaims(deps, script([claim()]), [src()], "stat_spotlight", {})).rejects.toThrow(/failed validation/);
  });

  it("makes no LLM call when every claim already failed deterministically", async () => {
    const { deps, provider } = await makeDeps({ reply: () => ({ verdicts: [] }) });
    await verifyClaims(deps, script([claim({ text: "Faith Kipyegon ran 3:01.00." })]), [src()], "stat_spotlight", {});
    expect(provider.calls).toHaveLength(0);
  });
});

describe("narration audit + applyVerification", () => {
  const beats = [
    { id: "b1", text: "Faith Kipyegon just ran 3:49.04.", onScreen: "", claimIds: ["c1"] },
    { id: "b2", text: "That is faster than 3:40.00 by far.", onScreen: "", claimIds: [] },
    { id: "b3", text: "Coach Sebastian Coe called it historic.", onScreen: "", claimIds: [] },
    { id: "b4", text: 'She said "the stadium carried me home tonight".', onScreen: "", claimIds: [] },
    { id: "b5", text: "Follow for more.", onScreen: "", claimIds: [] },
  ];
  it("flags figures, names and quotations that no verified claim or source contains", () => {
    const { flagged } = auditNarration(beats, [claim()], [src()]);
    expect([...flagged.keys()].sort()).toEqual(["b2", "b3", "b4"]);
    expect(flagged.get("b2")![0]).toContain("3:40.00");
    expect(flagged.get("b3")!.join()).toMatch(/Sebastian|Coe/);
    expect(flagged.get("b4")![0]).toContain("quotation");
  });
  it("does not flag text that IS in a verified claim or source", () => {
    expect(auditNarration([beats[0]!, beats[4]!], [claim()], [src()]).flagged.size).toBe(0);
  });

  const doc = (): ScriptDoc =>
    ({
      title: "t",
      hookStyle: "stat",
      beats: [beats[0]!, { id: "b6", text: "Fastest ever, says Jakob Ingebrigtsen.", onScreen: "", claimIds: ["c2"] }, beats[4]!],
      claims: [claim(), claim({ id: "c2", text: "Jakob Ingebrigtsen called it the fastest ever." })],
      visual: { headline: "h" },
      variants: { tiktok: { caption: "", hashtags: [] }, instagram: { caption: "", hashtags: [] }, youtube: { title: "", description: "", hashtags: [] } },
      sourceAliases: {},
      estimatedDurationS: 10,
      removed: [],
      generator: "live",
    }) as ScriptDoc;

  it("removes beats resting on unverified claims, drops those claims, and records why", () => {
    const out = applyVerification(doc(), [{ id: "c1", verified: true, reason: "", method: "llm" }, { id: "c2", verified: false, reason: "name not in source", method: "deterministic" }], [src()]);
    expect(out.beats.map((b) => b.id)).toEqual(["b1", "b5"]);
    expect(out.claims.map((c) => c.id)).toEqual(["c1"]);
    expect(out.removed).toEqual([{ beatId: "b6", reason: "claim c2: name not in source" }]);
  });
});
