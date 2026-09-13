ALTER TABLE scores ADD COLUMN hint_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX scores_board_version ON scores(puzzle_index, hint_version, hints, guesses, won_at);
