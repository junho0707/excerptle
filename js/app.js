/* Bookle */
(() => {
  const MAX_GUESSES = 6;
  const MAX_HINTS = 4;
  const START = "2026-09-08";
  const { fold, isMatch } = window.BookleMatch;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const K = {
    id: "bookle.playerId",
    name: "bookle.name",
    stats: "bookle.stats",
    settings: "bookle.settings",
    seen: "bookle.seenHowTo",
    progress: "bookle.progress",
    lb: "bookle.lb.v1",
  };

  const state = {
    index: null,
    puzzle: null,
    playIndex: 1001,
    mode: "daily", // daily | preset | battle
    guesses: [],
    hints: 0,
    status: "playing",
    startedAt: Date.now(),
    settings: loadSettings(),
    battle: null,
  };

  function utcDate(d = new Date()) {
    return new Date(d).toISOString().slice(0, 10);
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
    const btn = $("#settings-auth-btn");
    if (st) st.textContent = s ? `Signed in as ${s.email} (${s.provider})` : "Not signed in. Progress stays on this device until you sign in.";
    if (btn) btn.textContent = s ? "Sign out" : "Sign in";
    if (btn) btn.dataset.act = s ? "sign-out" : "open-auth";
  }

  function loadJSON(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "") || fallback;
    } catch {
      return fallback;
    }
  }
  function progressMap() {
    return loadJSON(K.progress, {});
  }
  function saveProgress() {
    const all = progressMap();
    all[String(state.playIndex)] = {
      status: state.status,
      guesses: state.guesses,
      hints: state.hints,
      puzzleId: state.puzzle?.id,
      mode: state.mode,
      timeMs: Date.now() - state.startedAt,
      at: Date.now(),
    };
    localStorage.setItem(K.progress, JSON.stringify(all));
  }

  function loadStats() {
    return {
      played: 0, wins: 0, currentStreak: 0, maxStreak: 0,
      dist: [0, 0, 0, 0, 0, 0], fails: 0, lastDaily: null, lastWinDate: null,
      practicePlayed: 0,
      ...loadJSON(K.stats, {}),
    };
  }

  function dailyIndexNow() {
    const start = state.index?.startDate || START;
    const base = state.index?.dailyStartIndex || 1001;
    return base + Math.max(0, daysBetween(start, utcDate()));
  }

  function slugForIndex(n) {
    const order = state.index.order;
    if (!order?.length) return null;
    const presets = state.index.presetCount || order.length;
    if (n >= (state.index.dailyStartIndex || 1001)) {
      const day = n - (state.index.dailyStartIndex || 1001);
      return order[day % order.length];
    }
    if (n < 1) return null;
    return order[(n - 1) % Math.min(presets, order.length)];
  }

  function dateForDailyIndex(n) {
    const start = state.index?.startDate || START;
    const base = state.index.dailyStartIndex || 1001;
    return addDays(start, n - base);
  }

  async function loadIndex() {
    if (state.index) return state.index;
    const res = await fetch("puzzles/index.json");
    if (!res.ok) throw new Error("index");
    state.index = await res.json();
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
  function hintLabels(p) {
    return p.labels?.slice(0, 5) || [
      "First sentence", "First paragraph", "First two paragraphs", "A few pages", "Chapter 1",
    ];
  }

  function shareGrid() {
    const g = [];
    for (let i = 0; i < MAX_GUESSES; i++) {
      if (i >= state.guesses.length) g.push("⬜");
      else if (state.status === "won" && i === state.guesses.length - 1) g.push("🟩");
      else g.push("🟨");
    }
    const h = [];
    for (let i = 0; i < MAX_HINTS; i++) h.push(i < state.hints ? "💡" : "⬜");
    return { guesses: g.join(""), hints: h.join("") };
  }

  function shareText() {
    const n = state.status === "won" ? `${state.guesses.length}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
    const { guesses, hints } = shareGrid();
    const kind = state.mode === "daily" ? "Daily" : state.mode === "battle" ? "Battle" : "Bank";
    return `Excerptle ${kind} #${state.playIndex} ${n} · ${state.hints} hint${state.hints === 1 ? "" : "s"}\n${guesses}\n${hints}\nhttps://excerptle.io/?p=${state.playIndex}`;
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

  function closeModal() {
    $("#modal").classList.add("hidden");
    $("#modal-inner").innerHTML = "";
  }
  function openModal(html) {
    $("#modal-inner").innerHTML = html;
    $("#modal").classList.remove("hidden");
  }

  function renderExcerpt() {
    if (!state.puzzle) return;
    const t = tiers(state.puzzle);
    const labels = hintLabels(state.puzzle);
    const idx = Math.min(state.hints, t.length - 1);
    $("#tier-label").textContent = `${labels[idx] || "Excerpt"} · hint ${state.hints}/${MAX_HINTS}`;
    const box = $("#excerpt");
    box.textContent = t[idx] || "";
    box.classList.remove("fade");
    void box.offsetWidth;
    box.classList.add("fade");
    const kind =
      state.mode === "daily" ? `Daily #${state.playIndex}` :
      state.mode === "battle" ? `Battle #${state.playIndex}` :
      `Bank #${state.playIndex}`;
    $("#meta-left").textContent = kind;
    $("#meta-right").textContent = `${state.guesses.length}/${MAX_GUESSES} · ${state.hints} hint${state.hints === 1 ? "" : "s"}`;
    const hb = $("#hint-btn");
    if (hb) hb.disabled = state.status !== "playing" || state.hints >= Math.min(MAX_HINTS, t.length - 1);
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

  function lbFor(idx) {
    const all = loadJSON(K.lb, {});
    return all[String(idx)] || [];
  }
  function pushLb(entry) {
    const all = loadJSON(K.lb, {});
    const k = String(state.playIndex);
    const list = all[k] || [];
    const mine = list.filter((r) => r.id !== playerId());
    mine.push(entry);
    mine.sort((a, b) => {
      if (a.win !== b.win) return a.win ? -1 : 1;
      if (a.hints !== b.hints) return a.hints - b.hints;
      if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
      return a.guesses - b.guesses;
    });
    all[k] = mine.slice(0, 100);
    localStorage.setItem(K.lb, JSON.stringify(all));
    const url = window.BOOKLE_API;
    if (url) {
      try {
        navigator.sendBeacon?.(url, JSON.stringify({ type: "score", ...entry, puzzleIndex: state.playIndex }));
      } catch { /* optional */ }
    }
  }

  function postGameHtml() {
    const p = state.puzzle;
    const { guesses, hints } = shareGrid();
    const timeMs = Date.now() - state.startedAt;
    const secs = Math.max(1, Math.round(timeMs / 1000));
    const board = lbFor(state.playIndex);
    const rank = board.findIndex((r) => r.id === playerId()) + 1;
    const headline = state.status === "won" ? "You got it." : "The book was";
    return `
      <div class="lede">${headline}</div>
      <h2>${escapeHtml(p.title)}</h2>
      <p class="by">${escapeHtml(p.author)}${p.year ? ", " + p.year : ""} · #${state.playIndex}</p>
      <p>${state.guesses.length}/${MAX_GUESSES} guesses · ${state.hints} hints · ${secs}s</p>
      <div class="grid" aria-label="share grid">${guesses}<br>${hints}</div>
      <p class="lede">${rank ? `You’re #${rank} on this puzzle’s board.` : "Logged on this puzzle’s board."}</p>
      <div class="row">
        <button class="btn" type="button" data-act="share">Share</button>
        <button class="btn ghost" type="button" data-act="challenge">Challenge a friend</button>
        <a class="btn ghost" href="${p.source?.url || "https://www.gutenberg.org/"}" target="_blank" rel="noopener">Gutenberg</a>
      </div>
      <div class="row">
        <button class="btn" type="button" data-act="play-random">Next random book</button>
        <button class="btn ghost" type="button" data-act="open-play">Choose by ID</button>
        <a class="btn ghost" href="#/ranks?i=${state.playIndex}">Leaderboard</a>
      </div>
    `;
  }

  function renderResult() {
    const box = $("#result");
    const form = $("#form");
    if (state.status === "playing") {
      box.classList.add("hidden");
      form.classList.remove("hidden");
      $("#ad").classList.add("hidden");
      return;
    }
    form.classList.add("hidden");
    box.classList.remove("hidden");
    $("#ad").classList.remove("hidden");
    box.innerHTML = postGameHtml();
  }

  function recordFinish() {
    const timeMs = Date.now() - state.startedAt;
    saveProgress();
    pushLb({
      id: playerId(),
      name: displayName(),
      guesses: state.guesses.length,
      hints: state.hints,
      timeMs,
      win: state.status === "won",
      at: Date.now(),
    });
    if (state.mode !== "daily") return;
    const s = loadStats();
    if (s.lastDaily === utcDate()) return;
    s.played += 1;
    s.lastDaily = utcDate();
    if (state.status === "won") {
      s.wins += 1;
      s.dist[Math.min(state.guesses.length, MAX_GUESSES) - 1] += 1;
      if (s.lastWinDate && daysBetween(s.lastWinDate, utcDate()) === 1) s.currentStreak += 1;
      else s.currentStreak = 1;
      s.lastWinDate = utcDate();
      s.maxStreak = Math.max(s.maxStreak, s.currentStreak);
    } else {
      s.fails += 1;
      s.currentStreak = 0;
    }
    localStorage.setItem(K.stats, JSON.stringify(s));
  }

  function onHint() {
    if (state.status !== "playing") return;
    const t = tiers(state.puzzle);
    if (state.hints >= Math.min(MAX_HINTS, t.length - 1)) {
      setMsg("No more hints.");
      return;
    }
    state.hints += 1;
    setMsg("Hint unlocked.");
    saveProgress();
    renderExcerpt();
    if (state.battle) battleSend({ type: "hint", hints: state.hints });
  }

  function onGuess(raw) {
    if (state.status !== "playing") return;
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
      setMsg("That’s the book.");
      recordFinish();
      if (state.battle) battleSend({ type: "win", name: displayName(), guesses: state.guesses.length, hints: state.hints });
    } else if (state.guesses.length >= MAX_GUESSES) {
      state.status = "lost";
      setMsg("No more guesses.");
      recordFinish();
      if (state.battle) battleSend({ type: "lose", name: displayName() });
    } else {
      setMsg("Not it — take a hint, or try another title.");
      saveProgress();
    }
    renderExcerpt();
    renderGuesses();
    renderResult();
  }

  async function startPlay({ playIndex, mode, resume = true, fresh = false }) {
    await loadIndex();
    show("game");
    state.mode = mode || (playIndex >= (state.index.dailyStartIndex || 1001) ? "daily" : "preset");
    state.playIndex = playIndex;
    const todayDaily = dailyIndexNow();
    if (state.mode === "daily" && playIndex > todayDaily) {
      $("#excerpt").textContent = "That daily isn’t out yet.";
      $("#form").classList.add("hidden");
      return;
    }
    const slug = slugForIndex(playIndex);
    if (!slug) {
      $("#excerpt").textContent = "Puzzle not in the bank yet.";
      return;
    }
    state.puzzle = await loadPuzzle(slug);
    const saved = resume ? progressMap()[String(playIndex)] : null;
    if (!fresh && saved && saved.puzzleId === state.puzzle.id) {
      state.guesses = saved.guesses || [];
      state.hints = saved.hints || 0;
      state.status = saved.status || "playing";
      state.startedAt = Date.now() - (saved.timeMs || 0);
    } else {
      state.guesses = [];
      state.hints = 0;
      state.status = "playing";
      state.startedAt = Date.now();
    }
    setMsg("");
    const input = $("#guess-input");
    if (input) input.value = "";
    renderExcerpt();
    renderGuesses();
    renderResult();
    const nav = $("#story-nav");
    if (nav) nav.classList.toggle("hidden", state.mode === "battle");
    if (!localStorage.getItem(K.seen)) {
      localStorage.setItem(K.seen, "1");
      openHow();
    }
  }

  function presetCount() {
    return state.index?.presetCount || state.index?.order?.length || 1;
  }

  function randomPresetIndex(exclude) {
    const n = presetCount();
    if (n <= 1) return 1;
    let x = 1 + Math.floor(Math.random() * n);
    if (x === exclude) x = (x % n) + 1;
    return x;
  }

  function playRandom() {
    closeModal();
    const n = randomPresetIndex(state.playIndex);
    location.hash = `#/play/${n}`;
  }

  function playById(raw) {
    const n = parseInt(raw, 10);
    if (!n || n < 1) {
      setMsg("Enter a book ID.");
      return;
    }
    const today = dailyIndexNow();
    const maxPreset = presetCount();
    const ok = (n >= 1 && n <= maxPreset) || (n >= (state.index.dailyStartIndex || 1001) && n <= today);
    if (!ok) {
      setMsg(`No book #${n} yet. Try 1–${maxPreset}, or a daily up to #${today}.`);
      return;
    }
    closeModal();
    location.hash = `#/play/${n}`;
  }

  function playChoicesHtml() {
    const d = dailyIndexNow();
    const done = progressMap()[String(d)];
    const todayLabel = done?.status === "won" ? "Finished today — play another"
      : done?.status === "lost" ? "Today’s is done"
      : "Today’s daily";
    return `
      <button class="modal-x" type="button" data-act="close-modal" aria-label="Close">×</button>
      <h2>New game</h2>
      <button class="choice" type="button" data-act="play-today">
        <b>${todayLabel}</b><span>Daily #${d}</span>
      </button>
      <button class="choice" type="button" data-act="play-random">
        <b>Random book</b><span>Another title from the bank</span>
      </button>
      <div class="choice">
        <b>Choose by ID</b>
        <span>Type a book number, or <a href="#/bank" data-act="close-modal">browse all books</a></span>
        <div class="id-row">
          <input id="play-id-input" type="number" min="1" placeholder="e.g. 42" inputmode="numeric">
          <button class="btn" type="button" data-act="play-id">Play</button>
        </div>
      </div>
      <button class="choice" type="button" data-act="battle-start">
        <b>Battle mode</b><span>Same book. First correct title wins. Hints shared.</span>
      </button>
    `;
  }

  function openPlay() {
    openModal(playChoicesHtml());
  }

  function authError(msg) {
    const el = $("#auth-err");
    if (el) el.textContent = msg || "";
  }

  function openAuth(step, email, extra) {
    const gSvg = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13.2 24 13.2c3.1 0 5.8 1.2 8 3.1l5.7-5.7C34.2 6.1 29.4 4 24 4 16.1 4 9.2 8.5 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3C29.3 35.1 26.8 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.1 39.4 16 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-1.1 3.2-3.5 5.7-6.6 7.1l6.3 5.3C37.8 38.3 44 32.5 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>`;
    if (step === "verify") {
      openModal(`
        <button class="modal-x" type="button" data-act="close-modal" aria-label="Close">×</button>
        <h2>Check your email</h2>
        <p class="lede">We sent a 6-digit code to <strong>${escapeHtml(email)}</strong>. Enter it, or use your password if you already have one. No passkeys.</p>
        ${extra?.demoCode ? `<p class="lede">Dev (no mail server yet): your code is <strong>${extra.demoCode}</strong></p>` : ""}
        <div class="auth-stack">
          <input id="auth-code" inputmode="numeric" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code">
          <button class="btn full" type="button" data-act="auth-code">Verify code</button>
        </div>
        <div class="or-line">or</div>
        <div class="auth-stack">
          <input id="auth-password" type="password" placeholder="Password (8+ characters)" autocomplete="current-password">
          <button class="btn ghost full" type="button" data-act="auth-password">Sign in with password</button>
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
      <p class="lede">One account keeps streaks, the book bank, and leaderboards. Google, or email — then a code or your password.</p>
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
      <p>${escapeHtml(s.email)}</p>
      <p class="lede">${s.provider === "google" ? "Signed in with Google." : "Signed in with email."}</p>
      <p><a class="btn ghost" href="#/settings" data-act="close-modal">Settings</a>
         <button class="btn" type="button" data-act="sign-out">Sign out</button></p>
    `);
  }
  function openHow() {
    openModal(`
      <button class="modal-x" type="button" data-act="close-modal" aria-label="Close">×</button>
      <h2>How to play</h2>
      <ol>
        <li>You always see the <strong>first sentence</strong>.</li>
        <li><strong>Guess</strong> the title. A miss does <em>not</em> reveal more text.</li>
        <li><strong>Hint</strong> expands the excerpt: paragraph → two paragraphs → a few pages → chapter 1.</li>
        <li>Six guesses. Matching is generous on typos and “The…”, not on one-word stabs like “great”.</li>
        <li>Public domain only. Books are numbered (choose by ID) so titles stay secret.</li>
      </ol>
      <p><button class="btn" type="button" data-act="close-modal">Close</button></p>
    `);
  }

  function renderBank() {
    show("screen-bank");
    const presets = state.index.presetCount || state.index.order.length;
    $("#preset-max").textContent = String(presets);
    const filter = $("#bank-filter").value;
    const today = dailyIndexNow();
    const pageSize = 100;
    const params = new URLSearchParams(location.hash.split("?")[1] || location.search);
    let page = parseInt(params.get("page") || "1", 10) || 1;
    let items = [];
    if (filter !== "daily") {
      for (let i = 1; i <= presets; i++) items.push(i);
    }
    if (filter !== "preset") {
      for (let i = state.index.dailyStartIndex; i <= today; i++) items.push(i);
    }
    const jump = parseInt($("#bank-jump").value, 10);
    if (jump) {
      const idx = items.indexOf(jump);
      if (idx >= 0) page = Math.floor(idx / pageSize) + 1;
    }
    const maxPage = Math.max(1, Math.ceil(items.length / pageSize));
    page = Math.min(page, maxPage);
    const slice = items.slice((page - 1) * pageSize, page * pageSize);
    const prog = progressMap();
    $("#bank-grid").innerHTML = slice
      .map((n) => {
        const st = prog[String(n)]?.status;
        const cls = st === "won" ? "won" : st === "lost" ? "lost" : st === "playing" ? "play" : "";
        return `<a class="bank-cell ${cls}" href="#/play/${n}">#${n}</a>`;
      })
      .join("");
    $("#bank-pager").innerHTML = `Page ${page}/${maxPage}
      ${page > 1 ? `<button class="btn ghost" type="button" data-page="${page - 1}">Prev</button>` : ""}
      ${page < maxPage ? `<button class="btn ghost" type="button" data-page="${page + 1}">Next</button>` : ""}`;
  }

  function renderRanks() {
    show("screen-ranks");
    const params = new URLSearchParams((location.hash.split("?")[1] || "") + "&" + location.search.slice(1));
    const fallback = dailyIndexNow();
    if (!$("#lb-index").value) $("#lb-index").value = params.get("i") || fallback;
    const idx = parseInt($("#lb-index").value, 10) || fallback;
    const hintF = $("#lb-hints").value;
    const scope = $("#lb-scope").value;
    const all = loadJSON(K.lb, {});
    let rows = [];
    if (scope === "this") rows = (all[String(idx)] || []).map((r) => ({ ...r, puzzleIndex: idx }));
    else {
      const base = state.index.dailyStartIndex || 1001;
      for (const [k, list] of Object.entries(all)) {
        const n = parseInt(k, 10);
        if (scope === "daily" && n < base) continue;
        if (scope === "preset" && n >= base) continue;
        for (const r of list) rows.push({ ...r, puzzleIndex: n });
      }
    }
    if (hintF !== "any") rows = rows.filter((r) => r.hints === parseInt(hintF, 10));
    rows.sort((a, b) => {
      if (a.win !== b.win) return a.win ? -1 : 1;
      if (a.hints !== b.hints) return a.hints - b.hints;
      if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
      return a.guesses - b.guesses;
    });
    const me = playerId();
    $("#lb-body").innerHTML = rows.length
      ? `<div class="lb"><table><thead><tr><th>#</th><th>Player</th><th>Puzzle</th><th>Hints</th><th>Guesses</th><th>Time</th></tr></thead><tbody>${rows
          .slice(0, 50)
          .map((r, i) => `<tr class="${r.id === me ? "you" : ""}"><td>${i + 1}</td><td>${escapeHtml(r.name)}</td><td>#${r.puzzleIndex}</td><td>${r.hints}</td><td>${r.win ? r.guesses : "X"}</td><td>${Math.round(r.timeMs / 1000)}s</td></tr>`)
          .join("")}</tbody></table></div>`
      : `<p class="lede">No scores yet for this filter. Finish a puzzle to post.</p>`;
  }

  function renderSettings() {
    show("screen-settings");
    $("#theme").value = state.settings.theme;
    $("#display-name").value = localStorage.getItem(K.name) || "";
    paintAuth();
  }

  /* —— Battle (PeerJS) —— */
  function battleSend(msg) {
    try {
      state.battle?.conn?.send(msg);
    } catch { /* */ }
  }

  async function loadPeer() {
    if (window.Peer) return window.Peer;
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js";
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return window.Peer;
  }

  function battleCode() {
    const a = "abcdefghjkmnpqrstuvwxyz23456789";
    let s = "";
    for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
  }

  function renderBattleLobby(code, status, link) {
    show("screen-battle");
    $("#battle-body").innerHTML = `
      <p class="lede">${escapeHtml(status)}</p>
      <div class="battle-code">${escapeHtml(code || "……")}</div>
      <p><button class="btn" type="button" data-act="copy-battle">Copy link</button></p>
      <p class="lede">Same index. First correct title wins. A hint either of you takes is shown to both.</p>
      <label class="row">Join a code
        <input id="join-code" type="text" maxlength="8" placeholder="abc123">
      </label>
      <p><button class="btn ghost" type="button" data-act="battle-join">Join</button></p>
    `;
    state.battle = state.battle || {};
    state.battle.link = link;
  }

  async function battleHost() {
    await loadIndex();
    const playIndex = dailyIndexNow();
    const code = battleCode();
    const id = "bk-" + code;
    const link = `${origin()}?b=${code}&p=${playIndex}`;
    renderBattleLobby(code, "Starting room…", link);
    try {
      await loadPeer();
    } catch {
      $("#battle-body").insertAdjacentHTML("beforeend", `<p>Could not load battle network. Try again on Wi‑Fi.</p>`);
      return;
    }
    const peer = new window.Peer(id);
    state.battle = { role: "host", peer, code, playIndex, link };
    peer.on("open", () => {
      renderBattleLobby(code, "Waiting for your friend… share the link.", link);
    });
    peer.on("error", (e) => {
      setMsg(String(e));
    });
    peer.on("connection", (conn) => {
      state.battle.conn = conn;
      conn.on("open", async () => {
        conn.send({ type: "hello", playIndex, name: displayName() });
        await startPlay({ playIndex, mode: "battle", fresh: true });
        setMsg("Battle on. First title wins.");
      });
      conn.on("data", onBattleData);
    });
  }

  async function battleJoin(code) {
    code = (code || "").trim().toLowerCase();
    if (!code) return;
    await loadIndex();
    const params = new URLSearchParams(location.search);
    const playIndex = parseInt(params.get("p"), 10) || dailyIndexNow();
    try {
      await loadPeer();
    } catch {
      alert("Could not load battle network.");
      return;
    }
    const peer = new window.Peer();
    state.battle = { role: "guest", peer, code, playIndex };
    show("screen-battle");
    $("#battle-body").innerHTML = `<p>Joining ${escapeHtml(code)}…</p>`;
    peer.on("open", () => {
      const conn = peer.connect("bk-" + code);
      state.battle.conn = conn;
      conn.on("open", () => conn.send({ type: "hello", name: displayName() }));
      conn.on("data", onBattleData);
    });
    peer.on("error", (e) => {
      $("#battle-body").innerHTML = `<p>Could not join: ${escapeHtml(String(e))}</p>`;
    });
  }

  async function onBattleData(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "hello" && msg.playIndex && state.battle.role === "guest") {
      await startPlay({ playIndex: msg.playIndex, mode: "battle", fresh: true });
      setMsg(`${msg.name || "Host"} is in. First title wins.`);
    }
    if (msg.type === "hint" && typeof msg.hints === "number") {
      if (msg.hints > state.hints && state.status === "playing") {
        state.hints = msg.hints;
        setMsg("Your opponent took a hint — you see it too.");
        renderExcerpt();
      }
    }
    if (msg.type === "win" && state.status === "playing") {
      state.status = "lost";
      setMsg(`${msg.name || "Opponent"} guessed first.`);
      recordFinish();
      renderExcerpt();
      renderGuesses();
      renderResult();
    }
  }

  function route() {
    const params = new URLSearchParams(location.search);
    const hash = (location.hash || "#/").replace(/^#/, "");
    const parts = hash.split("?")[0].split("/").filter(Boolean);
    const qBattle = params.get("b");
    const qPlay = params.get("p");
    if (qBattle && !parts.length) return { page: "battle-join", code: qBattle, playIndex: qPlay };
    if (qPlay && !parts.length) return { page: "play", playIndex: parseInt(qPlay, 10) };
    const page = parts[0] || "home";
    if (page === "play" && parts[1]) return { page: "play", playIndex: parseInt(parts[1], 10) };
    if (page === "battle" && parts[1]) return { page: "battle-join", code: parts[1] };
    return { page, playIndex: qPlay ? parseInt(qPlay, 10) : undefined };
  }

  async function go() {
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
    const screens = { news: "screen-news", support: "screen-support", settings: "screen-settings" };
    if (r.page === "bank") return renderBank();
    if (r.page === "ranks") return renderRanks();
    if (r.page === "settings") return renderSettings();
    if (screens[r.page]) return show(screens[r.page]);
    if (r.page === "battle-join") return battleJoin(r.code);
    if (r.page === "battle") return battleHost();
    if (r.page === "play" && r.playIndex) {
      const mode = r.playIndex >= (state.index.dailyStartIndex || 1001) ? "daily" : "preset";
      return startPlay({ playIndex: r.playIndex, mode });
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
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target?.id === "play-id-input") {
      e.preventDefault();
      playById(e.target.value);
    }
    if (e.key === "Enter" && e.target?.id === "auth-email") {
      e.preventDefault();
      document.querySelector('[data-act="auth-email"]')?.click();
    }
    if (e.key === "Enter" && e.target?.id === "auth-code") {
      e.preventDefault();
      document.querySelector('[data-act="auth-code"]')?.click();
    }
    if (e.key === "Enter" && e.target?.id === "auth-password") {
      e.preventDefault();
      document.querySelector('[data-act="auth-password"]')?.click();
    }
  });

  document.addEventListener("click", async (e) => {
    const pageBtn = e.target.closest("[data-page]");
    if (pageBtn) {
      location.hash = `#/bank?page=${pageBtn.dataset.page}`;
      return;
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "close-modal") closeModal();
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
      try {
        const sent = await window.BookleAuth.sendCode(email);
        openAuth("verify", email, sent);
      } catch (err) {
        authError(err.message || String(err));
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
      try {
        await window.BookleAuth.verifyCode(window._bookleEmail, $("#auth-code")?.value);
        closeModal();
        paintAuth();
      } catch (err) {
        authError(err.message || String(err));
      }
    }
    if (act === "auth-password") {
      try {
        await window.BookleAuth.signInPassword(window._bookleEmail, $("#auth-password")?.value);
        closeModal();
        paintAuth();
      } catch (err) {
        authError(err.message || String(err));
      }
    }
    if (act === "hint") onHint();
    if (act === "play-today") {
      closeModal();
      location.hash = "#/";
      startPlay({ playIndex: dailyIndexNow(), mode: "daily" });
    }
    if (act === "play-random") playRandom();
    if (act === "play-id") playById($("#play-id-input")?.value);
    if (act === "share") {
      const text = shareText();
      try {
        if (navigator.share) await navigator.share({ text });
        else {
          await navigator.clipboard.writeText(text);
          setMsg("Copied.");
        }
      } catch {
        await navigator.clipboard.writeText(text);
        setMsg("Copied.");
      }
    }
    if (act === "challenge") {
      closeModal();
      battleHost();
    }
    if (act === "battle-start") {
      closeModal();
      battleHost();
    }
    if (act === "battle-join") {
      battleJoin($("#join-code")?.value);
    }
    if (act === "copy-battle" && state.battle?.link) {
      await navigator.clipboard.writeText(state.battle.link);
      setMsg("Battle link copied.");
    }
  });

  document.addEventListener("change", (e) => {
    if (e.target.id === "theme") {
      state.settings.theme = e.target.value;
      saveSettings();
    }
    if (e.target.id === "display-name") {
      localStorage.setItem(K.name, e.target.value.trim().slice(0, 24));
    }
    if (e.target.id === "bank-filter") renderBank();
    if (e.target.id === "lb-hints" || e.target.id === "lb-scope") renderRanks();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });
  $("#bank-jump")?.addEventListener("change", () => renderBank());
  $("#lb-index")?.addEventListener("change", () => renderRanks());
  $("#modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal();
  });

  window.addEventListener("hashchange", go);
  document.addEventListener("bookle-auth", () => paintAuth());
  applyTheme();
  paintAuth();
  go();
})();
