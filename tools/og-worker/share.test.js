import test from "node:test";
import assert from "node:assert/strict";
import { readShare, shareFromUrl, unfurl } from "./share.js";
import { cardSvg } from "./card.js";
const encode = d => Buffer.from(JSON.stringify(d)).toString("base64url");
test("unfinished shares invite; completed losses show X/6; old links still work", () => {
  const base = {v:2,n:"Reader",m:"daily",g:2,h:1,w:0};
  const unfinished = readShare(encode({...base,c:0}));
  assert.match(unfurl(unfinished,642).title,/is reading/);
  assert.doesNotMatch(unfurl(unfinished,642).title,/X\/6/);
  assert.match(unfurl(readShare(encode({...base,c:1})),642).title,/X\/6/);
  assert.equal(readShare(encode({...base,v:1})).c,1);
  // Links shared before the clock was removed still carry t; it must parse and
  // simply not appear in the unfurl.
  const old = readShare(encode({...base,c:1,w:1,t:214}));
  assert.equal(old.t,214);
  assert.doesNotMatch(unfurl(old,642).description,/\d+m \d+s|\b\d+s\b/);
});
test("book zero and battle invitations are valid, malformed links are ignored", () => {
  const s = encode({v:2,m:"preset",c:0});
  assert.equal(shareFromUrl(new URL("https://excerptle.io/?p=0&s="+s)).idx,0);
  assert.equal(shareFromUrl(new URL("https://excerptle.io/?p=0&b=abc123")).d.invite,true);
  for (const p of ["", "-1", "12abc", "Infinity"]) {
    assert.equal(shareFromUrl(new URL("https://excerptle.io/?p="+p+"&s="+s)),null);
  }
  assert.equal(readShare("x".repeat(3000)),null);
  assert.equal(readShare(encode({v:99})),null);
});
test("names cannot inject SVG markup", () => {
  const svg = cardSvg({n:'<script>&"',m:"preset",c:0},642);
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes("&lt;script&gt;&amp;&quot;"));
});

// Optional full-stack smoke test against wrangler dev.
test("Worker serves pages, personalized metadata and actual PNGs", {skip:!process.env.SHARE_TEST_URL}, async () => {
  const base = process.env.SHARE_TEST_URL;
  for (const path of ["/", "/privacy", "/support", "/js/app.js", "/assets/og.png", "/puzzles/index.json"]) {
    assert.equal((await fetch(base+path)).status,200,path);
  }
  const cases = [
    {v:2,n:"Reader",m:"daily",c:0},
    {v:2,n:"Reader",m:"preset",c:0},
    {v:2,n:"Reader",m:"daily",c:1,w:1,g:3,h:1},
    {v:2,n:"Reader",m:"preset",c:1,w:0,g:6,h:5},
  ];
  const queries = cases.map(d => "?p=0&s="+encode(d)).concat("?p=0&b=abc123&n=Reader");
  for (const query of queries) {
    const res = await fetch(base+"/"+query);
    const html = await res.text();
    assert.match(html,/Reader/);
    assert.match(html,/noindex,follow/);
    assert.match(html,/og\.png\?/);
    assert.equal(res.headers.get("cache-control"),"private, no-store");
    const img = await fetch(base+"/og.png"+query);
    assert.equal(img.status,200);
    assert.equal(img.headers.get("content-type"),"image/png");
    const data = Buffer.from(await img.arrayBuffer());
    assert.equal(data.subarray(1,4).toString(),"PNG");
    assert.equal(data.readUInt32BE(16),1200);
    assert.equal(data.readUInt32BE(20),630);
  }
  assert.match(await (await fetch(base+"/")).text(),/Excerptle — guess the book/);
  assert.equal((await fetch(base+"/og.png?p=bad")).status,400);
  assert.equal((await fetch(base+"/missing-page")).status,404);
});
