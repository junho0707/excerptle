import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fold(s) {
  s = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  while (/^(the|a|an)\s+/.test(s)) s = s.replace(/^(the|a|an)\s+/, "");
  return s.replace(/\s+by\s+.+$/, "");
}

function levenshtein(a, b) {
  if (a === b) return 0;
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

function isMatch(guess, puzzle) {
  const g = fold(guess);
  if (!g) return false;
  const titles = new Set([puzzle.title, ...(puzzle.aliases || [])].map(fold));
  for (const t of titles) {
    if (!t) continue;
    if (g === t) return true;
    const n = Math.max(t.length, g.length);
    if (n < 5) continue;
    const budget = Math.max(1, Math.floor(n / 8));
    if (levenshtein(g, t) <= budget) return true;
  }
  return false;
}

// The curated b*.json puzzles are gone: every book is a Gutenberg id now, so
// the test runs over whatever index.json actually ships. It used to filter for
// b\d+ and silently passed on zero files.
const index = JSON.parse(readFileSync(join(root, "puzzles", "index.json"), "utf8"));
const files = index.order.map((slug) => `${slug}.json`);
let fail = 0;
for (const f of files) {
  const p = JSON.parse(readFileSync(join(root, "puzzles", f), "utf8"));
  const tries = [
    p.title,
    p.title.toUpperCase(),
    `The ${p.title}`,
    `${p.title} by ${p.author}`,
    ...(p.aliases || []),
  ];
  for (const t of tries) {
    if (!isMatch(t, p)) {
      console.error("should match", p.id, t);
      fail++;
    }
  }
  if (isMatch("Totally Fake Book Title", p)) {
    console.error("false positive", p.id);
    fail++;
  }
}
if (!isMatch("great gatsby", { title: "The Great Gatsby", aliases: ["great gatsby"] })) fail++;
if (!isMatch("les mis", { title: "Les Misérables", aliases: ["les mis"] })) fail++;
if (!isMatch("pride and prejudce", { title: "Pride and Prejudice", aliases: ["pride and prejudice"] })) fail++;
if (isMatch("pride", { title: "Pride and Prejudice", aliases: ["pride and prejudice"] })) {
  console.error("pride alone should not match");
  fail++;
}
if (fail) {
  console.error("FAIL", fail);
  process.exit(1);
}
console.log("ok match", files.length, "puzzles");
