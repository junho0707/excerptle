-- Remembers which quota band each metric has already been shouted about,
-- keyed by metric + UTC day, so an hourly check doesn't repeat itself.
CREATE TABLE alert_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX alert_state_updated ON alert_state(updated_at);
