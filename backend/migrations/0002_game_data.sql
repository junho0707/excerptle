ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_salt TEXT;

CREATE TABLE scores (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  puzzle_index INTEGER NOT NULL,
  name TEXT NOT NULL,
  guesses INTEGER NOT NULL,
  hints INTEGER NOT NULL,
  time_ms INTEGER NOT NULL,
  won_at INTEGER NOT NULL
);
CREATE INDEX scores_board ON scores(puzzle_index, hints, guesses, time_ms, won_at);
CREATE INDEX scores_user_puzzle ON scores(user_id, puzzle_index);

CREATE TABLE progress (
  user_id TEXT NOT NULL REFERENCES users(id),
  puzzle_index INTEGER NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, puzzle_index)
);
CREATE INDEX progress_updated ON progress(user_id, updated_at);
