/* Bookle */
(() => {
  const MAX_GUESSES = 6;
  const MAX_HINTS = 5;
  const START = "2026-09-08";

  const { fold, isMatch, partialMatch, stripEdition } = window.BookleMatch;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const K = {
    id: "bookle.playerId",
    name: "bookle.name",
    settings: "bookle.settings",
    seen: "bookle.seenHowTo",
    // The public catalogue was rebuilt on the 720-book lists (bank #0–#599,
    // dailies #600+) and every puzzle id changed with it. A new key
    // intentionally leaves pre-launch progress behind.
    progress: "bookle.progress.v4",
  };

  const state = {
    index: null,
    puzzle: null,
    playIndex: 600,
    mode: "daily", // daily | preset
    guesses: [],
    hints: 0,
    status: "playing",
    settings: loadSettings(),
    reader: { loading: false, data: null, error: "" },

  };
  let activeAccountUid = window.BookleAuth?.session?.()?.uid || null;

  /* The daily rolls over at midnight Pacific for everyone, not in whatever
     zone the browser happens to sit in — otherwise "today's puzzle" means a
     different book either side of a time zone. en-CA formats as YYYY-MM-DD, which
     is what daysBetween() and the derived daily dates expect. */
  const DAY_ZONE = "America/Los_Angeles";
  const dayFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: DAY_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  });
  function gameDate(d = new Date()) {
    return dayFormatter.format(d);
  }
  function daysBetween(a, b) {
    return Math.floor(
      (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000
    );
  }
  function addDays(iso, n) {
    const t = Date.parse(iso + "T00:00:00Z") + n * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  }

  function loadSettings() {
    try {
      return { theme: "paper", ...JSON.parse(localStorage.getItem(K.settings) || "{}") };
    } catch {
      return { theme: "paper" };
    }
  }
  function saveSettings() {
    localStorage.setItem(K.settings, JSON.stringify(state.settings));
    applyTheme();
  }
  function applyTheme() {
    document.documentElement.dataset.theme = state.settings.theme === "night" ? "night" : "";
  }
  function playerId() {
    let id = localStorage.getItem(K.id);
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
      localStorage.setItem(K.id, id);
    }
    return id;
  }
  function displayName() {
    const auth = window.BookleAuth?.session?.();
    if (auth?.name) return auth.name;
    if (auth?.email) return auth.email.split("@")[0];
    return (localStorage.getItem(K.name) || "").trim() || "Anonymous";
  }

  function paintAuth() {
    const s = window.BookleAuth?.session?.();
    const tab = $("#auth-tab");
    if (tab) {
      tab.textContent = s ? (s.email.split("@")[0] || "Account") : "Sign in";
      tab.dataset.act = s ? "open-account" : "open-auth";
    }
    const st = $("#auth-status");
    if (st) st.textContent = s ? `Signed in as ${s.email}` : "Not signed in. Progress stays on this device until you sign in.";
    renderPasswordBox();
  }

  function loadJSON(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "") || fallback;
    } catch {
      return fallback;
    }
  }
  // Gameplay data is scoped to the signed-in account (or to this browser's
  // guest identity). That prevents one person's saved rounds appearing when a
  // different person signs in on a shared computer. Guest writes also retain
  // the former key as a backwards-compatible local copy.
  function playOwner() {
    const uid = window.BookleAuth?.session?.()?.uid;
    return uid ? `account:${uid}` : `guest:${playerId()}`;
  }
  function playKey(key, owner = playOwner()) {
    return `${key}.${owner}`;
  }
  function loadPlayJSON(key, fallback, owner = playOwner()) {
    const scoped = playKey(key, owner);
    if (localStorage.getItem(scoped) !== null) return loadJSON(scoped, fallback);
    // Existing guest data predates scoped storage. Read it once until it is
    // naturally saved or imported into an account.
    return owner.startsWith("guest:") ? loadJSON(key, fallback) : fallback;
  }
  function savePlayJSON(key, value, owner = playOwner()) {
    const text = JSON.stringify(value);
    localStorage.setItem(playKey(key, owner), text);
    if (owner.startsWith("guest:")) localStorage.setItem(key, text);
  }
  function progressMap() {
    return loadPlayJSON(K.progress, {});
  }
  function saveProgress({ remote = true } = {}) {
    if (!state.puzzle || state.loading) return;
    const all = progressMap();
    const key = String(state.playIndex);
    const row = {
      status: state.status,
      guesses: state.guesses,
      hints: state.hints,
      hintVersion: roundHintVersion(),
      gaveUp: state.gaveUp ? 1 : undefined,
      puzzleId: state.puzzle?.id,
      mode: state.mode,
      // Kept once the round ends so the bank can label a book you have read
      // and the stats can count authors, without re-fetching every puzzle.
      title: state.status === "playing" ? undefined : state.puzzle?.title,
      author: state.status === "playing" ? undefined : state.puzzle?.author,
      at: Date.now(),
    };
    all[key] = row;
    savePlayJSON(K.progress, all);
    // Merely opening a book must not overwrite a round saved on another device.
    if (remote && (state.status !== "playing" || state.guesses.length || state.hints)) syncProgressEntry({ [key]: row });
  }

  // The browser remains the fast, offline-first copy.  On sign-in we merge by
  // each row's timestamp, then send the union; this also lets a player finish
  // a round on one device and resume it on another.
  let progressSyncing = null;
  let pendingProgress = {};
  /* Merging two copies of the same round: how far it got beats when it was
     saved. 2 = the round is over, 1 = it was played, 0 = it was only opened.
     A timestamp alone would let a laptop's stale, still-open round overwrite
     the finish that happened on the phone. */
  function progressRank(row) {
    if (row?.status === "won" || row?.status === "lost") return 2;
    return row?.hints || row?.guesses?.length ? 1 : 0;
  }
  function beats(row, current) {
    const a = progressRank(row);
    const b = progressRank(current);
    return a === b ? Number(row?.at || 0) >= Number(current?.at || 0) : a > b;
  }
  function progressConnection() {
    const api = (window.EXCERPTLE_API || window.BOOKLE_API || "").replace(/\/$/, "");
    const auth = window.BookleAuth?.session?.();
    return api && auth?.token ? { api, token: auth.token, uid: auth.uid, headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" } } : null;
  }
  const ownsProgress = connection => connection?.token === window.BookleAuth?.session?.()?.token;
  function syncProgressEntry(entries) {
    pendingProgress = { ...pendingProgress, ...entries };
    return flushProgressEntries();
  }
  async function flushProgressEntries() {
    const connection = progressConnection();
    if (!connection || progressSyncing || !Object.keys(pendingProgress).length) return progressSyncing;
    progressSyncing = (async () => {
      try {
        while (ownsProgress(connection) && Object.keys(pendingProgress).length) {
          // Stay below the API's 16 KB request limit, even with long guesses:
          // the server rejects any single entry over 4096 bytes.
          const batch = Object.fromEntries(Object.entries(pendingProgress).slice(0, 3));
          for (const key of Object.keys(batch)) delete pendingProgress[key];
          try {
            const res = await fetch(`${connection.api}/me/progress`, { method: "PUT", headers: connection.headers, body: JSON.stringify({ progress: batch }), signal: AbortSignal.timeout(5000) });
            if (!res.ok) throw new Error(`progress ${res.status}`);
          } catch {
            if (ownsProgress(connection)) pendingProgress = { ...batch, ...pendingProgress };
            break; // Retry on the next action/online event, not a tight loop.
          }
        }
      } catch { /* The browser copy remains authoritative until the next retry. */ }
      finally {
        progressSyncing = null;
      }
    })();
    return progressSyncing;
  }
  async function syncProgress() {
    const connection = progressConnection();
    if (!connection || progressSyncing) return progressSyncing;
    progressSyncing = (async () => {
      try {
        const res = await fetch(`${connection.api}/me/progress`, { headers: connection.headers, signal: AbortSignal.timeout(5000) });
        if (!res.ok || !ownsProgress(connection)) return;
        const remote = (await res.json()).progress || {};
        if (!ownsProgress(connection)) return;
        const merged = { ...remote };
        const local = progressMap();
        // Only what the server does not already hold goes back up: queueing the
        // whole merged map turned every sign-in into a hundred PUTs.
        const changed = {};
        for (const [index, row] of Object.entries(local)) {
          if (!merged[index] || beats(row, merged[index])) {
            merged[index] = row;
            changed[index] = row;
          }
        }
        savePlayJSON(K.progress, merged);
        if (Object.keys(changed).length) pendingProgress = { ...pendingProgress, ...changed };
        // Stats are derived from this map now, so a sync that lands after the
        // screen rendered has to repaint it — otherwise opening the app straight
        // onto Stats shows a zero streak until you navigate away and back.
        if (!$("#screen-stats")?.classList.contains("hidden")) renderStats();
        const active = String(state.playIndex);
        if (merged[active] && merged[active] !== local[active] && state.status === "playing"
          && !state.loading && !$("#game").classList.contains("hidden")) {
          await startPlay({ playIndex: state.playIndex, mode: state.mode, showHow: false });
        }
      } catch { /* Sync is opportunistic; local progress remains intact. */ }
      finally {
        progressSyncing = null;
        if (Object.keys(pendingProgress).length) flushProgressEntries();
      }
    })();
    return progressSyncing;
  }

  /* Carry unscoped local play into an account namespace, once per
     account-and-guest pair. This runs for a fresh sign-in and, at boot, for a
     session that was already present when scoped storage shipped — that player
     gets no `bookle-auth` event, so without this their streak and board would
     simply be gone the first time they loaded the new build. */
  function importGuestPlay(uid) {
    if (!uid) return;
    const guest = `guest:${playerId()}`;
    const account = `account:${uid}`;
    const marker = `bookle.guest-imported.${uid}.${guest}`;
    if (localStorage.getItem(marker)) return;

    const guestProgress = loadPlayJSON(K.progress, {}, guest);
    const accountProgress = loadPlayJSON(K.progress, {}, account);
    const mergedProgress = { ...accountProgress };
    for (const [index, row] of Object.entries(guestProgress)) {
      if (!mergedProgress[index] || beats(row, mergedProgress[index])) mergedProgress[index] = row;
    }
    if (Object.keys(guestProgress).length) savePlayJSON(K.progress, mergedProgress, account);

    localStorage.setItem(marker, "1");
  }

  function resetRoundForIdentityChange() {
    stopRoundTimers();
    pendingProgress = {};
    state.puzzle = null;
    state.guesses = [];
    state.hints = 0;
    state.status = "playing";
    state.reader = { loading: false, data: null, error: "" };
  }

  function dailyIndexNow() {
    const start = state.index?.startDate || START;
    const base = state.index?.dailyStartIndex ?? 600;
    return base + Math.max(0, daysBetween(start, gameDate()));
  }

  function slugForIndex(n) {
    const order = state.index.order;
    if (!order?.length) return null;
    const presets = Math.min(state.index.presetCount || order.length, order.length);
    // Dailies come out of the tail of the order — books the bank never offers,
    // so today's daily can't be one you already browsed.
    if (n >= (state.index.dailyStartIndex ?? 600)) {
      const day = n - (state.index.dailyStartIndex ?? 600);
      const pool = order.length - presets;
      return pool > 0 ? order[presets + (day % pool)] : order[day % order.length];
    }
    if (n < 0) return null;
    return order[n % presets];
  }

  function dateForDailyIndex(n) {
    const start = state.index?.startDate || START;
    const base = state.index?.dailyStartIndex ?? 600;
    return addDays(start, n - base);
  }

  /* Current and best daily streaks, read off the solved dailies. A daily's
     index is its date, so consecutive dates are a run. The current run only
     counts while it is still alive — it has to reach today, or yesterday with
     today still to play. */
  function dailyStreaks() {
    const base = state.index?.dailyStartIndex ?? 600;
    const dates = Object.entries(progressMap())
      .filter(([key, row]) => row?.status === "won" && parseInt(key, 10) >= base)
      .map(([key]) => dateForDailyIndex(parseInt(key, 10)))
      .sort();
    let best = 0;
    let run = 0;
    let last = null;
    for (const date of dates) {
      run = last && daysBetween(last, date) === 1 ? run + 1 : 1;
      best = Math.max(best, run);
      last = date;
    }
    return { current: last && daysBetween(last, gameDate()) <= 1 ? run : 0, best };
  }

  async function loadIndex() {
    if (state.index) return state.index;
    // index.html starts this fetch in <head> so it overlaps with loading the
    // scripts. Fall back to a fresh request if that head start is missing
    // (another page, or the pre-fetch failed).
    state.index = (await window.__excerptleIndex) || null;
    if (!state.index) {
      const res = await fetch("puzzles/index.json");
      if (!res.ok) throw new Error("index");
      state.index = await res.json();
    }
    return state.index;
  }
  async function loadPuzzle(id) {
    const res = await fetch(`puzzles/${id}.json`);
    if (!res.ok) throw new Error("puzzle");
    return res.json();
  }

  function tiers(p) {
    const t = p.texts || [];
    return t.slice(0, 5);
  }
  // Fixed wording so the tier label always matches the How-to-play table.
  const TIER_LABELS = [
    "First sentence", "First paragraph", "First few paragraphs",
    "First couple of pages", "First chapter",
  ];
  function hintLabels() {
    return TIER_LABELS;
  }
  const FACT_HINTS = ["Opening excerpt", "Genre", "Publication year", "Setting", "Author"];
  function isCurrentHints(p = state.puzzle) {
    return Number(p?.hintVersion) === 2;
  }
  function roundHintVersion(p = state.puzzle) {
    return isCurrentHints(p) ? 2 : 1;
  }
  function nextHintLabel() {
    return isCurrentHints() ? FACT_HINTS[state.hints] || "No more hints" : hintLabels()[state.hints + 1] || "No more hints";
  }

  // The Worker renders the shared result as both metadata and a PNG card.
  function kindOf(mode) {
    return mode === "daily" ? "Daily" : "Book";
  }

  /* The share link carries the whole result, so the page the recipient opens
     — and the crawler that unfurls it — can render the card without a
     lookup. Never the title: the link must not spoil the puzzle. */
  const b64u = {
    enc(str) {
      const bytes = new TextEncoder().encode(str);
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
    dec(str) {
      const b = str.replace(/-/g, "+").replace(/_/g, "/");
      const bin = atob(b + "=".repeat((4 - (b.length % 4)) % 4));
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    },
  };

  function sharePayload() {
    const finished = state.status === "won" || state.status === "lost";
    return b64u.enc(JSON.stringify({
      v: 2,
      c: finished ? 1 : 0,
      n: displayName().slice(0, 24),
      m: state.mode,
      w: state.status === "won" ? 1 : 0,
      g: state.guesses.length,
      h: state.hints,
    }));
  }

  function readShare(raw) {
    try {
      if (typeof raw !== "string" || raw.length > 2048) return null;
      const d = JSON.parse(b64u.dec(raw));
      if (!d || ![1, 2].includes(d.v)) return null;
      d.c = d.v === 1 ? 1 : d.c === 1 ? 1 : 0;
      d.g = Math.min(Math.max(0, d.g | 0), MAX_GUESSES);
      d.h = Math.min(Math.max(0, d.h | 0), MAX_HINTS);
      d.n = String(d.n || "A player").slice(0, 24);
      d.w = d.w ? 1 : 0;
      // Links made by older builds can carry other modes; they read as a book.
      d.m = d.m === "daily" ? "daily" : "preset";
      return d;
    } catch {
      return null;
    }
  }

  function shareUrl() {
    return `${origin()}?p=${state.playIndex}&s=${sharePayload()}`;
  }

  function origin() {
    return location.origin + location.pathname.replace(/index\.html$/, "");
  }

  function show(id) {
    $$(".screen, #game").forEach((el) => el.classList.add("hidden"));
    const el = document.getElementById(id);
    if (el) el.classList.remove("hidden");
  }
  function setMsg(t) {
    const el = $("#msg");
    if (el) el.textContent = t || "";
  }

  let awaitingInstructions = false;
  function closeModal() {
    $("#modal").classList.add("hidden");
    $("#modal-inner").innerHTML = "";
    if (awaitingInstructions) {
      awaitingInstructions = false;
      localStorage.setItem(K.seen, "1");
      if (state.puzzle && state.status === "playing") {
        saveProgress();
        startRoundTimers();
      }
    }
  }
  function setNav(open) {
    document.body.classList.toggle("nav-open", open);
    $("#nav-toggle")?.setAttribute("aria-expanded", String(open));
  }

  function openModal(html) {
    $("#modal-inner").innerHTML = html;
    $("#modal").classList.remove("hidden");
  }

  // Replay a CSS animation on an element that just changed value.
  function bump(el) {
    if (!el) return;
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
  }

  let progressCheckpointTimer = null;
  let accountProgressSyncTimer = null;
  // No clock: a player who sits with the opening for ten minutes is doing the
  // thing this game is for. Rounds are still checkpointed so a refresh or a
  // device switch resumes where you left off.
  function startRoundTimers() {
    clearInterval(progressCheckpointTimer);
    clearInterval(accountProgressSyncTimer);
    if (state.status === "playing") {
      progressCheckpointTimer = setInterval(() => saveProgress({ remote: false }), 10000);
      // Account syncs are incremental, but do not need to happen every ten
      // seconds; page exit and game actions sync immediately.
      accountProgressSyncTimer = setInterval(() => saveProgress(), 5 * 60 * 1000);
    }
  }
  function stopRoundTimers() {
    clearInterval(progressCheckpointTimer);
    clearInterval(accountProgressSyncTimer);
    progressCheckpointTimer = null;
    accountProgressSyncTimer = null;
  }

  function renderExcerpt() {
    if (!state.puzzle) return;
    const t = tiers(state.puzzle);
    const labels = hintLabels();
    const currentHints = isCurrentHints();
    const finished = state.status !== "playing";
    const idx = currentHints ? (state.hints ? 1 : 0) : (finished ? t.length - 1 : Math.min(state.hints, t.length - 1));
    // The hint count lives on the Hint button now — the label just names the tier.
    $("#tier-label").textContent = currentHints
      ? (finished ? (state.puzzle.reading?.label || "Opening section") : (state.hints ? "Opening excerpt" : "First sentence"))
      : (labels[idx] || "Excerpt");
    const ab = $("#author-reveal");
    if (ab) {
      const shown = !currentHints && (finished || state.hints >= MAX_HINTS) && state.puzzle.author;
      ab.hidden = !shown;
      if (shown) ab.textContent = `Author: ${state.puzzle.author}`;
    }
    const box = $("#excerpt");
    if (!finished) box.classList.remove("complete-reading");
    setExcerptText(box, currentHints
      ? (state.hints ? state.puzzle.openingExcerpt : state.puzzle.openingSentence)
      : (t[idx] || ""));
    // Ending a round turns this same reading surface into the complete opening
    // chapter/section. It deliberately replaces the excerpt instead of adding
    // a second copy below the result.
    if (finished && currentHints && state.puzzle.reading) renderCompletedExcerpt(box);
    box.classList.remove("fade");
    void box.offsetWidth;
    box.classList.add("fade");
    syncReader();
    const kind = state.mode === "daily" ? `Daily #${state.playIndex}` : `Book bank #${state.playIndex}`;
    $("#meta-left").textContent = kind;
    const cg = $("#count-guesses");
    const chn = $("#count-hints");
    if (cg) {
      cg.textContent = `${state.guesses.length}/${MAX_GUESSES}`;
      cg.classList.toggle("spent", state.guesses.length >= MAX_GUESSES);
    }
    if (chn) {
      chn.textContent = `${state.hints}/${MAX_HINTS}`;
      chn.classList.toggle("spent", state.hints >= MAX_HINTS);
    }
    const hb = $("#hint-btn");
    if (hb) {
      hb.disabled = state.status !== "playing" || state.hints >= MAX_HINTS;
      hb.firstChild.textContent = currentHints ? `Hint: ${nextHintLabel()} ` : "Hint ";
    }
    const facts = $("#hint-facts");
    if (facts) {
      const values = [null, state.puzzle.genre, state.puzzle.year, state.puzzle.setting, state.puzzle.author];
      // Once the book is known, the whole clue trail is part of the reveal —
      // not only the facts a player happened to spend during their round.
      const revealedFacts = finished ? MAX_HINTS : state.hints;
      facts.innerHTML = currentHints ? FACT_HINTS.slice(1, revealedFacts).map((label, i) =>
        `<div><dt>${label}</dt><dd>${escapeHtml(String(values[i + 1] || ""))}</dd></div>`).join("") : "";
      facts.hidden = !facts.innerHTML;
    }
  }

  /* Full-screen reader. It is a copy of what #excerpt shows at this moment —
     the hint tier reached during play, the whole reading once the round is
     over — so it can never reveal more than the player has unlocked. A
     history entry is pushed while it is open so the browser's Back button
     closes it, the way it would close any sheet on a phone. */
  let readerOpen = false;
  function syncReader() {
    if (!readerOpen) return;
    const src = $("#excerpt");
    const body = $("#reader-body");
    $("#reader-label").textContent = $("#tier-label").textContent;
    body.innerHTML = src.innerHTML;
    body.classList.toggle("complete-reading", src.classList.contains("complete-reading"));
  }
  function openReader() {
    if (readerOpen || !state.puzzle || state.loading) return;
    readerOpen = true;
    $("#reader").classList.remove("hidden");
    document.body.classList.add("reader-open");
    // Everything behind the overlay is out of reach of Tab and screen readers.
    $(".app").inert = true;
    history.pushState({ reader: 1 }, "");
    syncReader();
    $(".reader-scroll").scrollTop = 0;
    $("#reader-close").focus();
  }
  function closeReader({ fromHistory = false } = {}) {
    if (!readerOpen) return;
    readerOpen = false;
    $("#reader").classList.add("hidden");
    document.body.classList.remove("reader-open");
    $(".app").inert = false;
    // Closing with the button or Esc spends the entry that opening pushed.
    if (!fromHistory && history.state?.reader) history.back();
    $("#excerpt").focus({ preventScroll: true });
  }

  // Some openings name the detective, the hero, the narrator — and the name
  // alone hands over the book. Those are swapped for the pronoun the sentence
  // wants, written {{him}} in the puzzle text. Mark the swap in the rendering
  // so nobody reads the sentence as the author wrote it and hover explains it.
  const REDACTION_NOTE = "A name that would give the book away, swapped for a pronoun.";
  function setExcerptText(box, text) {
    const raw = String(text || "");
    if (!raw.includes("{{")) {
      box.textContent = raw;
      return;
    }
    box.innerHTML = escapeHtml(raw).replace(/\{\{([^{}]+)\}\}/g, (_, word) =>
      `<span class="redacted" tabindex="0" role="note" aria-label="${word}. ${REDACTION_NOTE}">(${word})<span class="redacted-tip" aria-hidden="true">${REDACTION_NOTE}</span></span>`);
  }

  function placeNote(host) {
    const tip = host?.querySelector(".redacted-tip");
    if (!tip) return;
    tip.style.setProperty("--tip-x", "0px");
    const r = tip.getBoundingClientRect();
    const pad = 8;
    let dx = 0;
    if (r.left < pad) dx = pad - r.left;
    else if (r.right > window.innerWidth - pad) dx = window.innerWidth - pad - r.right;
    tip.style.setProperty("--tip-x", `${Math.round(dx)}px`);
  }
  for (const ev of ["pointerenter", "focus"]) {
    document.addEventListener(ev, (e) => {
      const host = e.target instanceof Element ? e.target.closest(".redacted") : null;
      if (host) placeNote(host);
    }, true);
  }

  function renderCompletedExcerpt(box) {
    const data = state.reader.data;
    if (data?.paragraphs?.length) {
      box.innerHTML = data.paragraphs.map(x => `<p>${escapeHtml(x)}</p>`).join("");
      box.classList.add("complete-reading");
      return;
    }
    box.classList.remove("complete-reading");
    if (state.reader.loading) {
      box.textContent = `Loading the complete ${(state.puzzle.reading.label || "opening section").toLowerCase()}…`;
      return;
    }
    if (state.reader.error) {
      box.innerHTML = `<p>${escapeHtml(state.reader.error)}</p><button class="btn ghost" type="button" data-act="retry-reading">Try again</button>`;
      return;
    }
    state.reader.loading = true;
    box.textContent = `Loading the complete ${(state.puzzle.reading.label || "opening section").toLowerCase()}…`;
    const expected = state.puzzle.id;
    fetch(state.puzzle.reading.url)
      .then(res => {
        if (!res.ok) throw new Error("Could not load the complete opening section.");
        return res.json();
      })
      .then(data => {
        if (state.puzzle?.id !== expected || data?.puzzleId !== expected || !Array.isArray(data?.paragraphs) || !data.paragraphs.length) {
          throw new Error("Invalid reading section.");
        }
        state.reader.data = data;
      })
      .catch(() => {
        if (state.puzzle?.id === expected) state.reader.error = "Could not load the complete opening section.";
      })
      .finally(() => {
        if (state.puzzle?.id === expected) {
          state.reader.loading = false;
          renderExcerpt();
        }
      });
  }

  function retryCompletedExcerpt() {
    if (state.status === "playing" || !state.puzzle?.reading) return;
    state.reader.error = "";
    state.reader.data = null;
    state.reader.loading = false;
    renderExcerpt();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderGuesses() {
    $("#guesses").innerHTML = state.guesses
      .map((g, i) => {
        const hit = i === state.guesses.length - 1 && state.status === "won";
        return `<li><span class="n">${i + 1}</span><span class="mark">${hit ? "🟩" : "🟨"}</span><span>${escapeHtml(g)}</span></li>`;
      })
      .join("");
  }

  // Spent squares in wine, unspent left empty — the same story the share grid tells.
  function blocks(used, total, label) {
    let out = `<span class="sq-row" role="img" aria-label="${label}">`;
    for (let i = 0; i < total; i++) out += `<span class="sq${i < used ? " on" : ""}"></span>`;
    return out + "</span>";
  }

  function postGameHtml() {
    const p = state.puzzle;
    const won = state.status === "won";
    const lostLine = state.gaveUp ? "Gave up" : "Out of guesses";
    return `
      <div class="verdict ${won ? "ok" : "no"}">
        <span class="verdict-mark" aria-hidden="true">${won ? "✓" : "✕"}</span>
        <span>${won ? "Correct" : lostLine}</span>
      </div>

      <section class="pg-sec pg-book">
        <h2>${escapeHtml(stripEdition(p.title))}</h2>
        <p class="by">${escapeHtml(p.author)}</p>
        <dl class="pg-stats">
          ${p.year ? `<div><dt>Published</dt><dd>${escapeHtml(String(p.year))}</dd></div>` : ""}
          <div><dt>Book</dt><dd>#${state.playIndex}</dd></div>
        </dl>
      </section>

      <section class="pg-sec pg-effort">
        <h3>Your round</h3>
        <div class="stat-row">
          <span class="stat-k">Guesses</span>
          ${blocks(state.guesses.length, MAX_GUESSES, `${state.guesses.length} of ${MAX_GUESSES} guesses used`)}
        </div>
        <div class="stat-row">
          <span class="stat-k">Hints</span>
          ${blocks(state.hints, MAX_HINTS, `${state.hints} of ${MAX_HINTS} hints used`)}
        </div>
      </section>

      ${won && !window.BookleAuth?.session?.() ? `<section class="pg-sec pg-save">
        <button class="btn" type="button" data-act="open-auth">Sign in to save your result</button>
      </section>` : ""}

      <div class="row pg-actions">
        <button class="btn" type="button" data-act="share">Share</button>
        <a class="btn ghost" href="${p.source?.url || "https://www.gutenberg.org/"}" target="_blank" rel="noopener">Read the full book →</a>
      </div>
    `;
  }

  // Playing: story first, "guess more" under it. Finished: CTA on top, then the
  // result card, then the excerpt — opened to its full length once solved, and
  // as far as it was revealed if the guesses ran out.
  function placeMore(done) {
    const more = $("#more");
    const game = $("#game");
    const card = $(".daily-card");
    if (!more || !game || !card) return;
    if (done) game.insertBefore(more, card);
    else game.insertBefore(more, card.nextSibling);
    card.classList.toggle("done", done);
  }

  function renderResult({ refreshAd = true } = {}) {
    const box = $("#result");
    const form = $("#form");
    const more = $("#more");
    if (state.status === "playing") {
      box.classList.add("hidden");
      form.classList.remove("hidden");
      if (more) more.classList.remove("hidden");
      placeMore(false);
      window.ExcerptleAds?.clear();
      elsewhere();
      return;
    }
    form.classList.add("hidden");
    if (more) more.classList.remove("hidden");
    placeMore(true);
    box.classList.remove("hidden");
    box.innerHTML = postGameHtml();
    // Fresh <ins> per finished game — see js/ads.js.
    if (refreshAd) window.ExcerptleAds?.render();
    elsewhere();
  }

  /* Links to our other sites: shown both during and after a round. The
     markup starts hidden so it can't flash before the first puzzle is up. */
  function elsewhere() {
    document.getElementById("elsewhere")?.classList.remove("hidden");
  }

  function recordFinish() {
    stopRoundTimers();
    saveProgress();
  }

  function onHint() {
    if (state.loading || !state.puzzle) return;
    if (state.status !== "playing") return;
    armGiveUp(false);
    if (state.hints >= MAX_HINTS) {
      setMsg("No more hints.");
      return;
    }
    state.hints += 1;
    setMsg(isCurrentHints() ? `${FACT_HINTS[state.hints - 1]} revealed.` : "");
    saveProgress();
    renderExcerpt();
    bump($("#count-hints"));
    bump($("#tier-label"));
  }

  // Two taps, because one stray tap must not be able to end a round. The arm
  // clears on any other move, so it cannot lie in wait across a game.
  let giveUpArmed = false;
  function armGiveUp(on) {
    giveUpArmed = on;
    const btn = $("#give-up");
    if (btn) btn.textContent = on ? "Tap again to reveal" : "Give up";
  }
  function onGiveUp() {
    if (state.loading || !state.puzzle) return;
    if (state.status !== "playing") return;
    if (!giveUpArmed) {
      armGiveUp(true);
      setMsg("Give up and see the answer? Tap again to confirm.");
      return;
    }
    armGiveUp(false);
    state.status = "lost";
    state.gaveUp = true;
    setMsg("");
    recordFinish();
    renderExcerpt();
    renderGuesses();
    renderResult();
  }

  function onGuess(raw) {
    if (state.loading || !state.puzzle) return;
    if (state.status !== "playing") return;
    armGiveUp(false);
    const guess = raw.trim();
    if (!guess) {
      setMsg("Type a title, or take a hint.");
      return;
    }
    if (state.guesses.some((g) => fold(g) === fold(guess))) {
      setMsg("Already guessed.");
      return;
    }
    state.guesses.push(guess);
    if (isMatch(guess, state.puzzle)) {
      state.status = "won";
      setMsg("");
      recordFinish();
    } else if (state.guesses.length >= MAX_GUESSES) {
      state.status = "lost";
      setMsg("No more guesses.");
      recordFinish();
    } else {
      const partial = partialMatch(guess, state.puzzle);
      setMsg(partial
        ? `You’re on the right track — ${partial.missing} key title word${partial.missing === 1 ? "" : "s"} to go.`
        : "Not it — take a hint, or try another title.");
      saveProgress();
    }
    renderExcerpt();
    renderGuesses();
    renderResult();
    bump($("#count-guesses"));
  }

  let playRequest = 0;
  async function startPlay({ playIndex, mode, resume = true, fresh = false, showHow = true }) {
    const request = ++playRequest;
    state.loading = true;
    clearInterval(progressCheckpointTimer);
    clearInterval(accountProgressSyncTimer);
    progressCheckpointTimer = null;
    accountProgressSyncTimer = null;
    await loadIndex();
    if (request !== playRequest) return;
    // Don't expose the previous round's input while the next puzzle loads:
    // startPlay clears it on arrival, which would erase a fast user's guess.
    $("#form").classList.add("hidden");
    $("#result").classList.add("hidden");
    $("#excerpt").textContent = "Loading…";
    $("#author-reveal").hidden = true;
    $("#guesses").innerHTML = "";
    state.puzzle = null;
    state.reader = { loading: false, data: null, error: "" };
    show("game");
    state.mode = mode || (playIndex >= (state.index.dailyStartIndex ?? 600) ? "daily" : "preset");
    state.playIndex = playIndex;
    const todayDaily = dailyIndexNow();
    // Every exit from here clears `loading`: leaving it set would make the flag
    // a lie for anything that later reads it on its own.
    const bail = (text) => { state.loading = false; $("#excerpt").textContent = text; };
    if (!Number.isSafeInteger(playIndex) || playIndex < 0 || (state.mode !== "daily" && playIndex >= presetCount())) {
      bail("Puzzle not in the bank yet.");
      return;
    }
    if (state.mode === "daily" && playIndex > todayDaily) {
      bail("That daily isn’t out yet.");
      $("#form").classList.add("hidden");
      return;
    }
    const slug = slugForIndex(playIndex);
    if (!slug) {
      bail("Puzzle not in the bank yet.");
      return;
    }
    let puzzle;
    try {
      puzzle = await loadPuzzle(slug);
    } catch {
      if (request === playRequest) bail("Could not load this book. Reload the page or choose another book.");
      return;
    }
    if (request !== playRequest) return;
    state.puzzle = puzzle;
    state.loading = false;
    const saved = resume ? progressMap()[String(playIndex)] : null;
    if (!fresh && saved && saved.puzzleId === state.puzzle.id) {
      state.guesses = saved.guesses || [];
      state.hints = saved.hints || 0;
      state.status = saved.status || "playing";
      state.gaveUp = !!saved.gaveUp;
    } else {
      state.guesses = [];
      state.hints = 0;
      state.status = "playing";
      state.gaveUp = false;
    }
    armGiveUp(false);
    setMsg("");
    const input = $("#guess-input");
    if (input) input.value = "";
    renderExcerpt();
    renderGuesses();
    renderResult();
    if (showHow && !localStorage.getItem(K.seen)) {
      awaitingInstructions = true;
      openHow();
    } else {
      // This first checkpoint covers a refresh immediately after the round opens.
      if (state.status === "playing") saveProgress();
      startRoundTimers();
    }
  }

  function presetCount() {
    return state.index?.presetCount || state.index?.order?.length || 1;
  }

  function randomPresetIndex(exclude) {
    const n = presetCount();
    if (n <= 1) return 0;
    let x = Math.floor(Math.random() * n);
    if (x === exclude) x = (x + 1) % n;
    return x;
  }

  function playRandom() {
    closeModal();
    const n = randomPresetIndex(state.playIndex);
    location.hash = `#/play/${n}`;
  }

  function playById(raw) {
    const n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 0) {
      pickError("Enter a book ID.");
      return;
    }
    const today = dailyIndexNow();
    const maxPreset = presetCount();
    const ok = (n >= 0 && n < maxPreset) || (n >= (state.index.dailyStartIndex ?? 600) && n <= today);
    if (!ok) {
      pickError(`No book #${n} yet. Try 0–${maxPreset - 1}, or a daily up to #${today}.`);
      return;
    }
    closeModal();
    location.hash = `#/play/${n}`;
  }

  function playChoicesHtml() {
    const d = dailyIndexNow();
    const done = progressMap()[String(d)];
    const finished = done?.status === "won" || done?.status === "lost";
    const max = presetCount();
    return `
      <button class="modal-x" type="button" data-act="close-modal" aria-label="Close">×</button>
      <h2>New game</h2>

      <div class="choice">
        <span class="choice-text"><b>Today’s daily</b><span>${finished ? "You’ve already completed today’s" : `Daily #${d}`}</span></span>
        <span class="choice-go">
          <button class="btn" type="button" data-act="pick-today">Guess</button>
        </span>
      </div>

      <div class="choice">
        <span class="choice-text">
          <b>Random book</b>
          <span>From <a href="#/bank" data-act="close-modal">All Books</a></span>
        </span>
        <span class="choice-go">
          <button class="btn" type="button" data-act="pick-random">Guess</button>
        </span>
      </div>

      <div class="choice">
        <span class="choice-text"><b>Choose by ID</b><span>Book bank #0–#${max - 1}</span></span>
        <span class="choice-go">
          <input id="play-id-input" type="number" min="0" max="${max - 1}" placeholder="e.g. 42" inputmode="numeric">
          <button class="btn" type="button" data-act="pick-id">Guess</button>
        </span>
      </div>
      <p class="auth-err" id="choice-err"></p>
    `;
  }

  function pickIndex(n) {
    closeModal();
    const target = `#/play/${n}`;
    // Setting the hash routes for us; if we're already there it won't fire.
    if (location.hash === target) startPlay({ playIndex: n, mode: "preset" });
    else location.hash = target;
  }

  /* What a recipient sees on arrival. Result only — no title, no excerpt
     detail — so opening a friend's link never spoils the book. */
  function sharedResultHtml(d, idx) {
    const score = d.w ? `${d.g}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
    // Same spent-squares readout as the post-game panel, so a result looks
    // the same whether you earned it or were sent it.
    return `
      <button class="modal-x" type="button" data-act="close-modal" aria-label="Close">×</button>
      <div class="share-card">
        <p class="sc-who"><b>${escapeHtml(d.n)}</b> ${d.w ? "solved" : "played"} ${kindOf(d.m)} #${idx}</p>
        <p class="sc-score">${escapeHtml(score)}</p>
        <div class="sc-stats">
          <div class="stat-row">
            <span class="stat-k">Guesses</span>
            ${blocks(d.g, MAX_GUESSES, `${d.g} of ${MAX_GUESSES} guesses used`)}
          </div>
          <div class="stat-row">
            <span class="stat-k">Hints</span>
            ${blocks(d.h, MAX_HINTS, `${d.h} of ${MAX_HINTS} hints used`)}
          </div>
        </div>
      </div>
      <p class="lede sc-cta">Check out this book.</p>
      <button class="btn full" type="button" data-act="close-modal">Play #${idx}</button>
    `;
  }

  function openPlay() {
    openModal(playChoicesHtml());
  }

  // setMsg writes to the game screen, which a modal covers. Prefer the
  // modal's own error line whenever one is on screen.
  function pickError(msg) {
    const el = $("#choice-err");
    if (el) el.textContent = msg || "";
    else setMsg(msg);
  }

  // Every one of these steps is a network round trip; a button that goes quiet
  // and stays clickable is how you get two sign-in attempts.
  function authBusy(btn, label) {
    if (!btn) return () => {};
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    return () => {
      if (!btn.isConnected) return;
      btn.disabled = false;
      btn.textContent = was;
    };
  }

  function authError(msg) {
    const el = $("#auth-err");
    if (el) el.textContent = msg || "";
  }

  function openAuth(step, email, extra) {
    const gSvg = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13.2 24 13.2c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.1 4 9.2 8.5 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.3 35.1 26.8 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.1 39.4 16 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1.1 3.2-3.5 5.7-6.6 7.1l6.3 5.3C37.8 38.3 44 32.5 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>`;
    if (step === "password") {
      openModal(`
        <button class="modal-x" type="button" data-act="close-modal" aria-label="Close">×</button>
        <h2>Welcome back</h2>
        <p class="lede">Signing in as <strong>${escapeHtml(email)}</strong>.</p>
        <div class="auth-stack">
          <label class="sr-only" for="auth-pass">Password</label>
          <input id="auth-pass" type="password" autocomplete="current-password" placeholder="Password">
          <button class="btn full" type="button" data-act="auth-password">Sign in</button>
        </div>
        <p class="auth-err" id="auth-err"></p>
        <p class="lede">Forgotten it? A code works just as well.</p>
        <p><button class="btn ghost" type="button" data-act="auth-use-code">Email me a code instead</button>
           <button class="btn ghost" type="button" data-act="open-auth">Use a different email</button></p>
      `);
      window._bookleEmail = email;
      $("#auth-pass")?.focus();
      return;
    }
    /* Offered once, right after a code has done its job — the one moment we
       know the address is real and the person is already here. Skipping is a
       real answer: Settings has the same box. */
    if (step === "set-password") {
      openModal(`
        <button class="modal-x" type="button" data-act="close-modal" aria-label="Close">×</button>
        <h2>Set a password?</h2>
        <p class="lede">You're signed in. Add a password and next time you can go straight in, without waiting for a code.</p>
        <div class="auth-stack">
          <label class="sr-only" for="auth-newpass">New password</label>
          <input id="auth-newpass" type="password" autocomplete="new-password" placeholder="New password (8+ characters)">
          <button class="btn full" type="button" data-act="auth-set-password">Save password</button>
        </div>
        <p class="lede pw-note">Your password is scrambled on this device before it is sent. That takes a moment on an older phone.</p>
        <p class="auth-err" id="auth-err"></p>
        <p><button class="btn ghost" type="button" data-act="close-modal">Not now</button></p>
        <p class="lede">You can always set one later under Settings.</p>
      `);
      $("#auth-newpass")?.focus();
      return;
    }
    if (step === "verify") {
      openModal(`
        <button class="modal-x" type="button" data-act="close-modal" aria-label="Close">×</button>
        <h2>Check your email</h2>
        <p class="lede">We sent a 6-digit code to <strong>${escapeHtml(email)}</strong>.</p>
        ${extra?.hasPassword ? `<p class="lede">Signing in with a code is fine — your password still works next time.</p>` : ""}
        ${extra?.demoCode ? `<p class="lede">Dev (no mail server yet): your code is <strong>${extra.demoCode}</strong></p>` : ""}
        <div class="auth-stack">
          <input id="auth-code" inputmode="numeric" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code">
          <button class="btn full" type="button" data-act="auth-code">Verify code</button>
        </div>
        <p class="auth-err" id="auth-err"></p>
        <p><button class="btn ghost" type="button" data-act="auth-resend">Send a new code</button>
           <button class="btn ghost" type="button" data-act="open-auth">Use a different email</button></p>
      `);
      window._bookleEmail = email;
      return;
    }
    openModal(`
      <button class="modal-x" type="button" data-act="close-modal" aria-label="Close">×</button>
      <h2>Sign in or sign up</h2>
      <p class="lede">Sign in with Google, a password, or an email code to manage your account.</p>
      <button class="btn google" type="button" data-act="auth-google">${gSvg} Continue with Google</button>
      <div class="or-line">or</div>
      <div class="auth-stack">
        <label class="sr-only" for="auth-email">Email</label>
        <input id="auth-email" type="email" placeholder="you@example.com" autocomplete="email">
        <button class="btn full" type="button" data-act="auth-email">Continue</button>
      </div>
      <p class="auth-err" id="auth-err"></p>
    `);
  }

  function openAccount() {
    const s = window.BookleAuth.session();
    if (!s) return openAuth();
    openModal(`
      <button class="modal-x" type="button" data-act="close-modal" aria-label="Close">×</button>
      <h2>Account</h2>
      <p><strong>Email</strong><br>${escapeHtml(s.email)}</p>
      <p><strong>Sign-in method</strong><br>${s.provider === "google" ? "Google" : s.provider === "password" ? "Password" : "Email code"}</p>
      <p><strong>Password</strong><br>${window.BookleAuth.hasPassword() ? "Set" : "Not set — add one in Settings"}</p>
      <p><button class="btn ghost" type="button" data-act="sign-out">Sign out</button></p>
    `);
  }
  function openHow() {
    openModal(`
      <button class="modal-x" type="button" data-act="close-modal" aria-label="Close">×</button>
      <h2>How to play</h2>
      <p class="how-intro">You see the <strong>first sentence</strong> of a book. Name it in <strong>six guesses</strong>. Stuck? Each hint stays visible:</p>
      <table class="how-table">
        <tbody>
          <tr><th>Start</th><td>The first sentence</td></tr>
          <tr><th>Hint 1</th><td>The book’s opening paragraphs</td></tr>
          <tr><th>Hint 2</th><td>Genre</td></tr>
          <tr><th>Hint 3</th><td>Original publication date (approximate dates for ancient works)</td></tr>
          <tr><th>Hint 4</th><td>Setting</td></tr>
          <tr><th>Hint 5</th><td>Author</td></tr>
        </tbody>
      </table>
      <ul class="how-notes">
        <li>Wrong guesses don’t reveal anything. <strong>Close spelling counts</strong>; “The” is optional.</li>
        <li>Fewer hints and guesses means a better score.</li>
        <li><strong>Give up</strong> names the book and counts as a miss. After the round you can read the opening chapter.</li>
      </ul>
      <p><button class="btn" type="button" data-act="close-modal">Close</button></p>
    `);
  }

  /* "1 … 4 5 6 … 12": the first and last page, the current one and its
     neighbours, with an ellipsis only where it hides two pages or more (one
     hidden page is shown instead — "…" would be no shorter). */
  function pageList(page, max) {
    if (max <= 7) return Array.from({ length: max }, (_, i) => i + 1);
    const keep = [...new Set([1, page - 1, page, page + 1, max])].filter((n) => n >= 1 && n <= max).sort((a, b) => a - b);
    const out = [];
    for (const n of keep) {
      const prev = out[out.length - 1];
      if (prev && n - prev === 2) out.push(prev + 1);
      else if (prev && n - prev > 2) out.push("…");
      out.push(n);
    }
    return out;
  }

  function renderBank() {
    show("screen-bank");
    const presets = state.index.presetCount || state.index.order.length;
    const filter = $("#bank-filter").value;
    const status = $("#bank-status")?.value || "all";
    const prog = progressMap();
    const today = dailyIndexNow();
    const pageSize = 100;
    const params = new URLSearchParams(location.hash.split("?")[1] || location.search);
    let page = parseInt(params.get("page") || "1", 10) || 1;
    let items = [];
    if (filter !== "daily") {
      for (let i = 0; i < presets; i++) items.push(i);
    }
    if (filter !== "preset") {
      for (let i = state.index.dailyStartIndex; i <= today; i++) items.push(i);
    }
    // Narrowed by what this browser has actually played, read out of the
    // progress map.
    if (status !== "all") {
      items = items.filter((n) => {
        const st = prog[String(n)]?.status;
        if (status === "won") return st === "won";
        if (status === "done") return st === "won" || st === "lost";
        return st !== "won" && st !== "lost";
      });
    }
    const jump = parseInt($("#bank-jump").value, 10);
    if (Number.isInteger(jump)) {
      const idx = items.indexOf(jump);
      if (idx >= 0) page = Math.floor(idx / pageSize) + 1;
    }
    const maxPage = Math.max(1, Math.ceil(items.length / pageSize));
    page = Math.min(page, maxPage);
    const slice = items.slice((page - 1) * pageSize, page * pageSize);
    if (!items.length) {
      $("#bank-grid").innerHTML = `<p class="lede">${status === "todo"
        ? "You have finished every book in this list."
        : "Nothing here yet — finish a book and it shows up."}</p>`;
      $("#bank-pager").innerHTML = "";
      return;
    }
    $("#bank-grid").innerHTML = slice
      .map((n) => {
        const row = prog[String(n)];
        const st = row?.status;
        const cls = st === "won" ? "won" : st === "lost" ? "lost" : st === "playing" ? "play" : "";
        // Naming a book you have already finished spoils nothing and turns the
        // grid into a record of what you have read — missed ones included.
        // Rounds finished before the title was recorded fall back to a mark.
        const done = st === "won" || st === "lost";
        const label = done && row.title
          ? `<span class="bank-n">#${n}</span><span class="bank-t">${escapeHtml(row.title)}</span>`
          : `#${n}${done ? `<span class="bank-tick" aria-hidden="true">${st === "won" ? "\u2713" : "\u2715"}</span>` : ""}`;
        const aria = done ? ` aria-label="#${n}${row.title ? `, ${escapeHtml(row.title)}` : ""}, ${st === "won" ? "guessed" : "missed"}"` : "";
        return `<a class="bank-cell ${cls}"${aria} href="#/play/${n}">${label}</a>`;
      })
      .join("");
    $("#bank-pager").innerHTML = `
      ${page > 1 ? `<button class="btn ghost" type="button" data-page="${page - 1}">Prev</button>` : `<span class="pager-gap"></span>`}
      ${pageList(page, maxPage).map((n) => n === "…" ? `<span class="pager-dots" aria-hidden="true">…</span>`
        : `<button class="btn pager-n${n === page ? "" : " ghost"}" type="button" data-page="${n}"${n === page ? ' aria-current="page"' : ""} aria-label="Page ${n}">${n}</button>`).join("")}
      ${page < maxPage ? `<button class="btn ghost" type="button" data-page="${page + 1}">Next</button>` : `<span class="pager-gap"></span>`}`;
  }

  /* Everything the player has actually done, read back out of the progress
     map. */
  function summarize() {
    const base = state.index?.dailyStartIndex ?? 600;
    const blank = () => ({ played: 0, wins: 0, losses: 0, hints: 0, guesses: 0 });
    const books = blank();
    const daily = blank();
    // Rounds finished before the game recorded authors have none, so this
    // undercounts old play rather than inventing a number for it.
    const authors = new Set();

    for (const [k, r] of Object.entries(progressMap())) {
      if (!r || r.status === "playing") continue;
      const bucket = parseInt(k, 10) >= base ? daily : books;
      bucket.played += 1;
      bucket.hints += r.hints || 0;
      bucket.guesses += (r.guesses || []).length;
      if (r.status === "won") {
        bucket.wins += 1;
        if (r.author) authors.add(r.author);
      } else {
        bucket.losses += 1;
      }
    }
    const all = blank();
    for (const b of [books, daily]) {
      all.played += b.played; all.wins += b.wins; all.losses += b.losses;
      all.hints += b.hints; all.guesses += b.guesses;
    }
    return { all, books, daily, authors: authors.size };
  }

  function pct(n, d) {
    return d ? `${Math.round((n / d) * 100)}%` : "—";
  }
  function avg(n, d) {
    return d ? (n / d).toFixed(1) : "—";
  }
  function tile(value, label) {
    return `<div><b>${value}</b><span>${label}</span></div>`;
  }

  /* The month the calendar is showing, as "YYYY-MM". Kept for the tab so a
     trip into a day and back lands where you were; sessionStorage can throw
     (private windows, blocked storage), and the calendar works without it. */
  const CAL_KEY = "excerptle.calMonth";
  let calShown = null;
  function calMonth() {
    const start = (state.index?.startDate || START).slice(0, 7);
    const now = gameDate().slice(0, 7);
    let m = calShown;
    if (!m) {
      try { m = sessionStorage.getItem(CAL_KEY); } catch { /* default below */ }
    }
    if (!/^\d{4}-\d{2}$/.test(m || "")) m = now;
    return m < start ? start : m > now ? now : m;
  }
  function stepCalendar(by) {
    const [y, mo] = calMonth().split("-").map(Number);
    const d = new Date(Date.UTC(y, mo - 1 + by, 1));
    calShown = d.toISOString().slice(0, 7);
    try { sessionStorage.setItem(CAL_KEY, calMonth()); } catch { /* not remembered */ }
    calShown = calMonth(); // clamped to the first daily and the current month
    renderStats();
  }

  /* One month of dailies. A day's index is its date (dateForDailyIndex's
     inverse), so each cell can be coloured from the same progress map the
     rest of Stats reads, and links straight to that book. */
  function calendarHtml() {
    const start = state.index?.startDate || START;
    const base = state.index?.dailyStartIndex ?? 600;
    const today = gameDate();
    const month = calMonth();
    const [y, mo] = month.split("-").map(Number);
    const lead = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const prog = progressMap();
    const label = new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
    const first = month <= start.slice(0, 7);
    const last = month >= today.slice(0, 7);
    let cells = "";
    for (let i = 0; i < lead; i++) cells += `<span class="cal-pad"></span>`;
    for (let d = 1; d <= days; d++) {
      const iso = `${month}-${String(d).padStart(2, "0")}`;
      const name = new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" });
      if (iso < start || iso > today) {
        cells += `<span class="cal-day off" aria-label="${name}, ${iso < start ? "before the first daily" : "not out yet"}">${d}</span>`;
        continue;
      }
      const index = base + daysBetween(start, iso);
      const row = prog[String(index)];
      const st = row?.status === "won" ? "won" : row?.status === "lost" ? "lost"
        : row && (row.guesses?.length || row.hints) ? "play" : "";
      const word = { won: "solved", lost: "missed", play: "in progress", "": "not played" }[st];
      const mark = st === "won" ? `<i aria-hidden="true">\u2713</i>` : st === "lost" ? `<i aria-hidden="true">\u2715</i>` : "";
      cells += `<a class="cal-day ${st}${iso === today ? " today" : ""}" href="#/play/${index}" aria-label="${name}, ${word}"${iso === today ? ' aria-current="date"' : ""}>${d}${mark}</a>`;
    }
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((n) => `<span aria-hidden="true">${n}</span>`).join("");
    return `
      <section class="s-block" id="cal">
        <h2>Daily calendar</h2>
        <div class="cal-nav">
          <button type="button" class="btn ghost sm" data-act="cal-prev" aria-label="Previous month"${first ? " disabled" : ""}>\u2039</button>
          <span class="cal-month" aria-live="polite">${label}</span>
          <button type="button" class="btn ghost sm" data-act="cal-next" aria-label="Next month"${last ? " disabled" : ""}>\u203a</button>
        </div>
        <div class="cal-grid">${dow}${cells}</div>
      </section>`;
  }

  function renderStats() {
    show("screen-stats");
    const { all, books, daily, authors } = summarize();
    const streaks = dailyStreaks();
    const rows = (...pairs) =>
      `<dl class="pg-stats">${pairs.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;

    /* Daily and Book bank are two ways of playing the same game, so they share
       one type scale. The page title is the only level above them. */
    $("#stats-body").innerHTML = `
      ${calendarHtml()}

      <section class="s-block">
        <h2>Books discovered</h2>
        <div class="stat-grid">
          ${tile(all.wins, "Books")}
          ${tile(authors || "—", "Authors")}
          ${tile(all.played, "Openings read")}
        </div>
      </section>

      <section class="s-block">
        <h2>Daily</h2>
        <div class="stat-grid">
          ${tile(daily.wins, "Completed")}
          ${tile(streaks.current, "Streak")}
          ${tile(streaks.best, "Best streak")}
          ${tile(pct(daily.wins, daily.played), "Win rate")}
        </div>
        ${rows(["Avg guesses", avg(daily.guesses, daily.played)],
               ["Avg hints", avg(daily.hints, daily.played)])}
      </section>

      <section class="s-block">
        <h2>Book bank</h2>
        <div class="stat-grid">
          ${tile(books.wins, "Completed")}
          ${tile(books.played, "Played")}
          ${tile(pct(books.wins, books.played), "Win rate")}
        </div>
        ${rows(["Avg guesses", avg(books.guesses, books.played)],
               ["Avg hints", avg(books.hints, books.played)])}
      </section>
    `;
  }

  /* The same offer as the post-code modal, for anyone who said "not now" —
     and the only way to change or drop a password once it exists. */
  function renderPasswordBox() {
    const box = $("#password-box");
    if (!box) return;
    const s = window.BookleAuth?.session?.();
    if (!s) { box.innerHTML = ""; return; }
    const has = window.BookleAuth.hasPassword();
    box.innerHTML = `
      <h2 class="pw-title">Password</h2>
      <p class="lede">${has
        ? "You can sign in with your password or an email code — either one."
        : "No password yet. Set one to sign in without waiting for an email code."}</p>
      <div class="auth-stack">
        ${has ? `<input id="pw-current" type="password" autocomplete="current-password" placeholder="Current password">` : ""}
        <input id="pw-new" type="password" autocomplete="new-password" placeholder="New password (8+ characters)">
        <button class="btn" type="button" data-act="pw-save">${has ? "Change password" : "Save password"}</button>
        ${has ? `<button class="btn ghost" type="button" data-act="pw-remove">Remove password</button>` : ""}
      </div>
      <p class="auth-err" id="pw-err"></p>`;
  }

  function renderSettings() {
    show("screen-settings");
    $("#theme").value = state.settings.theme;
    $("#display-name").value = displayName() === "Anonymous" ? "" : displayName();
    paintAuth();
    renderPasswordBox();
  }

  async function saveDisplayName() {
    const field = $("#display-name");
    const status = $("#name-status");
    const button = $("[data-act='save-name']");
    const draft = String(field?.value || "").trim().replace(/\s+/g, " ");
    if ([...draft].length > 24 || /[\u0000-\u001f\u007f]/.test(draft)) {
      if (status) status.textContent = "Use up to 24 visible characters.";
      return;
    }
    if (button) button.disabled = true;
    if (status) status.textContent = "Saving…";
    try {
      const auth = window.BookleAuth?.session?.();
      const name = auth ? (await window.BookleAuth.updateProfile(draft)).name : (draft || "Anonymous");
      if (!auth) localStorage.setItem(K.name, name);
      if (field) field.value = name === "Anonymous" ? "" : name;
      if (status) status.textContent = auth ? "Saved to your account." : "Saved on this device.";
      paintAuth();
      if (state.status !== "playing") {
        renderResult({ refreshAd: false });
      }
    } catch (err) {
      if (status) status.textContent = err.message || "Could not save your name.";
    } finally {
      if (button) button.disabled = false;
    }
  }

  function route() {
    const params = new URLSearchParams(location.search);
    const hash = (location.hash || "#/").replace(/^#/, "");
    const parts = hash.split("?")[0].split("/").filter(Boolean);
    const qPlay = params.get("p");
    const qShare = params.get("s");
    if (qPlay && !parts.length) return { page: "play", playIndex: parseInt(qPlay, 10), share: qShare };
    const page = parts[0] || "home";
    if (page === "play" && parts[1]) return { page: "play", playIndex: parseInt(parts[1], 10) };
    return { page, playIndex: qPlay ? parseInt(qPlay, 10) : undefined };
  }

  /* The tab has to say which screen you're on: every hash route names itself.
     The daily is the landing page, so it keeps the plain title. */
  const TITLES = {
    home: "Guess The Book",
    bank: "All Books",
    stats: "Stats",
    settings: "Settings",
    legal: "Privacy & Terms",
    news: "News",
  };
  function setTitle(page, playIndex) {
    let name = TITLES[page] || TITLES.home;
    // Never the book: a title in the tab would spoil the puzzle outright.
    if (page === "play" && Number.isInteger(playIndex) && playIndex >= 0) {
      const daily = playIndex >= (state.index?.dailyStartIndex ?? 600);
      name = daily ? TITLES.home : `Book #${playIndex}`;
    }
    document.title = `Excerptle | ${name}`;
  }

  function params0() {
    return new URLSearchParams(location.search);
  }

  const KNOWN_PAGES = new Set(["home", "bank", "stats", "settings", "legal", "news", "play", "new", "signin", "account"]);

  async function go() {
    ++playRequest; // Invalidate requests even when leaving for a non-game screen.
    stopRoundTimers();
    applyTheme();
    playerId();
    paintAuth();
    try {
      await loadIndex();
    } catch {
      show("game");
      $("#excerpt").textContent = "Serve this folder over HTTP so puzzles can load.";
      return;
    }
    const r = route();
    // Consume ?b= (old invite links) / ?p= / ?s= once. Left in place they
    // hijack every later navigation back to "#/".
    if (location.search && (params0().get("b") || params0().get("p") || params0().get("s"))) {
      history.replaceState(null, "", location.pathname + location.hash);
    }
    setTitle(r.page, r.playIndex);
    // Screens that no longer exist (the old standings and head-to-head routes)
    // land on the daily, with the dead hash spent, rather than a blank screen.
    if (!KNOWN_PAGES.has(r.page)) {
      history.replaceState(null, "", location.pathname + "#/");
      return startPlay({ playIndex: dailyIndexNow(), mode: "daily" });
    }
    const screens = { news: "screen-news", settings: "screen-settings", legal: "screen-legal" };
    if (r.page === "bank") return renderBank();
    if (r.page === "stats") return renderStats();
    if (r.page === "settings") return renderSettings();
    /* One-shot modal routes: how the static pages' header — which carries the
       same tabs but no js/app.js — asks for a modal only the game can open.
       Left in the URL any of them would reopen on every reload, so spend the
       hash and land on the daily behind the modal. */
    const oneShot = { new: openPlay, signin: openAuth, account: openAccount };
    if (oneShot[r.page]) {
      history.replaceState(null, "", location.pathname + "#/");
      await startPlay({ playIndex: dailyIndexNow(), mode: "daily" });
      oneShot[r.page]();
      return;
    }
    if (screens[r.page]) return show(screens[r.page]);
    if (r.page === "play" && Number.isInteger(r.playIndex) && r.playIndex >= 0) {
      const mode = r.playIndex >= (state.index.dailyStartIndex ?? 600) ? "daily" : "preset";
      const shared = r.share ? readShare(r.share) : null;
      await startPlay({ playIndex: r.playIndex, mode, showHow: !shared?.c });
      // The friend's card lands on top of the puzzle they were beaten on.
      if (shared?.c) openModal(sharedResultHtml(shared, r.playIndex));
      return;
    }
    return startPlay({ playIndex: dailyIndexNow(), mode: "daily" });
  }

  document.addEventListener("submit", (e) => {
    if (e.target.closest("#form")) {
      e.preventDefault();
      onGuess($("#guess-input").value);
      $("#guess-input").value = "";
      $("#guess-input")?.focus();
    }
    if (e.target.closest("#jump-form")) {
      e.preventDefault();
      const el = $("#jump-input");
      playById(el.value);
      el.value = "";
      el.blur();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".redacted.open").forEach(el => el.classList.remove("open"));
    if (e.key === "Enter" && e.target?.id === "play-id-input") {
      e.preventDefault();
      playById(e.target.value);
    }
    if (e.key === "Enter" && e.target?.id === "auth-email") {
      e.preventDefault();
      document.querySelector('[data-act="auth-email"]')?.click();
    }
    if (e.key === "Enter" && e.target?.id === "auth-pass") {
      e.preventDefault();
      document.querySelector('[data-act="auth-password"]')?.click();
    }
    if (e.key === "Enter" && e.target?.id === "auth-newpass") {
      e.preventDefault();
      document.querySelector('[data-act="auth-set-password"]')?.click();
    }
    if (e.key === "Enter" && (e.target?.id === "pw-new" || e.target?.id === "pw-current")) {
      e.preventDefault();
      document.querySelector('[data-act="pw-save"]')?.click();
    }
    if (e.key === "Enter" && e.target?.id === "auth-code") {
      e.preventDefault();
      document.querySelector('[data-act="auth-code"]')?.click();
    }
  });

  document.addEventListener("click", async (e) => {
    const pageBtn = e.target.closest("[data-page]");
    if (pageBtn) {
      location.hash = `#/bank?page=${pageBtn.dataset.page}`;
      return;
    }
    const note = e.target.closest(".redacted");
    document.querySelectorAll(".redacted.open").forEach(el => {
      if (el !== note) el.classList.remove("open");
    });
    if (note) {
      note.classList.toggle("open");
      if (note.classList.contains("open")) placeNote(note);
      return;
    }
    // The excerpt is itself the "read full screen" control. A drag that ended
    // as a click is a text selection, and a button or link inside it (the
    // retry after a failed chapter load) keeps its own job.
    if ((e.target.closest("#excerpt") || e.target.closest(".reader-hint")) && !e.target.closest("button, a")) {
      if (!String(getSelection() || "")) openReader();
      return;
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) {
      if (!e.target.closest("#main-nav")) setNav(false);
      return;
    }
    if (act === "toggle-nav") {
      setNav(!document.body.classList.contains("nav-open"));
      return;
    }
    // Any other action is a navigation — close the menu behind it.
    setNav(false);
    if (act === "close-modal") closeModal();
    if (act === "close-reader") closeReader();
    if (act === "open-play") openPlay();
    if (act === "open-how") openHow();
    if (act === "open-auth") openAuth();
    if (act === "open-account") openAccount();
    if (act === "sign-out") {
      window.BookleAuth.signOut();
      closeModal();
      paintAuth();
    }
    if (act === "auth-google") {
      authError("");
      try {
        await window.BookleAuth.googleSignIn();
        closeModal();
        paintAuth();
      } catch (err) {
        authError(err.message || String(err));
      }
    }
    if (act === "auth-email") {
      const email = ($("#auth-email")?.value || "").trim();
      if (!window.BookleAuth.validEmail(email)) {
        authError("Enter a valid email.");
        return;
      }
      authError("");
      const btn = e.target.closest("[data-act]");
      const busy = authBusy(btn, "Checking…");
      try {
        // Ask first: a returning account with a password should never be made
        // to wait on an email that it does not need.
        const who = await window.BookleAuth.checkEmail(email);
        if (who.account && who.hasPassword) {
          // Carried across so the password screen doesn't ask a second time.
          window._bookleKdf = who.kdf;
          return openAuth("password", email);
        }
        openAuth("verify", email, await window.BookleAuth.sendCode(email));
      } catch (err) {
        authError(err.message || String(err));
      } finally {
        busy();
      }
    }
    if (act === "auth-password") {
      const btn = e.target.closest("[data-act]");
      const busy = authBusy(btn, "Checking password…");
      try {
        await window.BookleAuth.signInWithPassword(window._bookleEmail, $("#auth-pass")?.value || "", window._bookleKdf);
        closeModal();
        paintAuth();
      } catch (err) {
        authError(err.message || String(err));
      } finally {
        busy();
      }
    }
    if (act === "auth-use-code") {
      const email = window._bookleEmail;
      if (!email) return openAuth();
      const btn = e.target.closest("[data-act]");
      const busy = authBusy(btn, "Sending…");
      try {
        openAuth("verify", email, await window.BookleAuth.sendCode(email));
      } catch (err) {
        authError(err.message || String(err));
      } finally {
        busy();
      }
    }
    if (act === "auth-set-password") {
      const btn = e.target.closest("[data-act]");
      const busy = authBusy(btn, "Securing…");
      try {
        await window.BookleAuth.setPassword($("#auth-newpass")?.value || "");
        closeModal();
        paintAuth();
        setMsg("Password saved. You can sign in with it next time.");
      } catch (err) {
        authError(err.message || String(err));
      } finally {
        busy();
      }
    }
    if (act === "auth-resend") {
      const email = window._bookleEmail;
      if (!email) return openAuth();
      try {
        const sent = await window.BookleAuth.sendCode(email);
        openAuth("verify", email, sent);
        authError("New code sent.");
      } catch (err) {
        authError(err.message || String(err));
      }
    }
    if (act === "auth-code") {
      const btn = e.target.closest("[data-act]");
      const busy = authBusy(btn, "Checking…");
      try {
        await window.BookleAuth.verifyCode(window._bookleEmail, $("#auth-code")?.value);
        paintAuth();
        if (window.BookleAuth.hasPassword()) closeModal();
        else openAuth("set-password");
      } catch (err) {
        authError(err.message || String(err));
      } finally {
        busy();
      }
    }
    if (act === "pw-save" || act === "pw-remove") {
      const err = $("#pw-err");
      const btn = e.target.closest("[data-act]");
      const current = $("#pw-current")?.value || "";
      if (act === "pw-remove" && !confirm("Remove your password? You'll sign in with an emailed code instead.")) return;
      if (err) err.textContent = "";
      const busy = authBusy(btn, "Securing…");
      try {
        if (act === "pw-remove") await window.BookleAuth.removePassword(current);
        else await window.BookleAuth.setPassword($("#pw-new")?.value || "", current);
        renderPasswordBox();
        const done = $("#pw-err");
        if (done) done.textContent = act === "pw-remove" ? "Password removed." : "Password saved.";
      } catch (e2) {
        if ($("#pw-err")) $("#pw-err").textContent = e2.message || String(e2);
      } finally {
        busy();
      }
    }
    if (act === "hint") onHint();
    if (act === "give-up") onGiveUp();
    if (act === "retry-reading") retryCompletedExcerpt();
    if (act === "cal-prev") stepCalendar(-1);
    if (act === "cal-next") stepCalendar(1);
    if (act === "save-name") saveDisplayName();
    if (act === "play-today" || act === "pick-today") {
      closeModal();
      location.hash = "#/";
      startPlay({ playIndex: dailyIndexNow(), mode: "daily" });
    }
    if (act === "play-random") playRandom();
    if (act === "pick-random") pickIndex(randomPresetIndex(state.playIndex));
    if (act === "pick-id") playById($("#play-id-input")?.value);
    if (act === "share") {
      const btn = e.target.closest("[data-act]");
      const url = shareUrl();
      // Just the link, never a pasted summary — the card is what the link
      // previews as, and the Worker builds that from the link itself.
      if (navigator.share) {
        try {
          await navigator.share({ title: "Excerptle", url });
          return;
        } catch (err) {
          // Dismissing the sheet is a decision; don't then copy it anyway.
          if (err && err.name === "AbortError") return;
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        if (btn) {
          btn.textContent = "Copied ✓";
          setTimeout(() => { btn.textContent = "Share"; }, 2000);
        }
      } catch {
        setMsg("Could not copy.");
      }
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.id === "theme") {
      state.settings.theme = e.target.value;
      saveSettings();
    }
    if (e.target.id === "bank-filter" || e.target.id === "bank-status") renderBank();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeReader();
      closeModal();
      setNav(false);
    }
    if ((e.key === "Enter" || e.key === " ") && e.target?.id === "excerpt") {
      e.preventDefault();
      openReader();
    }
  });
  window.addEventListener("popstate", () => {
    if (readerOpen && !history.state?.reader) closeReader({ fromHistory: true });
  });
  $("#bank-jump")?.addEventListener("change", () => renderBank());
  $("#modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal();
  });

  /* The daily index is read once, when the route runs. A tab left open across
     midnight would sit on yesterday's book forever, so re-check on the way
     back in — but never yank a puzzle out from under a game in progress. */
  function rollDaily() {
    if (state.mode !== "daily" || !state.puzzle) return;
    // An explicit #/play/N link is an archive visit. Only the landing route is
    // allowed to roll itself forward at midnight.
    if (route().page !== "home") return;
    const today = dailyIndexNow();
    if (today === state.playIndex) return;
    if (state.status === "playing" && (state.guesses.length || state.hints)) return;
    startPlay({ playIndex: today, mode: "daily", showHow: false });
  }

  window.addEventListener("hashchange", () => {
    setNav(false);
    go();
  });
  // Browsers may suspend timers in a background tab. Save the exact elapsed
  // time at that boundary instead of relying solely on the 10-second check.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state.puzzle && state.status === "playing") saveProgress();
    if (document.visibilityState === "visible") {
      rollDaily();
    }
  });
  window.addEventListener("online", flushProgressEntries);
  window.addEventListener("pagehide", () => {
    if (state.puzzle && state.status === "playing") saveProgress();
  });
  document.addEventListener("bookle-auth", (e) => {
    const nextUid = e.detail?.uid || null;
    if (nextUid !== activeAccountUid) {
      if (nextUid) importGuestPlay(nextUid);
      activeAccountUid = nextUid;
      resetRoundForIdentityChange();
      go();
    }
    paintAuth();
    // The result card contains an optional sign-in offer. It must follow the
    // session too, or a successful login leaves a stale "Sign in" action.
    if (state.puzzle && state.status !== "playing") $("#result").innerHTML = postGameHtml();
    const token = e.detail?.token;
    Promise.resolve(progressSyncing).then(() => {
      if (token && token === window.BookleAuth?.session?.()?.token) syncProgress();
    });
  });
  applyTheme();
  paintAuth();
  if (activeAccountUid) importGuestPlay(activeAccountUid);
  go().then(syncProgress);
})();
