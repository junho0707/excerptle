/* Generous but not dumb title matching. */
window.BookleMatch = (() => {
  const STOP = new Set([
    "the", "a", "an", "of", "and", "or", "to", "in", "on", "at", "for",
    "from", "with", "by", "vs", "via", "de", "la", "le", "el", "und",
  ]);

  function fold(s) {
    s = String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    while (/^(the|a|an)\s+/.test(s)) s = s.replace(/^(the|a|an)\s+/, "");
    return s;
  }

  /* "…by F. Scott Fitzgerald" is something a player types, not part of a
     title. Dropping it is a guess-side allowance only: applied to titles it
     would turn "Won By the Sword" into "won" and "Stories by English
     Authors: The Sea" into "stories". */
  function stripAuthor(folded) {
    return folded.replace(/\s+by\s+.+$/, "").trim();
  }

  /* Words that can end a title without identifying it. The one-word shortcut
     ("gatsby", "karenina") must never fire on these, or "complete" would
     solve "Richard Carvel — Complete" and "romance" half the shelf. */
  const GENERIC = new Set([
    "complete", "unabridged", "illustrated", "annotated", "edition",
    "volume", "volumes", "part", "parts", "chapter", "chapters",
    "novel", "romance", "story", "stories", "tale", "tales",
    "memoir", "memoirs", "adventure", "adventures", "sequel",
  ]);
  // These are real title words, but are too broad to confirm that a player is
  // on the right book by themselves.  We do not turn a wild "great" or
  // "story" guess into free answer information.
  const VAGUE = new Set([
    ...GENERIC, "great", "little", "old", "new", "good", "bad", "life",
    "death", "world", "house", "man", "woman", "boy", "girl", "book",
    "history", "love", "war", "time", "day", "night", "way",
  ]);

  function tokens(s) {
    return fold(s).split(" ").filter((w) => w && !STOP.has(w));
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const v0 = Array.from({ length: b.length + 1 }, (_, i) => i);
    const v1 = new Array(b.length + 1);
    for (let i = 0; i < a.length; i++) {
      v1[0] = i + 1;
      for (let j = 0; j < b.length; j++) {
        const cost = a[i] === b[j] ? 0 : 1;
        v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
      }
      for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
    }
    return v1[b.length];
  }

  function budget(n) {
    if (n < 5) return 0;
    if (n < 8) return 1;
    return Math.max(1, Math.floor(n / 6));
  }

  function close(a, b) {
    const n = Math.max(a.length, b.length);
    return levenshtein(a, b) <= budget(n);
  }

  /* Gutenberg titles carry packaging the reader never sees on a spine:
     "— Complete", "Part 4.", "Volume I", "Junior Deluxe Edition". Nobody
     should have to type those, and the reveal shouldn't show them either. */
  const EDITION_TAILS = [
    // "(Complete)", "[Illustrated]", "(1853-1910)"
    /\s*[([](?:complete|unabridged|illustrated|annotated)[^)\]]*[)\]]\s*$/i,
    /\s*\(\s*\d{4}\s*(?:[-–—]\s*\d{4}\s*)?\)\s*$/,
    // "— Complete", ", Complete.", ": Unabridged"
    /(?:[—–,.;:]|\s[-]|\s)\s*(?:complete|unabridged|illustrated|annotated)\s*\.?\s*$/i,
    // ". Junior Deluxe Edition", "— Author's Edition"
    /[—–,.;:]\s*[^,.;:—–]*\bedition\b\s*\.?\s*$/i,
    // ", Part 4.", "- Part 1", ". Volume I, Part 1: 1835-1866", ", Chapters 01 to 05"
    /(?:[—–,.;:]|\s[-])\s*(?:vol(?:ume|s?\.)?|pt\.?|parts?|chapters?)\s+[\divxlcdm][\s\S]*$/i,
  ];

  // Strip packaging, repeatedly — "Mark Twain's Letters — Complete (1853-1910)"
  // needs two passes.
  function stripEdition(title) {
    let t = String(title || "").trim();
    for (let pass = 0; pass < 4; pass++) {
      const before = t;
      for (const re of EDITION_TAILS) t = t.replace(re, "").trim();
      if (t === before) break;
      // Only tidy the seam a strip left behind — an untouched title keeps its
      // own punctuation ("The Cruise of the Jasper B.").
      t = t.replace(/[\s.,;:—–-]+$/, "").trim();
    }
    return t || String(title || "").trim();
  }

  /* Where a subtitle begins. Deliberately narrow: a colon, a semicolon, a
     *spaced* dash, the Victorian "; Or," convention, or ", and Other Stories".
     A bare comma is not a separator — "The Life, Adventures & Piracies of…"
     must not collapse to "The Life". */
  const SUBTITLE = /(?::|;|\s[—–]\s|\s--?\s|,\s*or[,\s]|,\s*and\s+other\s)/i;

  function mainTitle(title) {
    const m = SUBTITLE.exec(title);
    if (!m || m.index <= 0) return "";
    const head = title.slice(0, m.index).replace(/[\s.,;:—–-]+$/, "").trim();
    // A head has to still be a title, not a leftover article.
    return tokens(head).length ? head : "";
  }

  /* Full titles the answer may take. Each is matched whole by isMatch, so a
     guess still has to cover every token of one of them — "The Adventures"
     never satisfies "The Adventures of Tom Sawyer". */
  function variants(title) {
    const out = [];
    const push = (t) => {
      const f = fold(t);
      if (f && f.length >= 3 && !out.includes(f)) out.push(f);
    };
    push(title);
    const bare = stripEdition(title);
    push(bare);
    push(mainTitle(bare));
    push(mainTitle(title));
    return out;
  }

  function titlesOf(puzzle) {
    const out = [];
    for (const t of [puzzle.title, ...(puzzle.aliases || [])]) {
      for (const v of variants(t)) if (!out.includes(v)) out.push(v);
    }
    return out;
  }

  function isMatch(guess, puzzle) {
    const g = fold(guess);
    if (!g) return false;
    const gt = tokens(guess);
    if (!gt.length) return false;
    // Try the guess as typed and with a trailing "by <author>" removed.
    const forms = [g];
    const noAuthor = stripAuthor(g);
    if (noAuthor && noAuthor !== g) forms.push(noAuthor);

    for (const t of titlesOf(puzzle)) {
      if (forms.some((f) => f === t || close(f, t))) return true;

      const tt = t.split(" ").filter((w) => w && !STOP.has(w));
      if (!tt.length) continue;

      // All title tokens present (author extras allowed).
      if (tt.every((w) => gt.some((x) => x === w || (w.length >= 5 && close(x, w))))) {
        return true;
      }

      // Single distinctive token: last content word, length >= 6 (Gatsby, Karenina)
      // not a short generic first word (great, tale, call).
      if (gt.length === 1) {
        const w = gt[0];
        if (tt.length === 1 && close(w, tt[0])) return true;
        const last = tt[tt.length - 1];
        if (GENERIC.has(last) || GENERIC.has(w)) continue;
        if (w.length >= 6 && last.length >= 6 && close(w, last)) return true;
      }
    }
    return false;
  }

  /* A non-spoiling nudge for an incomplete title.  It reports only the number
     of meaningful words still needed, never which ones or where they belong. */
  function partialMatch(guess, puzzle) {
    const g = tokens(stripAuthor(fold(guess)));
    if (!g.length) return null;
    let best = null;
    for (const title of titlesOf(puzzle)) {
      const target = title.split(" ").filter((w) => w && !STOP.has(w));
      if (target.length < 2) continue;
      const matched = target.filter((w) => g.some((x) => x === w || (w.length >= 5 && close(x, w))));
      const distinctive = matched.some(w => w.length >= 4 && !VAGUE.has(w));
      if (!distinctive || !matched.length || matched.length >= target.length) continue;
      const candidate = { matched: matched.length, missing: target.length - matched.length };
      if (!best || candidate.matched > best.matched || (candidate.matched === best.matched && candidate.missing < best.missing)) best = candidate;
    }
    return best;
  }

  return { fold, isMatch, partialMatch, tokens, stripEdition, variants };
})();
