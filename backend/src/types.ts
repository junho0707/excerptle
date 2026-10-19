/* Types shared by the Worker, its alerting module and the tests. Type-only:
   nothing here survives into the bundle. */

/* Bindings, as wrangler.toml and `wrangler secret put` provide them. Vars that
   the code reads defensively (or that the tests leave out) are optional. */
export interface Env {
  DB: D1Database;

  // [vars] in wrangler.toml
  SITE_URL: string;
  ALLOWED_ORIGINS: string;
  GOOGLE_CLIENT_ID: string;
  /** "true" or "false": which Stripe mode prices and webhook events must match. */
  STRIPE_LIVE: string;
  MAIL_FROM?: string;
  ALERT_DASH_URL?: string;

  // Secrets. Every one may be missing; the code answers 503 or skips the feature.
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_ID?: string;
  STRIPE_YEARLY_PRICE_ID?: string;
  STRIPE_PORTAL_CONFIGURATION?: string;
  OTP_SECRET?: string;
  RESEND_API_KEY?: string;
  SLACK_WEBHOOK_URL?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  /** Local only (backend/.dev.vars): "true" echoes sign-in codes on localhost. */
  DEV_ECHO_CODES?: string;
}

// ---- D1 rows (see migrations/) ----

export interface UserRow {
  id: string;
  email: string;
  name: string;
  google_sub: string | null;
  stripe_customer: string | null;
  created_at: number;
  password_hash: string | null;
  /** `${iterations}:${saltHex}` */
  password_salt: string | null;
}
export interface EmailCodeRow {
  email: string;
  code_hash: string;
  expires_at: number;
  attempts: number;
}
export interface SubscriptionRow {
  id: string;
  user_id: string;
  status: string;
  period_end: number;
  cancel_at_end: number;
  price_id: string;
  event_created: number;
  event_id: string;
}
export interface ProgressRow {
  puzzle_index: number;
  data: string;
}
export interface AlertStateRow {
  value: string;
}

// ---- Request bodies. Untrusted JSON: every field is validated before use. ----

export type JsonBody = Record<string, unknown>;
export interface AuthBody {
  accessToken?: unknown;
  email?: unknown;
  key?: unknown;
  code?: unknown;
}
export interface PasswordBody {
  currentKey?: unknown;
  remove?: unknown;
  key?: unknown;
  salt?: unknown;
  iterations?: unknown;
}
export interface ScoreBody {
  puzzleIndex?: unknown;
  guesses?: unknown;
  hints?: unknown;
  hintVersion?: unknown;
  timeMs?: unknown;
  win?: unknown;
}
export interface ProfileBody {
  name?: unknown;
}
export interface ProgressBody {
  progress?: unknown;
}
export interface BillingBody {
  returnUrl?: unknown;
  plan?: unknown;
}
/* One round as the client stores it. Opaque to the Worker apart from the
   fields it ranks on; everything else is stored and returned as sent. */
export interface ProgressEntry {
  status?: unknown;
  guesses?: unknown;
  hints?: unknown;
  at?: unknown;
  [field: string]: unknown;
}

// ---- Responses ----

export interface ErrorResponse { error: string }
export interface OkResponse { ok: true }
export interface KdfParams { salt: string; iterations: number }
export interface KdfConfigResponse { iterations: number; saltBytes: number }
export type SignInProvider = 'google' | 'password' | 'email';
export interface SessionResponse {
  uid: string;
  email: string;
  name: string;
  provider: SignInProvider;
  token: string;
  expiresAt: number;
  hasPassword: boolean;
}
export interface CheckResponse { account: boolean; hasPassword: boolean; google: boolean; kdf?: KdfParams }
export interface EmailCodeResponse { hasPassword: boolean; devCode?: string }
export interface PasswordResponse { ok: true; hasPassword: boolean }
export interface LeaderboardRow {
  name: string;
  playerId: string;
  guesses: number;
  hints: number;
  hintVersion: number;
  at: number;
}
export interface ScoresResponse { scores: LeaderboardRow[] }
export interface ProfileResponse { uid: string; name: string }
export interface ProgressResponse { progress: Record<string, ProgressEntry> }
export interface BillingStatus {
  pro: boolean;
  status: string;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  price: '$20/year' | '$3/month';
  hasCustomer: boolean;
}
export interface UrlResponse { url: string | null }
export interface WebhookResponse { received: true }
