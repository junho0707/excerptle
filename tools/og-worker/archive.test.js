import test from "node:test";
import assert from "node:assert/strict";
import { handleArchive, handleSitemap, todayIndex, publishedIndices } from "./archive.js";

// order: 2 presets, then a 3-book daily pool. Day 0 is 2026-09-09 (index 600).
const index = { startDate: "2026-09-09", dailyStartIndex: 600, presetCount: 2, order: ["p0", "p1", "d0", "d1", "d2"] };
const puzzle = (title) => ({ title, author: "A. Author", year: 1900, genre: "Novel", setting: "Somewhere", openingExcerpt: "First line.\n\nSecond paragraph.", source: { url: "https://www.gutenberg.org/ebooks/1" } });
const files = {
  "/puzzles/index.json": index,
  "/puzzles/d0.json": puzzle("Zero <b>Book</b>"),
  "/puzzles/d1.json": puzzle("One"),
  "/puzzles/d2.json": puzzle("Two"),
};
const SITEMAP = `<?xml version="1.0"?>\n<urlset>\n  <url><loc>https://excerptle.io/</loc></url>\n</urlset>\n`;
const env = {
  ASSETS: {
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/sitemap.xml") return new Response(SITEMAP);
      return path in files ? Response.json(files[path]) : new Response("no", { status: 404 });
    },
  },
};
// 2026-09-12 12:00 Pacific = day 3 = index 603 (today). Published candidates: 600-602.
const now = new Date("2026-09-12T19:00:00Z");
const notes = { 600: "A note about <script>alert(1)</script> & more.\n\nSecond para.", 601: "", 603: "today", 604: "future", 599: "before launch" };
const get = (path, init) => handleArchive(new Request("https://excerptle.io" + path, init), env, notes, now);

test("today is computed on the Pacific calendar, like the client", () => {
  assert.equal(todayIndex(index, now), 603);
  // 06:59 UTC on the 12th is still the 11th in Pacific (UTC-7).
  assert.equal(todayIndex(index, new Date("2026-09-12T06:59:00Z")), 602);
  assert.equal(todayIndex(index, new Date("2026-09-12T07:00:00Z")), 603);
  assert.deepEqual(publishedIndices(index, notes, now), [600]);
});

test("a past daily with a note is 200 and carries its title, facts and links", async () => {
  const res = await get("/archive/600");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control"), /max-age=\d+/);
  const body = await res.text();
  assert.match(body, /Zero &lt;b&gt;Book&lt;\/b&gt;/);
  assert.match(body, /rel="canonical" href="https:\/\/excerptle\.io\/archive\/600"/);
  assert.match(body, /href="\/\?p=600"/);
  assert.match(body, /Read the full book/);
  assert.match(body, /First line\./);
  assert.match(body, /"@type":"Article"/);
  assert.match(body, /"@type":"Book"/);
});

test("today, the future, and anything before the first daily are 404", async () => {
  for (const n of [603, 604, 650, 599, 0]) assert.equal((await get("/archive/" + n)).status, 404, String(n));
});

test("a past daily without a note (or with a blank one) is 404", async () => {
  assert.equal((await get("/archive/601")).status, 404);
  assert.equal((await get("/archive/602")).status, 404);
});

test("junk paths are 404 and non-GET is refused", async () => {
  for (const p of ["/archive/abc", "/archive/600x", "/archive/-1", "/archive/0600", "/archive/600/extra"]) {
    const res = await get(p);
    assert.ok(res === null || res.status === 404, p);
  }
  assert.equal((await get("/archive/600", { method: "POST" })).status, 405);
  assert.equal(await get("/other"), null);
});

test("notes and titles are HTML-escaped", async () => {
  const body = await (await get("/archive/600")).text();
  assert.ok(!body.includes("<script>alert(1)</script>"));
  assert.ok(body.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more."));
  assert.ok(!body.includes("<b>Book</b>"));
  // JSON-LD cannot be closed early either.
  const ld = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
  assert.ok(!ld.includes("<"));
  assert.doesNotThrow(() => JSON.parse(ld));
});

test("the index lists only published entries and never today", async () => {
  const body = await (await get("/archive")).text();
  assert.match(body, /href="\/archive\/600"/);
  for (const n of [601, 602, 603, 604]) assert.ok(!body.includes(`/archive/${n}"`), String(n));
  assert.equal((await get("/archive/")).status, 200);
  const tomorrow = new Date("2026-09-13T19:00:00Z");
  const next = await (await handleArchive(new Request("https://excerptle.io/archive"), env, { ...notes, 602: "x" }, tomorrow)).text();
  assert.match(next, /href="\/archive\/602"/);
});

test("sitemap keeps the static entries and adds only published archive pages", async () => {
  const res = await handleSitemap(new Request("https://excerptle.io/sitemap.xml"), env, notes, now);
  const xml = await res.text();
  assert.match(xml, /<loc>https:\/\/excerptle\.io\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/excerptle\.io\/archive<\/loc>/);
  assert.match(xml, /<loc>https:\/\/excerptle\.io\/archive\/600<\/loc>/);
  assert.equal([...xml.matchAll(/\/archive\/\d+</g)].length, 1);
  assert.ok(xml.trimEnd().endsWith("</urlset>"));
  assert.match(res.headers.get("content-type"), /xml/);
});
