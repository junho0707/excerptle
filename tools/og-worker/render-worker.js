/* The share-card renderer, deliberately kept in its own Worker.

   This bundle carries ~2.5 MB of resvg WASM plus two TTFs. Cloudflare loads
   the whole script into the isolate on a cold start, so anything sitting in
   front of "/" pays that cost on the first hit in every colo — which is what
   used to make a first page load crawl. Only crawlers ever ask for /og.png,
   so the weight lives here and the front door (worker.js) stays tiny and
   reaches it over a service binding.

   Assets come over HTTP from SITE_URL rather than an ASSETS binding: a
   service-bound Worker has no access to the front door's bindings, and
   /puzzles/* and /assets/* are not run_worker_first, so the subrequest goes
   straight to the static asset server. */
import { shareFromUrl } from "./share.js";
import { cardSvg } from "./card.js";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import serif from "./fonts/DejaVuSerif.ttf";
import sans from "./fonts/DejaVuSans.ttf";

/* Per-isolate caches. Each one clears its own slot on failure, so a single
   bad fetch can't leave a rejected promise cached for the isolate's life. */
let ready;
let brandIcon;
let indexJson;

const siteUrl = (env, path) => new URL(path, env.SITE_URL || "https://excerptle.io").href;

async function toDataUri(response) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${response.headers.get("content-type") || "image/png"};base64,${btoa(binary)}`;
}

async function openingSentence(env, d, idx) {
  if (d.c || d.invite) return "";
  try {
    const { order, presetCount, dailyStartIndex } = await (indexJson ||=
      fetch(siteUrl(env, "/puzzles/index.json")).then((r) => r.json()));
    const presets = Math.min(presetCount || order.length, order.length);
    const day = idx - (dailyStartIndex ?? 600);
    const pool = order.length - presets;
    const slug = d.m === "daily"
      ? (pool > 0 ? order[presets + ((day % pool + pool) % pool)] : order[((day % order.length) + order.length) % order.length])
      : order[idx % presets];
    const puzzle = await (await fetch(siteUrl(env, `/puzzles/${slug}.json`))).json();
    return String(puzzle.texts?.[0] || "").replace(/\s+/g, " ").trim();
  } catch {
    // A cached index that failed to parse must not poison every later render.
    indexJson = undefined;
    return "";
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405 });
    const share = shareFromUrl(url);
    if (!share) return new Response("Invalid share", { status: 400 });

    const cache = caches.default;
    const cacheKey = new Request(url, { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) return request.method === "HEAD" ? new Response(null, cached) : cached;

    try { await (ready ||= initWasm(wasm)); } catch (err) { ready = undefined; throw err; }
    const [sentence, iconHref] = await Promise.all([
      openingSentence(env, share.d, share.idx),
      (brandIcon ||= fetch(siteUrl(env, "/assets/icon-192.png")).then(toDataUri))
        .catch(() => { brandIcon = undefined; return ""; }),
    ]);
    const renderer = new Resvg(cardSvg(share.d, share.idx, { openingSentence: sentence, iconHref }), {
      font: { fontBuffers: [new Uint8Array(serif), new Uint8Array(sans)], defaultFontFamily: "DejaVu Sans" },
    });
    let rendered;
    try {
      rendered = renderer.render();
      const response = new Response(rendered.asPng(), { headers: {
        "Content-Type": "image/png", "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      } });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return request.method === "HEAD" ? new Response(null, response) : response;
    } finally { rendered?.free(); renderer.free(); }
  },
};
