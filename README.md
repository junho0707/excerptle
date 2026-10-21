# Excerptle

**[excerptle.io](https://excerptle.io)**: a daily book-guessing game. You read the first
sentence of a public-domain book and have six guesses to name it. You can also take up to
five hints, which reveal the opening paragraphs, then genre, publication date, setting and
finally the author.

The catalogue has 720 books: a bank of 600 you can play any time, plus a separate run of
dailies that is the same for everyone and rolls over at midnight Pacific.

## How it's built

```
Browser ──► excerptle (Worker)  static assets + Open Graph tag rewrite for share links
               │ service binding
               └─► excerptle-og (Worker)  renders share-card PNGs (resvg WASM)

Browser ──► excerptle-api (Worker + D1)  accounts, cross-device progress, Slack alerts
```

- **Gameplay is fully client-side.** A round runs in the browser against pre-built JSON,
  with no API calls, so the game keeps working even if the backend is down. Accounts only
  sync progress between devices.
- **Frontend:** TypeScript with no framework (`src/`), bundled by esbuild. It uses
  system fonts and no webfonts, has a light and a dark theme, and is built mobile-first.
- **Title matching** (`src/match.ts`) ignores case, punctuation, diacritics and a
  leading article. It accepts aliases (*Huck Finn*, *Les Mis*) and allows a
  length-scaled typo budget. A single leftover word only counts if it is the whole
  title or a distinctive last word (`gatsby` counts, `great` doesn't).
- **Accounts** (`backend/`): Google sign-in, email one-time codes and optional
  passwords. A Cloudflare Worker serves them over D1, with sessions issued and checked on
  the server.
- **Share previews** (`tools/og-worker/`): the front-door Worker rewrites meta tags so a
  shared link unfurls to a card for that puzzle. The 3.5 MB renderer runs in its own
  Worker, which keeps cold starts for the main site in the single-digit-KB range.
- **Monitoring:** cron jobs post a daily Slack digest and alert before any Cloudflare
  free-tier limit is reached. See [docs/MONITORING.md](docs/MONITORING.md).

## Content pipeline

`tools/` holds the Python pipeline that built the catalogue:

1. Pick canonical titles and confirm each one is in the US public domain (published 1930
   or earlier).
2. Download the text from Project Gutenberg and strip the boilerplate.
3. Find the real first sentence, skipping title pages, contents lists and chapter labels.
4. Attach hint metadata (genre, date, setting) and cross-check it against Wikipedia.

Each book stops at its opening chapters. The full text is never hosted, and every puzzle
is attributed to its Gutenberg source.

## Running it

```sh
npm ci
npm run build                 # src/*.ts → js/
python3 -m http.server 8765   # then open http://localhost:8765
```

| Command | What it runs |
| --- | --- |
| `npm test` | Type check, title-matching, auth-flow and progress-sync tests, share-worker tests |
| `npm run test:e2e` | Playwright gameplay suite, desktop and mobile |
| `npm run test:data` | Puzzle integrity and hint-metadata checks across all 720 books |
| `npm test --prefix backend` | API tests against a local D1 |

CI runs all of these on every push. Deployment details are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Layout

```
index.html, *.html   the game and its static pages
src/                 browser TypeScript (game, auth, title matcher)
css/app.css          all styles
puzzles/             one JSON file per book, plus index.json
backend/             excerptle-api Worker, D1 migrations
tools/               content pipeline, share-card Worker, unit tests
tests/               Playwright specs
```

Excerpts come from [Project Gutenberg](https://www.gutenberg.org/). This project is not
affiliated with Project Gutenberg.
