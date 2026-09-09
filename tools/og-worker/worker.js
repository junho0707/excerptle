/* Front door for excerptle.io.

   `run_worker_first` in wrangler.jsonc points "/" at this script, so every
   first page load in a cold colo pays this Worker's startup cost. Keep it
   featherweight: no WASM, no fonts, no node polyfills. The share-card
   renderer needs all three, so it lives in its own Worker (render-worker.js)
   reached through the OG service binding — a separate isolate that only
   crawlers ever wake. */
import { shareFromUrl, unfurl } from "./share.js";

class Meta {
  constructor(content) { this.content = content; }
  element(el) { el.setAttribute("content", this.content); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/og.png") return env.OG.fetch(request);

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
};
