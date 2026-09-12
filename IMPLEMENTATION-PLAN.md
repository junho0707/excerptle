# Excerptle: accessible hints, post-game reading, and account fixes

Implementation handoff. Prepared against the repository on September 11, 2026. This document specifies work; it does not claim the changes have been implemented.

## 1. Product decisions to implement

Make the challenge playable through knowledge of books, genres, history, and authors, in addition to recognizing prose. Retain six guesses, five optional hints, existing title matching, and ranking by hints used, guesses used, then solve timestamp.

**Counting assumption:** the user's numbered table describes five optional hints. Keep the free first sentence, then make Hint 1 the longer opening excerpt. Do not silently count the initial screen as a spent hint. If the owner instead wants 100–180 words immediately on load, that is a different four-optional-hint design and requires changing scoring, counters, and instructions together.

| Stage | Content | Content rule |
| --- | --- | --- |
| Start, 0/5 hints | First sentence | Actual narrative opening, excluding front matter. |
| Hint 1 | Opening excerpt | First 2–4 complete paragraphs; aim for 100–180 words. Natural paragraph boundaries take priority over a rigid word count. |
| Hint 2 | Genre | One primary genre, optionally a subtype; concise and recognizable. |
| Hint 3 | Publication year | Original publication year of the work, not the translation, edition, or Gutenberg release. |
| Hint 4 | Setting | Main story location and approximate story period, roughly one short line. |
| Hint 5 | Author | Commonly recognized full name. |

Hints are cumulative. Hint 1 replaces the free sentence with the opening paragraphs; hints 2–5 add labeled facts below the excerpt without replacing it. Wrong guesses use a guess and never reveal a hint. Showing all five hints does not end the game. Do not add plot summaries, character clues, multiple-choice answers, or extra hint tiers in this change.

After a correct answer, six unsuccessful guesses, or confirmed give-up, reveal the answer and offer **Read the first chapter**. Reading is free, requires no sign-in, and changes no guesses, hints, scores, streaks, or saved result. This means the complete opening chapter, not the complete novel. Keep a separate **Read the full book on Project Gutenberg** link.

For collections and works without chapters, use the complete first story or first meaningful narrative section, with an accurate label such as **Read the first story**. Record and review these exceptions rather than inventing chapter boundaries.

## 2. Findings that explain the work

- `js/app.js`: `tiers()`, `TIER_LABELS`, and `renderExcerpt()` currently use five progressively longer text strings plus an author hint. Only `status === "won"` reveals the longest text automatically. Losses retain the current tier.
- `tools/build_puzzles.py`: `build_ladder()` targets word counts, and `build_one()` builds from a continuous narrative stream. The longest tier can cross chapter boundaries or stop before the chapter ends. Do not reuse `texts[4]` as a verified full chapter.
- `puzzles/index.json` contains 720 puzzles: 600 bank books and 120 daily books. `tools/final_bank.json` and `tools/final_dailies.json` are builder inputs. Genre fields can be empty; setting is not currently emitted into puzzle JSON.
- `js/app.js`: Settings writes only `bookle.name`; `displayName()` prefers the signed-in session name. Local leaderboard entries store names at solve time.
- `backend/src/worker.js`: `/scores` returns stored `scores.name`; submissions copy `users.name`. There is no profile-name update route. Fixing the input alone cannot update existing public results.
- `renderRanks()` identifies and deduplicates rows using name, hint count, and guess count. Renaming can create duplicates or misidentify another player with the same name and score.
- Instructions are duplicated in the in-game modal, static pages, and structured metadata. The existing prose-only hint explanations must all change.

## 3. Work package A: puzzle data and content generation

Primary files: `tools/build_puzzles.py`, `tools/final_bank.json`, `tools/final_dailies.json`, `tools/anchors.json`, `tools/test_puzzles.py`, `tools/qa_puzzles.py`, and `puzzles/*.json`.

### Data contract

Add explicit fields rather than overloading the legacy `texts` array:

