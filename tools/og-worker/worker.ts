/* Front door for excerptle.io.

   `run_worker_first` in wrangler.jsonc points "/" at this script, so every
   first page load in a cold colo pays this Worker's startup cost. Keep it
   featherweight: no WASM, no fonts, no node polyfills. The share-card
   renderer needs all three, so it lives in its own Worker (render-worker.ts)
   reached through the OG service binding — a separate isolate that only
   crawlers ever wake. */
import notes from "../../content/archive-notes.json";
import archiveIndex from "../../content/archive-index.json";
import { handleArchive, handleSitemap } from "./archive.ts";
import { openingSentenceFor, shareFromUrl, unfurl } from "./share.ts";
import type { Env, ReadJson } from "./types.ts";

/* Per-isolate, and cleared on failure so one bad parse can't poison the
   isolate for its whole life. Only /og.png ever touches it. */
let puzzleIndex: Promise<unknown> | undefined;

function jsonReader(env: Env, origin: string): ReadJson {
  const get = async (path: string): Promise<unknown> => {
    const res = await env.ASSETS.fetch(new Request(new URL(path, origin)));
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
  };
  return async (path: string) => {
    if (!path.endsWith("/index.json")) return get(path);
    try { return await (puzzleIndex ||= get(path)); }
    catch (err) { puzzleIndex = undefined; throw err; }
  };
}

class Meta implements HTMLRewriterElementContentHandlers {
  content: string;
  constructor(content: string) { this.content = content; }
  element(el: Element) { el.setAttribute("content", this.content); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // The card renderer has no ASSETS binding and cannot fetch this zone, so
    // the sentence it prints is looked up here and handed over on the request.
    if (url.pathname === "/og.png") {
      const share = shareFromUrl(url);
      let sentence = "";
      try {
        if (share) sentence = await openingSentenceFor(jsonReader(env, url.origin), share.d, share.idx);
      } catch {
        // A card without its sentence still renders; the fallback line covers it.
      }
      const headers = new Headers(request.headers);
      // Headers are latin-1; openings are not.
      if (sentence) headers.set("X-Opening-Sentence", encodeURIComponent(sentence));
      else headers.delete("X-Opening-Sentence");
      return env.OG.fetch(new Request(url, { method: request.method, headers }));
    }

    if (url.pathname === "/sitemap.xml") return handleSitemap(request, env, notes);
    if (url.pathname === "/archive" || url.pathname.startsWith("/archive/")) {
      const archived = await handleArchive(request, env, notes, new Date(), archiveIndex);
      if (archived) return archived;
    }

    const res = await env.ASSETS.fetch(request);
    // The overwhelmingly common case: a person opening the site. Nothing to
    // rewrite, so hand the static asset straight back.
    const share = shareFromUrl(url);
    if (!share || !["/", "/index.html"].includes(url.pathname) || !res.ok
      || !(res.headers.get("content-type") || "").includes("text/html")) return res;

    const { title, description } = unfurl(share.d, share.idx);
    const img = new URL("/og.png", url.origin);
    img.search = url.search;
    img.searchParams.set("card", "1");
    const rewriter = new HTMLRewriter();
    for (const [selector, content] of [
      ['meta[property="og:title"], meta[name="twitter:title"]', title],
      ['meta[property="og:description"], meta[name="twitter:description"], meta[name="description"]', description],
      ['meta[property="og:url"]', url.href],
      ['meta[property="og:image"], meta[name="twitter:image"]', img.href],
      ['meta[property="og:image:alt"]', title],
      ['meta[name="robots"]', "noindex,follow"],
    ]) rewriter.on(selector, new Meta(content));
    const response = rewriter.transform(res);
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.delete("etag");
    return response;
  },
} satisfies ExportedHandler<Env>;
