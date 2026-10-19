/* The /archive pages and the sitemap, rendered at the edge from
   puzzles/*.json plus content/archive-notes.json.

   Everything here is pure given (env.ASSETS, notes, now), so the tests drive it
   with a fake ASSETS and a fixed clock. */

const ORIGIN = "https://excerptle.io";
/* The daily rolls over at midnight Pacific. Same zone and formatter as
   gameDate() in js/app.js — keep the two in step. en-CA gives YYYY-MM-DD. */
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
});
export const gameDate = (d = new Date()) => dayFormatter.format(d);
const daysBetween = (a, b) =>
  Math.floor((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
const longDate = (iso) =>
  new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/* JSON-LD lives inside a <script>; "<" must not be able to close it. */
const ldJson = (o) => JSON.stringify(o).replace(/</g, "\\u003c");

/* Mirrors dailyIndexNow() in js/app.js (without its Math.max(0, ...) floor:
   before launch nothing is published, which is what we want here). */
export function todayIndex(index, now = new Date()) {
  return (index.dailyStartIndex ?? 600) + daysBetween(index.startDate, gameDate(now));
}

/* Mirrors slugForIndex() for dailies: they come from the tail of `order`. */
export function dailySlug(index, n) {
  const { order } = index;
  const base = index.dailyStartIndex ?? 600;
  const presets = Math.min(index.presetCount || order.length, order.length);
  const day = n - base;
  const pool = order.length - presets;
  return pool > 0 ? order[presets + (((day % pool) + pool) % pool)] : order[((day % order.length) + order.length) % order.length];
}

/* Published = a daily strictly before today's game date that has a note. */
export function publishedIndices(index, notes, now = new Date()) {
  const base = index.dailyStartIndex ?? 600;
  const today = todayIndex(index, now);
  const out = [];
  for (let n = base; n < today; n++) if (hasNote(notes, n)) out.push(n);
  return out;
}
const hasNote = (notes, n) => typeof notes[String(n)] === "string" && notes[String(n)].trim() !== "";

const metaCache = new Map();
async function readJson(env, path) {
  const res = await env.ASSETS.fetch(new Request(new URL(path, ORIGIN)));
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}
async function puzzleFor(env, slug) {
  let p = metaCache.get(slug);
  if (!p) {
    p = readJson(env, `/puzzles/${slug}.json`).catch((e) => { metaCache.delete(slug); throw e; });
    metaCache.set(slug, p);
  }
  return p;
}

/* The opening paragraph(s): the first paragraph, plus following ones while it
   is still a fragment ("TOM!"). Redaction braces are dropped. */
export function openingText(puzzle) {
  const paras = String(puzzle.openingExcerpt || puzzle.texts?.[0] || "")
    .replace(/\{\{([^{}]+)\}\}/g, "$1").split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const out = [];
  let len = 0;
  for (const p of paras) {
    if (out.length && len >= 160) break;
    out.push(p); len += p.length;
    if (out.length >= 3) break;
  }
  return out;
}

const LAYOUT_HEAD = (title, desc, canonical, extraHead) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${esc(canonical)}">
  <meta name="theme-color" content="#f4efe4">
  <meta name="robots" content="index,follow">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="Excerptle">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="${esc(canonical)}">
  <meta property="og:image" content="${ORIGIN}/assets/og.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${ORIGIN}/assets/og.png">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/png" sizes="32x32" href="/assets/icon-32.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/assets/icon-180.png">
  <link rel="manifest" href="/site.webmanifest">
  <meta name="google-adsense-account" content="ca-pub-2005015845685746">
  <link rel="stylesheet" href="/css/app.css">
  <style>
    .arch-crumbs { font-size: 0.85rem; color: var(--ink-soft); margin: 0 0 0.6rem; }
    .arch-crumbs a { color: inherit; }
    .arch-facts { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 1rem 0 1.4rem; }
    .arch-facts dt { color: var(--ink-soft); font-size: 0.8rem; letter-spacing: 0.06em; text-transform: uppercase; align-self: baseline; }
    .arch-facts dd { margin: 0; }
    .arch-opening { margin: 1.2rem 0; padding: 0.2rem 0 0.2rem 1.1rem; border-left: 3px solid var(--ink-soft); }
    .arch-opening p { font-family: Georgia, "Times New Roman", serif; font-size: 1.08rem; line-height: 1.6; }
    .arch-list { list-style: none; padding: 0; margin: 1rem 0; }
    .arch-list li { padding: 0.55rem 0; border-bottom: 1px solid color-mix(in srgb, var(--ink-soft) 25%, transparent); }
    .arch-list .n { color: var(--ink-soft); font-size: 0.85rem; display: block; }
    .arch-pager { display: flex; justify-content: space-between; gap: 1rem; margin: 1.6rem 0 0; }
  </style>
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-2005015845685746"
          crossorigin="anonymous"></script>
  <script type="application/ld+json">${extraHead}</script>
</head>
<body>
  <div class="app">
    <header class="top">
      <a class="brand" href="/" aria-label="Excerptle home">
        <img class="brand-mark" src="/assets/icon-192.png" width="36" height="36" alt="" decoding="async">
        <span class="brand-words">
          <strong>EXCERPTLE</strong>
          <span>Guess the book</span>
        </span>
      </a>
      <div class="nav-right">
        <a class="tab signin" id="auth-tab" href="/#/signin">Sign in</a>
        <button type="button" class="nav-toggle" id="nav-toggle" data-act="toggle-nav"
                aria-expanded="false" aria-controls="main-nav" aria-label="Menu">
          <span class="nav-bars" aria-hidden="true"></span>
        </button>
      </div>
      <nav class="tabs" id="main-nav" aria-label="Main">
        <a class="tab" href="/#/new">New game</a>
        <a class="tab" href="/how-to-play">How to play</a>
        <a class="tab" href="/#/bank">All books</a>
        <a class="tab" href="/archive">Archive</a>
        <a class="tab" href="/#/stats">Stats</a>
        <a class="tab" href="/#/settings">Settings</a>
      </nav>
    </header>
`;

const LAYOUT_FOOT = `
    <footer>
      <nav class="footer-links" aria-label="Footer">
        <a href="/">Play</a>
        <a href="/how-to-play">How to play</a>
        <a href="/faq">FAQ</a>
        <a href="/archive">Archive</a>
        <a href="/about">About</a>
        <a href="/#/news">News</a>
        <a href="/privacy">Privacy &amp; terms</a>
      </nav>
      __SOCIAL__
      <p class="footer-note">Public-domain excerpts &middot; not affiliated with Project Gutenberg</p>
    </footer>
  </div>
  <script src="/js/share-page.js" defer></script>
</body>
</html>
`;

const crumbsLd = (items) => ({
  "@type": "BreadcrumbList",
  itemListElement: items.map(([name, item], i) => ({ "@type": "ListItem", position: i + 1, name, item })),
});

function html(body, { maxAge, status = 200 }) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Short: the index changes at midnight Pacific and a note may be edited.
      "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
const notFound = () => new Response("Not found", {
  status: 404,
  headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=60, s-maxage=60", "X-Robots-Tag": "noindex" },
});

function renderIndex(rows) {
  const title = "Archive of past Excerptle puzzles";
  const desc = `Every past daily Excerptle puzzle with the book's opening, its context and a short note on why the opening works. ${rows.length} books so far.`;
  const canonical = `${ORIGIN}/archive`;
  const ld = ldJson({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "CollectionPage", "@id": canonical, url: canonical, name: title, description: desc, isPartOf: { "@id": `${ORIGIN}/#website` } },
      crumbsLd([["Excerptle", `${ORIGIN}/`], ["Archive", canonical]]),
    ],
  });
  const items = rows.map((r) => `        <li><a href="/archive/${r.n}"><strong>${esc(r.title)}</strong></a> &mdash; ${esc(r.author)}, ${esc(r.year)}<span class="n">#${r.n} &middot; ${esc(longDate(r.date))}</span></li>`).join("\n");
  return LAYOUT_HEAD(title, desc, canonical, ld) + `
    <main class="screen prose">
      <nav class="arch-crumbs" aria-label="Breadcrumb"><a href="/">Excerptle</a> &rsaquo; Archive</nav>
      <h1 class="screen-title">Archive</h1>
      <p class="lede">Each day Excerptle opens a public-domain book at its first lines and gives you six guesses. Once a day is over, it lands here: the opening, a few facts, a link to read the whole book for free, and a short note on what the opening is doing. Today&rsquo;s puzzle is never listed.</p>
      ${rows.length ? `<ol class="arch-list" reversed>\n${items}\n      </ol>` : "<p>The first entries will appear here once their day is over.</p>"}
      <p class="prose-cta"><a class="btn" href="/">Play today&rsquo;s puzzle</a></p>
    </main>
` + LAYOUT_FOOT;
}

