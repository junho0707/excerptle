CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  google_sub TEXT UNIQUE, stripe_customer TEXT UNIQUE, created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE email_codes (
  email TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL, period_end INTEGER NOT NULL, cancel_at_end INTEGER NOT NULL,
  price_id TEXT NOT NULL, event_created INTEGER NOT NULL, event_id TEXT NOT NULL
);
CREATE INDEX subscriptions_user ON subscriptions(user_id);
CREATE TABLE stripe_events (id TEXT PRIMARY KEY, processed_at INTEGER NOT NULL);
CREATE TABLE checkout_locks (user_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
