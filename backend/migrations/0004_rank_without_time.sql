-- Leaderboards rank on hints, then guesses, then who solved it first. Time
-- spent is no longer part of the order. The old index led on time_ms, so every
-- board read had to sort after the index lookup.
-- Note for future migrations: the test harness splits this file on the
-- semicolon, so a semicolon inside a comment leaves a chunk with no statement
-- in it and the whole run fails.
DROP INDEX IF EXISTS scores_board;
CREATE INDEX scores_board ON scores(puzzle_index, hints, guesses, won_at);
