/* Writes content/archive-index.json: title, author and year for every daily
   that has an archive note, so the /archive list renders from the Worker
   bundle instead of fetching one puzzle file per entry (a list that grows
   daily would otherwise walk into the Workers subrequest limit).

   Rerun after editing content/archive-notes.json or rebuilding puzzles;
   tools/og-worker/archive.test.ts fails if this file has drifted. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dailySlug } from "./og-worker/archive.ts";

interface ArchiveEntry {
  title: string;
  author: string;
  year?: string | number;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = <T>(p: string): T => JSON.parse(readFileSync(join(root, p), "utf8"));

export function buildArchiveIndex(): Record<number, ArchiveEntry> {
  const index = read<Parameters<typeof dailySlug>[0]>("puzzles/index.json");
  const notes = read<Record<string, string>>("content/archive-notes.json");
  const out: Record<number, ArchiveEntry> = {};
  for (const n of Object.keys(notes).map(Number).sort((a, b) => a - b)) {
    if (!String(notes[n] || "").trim()) continue;
    const p = read<ArchiveEntry>(`puzzles/${dailySlug(index, n)}.json`);
    out[n] = { title: p.title, author: p.author, year: p.year };
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = buildArchiveIndex();
  writeFileSync(join(root, "content/archive-index.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`content/archive-index.json: ${Object.keys(out).length} entries`);
}
