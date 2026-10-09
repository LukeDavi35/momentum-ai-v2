import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.js";
import { LocalHashEmbedder } from "../src/ideate/embeddings.js";
import { parseFeed } from "../src/ingest/rss.js";
import { parseApproxTraffic, parseTrends } from "../src/ingest/trends.js";
import { parseSubreddit } from "../src/ingest/reddit.js";
import { contentHash, getItemsByIds, listRecentItems, storeItems } from "../src/ingest/store.js";
import { runIngest } from "../src/ingest/index.js";
import { decodeEntities, normalizeForMatch, stripHtml } from "../src/ingest/text.js";
import { CITABLE_KINDS } from "../src/ingest/types.js";
import { silentLogger, testConfig, testDb } from "./helpers.js";

let db: Db;
beforeEach(async () => {
  db = await testDb();
});

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<item><title>Kipyegon breaks 1500m world record &amp; wins gold</title><link>https://ex.test/a</link>
<description>&lt;p&gt;Faith Kipyegon ran &lt;b&gt;3:49.04&lt;/b&gt; in Paris.&lt;/p&gt;</description><pubDate>Thu, 09 Oct 2026 10:00:00 GMT</pubDate></item>
<item><title>No date item</title><link>https://ex.test/b</link><description>plain text</description></item>
<item><title></title><link>https://ex.test/empty</link></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom story</title>
<link rel="alternate" href="https://ex.test/atom"/><summary>Atom summary text</summary><updated>2026-10-09T09:00:00Z</updated></entry></feed>`;

describe("text helpers", () => {
  it("decodes entities and strips html", () => {
    expect(decodeEntities("a &amp; b &#39;c&#39; &#x41;")).toBe("a & b 'c' A");
    expect(stripHtml("<p>Hi <b>there</b></p><script>x()</script>")).toBe("Hi there");
  });
  it("normalises quotes, dashes and thousands separators for matching", () => {
    expect(normalizeForMatch("It’s  “1,500”m – fast")).toBe(`it's "1500"m - fast`);
  });
});

describe("rss/atom parsing", () => {
  it("parses RSS items, cleans html, decodes entities, skips empty titles", () => {
    const items = parseFeed(RSS, { id: "t", kind: "news", pillar: "track_and_field" });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ title: "Kipyegon breaks 1500m world record & wins gold", url: "https://ex.test/a", kind: "news", pillar: "track_and_field" });
    expect(items[0]!.summary).toBe("Faith Kipyegon ran 3:49.04 in Paris.");
    expect(items[0]!.publishedAt?.toISOString()).toBe("2026-10-09T10:00:00.000Z");
    expect(items[1]!.publishedAt).toBeUndefined();
  });
  it("parses Atom entries", () => {
    const items = parseFeed(ATOM, { id: "a", kind: "news" });
    expect(items).toEqual([expect.objectContaining({ title: "Atom story", url: "https://ex.test/atom", summary: "Atom summary text" })]);
  });
  it("returns [] for non-feed XML instead of throwing", () => {
    expect(parseFeed("<html><body>nope</body></html>", { id: "x", kind: "news" })).toEqual([]);
  });
});

describe("trends", () => {
  const XML = `<rss xmlns:ht="https://trends.google.com/trending/rss"><channel>
  <item><title>london marathon</title><ht:approx_traffic>200K+</ht:approx_traffic><pubDate>Thu, 09 Oct 2026 08:00:00 GMT</pubDate>
    <ht:news_item><ht:news_item_title>Marathon route announced</ht:news_item_title><ht:news_item_snippet>Runners ready</ht:news_item_snippet></ht:news_item></item>
  <item><title>celebrity gossip</title><ht:approx_traffic>2M+</ht:approx_traffic></item>
  </channel></rss>`;
  it("keeps only sport/fitness-keyword trends and parses traffic", () => {
    const items = parseTrends(XML, ["marathon", "fitness"]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "trend", title: "london marathon", metrics: { traffic: 200000 } });
  });
  it("parses approximate traffic strings", () => {
    expect(parseApproxTraffic("200K+")).toBe(200000);
    expect(parseApproxTraffic("1M+")).toBe(1000000);
    expect(parseApproxTraffic("5,000+")).toBe(5000);
    expect(parseApproxTraffic("")).toBe(0);
  });
});