function renderEntry(e, prev, next) {
  const { n, date, puzzle: p, note } = e;
  const title = `${p.title} by ${p.author} (${p.year}): the opening, explained | Excerptle #${n}`;
  const first = openingText(p);
  const noteText = note.trim();
  const desc = (noteText.length > 155 ? noteText.slice(0, noteText.lastIndexOf(" ", 155)) + "…" : noteText);
  const canonical = `${ORIGIN}/archive/${n}`;
  const ld = ldJson({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article", "@id": canonical, url: canonical,
        headline: `${p.title} by ${p.author}: the opening`,
        description: desc,
        datePublished: addDays(date, 1), dateModified: addDays(date, 1),
        inLanguage: "en",
        author: { "@type": "Organization", name: "Excerptle", url: `${ORIGIN}/` },
        publisher: { "@type": "Organization", name: "Provable Learning LLC" },
        mainEntityOfPage: canonical,
        isPartOf: { "@id": `${ORIGIN}/#website` },
        about: {
          "@type": "Book", name: p.title, author: { "@type": "Person", name: p.author },
          datePublished: String(p.year), genre: p.genre, url: p.source?.url,
        },
      },
      crumbsLd([["Excerptle", `${ORIGIN}/`], ["Archive", `${ORIGIN}/archive`], [p.title, canonical]]),
    ],
  });
  const paras = noteText.split(/\n\s*\n/).map((t) => `      <p>${esc(t.replace(/\s+/g, " ").trim())}</p>`).join("\n");
  const pager = (prev || next) ? `      <nav class="arch-pager" aria-label="More puzzles">
        <span>${prev ? `<a href="/archive/${prev}" rel="prev">&larr; #${prev}</a>` : ""}</span>
        <span>${next ? `<a href="/archive/${next}" rel="next">#${next} &rarr;</a>` : ""}</span>
      </nav>\n` : "";
  return LAYOUT_HEAD(title, desc, canonical, ld) + `
    <main class="screen prose">
      <nav class="arch-crumbs" aria-label="Breadcrumb"><a href="/">Excerptle</a> &rsaquo; <a href="/archive">Archive</a> &rsaquo; #${n}</nav>
      <h1 class="screen-title">${esc(p.title)}</h1>
      <p class="lede">${esc(p.author)} &middot; Excerptle #${n}, ${esc(longDate(date))}</p>
      <dl class="arch-facts">
        <dt>Author</dt><dd>${esc(p.author)}</dd>
        <dt>Published</dt><dd>${esc(p.year)}</dd>
        <dt>Genre</dt><dd>${esc(p.genre)}</dd>
        <dt>Setting</dt><dd>${esc(p.setting)}</dd>
      </dl>
      <h2>The opening</h2>
      <blockquote class="arch-opening">
