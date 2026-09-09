/* Shared with js/app.js: the share payload format. Keep the two in step —
   `v` is bumped if the shape ever changes, and readShare() rejects anything
   it doesn't know. */

export function readShare(raw) {
  try {
    const b = String(raw).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const d = JSON.parse(json);
    if (!d || d.v !== 1) return null;
    return {
      n: String(d.n || "A player").slice(0, 24),
      m: d.m === "daily" || d.m === "battle" ? d.m : "preset",
      w: d.w ? 1 : 0,
      g: Math.min(Math.max(0, d.g | 0), 6),
      h: Math.min(Math.max(0, d.h | 0), 5),
      t: Math.max(0, d.t | 0),
      br: Math.max(0, d.br | 0), bn: Math.max(0, d.bn | 0),
      or: Math.max(0, d.or | 0), on: Math.max(0, d.on | 0),
    };
  } catch {
    return null;
  }
}

const kindOf = (m) => (m === "daily" ? "Daily" : m === "battle" ? "Battle" : "Book");

export function grid(d) {
  let g = "";
  for (let i = 0; i < 6; i++) g += i >= d.g ? "⬜" : (d.w && i === d.g - 1 ? "🟩" : "🟨");
  let h = "";
  for (let i = 0; i < 5; i++) h += i < d.h ? "💡" : "⬜";
  return { guesses: g, hints: h };
}

export function fmtTime(sec) {
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, "0")}s`;
}

/* What the messaging app shows. Title carries the score, description carries
   the standings — deliberately never the book. */
export function unfurl(d, idx) {
  const score = d.w ? `${d.g}/6` : `X/6`;
  const hintWord = `${d.h} hint${d.h === 1 ? "" : "s"}`;
  const title = `${d.n} — Excerptle ${kindOf(d.m)} #${idx} ${score} · ${hintWord}`;
  const stand = [
    d.br ? `#${d.br} of ${d.bn} at ${hintWord}` : "",
    d.or ? `#${d.or} of ${d.on} overall` : "",
  ].filter(Boolean).join(" · ");
  const { guesses, hints } = grid(d);
  const parts = [
    `${guesses} ${hints}`,
    d.t ? fmtTime(d.t) : "",
    stand,
    d.w ? "Can you do better?" : "Can you solve it?",
  ].filter(Boolean);
  return { title, description: parts.join("  ·  ") };
}