```json
{
  "schemaVersion": 2,
  "hintVersion": 2,
  "openingSentence": "Actual opening sentence.",
  "openingExcerpt": "First paragraph.\n\nSecond paragraph.",
  "genre": "Gothic Horror",
  "setting": "Main location and approximate story period",
  "reading": {
    "kind": "chapter",
    "label": "Chapter 1",
    "url": "/puzzles/reading/g123.v2.json",
    "wordCount": 1234
  }
}
```

Retain existing `id`, `title`, `author`, `year`, `aliases`, and `source`. The example uses placeholders, not facts for a particular book. The reading asset contains `puzzleId`, `label`, and an ordered array of plain-text paragraphs. Use revisioned filenames when content changes so a cached descriptor cannot load a different revision. Keep chapter prose out of the initial puzzle payload; fetch it when the player opens the reader after finishing.

Retain legacy `texts` and `labels` during transition for old clients and saved legacy rounds. New rounds use the explicit fields. Do not reshuffle the catalogue, change slugs, shift the daily schedule, or drop entries during regeneration.

### Content tasks

1. Add a committed, curated metadata file keyed by stable puzzle ID, for example `tools/hint_metadata.json`. Store genre, setting, original year corrections, source references, and exception notes there; use one authoritative location for overrides.
2. Complete coverage for all 720 indexed puzzles. Verify genre and setting using the text and reliable bibliographic sources. Do not infer story year from publication year. Use a concise truthful description for stories spanning periods, locations, or multiple narratives. Document serialization/date exceptions.
3. Generate the excerpt from the verified narrative anchor, preserving actual wording and paragraph boundaries. Prefer 2–4 paragraphs nearest the target length; record exceptions for tiny dialogue paragraphs, unusually long paragraphs, and very short sections. Do not fabricate, summarize, or clip sentences to meet a quota.
4. Extract the complete first chapter from the same edition and opening. Find the next real narrative heading after the start, not a contents entry. Preserve dialogue, accents, and meaningful paragraph breaks; exclude licensing boilerplate and unrelated front matter.
5. Use reviewed boundary overrides where automated detection is uncertain. Existing anchors, `split_after_anchor()`, and opening audit files are useful inputs, not proof that a boundary is correct. Require explicit review for prologues, letters, unnamed chapters, short stories, and collections.
6. Ensure the chapter reader begins from the narrative opening, including the text already shown during play. No skipped or duplicated paragraphs at the transition. A chapter is not truncated to `WORD_CAP`.
7. Emit a coverage report listing all missing metadata, boundary exceptions, word counts, and review status. Block completion on unresolved content. Do not silently spend a player's hint on an empty value.
8. Extend validators for the new fields and reading assets. Existing ladder uniqueness/size checks should remain for legacy fixtures only, not reject the new metadata model.

Acceptance: every indexed puzzle has all five meaningful hints and a complete, accurately labeled reading section. Opening excerpt and reader agree. Regeneration is deterministic, index order is unchanged, and no Gutenberg headers/footers leak into prose. Manually review all extraction exceptions plus representative novels, translations, collections, short chapters, and long chapters.

## 4. Work package B: gameplay and chapter reader

Primary files: `js/app.js`, `index.html`, `css/app.css`; optionally extract a small reader module if it simplifies lifecycle handling.

### Hint UI

1. Replace new-game tier indexing with an explicit hint model based on `state.hints`. Render only earned facts into the active UI; unrevealed facts must not appear in accessible labels, tooltips, or hidden rendered elements.
2. Keep genre, publication year, setting, and author in a compact, wrapping fact list below the opening excerpt. Use `textContent` or the existing escaping helper for all content.
3. Label the button with the next action: `Hint: opening excerpt`, then `Hint: genre`, `Hint: publication year`, `Hint: setting`, `Hint: author`. Keep the `0/5` counter. At five hints, show a clear exhausted state.
4. Preserve the guess input and focus when revealing a hint. Announce the new fact through a polite live region without rereading the entire excerpt. Keep mobile controls reachable without scrolling through a long chapter.
5. Route all terminal outcomes through consistent result rendering, including restored completed rounds. Keep the current two-tap give-up confirmation and terminal-state input disabling.

### Reader interaction

