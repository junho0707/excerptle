/* Shapes shared by the two Workers, the archive pages and the tests. */

/* The bindings of the front-door Worker (root wrangler.jsonc). */
export interface Env {
  ASSETS: Fetcher;
  OG: Fetcher;
}

/* What the archive needs of ASSETS. Narrower than Fetcher so the tests can
   hand in a plain object with a fetch method. */
export interface AssetsEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
}

/* puzzles/index.json */
export interface PuzzleIndex {
  startDate: string;
  dailyStartIndex?: number;
  presetCount?: number;
  dailyPoolCount?: number;
  order: string[];
}

/* puzzles/<slug>.json — only the fields read here. */
export interface Puzzle {
  title: string;
  author: string;
  year: number | string;
  genre?: string;
  setting?: string;
  openingExcerpt?: string;
  texts?: string[];
  source?: { url?: string };
}

/* content/archive-notes.json: puzzle number -> note text. */
export type ArchiveNotes = Record<string, string>;

/* content/archive-index.json: puzzle number -> list-row facts. */
export interface ArchiveMetaEntry {
  title: string;
  author: string;
  year: number | string;
}
export type ArchiveMeta = Record<string, ArchiveMetaEntry>;

/* Whatever the caller uses to read site JSON (ASSETS in the Worker, a map in
   the tests). Untrusted: callers cast to the shape they expect. */
export type ReadJson = (path: string) => Promise<unknown>;
