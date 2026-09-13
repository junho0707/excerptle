-- Hint versions changed the presentation, not the competition: one account
-- gets one best result on each book, with the earliest identical score kept.
DELETE FROM scores
WHERE EXISTS (
  SELECT 1 FROM scores AS better
  WHERE better.user_id = scores.user_id
    AND better.puzzle_index = scores.puzzle_index
    AND (
      better.hints < scores.hints
      OR (better.hints = scores.hints AND better.guesses < scores.guesses)
      OR (better.hints = scores.hints AND better.guesses = scores.guesses AND better.won_at < scores.won_at)
      OR (better.hints = scores.hints AND better.guesses = scores.guesses AND better.won_at = scores.won_at AND better.id < scores.id)
    )
);
CREATE UNIQUE INDEX scores_user_puzzle_global ON scores(user_id, puzzle_index);
