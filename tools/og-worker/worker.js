/* Excerptle share unfurls.
 *
 * excerptle.io is a static site, so a share link has no per-link <meta> for a
 * crawler to read — every URL returns the same index.html and every preview
 * looks identical. This Worker sits in front of the origin and rewrites the
 * OG/Twitter tags from the `?s=` payload the client puts in the link.
 *
 * Deploy: see tools/og-worker/README.md. Everything except the rewrite is a
 * pass-through, so the game keeps working if this is removed.
 */
import { readShare, unfurl } from "./share.js";

const ORIGIN = "https://junho0707.github.io/excerptle";

class Meta {
  constructor(content) { this.content = content; }
  element(el) { el.setAttribute("content", this.content); }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const share = url.searchParams.get("s");
    const idx = parseInt(url.searchParams.get("p") || "", 10);

    const upstream = new URL(url.pathname + url.search, env.ORIGIN || ORIGIN);
    const res = await fetch(upstream, request);

    const isHtml = (res.headers.get("content-type") || "").includes("text/html");
    if (!share || !idx || !isHtml) return res;

    const d = readShare(share);
    if (!d) return res;

    const { title, description } = unfurl(d, idx);
    const img = new URL(env.OG_IMAGE || "/assets/og.png", url.origin).toString();

    return new HTMLRewriter()
      .on('meta[property="og:title"]', new Meta(title))
      .on('meta[name="twitter:title"]', new Meta(title))
      .on('meta[property="og:description"]', new Meta(description))
      .on('meta[name="twitter:description"]', new Meta(description))
      .on('meta[name="description"]', new Meta(description))
      .on('meta[property="og:url"]', new Meta(url.toString()))
      .on('meta[property="og:image"]', new Meta(img))
      .on('meta[name="twitter:image"]', new Meta(img))
      .transform(res);
  },
};