1. Put **Read the first chapter** prominently beside the book information in the result card, before secondary leaderboard/navigation actions. Keep the results compact until the user elects to read.
2. Open an inline reading section below the result on both mobile and desktop. Use the page's normal scroll; avoid a second long scrolling box inside a modal or card. Show title, author, accurate section label, and the complete section from its start.
3. On an explicit open action, move focus to the reader heading and bring it into view. Provide **Back to result** and **Close chapter** controls with predictable focus return. Do not auto-scroll merely because progress, profile data, or an ad rerenders.
4. Show loading, failure, and retry states. Keep the result and Gutenberg link usable when loading fails. Reopening may use an in-memory cache. Discard late responses after navigating to another puzzle; deduplicate repeated open requests.
5. A reload or returning to a completed puzzle must still offer the reader. Reader-open state is presentation state, not game progress; it may reset closed on navigation/reload. Account updates must not destroy an open reader or its scroll position.
6. Replace `chapterWords()` with the validated reading word count and accurate section label. Do not call a collection's first story “Chapter 1.” Remove stale comments and assumptions in `placeMore()`, `renderResult()`, and CSS that describe reading as a winner-only reward.
7. Keep the existing single post-game ad behavior. Opening, closing, retrying, or updating the reader/profile must not create another ad or shift prose while the player reads.

### Mobile, desktop, and accessibility acceptance

- Validate at 320, 390, 768, and 1280 CSS pixels, portrait/landscape, and 200% zoom. No horizontal page overflow; facts, author names, buttons, and source links wrap.
- Reading width approximately 65–75 characters on large screens, comfortable line spacing, theme-aware colors, and visible keyboard focus. Use existing typography where suitable.
- Touch targets at least 44×44 CSS pixels where practical. Input font size at least 16px. The software keyboard must not obscure the guess/submit flow.
- Use semantic headings and paragraphs, expose open/closed state with `aria-expanded`/`aria-controls`, and honor reduced motion. No focus trap or forced smooth scrolling.
- Manually check a real mobile browser where available; emulated viewport tests alone do not prove keyboard or mobile Safari behavior.

## 5. Compatibility, saved rounds, ranking, and battles

The hint meaning changes even though the maximum remains five. Preserve progress and explicitly distinguish the rulesets.

1. Add `hintVersion` to newly saved round data, local score rows, progress sync, score submissions, and new share payloads. Missing version means legacy version 1. Do not erase `bookle.progress.v4`, historical stats, or finished rounds.
2. Resume an in-progress legacy round using its old hint rules so previously revealed prose is not retracted or converted to different clues. New rounds use version 2. Both versions gain the post-game reader once completed.
3. Partition leaderboard comparisons by hint version. Add a D1 migration with a version column defaulting existing scores to 1, and update relevant uniqueness/index assumptions, best-score comparisons, queries, filters, and local/server merge logic to include the version. Validate supported versions; old requests without a version remain version 1.
4. Default a result's leaderboard link and rank calculation to that result's version. For a standalone board default to current rules and offer a clearly labeled legacy view. Do not combine old prose-help scores with new factual-help scores without disclosure.
5. Audit progress merging in `js/app.js` and the backend: version travels with the chosen complete round record, never merged separately from its hints/guesses/status. Keep completed books completed; this change does not create replay scores automatically.
6. Update share generation, parsing, and OG code in `js/app.js` and `tools/og-worker/` wherever rankings or hint explanations depend on version. Existing links remain readable; missing version is legacy. Shared incoming results must not unlock the recipient's unsolved book or expose the answer/chapter.
7. Preserve shared hints in battle mode. Include hint version in the handshake, and require mismatched clients to reload before starting. Both players see the same cumulative hints. Validate incoming hint bounds and version.
8. Audit every battle end path, including opponent win and exhausted guesses. The reader unlocks only when the shared match is over; one participant must not receive extra chapter information while still able to compete. Persist a local terminal state if needed to prevent stalled matches, and test that the winner cannot be overwritten by late messages. Keep give-up unavailable in battle unless deliberately implementing a complete forfeit protocol.

Acceptance: no progress reset, no score resubmission triggered by opening the reader, no mixed-version rank calculations, no battle clue leak during active competition, and no old share-link regression.

