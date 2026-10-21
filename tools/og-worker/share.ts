/* Shared with js/app.js: the share payload format. Keep the two in step —
   `v` is bumped if the shape ever changes, and readShare() rejects anything
   it doesn't know. */
import type { PuzzleIndex, Puzzle, ReadJson } from "./types.ts";

export type Mode = "daily" | "battle" | "preset";

/* A decoded `s=` payload. `t`, `br`, `bn`, `or`, `on` are optional because
   hand-built shares (preview, tests) omit them; readShare always fills them. */
export interface ShareResult {
  invite?: false;
  c: 0 | 1;
  n: string;
  m: Mode;
  w: 0 | 1;
  g: number;
  h: number;
  t?: number;
  br?: number;
  bn?: number;
  or?: number;
  on?: number;
}

/* A `b=` battle invitation. It may carry stray score fields (the preview's
   examples do); nothing reads them. */
export interface Invite extends Partial<Omit<ShareResult, "invite" | "m" | "n">> {
  invite: true;
  m: "battle";
  n: string;
}

export type Share = ShareResult | Invite;

/* The parsed JSON before validation: anything at all. */
type RawShare = { [key: string]: unknown } | null;

export function readShare(raw: string | null): ShareResult | null {
  try {
    if (typeof raw !== "string" || raw.length > 2048) return null;
    const b = raw.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const d = JSON.parse(json) as RawShare;
    if (!d || !([1, 2] as unknown[]).includes(d.v)) return null;
    return {
      c: d.v === 1 ? 1 : d.c === 1 ? 1 : 0,
      n: String(d.n || "A player").slice(0, 24),
      m: d.m === "daily" || d.m === "battle" ? d.m : "preset",
      w: d.w ? 1 : 0,
      g: Math.min(Math.max(0, Number(d.g) | 0), 6),
      h: Math.min(Math.max(0, Number(d.h) | 0), 5),
      t: Math.max(0, Number(d.t) | 0),
      br: Math.max(0, Number(d.br) | 0), bn: Math.max(0, Number(d.bn) | 0),
      or: Math.max(0, Number(d.or) | 0), on: Math.max(0, Number(d.on) | 0),
    };
  } catch {
    return null;
  }
}

export const kindOf = (m: string): string => (m === "daily" ? "Daily" : m === "battle" ? "Battle" : "Question bank");

export function grid(d: ShareResult): { guesses: string; hints: string } {
  let g = "";
  for (let i = 0; i < 6; i++) g += i >= d.g ? "⬜" : (d.w && i === d.g - 1 ? "🟩" : "🟨");
  let h = "";
  for (let i = 0; i < 5; i++) h += i < d.h ? "💡" : "⬜";
  return { guesses: g, hints: h };
}

/* What the messaging app shows. Title carries the score, description carries
   the standings — deliberately never the book. */
export function unfurl(d: Share, idx: number): { title: string; description: string } {
  if (d.invite) return { title: `${d.n} invited you to an Excerptle battle`, description: "Same book. Head to head. First to guess wins. Join your friend’s room." };
  if (!d.c) return { title: `${d.n} is reading Excerptle ${kindOf(d.m)} #${idx}`, description: "Name the book from its opening lines. Six guesses, hints whenever you want them. Come and read it." };
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
    stand,
    // Older links still carry a d.t timing field; it is simply not shown.
    "Can you also guess the book?",
  ].filter(Boolean);
  return { title, description: parts.join("  ·  ") };
}

/* The opening sentence behind a share link, through whatever JSON reader the
   caller has. The render Worker cannot do this lookup itself: a subrequest
   from it to excerptle.io/puzzles is a Worker reaching another Worker on the
   same zone, which Cloudflare refuses — so the front door, which holds the
   ASSETS binding, resolves it and passes the sentence along. */
export async function openingSentenceFor(readJson: ReadJson, d: Share, idx: number): Promise<string> {
  if (d.c || d.invite) return "";
  const { order, presetCount, dailyStartIndex } = await readJson("/puzzles/index.json") as PuzzleIndex;
  const presets = Math.min(presetCount || order.length, order.length);
  const day = idx - (dailyStartIndex ?? 600);
  const pool = order.length - presets;
  const slug = d.m === "daily"
    ? (pool > 0 ? order[presets + ((day % pool + pool) % pool)] : order[((day % order.length) + order.length) % order.length])
    : order[idx % presets];
  const puzzle = await readJson(`/puzzles/${slug}.json`) as Puzzle;
  // A name the puzzle redacts is written {{him}}; the card shows it the way
  // the game does rather than printing the braces.
  return String(puzzle.texts?.[0] || "")
    .replace(/\{\{([^{}]+)\}\}/g, "($1)")
    .replace(/\s+/g, " ")
    .trim();
}

export function shareFromUrl(url: URL): { idx: number; d: Share } | null {
  const raw = url.searchParams.get("p");
  if (raw === null || !/^\d{1,8}$/.test(raw)) return null;
  const idx = Number(raw);
  const code = url.searchParams.get("b");
  if (code && /^[a-z0-9-]{1,32}$/i.test(code)) {
    return { idx, d: { invite: true, m: "battle", n: (url.searchParams.get("n") || "A friend").slice(0, 24) } };
  }
  const d = readShare(url.searchParams.get("s"));
  return d ? { idx, d } : null;
}