${first.map((t) => `        <p>${esc(t)}</p>`).join("\n")}
      </blockquote>
      <h2>About this opening</h2>
${paras}
      <p class="prose-cta">
        <a class="btn" href="${esc(p.source?.url || "https://www.gutenberg.org/")}" target="_blank" rel="noopener noreferrer">Read the full book</a>
        <a class="btn ghost" href="/?p=${n}">Play this one</a>
      </p>
${pager}    </main>
` + LAYOUT_FOOT;
}

const withSocial = (s, social) => s.replace("__SOCIAL__", () => social);
const SOCIAL = `<nav class="social" aria-label="Excerptle on social media">
        <a href="https://www.instagram.com/excerptle.io/" target="_blank" rel="noopener noreferrer" aria-label="Excerptle on Instagram"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162zM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439z"/></svg></a>
        <a href="https://www.facebook.com/people/Excerptleio/61594058471633/" target="_blank" rel="noopener noreferrer" aria-label="Excerptle on Facebook"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z"/></svg></a>
        <a href="https://discord.gg/JG37PHzkW" target="_blank" rel="noopener noreferrer" aria-label="Excerptle on Discord"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg></a>
        <a href="https://www.tiktok.com/@excerptle.io" target="_blank" rel="noopener noreferrer" aria-label="Excerptle on TikTok"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg></a>
        <a href="https://x.com/provablelearnin" target="_blank" rel="noopener noreferrer" aria-label="Provable Learning on X"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg></a>
        <a href="https://www.youtube.com/@provablelearningllc" target="_blank" rel="noopener noreferrer" aria-label="Provable Learning on YouTube"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg></a>
      </nav>`;

/* Returns a Response for /archive and /archive/<n>, or null if the path is not
   ours. `meta` is content/archive-index.json (title/author/year per entry):
   with it the list costs no subrequests; without it each row fetches its
   puzzle, which only the tests rely on. */
export async function handleArchive(request, env, notes, now = new Date(), meta = null) {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/archive(?:\/([^/]*))?\/?$/);
  if (!m) return null;
  if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  let index;
  try { index = await readJson(env, "/puzzles/index.json"); } catch { return new Response("Unavailable", { status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store" } }); }
  const base = index.dailyStartIndex ?? 600;
  const published = publishedIndices(index, notes, now);

  let res;
  if (m[1] === undefined || m[1] === "") {
    const rows = (await Promise.all(published.map(async (n) => {
      try {
        const p = meta?.[String(n)] || await puzzleFor(env, dailySlug(index, n));
        return { n, date: addDays(index.startDate, n - base), title: p.title, author: p.author, year: p.year };
      } catch { return null; }
    }))).filter(Boolean).reverse();
    res = html(withSocial(renderIndex(rows), SOCIAL), { maxAge: 300 });
  } else {
    if (!/^[1-9]\d{0,5}$/.test(m[1])) return notFound();
    const n = Number(m[1]);
    const at = published.indexOf(n);
    if (at < 0) return notFound();
    let puzzle;
    try { puzzle = await puzzleFor(env, dailySlug(index, n)); } catch { return notFound(); }
    const page = renderEntry({ n, date: addDays(index.startDate, n - base), puzzle, note: notes[String(n)] }, published[at - 1], published[at + 1]);
    res = html(withSocial(page, SOCIAL), { maxAge: 3600 });
  }
  return request.method === "HEAD" ? new Response(null, res) : res;
}

/* /sitemap.xml: the static file stays the source of the fixed URLs (so the
   site's other agents edit one familiar file); this splices in /archive and the
   published entries, which change daily. */
export async function handleSitemap(request, env, notes, now = new Date()) {
  const staticRes = await env.ASSETS.fetch(request);
  if (!staticRes.ok) return staticRes;
  let index;
  try { index = await readJson(env, "/puzzles/index.json"); } catch { return staticRes; }
  const base = index.dailyStartIndex ?? 600;
  const published = publishedIndices(index, notes, now);
  const entry = (loc, lastmod, freq, prio) =>
    `  <url>\n    <loc>${esc(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${freq}</changefreq>\n    <priority>${prio}</priority>\n  </url>\n`;
  let extra = entry(`${ORIGIN}/archive`, gameDate(now), "daily", "0.8");
  // An entry only changes when its note does; the day after its puzzle is the honest date.
  for (const n of published) extra += entry(`${ORIGIN}/archive/${n}`, addDays(index.startDate, n - base + 1), "yearly", "0.6");
  const xml = (await staticRes.text()).replace("</urlset>", () => extra + "</urlset>");
  return new Response(xml, {
    headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=300, s-maxage=300" },
  });
}