describe("reddit", () => {
  it("keeps titles + engagement only, skips stickied/NSFW, never stores post bodies", () => {
    const json = {
      data: {
        children: [
          { data: { title: "First marathon tips?", selftext: "SECRET BODY TEXT", score: 120, num_comments: 40, upvote_ratio: 0.97, permalink: "/r/running/a", created_utc: 1760000000 } },
          { data: { title: "Pinned rules", stickied: true } },
          { data: { title: "nsfw", over_18: true } },
        ],
      },
    };
    const items = parseSubreddit(json, "running", "running");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "reddit", source: "reddit/r/running", metrics: { score: 120, comments: 40 } });
    expect(JSON.stringify(items)).not.toContain("SECRET BODY TEXT");
  });
  it("reddit/trend/internal items are not citable as facts", () => {
    expect(CITABLE_KINDS).toEqual(["news", "results"]);
  });
});

describe("store", () => {
  const embedder = new LocalHashEmbedder();
  const item = (title: string, extra: object = {}) => ({ source: "s", kind: "news" as const, title, summary: "sum", url: `https://x/${title}`, publishedAt: new Date(), ...extra });

  it("inserts new items with embeddings, de-dupes repeats and in-batch duplicates", async () => {
    const r1 = await storeItems(db, embedder, [item("a"), item("b"), item("a")]);
    expect(r1.inserted).toBe(2);
    const r2 = await storeItems(db, embedder, [item("a"), item("c")]);
    expect(r2.inserted).toBe(1);
    const recent = await listRecentItems(db, 24);
    expect(recent).toHaveLength(3);
    expect(recent[0]!.embedding?.model).toBe("local-hash-256");
    expect(recent[0]!.embedding?.vector).toHaveLength(256);
  });

  it("refreshes metrics on a repeat sighting (reddit score growth) without duplicating", async () => {
    const mk = (score: number) => item("hot", { kind: "reddit", metrics: { score } });
    await storeItems(db, embedder, [mk(10)]);
    const r = await storeItems(db, embedder, [mk(99)]);
    expect(r).toMatchObject({ inserted: 0, refreshed: 1 });
    const [row] = await listRecentItems(db, 24);
    expect(row!.metrics.score).toBe(99);
  });

  it("keys trend items per day so velocity can be re-measured daily", () => {
    const t = { source: "g", kind: "trend" as const, title: "x", url: undefined };
    expect(contentHash(t, new Date("2026-10-09T01:00:00Z"))).not.toBe(contentHash(t, new Date("2026-10-10T01:00:00Z")));
    const n = { source: "g", kind: "news" as const, title: "x", url: "https://u" };
    expect(contentHash(n, new Date("2026-10-09"))).toBe(contentHash(n, new Date("2026-10-10")));
  });

  it("fetches by id", async () => {
    await storeItems(db, embedder, [item("only")]);
    const [row] = await listRecentItems(db, 24);
    expect((await getItemsByIds(db, [row!.id]))[0]!.title).toBe("only");
    expect(await getItemsByIds(db, [])).toEqual([]);
  });
});

describe("runIngest", () => {
  const cfg = testConfig();
  const embedder = new LocalHashEmbedder();
  const deps = (fetchImpl: any) => ({ db, cfg, embedder, log: silentLogger(), fetchImpl });

  it("isolates a failing feed: others are still stored and the job does not throw", async () => {
    const fetchImpl = async (url: any) => (String(url).includes("bbc") ? new Response(RSS) : new Response("boom", { status: 500 }));
    const out = await runIngest(deps(fetchImpl), "rss");
    expect(out.filter((o) => !o.error).length).toBeGreaterThan(0);
    expect(out.filter((o) => o.error).length).toBeGreaterThan(0);
    expect((await listRecentItems(db, 24 * 365)).length).toBeGreaterThan(0);
  });

  it("throws (so BullMQ retries with backoff) only when every source fails", async () => {
    await expect(runIngest(deps(async () => new Response("down", { status: 503 })), "rss")).rejects.toThrow(/All rss sources failed/);
  });

  it("skips reddit gracefully when credentials are not configured", async () => {
    expect(await runIngest(deps(async () => new Response("")), "reddit")).toEqual([]);
  });

  it("reads internal items from the supplied provider", async () => {
    const out = await runIngest({ ...deps(fetch), internalItems: async () => [{ source: "internal", kind: "internal", title: "our top post", summary: "" }] }, "internal");
    expect(out[0]).toMatchObject({ source: "internal", fetched: 1, inserted: 1 });
  });
});