## 6. Work package C: display-name persistence and propagation

Primary files: `js/auth.js`, `js/app.js`, `index.html`, `backend/src/worker.js`, backend migrations/tests, and auth/progress test helpers.

### Server contract

1. Add authenticated `GET /me/profile` and `POST /me/profile` using the existing bearer-session validation. POST accepts `{ "name": "New name" }` and returns the canonical saved profile `{ "uid": "...", "name": "..." }`. Never accept a client-supplied account ID as authority.
2. Normalize leading/trailing whitespace consistently, reject invalid/control-character input, and enforce the existing 24-character UI limit consistently on client/server. Allow Unicode names. Define empty input as `Anonymous`; never fall back to the email prefix after an explicit anonymous choice.
3. Use `users.name` as the signed-in source of truth. Read leaderboard names by joining scores to users, with a fallback only for genuinely orphaned legacy rows. This updates all historical results without rewriting every score. Preserve score values, timestamps, and ownership.
4. Return a stable public player identifier with leaderboard rows, such as an opaque derived identifier, and the same identifier in the private profile. Do not expose email, token, or private authentication data. Use identity plus puzzle/version for deduplication and “you” highlighting, not display-name equality. Confirm that identical names are allowed for different people.
5. Keep returning existing score fields for compatibility. Add tests proving that one user cannot rename another and that renaming never changes rank or creates additional scores.

### Client behavior

1. Add an explicit **Save name** action and inline saving/saved/error feedback in Settings. Enter should submit; serialize/disable concurrent saves so a slow request cannot overwrite a newer result. Settings initially shows the resolved current profile name.
2. Signed in: save through the API; after success update the cached session name and owned local rows. Keep the old committed name on failure, retain the editable draft, and display a retryable error. Do not claim a failed request was saved.
3. Signed out: save to `bookle.name` and update only local rows owned by the current player ID. Explain briefly that guest changes are saved on this device.
4. Centralize name resolution and propagation. Refresh the account navigation label, account UI, Settings, owned leaderboard rows, result mini-board, newly generated shares, and battle lobby/opponent display. Keep email shown only where it is explicitly account information.
5. Keep stable identity when anonymous scores become linked to a signed-in account; record the public identifier returned by profile/score APIs on owned local rows. Audit `pushLb()`, `lbFor()`, `ranksFor()`, `rankKey()`, `renderRanks()`, and pending score upload logic. Do not rename or deduplicate another player's row just because the old names match.
6. Fetch current profile on session restoration and when returning to the app, with sensible request deduplication. Sync changes across same-origin tabs through storage/BroadcastChannel. On another device, refresh on load/focus; live server push is unnecessary.
7. Use a dedicated profile-change event rather than treating every rename as a fresh login. The existing `bookle-auth` listener triggers progress syncing and result HTML replacement; a rename must not reset a round, close a reader, or trigger score uploads.
8. Route guest battle-name edits through the same local save helper. Signed-in battle names should use the saved account name. Preserve existing battle name messages for notifying an active opponent.
9. Previously copied share URLs/images are historical snapshots and cannot be changed retroactively. New shares use the latest saved name. A later Google/password/email sign-in must retain the custom account name.

Acceptance: rename, reload, sign out/in, and open another device/tab; the saved account name remains consistent. Existing public scores update even without a new win. Failed saves do not show success. Guest rows update locally. Two accounts with the same name remain separate and only the correct row is marked “you.” Active guesses, reader state, and result totals survive a rename.

## 7. Work package D: all instructions and Support label

Primary files: in-game How to Play in `js/app.js`, `how-to-play.html`, `about.html`, `faq.html`, `index.html`, `support.html`, and every static page containing shared navigation.

Use this core explanation, adjusted only for page length:

> Start with the first sentence of a book and guess its title in six tries. Need help? Reveal the opening paragraphs, then its genre, original publication year, setting, and finally its author. Each hint stays visible. Wrong guesses use a guess but do not reveal a hint. Fewer hints, then fewer guesses, place you higher on the leaderboard. Once you solve it, run out of guesses, or give up, you can read the complete first chapter here and follow the link to the full book on Project Gutenberg.

