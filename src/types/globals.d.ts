/* The browser files are classic scripts, not modules: config.ts, match.ts,
   auth.ts, toast.ts and ads.ts each hang one object off `window`, and app.ts
   and share-page.ts read them from there. These are the shapes of those
   globals, and of the data they pass between them.

   This lives in a subfolder so `esbuild src/*.ts` doesn't emit it. */

/* ---- js/config.js ---- */

interface ExcerptleAdsConfig {
  enabled: boolean;
  client: string;
  slot: string;
}

/* ---- js/match.js ---- */

/** Anything with a title the matcher can check a guess against. */
interface MatchTarget {
  title: string;
  aliases?: string[];
}

interface PartialMatch {
  matched: number;
  missing: number;
}

interface BookleMatchApi {
  fold(s: unknown): string;
  isMatch(guess: string, puzzle: MatchTarget): boolean;
  partialMatch(guess: string, puzzle: MatchTarget): PartialMatch | null;
  tokens(s: unknown): string[];
  stripEdition(title: unknown): string;
  variants(title: string): string[];
}

/* ---- js/auth.js ---- */

interface KdfSettings {
  salt: string;
  iterations: number;
}

/** What `bookle.auth.session` holds in localStorage. With an API the server
    writes it; in demo mode auth.js makes one up. */
interface AuthSession {
  email: string;
  name?: string;
  provider?: string;
  uid?: string;
  token?: string;
  /** Unix seconds. */
  expiresAt?: number;
  hasPassword?: boolean;
}

interface EmailCheck {
  account: boolean;
  hasPassword: boolean;
  kdf?: KdfSettings | null;
}

interface SentCode {
  hasPassword: boolean;
  demoCode: string | null;
}

interface BookleAuthApi {
  session(): AuthSession | null;
  signOut(): void;
  validEmail(s: unknown): boolean;
  checkEmail(email: string): Promise<EmailCheck>;
  sendCode(email: string): Promise<SentCode>;
  verifyCode(email: string, code: unknown): Promise<void>;
  signInWithPassword(email: string, password: string, kdf?: KdfSettings | null): Promise<AuthSession | null>;
  hasPassword(): boolean;
  setPassword(password: string, current?: string): Promise<void>;
  removePassword(current: string): Promise<void>;
  updateProfile(name: unknown): Promise<{ uid?: string; name: string }>;
  googleSignIn(): Promise<AuthSession | null>;
}

/* ---- js/toast.js ---- */

interface ExcerptleToastApi {
  show(text: string, ms?: number): void;
  copyLink(url: string): Promise<void>;
}

/* ---- js/ads.js ---- */

interface ExcerptleAdsApi {
  render(): void;
  clear(): void;
  active(): boolean;
  configured(): boolean;
}

/* ---- puzzles/*.json ---- */

interface PuzzleIndex {
  startDate?: string;
  dailyStartIndex?: number;
  presetCount?: number;
  dailyPoolCount?: number;
  order: string[];
  count?: number;
  failed?: unknown[];
}

interface Puzzle extends MatchTarget {
  schemaVersion?: string;
  /** "2" for the fact-hint puzzles; older files have none. */
  hintVersion?: string | number;
  id: string;
  author: string;
  year?: string | number;
  openingSentence?: string;
  openingExcerpt?: string;
  genre?: string;
  setting?: string;
  reading?: { kind?: string; label?: string; url: string };
  source?: { gutenberg?: number; url?: string; license?: string };
  labels?: string[];
  texts?: string[];
}

/** puzzles/reading/<id>.json: the opening section shown after a round. */
interface ReadingSection {
  puzzleId?: string;
  paragraphs?: string[];
}

interface Window {
  EXCERPTLE_GOOGLE_CLIENT_ID: string;
  BOOKLE_GOOGLE_CLIENT_ID: string;
  EXCERPTLE_API: string;
  BOOKLE_API: string;
  EXCERPTLE_ADS?: ExcerptleAdsConfig;
  BookleMatch: BookleMatchApi;
  BookleAuth: BookleAuthApi;
  ExcerptleToast: ExcerptleToastApi;
  ExcerptleAds: ExcerptleAdsApi;
  /** AdSense's queue; adsbygoogle.js drains it. */
  adsbygoogle?: object[];
  /** index.html starts fetching puzzles/index.json in <head>. */
  __excerptleIndex?: Promise<PuzzleIndex | null>;
  /** The address and password settings carried between sign-in modals. */
  _bookleEmail?: string;
  _bookleKdf?: KdfSettings | null;
}

interface DocumentEventMap {
  "bookle-auth": CustomEvent<AuthSession | null>;
}
