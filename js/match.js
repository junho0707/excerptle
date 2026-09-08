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
    s = s.replace(/\s+by\s+.+$/, "");
    return s;
  }

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

  function titlesOf(puzzle) {
    return [puzzle.title, ...(puzzle.aliases || [])].map(fold).filter(Boolean);
  }

  function isMatch(guess, puzzle) {
    const g = fold(guess);
    if (!g) return false;
    const gt = tokens(guess);
    if (!gt.length) return false;

    for (const t of titlesOf(puzzle)) {
      if (g === t) return true;
      if (close(g, t)) return true;

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
        if (w.length >= 6 && last.length >= 6 && close(w, last)) return true;
      }
    }
    return false;
  }

  return { fold, isMatch, tokens };
})();