1. Include the exact five-row table from section 1 in the full instructions. State that using all hints does not finish the round, reading after finishing is free, and some works offer a first story/section instead of a chapter.
2. Update the in-game modal and static How to Play together. Update FAQ answers, About descriptions, metadata descriptions, and HowTo/FAQ JSON-LD so they agree with the new behavior. Remove current claims that every hint expands the text or that the full chapter is Hint 4.
3. Show existing users a dismissible “Hints have changed” notice keyed to version 2. Do not force-open instructions on every return or during an active legacy round. Do not reset onboarding/progress indiscriminately.
4. Change the shared navigation/tab label **Support** to **Support me** across game and static pages. Preserve the current Ko-fi destination and link behavior. Match any accessible label/title to the visible wording. Use **Support me** for corresponding navigation/footer links for consistency; retain contextual headings such as “Support Excerptle” where they are prose rather than navigation.
5. Inspect `about.html`, `faq.html`, `how-to-play.html`, `privacy.html`, `support.html`, `404.html`, and any other matching source pages. Update the `support` route title in `js/app.js` when it represents that navigation destination.
6. Keep source code and generated/public copies straight: edit tracked source files, not `dist/` output. Search all maintained HTML/JS/docs for outdated hint instructions; preserve explicitly historical release notes as history.

Acceptance: instructions, structured metadata, counters, actual reveal order, end-state reader behavior, and navigation labels agree on desktop and mobile. No broken Support destination or duplicate onboarding interruption.

## 8. Delivery order and verification

Suggested assignment order for implementation agents:

1. Agree on the fields, versioning, profile API, and public identity contract above. Capture index order and representative old saved rounds as regression fixtures.
2. Implement data generation and review content (A). In parallel workstreams, implement backend version/profile contracts (C and section 5). These have the longest lead times.
3. Implement gameplay/reader (B) and frontend name propagation (C) against those contracts. These both touch `js/app.js`; use sequential edits or isolated branches and an integration owner.
4. Update instructions/navigation (D) once behavior is fixed. Integrate all work, run checks, and resolve regressions before release.

Required verification commands:

```sh
python3 tools/test_puzzles.py
python3 tools/qa_puzzles.py
npm test
npm test --prefix backend
npm run test:e2e
git diff --check
```

Inspect command behavior and existing baseline failures first; update validators for the new schema and add meaningful generator/profile/gameplay tests. Run backend migrations against a local test database. If Chromium requires the repository's documented executable override, use `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Do not report blocked checks as passing.

Minimum automated regression cases:

- Reveal each hint in order, retain previous clues, disable a sixth hint, and prove wrong guesses reveal nothing.
- Win at zero hints; exhaust guesses at zero and five hints; give up before any guess and after a partial round. All offer the complete section with unchanged result counts.
- Finish/reload, navigate away/back, switch books during a delayed chapter fetch, retry a failed fetch, and rename with the reader open.
- Confirm unfetched chapter assets before finish/open, and no chapter action for active rounds. This is a UI gate on public static content, not an anti-cheat security boundary.
- Resume legacy playing/finished data and round-trip new versioned progress across account sync. Check leaderboard version separation and old/new share parsing.
- Two battle participants take hints and reach every terminal state; mismatched versions and late messages cannot restart or corrupt the match.
- Signed-in and guest renames, validation/failure/retry, subsequent sign-in, duplicate names, ownership highlighting, old score updates, and cross-tab refresh.
- Mobile overflow/focus/keyboard behavior, long chapter scrolling, and no repeated ad insertion.

Release preparation: deploy additive backend/migrations before the new client, and publish reader assets before or atomically with descriptors that reference them. Keep legacy fields and defaults while old tabs exist. Validate the final staged asset set, database migration, and rollback path. This request authorizes a plan, not a production deployment; implementation agents should follow the owner's subsequent deployment instructions.

Final implementation report must list changed files, content coverage/review exceptions, exact test outcomes, remaining blockers, and deployment status. No “complete” claim with missing metadata, unverified chapter boundaries, or a name change that only affects newly earned scores.
