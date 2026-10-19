/* The share-card renderer, deliberately kept in its own Worker.

   This bundle carries ~2.5 MB of resvg WASM plus two TTFs. Cloudflare loads
   the whole script into the isolate on a cold start, so anything sitting in
   front of "/" pays that cost on the first hit in every colo — which is what
   used to make a first page load crawl. Only crawlers ever ask for /og.png,
   so the weight lives here and the front door (worker.ts) stays tiny and
   reaches it over a service binding.

   It fetches nothing at runtime: a subrequest from here to excerptle.io is a
   Worker reaching another Worker on the same zone, which Cloudflare refuses,
   so the brand icon is bundled and the opening sentence arrives on the
   request from the front door, which does hold the ASSETS binding. */
import { shareFromUrl } from "./share.ts";
import { cardSvg } from "./card.ts";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import wasm from "@resvg/resvg-wasm/index_bg.wasm";
import serif from "./fonts/DejaVuSerif.ttf";
import sans from "./fonts/DejaVuSans.ttf";
import icon from "../../assets/icon-192.png";

/* Per-isolate. `ready` clears its own slot on failure so a single bad init
   can't leave a rejected promise cached for the isolate's life. */
let ready: Promise<void> | undefined;
let iconHref: string | undefined;

/* Bumped whenever the card's rendering changes, so a fix is not hidden behind
   a day of images cached from the version before it. */
const CARD_VERSION = "2";

function brandIcon(): string {
  if (iconHref === undefined) {
    const bytes = new Uint8Array(icon);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    iconHref = `data:image/png;base64,${btoa(binary)}`;
  }
  return iconHref;
}

function sentenceFrom(request: Request): string {
  try {
    return decodeURIComponent(request.headers.get("X-Opening-Sentence") || "");
  } catch {
    return "";
  }
}

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405 });
    const share = shareFromUrl(url);
    if (!share) return new Response("Invalid share", { status: 400 });

    const cache = caches.default;
    const cacheUrl = new URL(url);
    cacheUrl.searchParams.set("cv", CARD_VERSION);
    const cacheKey = new Request(cacheUrl, { method: "GET" });
    const cached = await cache.match(cacheKey);
    if (cached) return request.method === "HEAD" ? new Response(null, cached) : cached;

    try { await (ready ||= initWasm(wasm)); } catch (err) { ready = undefined; throw err; }
    const renderer = new Resvg(cardSvg(share.d, share.idx, {
      openingSentence: sentenceFrom(request), iconHref: brandIcon(),
    }), {
      font: { fontBuffers: [new Uint8Array(serif), new Uint8Array(sans)], defaultFontFamily: "DejaVu Sans" },
    });
    let rendered: ReturnType<InstanceType<typeof Resvg>["render"]> | undefined;
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
} satisfies ExportedHandler;
