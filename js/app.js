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
    stats: "bookle.stats",
    settings: "bookle.settings",
    seen: "bookle.seenHowTo",
    // The public catalogue was renumbered to bank #0–#599 / daily #600+.
    // New keys intentionally leave pre-launch progress and local boards behind.
    progress: "bookle.progress.v2",
    lb: "bookle.lb.v2",
  };

  const state = {
    index: null,
    puzzle: null,
    playIndex: 600,
    mode: "daily", // daily | preset | battle
    guesses: [],
    hints: 0,
    status: "playing",
    beatenBy: null, // opponent's name, when a battle ended on their guess
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
    paintPro();
    const st = $("#auth-status");
    if (st) st.textContent = s ? `Signed in as ${s.email}` : "Not signed in. Progress stays on this device until you sign in.";
  }

  // The Pro badge only means something next to a name, so it rides with the
  // account tab: hidden signed out, outlined when free, filled when paying.
  function paintPro() {
    const el = $("#pro-badge");
    if (!el) return;
    const v = window.ExcerptlePro?.view?.() || { phase: "off", pro: false };
    const signedIn = !!window.BookleAuth?.session?.();
    el.classList.toggle("hidden", !signedIn && !v.pro);
    el.classList.toggle("on", !!v.pro);
    el.classList.toggle("warn", v.phase === "past_due");
    el.title = v.pro ? "Excerptle Pro — active" : "Excerptle Pro — ad-free";
    el.setAttribute("aria-label", el.title);
  }

  const PRO_COPY = () => window.EXCERPTLE_PRO || {};

  function proBodyHtml() {
    const v = window.ExcerptlePro?.view?.() || { phase: "off", pro: false };
    const ends = v.currentPeriodEnd
      ? new Date(typeof v.currentPeriodEnd === "number" ? v.currentPeriodEnd * 1000 : v.currentPeriodEnd)
      : null;
    // Stripe states the period end in UTC; rendering it in local time slides it
    // a day for anyone west of Greenwich, so the receipt and the modal disagree.
    const on = ends ? ends.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }) : "";
    const manage = `<button class="btn ghost full" type="button" data-act="pro-portal">Manage billing</button>`;
    switch (v.phase) {
      case "loading":
        return `<p class="pro-status">Checking your subscription…</p>`;
      case "active":
        return `<p class="pro-status ok">PRO</p>
          ${on ? `<p class="pro-note">Renews ${on}.</p>` : ""}
          ${v.dev ? `<p class="pro-note">Local override (<code>bookle.pro.dev</code>) — not a real subscription.</p>` : manage}`;
      case "canceling":
        return `<p class="pro-status ok">PRO</p>
          <p class="pro-note">Ends${on ? ` ${on}` : " at the end of this period"}. Renewal can go back on in the billing portal.</p>${manage}`;
      case "past_due":
        return `<p class="pro-status warn">Your last payment didn’t go through. Stripe will retry, but updating the card is faster.</p>${manage}`;
      case "none":
        return `<button class="btn ghost full" type="button" data-act="pro-checkout-monthly">Monthly — ${PRO_COPY().priceLabel || "$3/month"}</button>
          <button class="btn full" type="button" data-act="pro-checkout-yearly">Yearly — $20/year</button>
          <p class="pro-note">Save $16/year with yearly.<br>Checkout and receipts are handled by Stripe.<br>Cancel any time.</p>`;
      case "error":
        return `<p class="pro-status warn">${escapeHtml(v.message || "Couldn’t reach billing just now.")}</p>
          <button class="btn ghost full" type="button" data-act="open-auth">Sign in again</button>
          <button class="btn ghost full" type="button" data-act="pro-refresh">Try again</button>`;
      default:
        if (v.reason === "signed-out") {
          return `<button class="btn full" type="button" data-act="open-auth">Sign in to subscribe</button>
            <p class="pro-note">A subscription belongs to an account, so it follows you between devices.</p>`;
        }
        return `<p class="pro-status">Stripe checkout isn’t connected yet.</p>`;
    }
  }

  function proModalHtml() {
    // Someone already paying doesn't need the sales line — they get the state,
    // the date and the billing link.
    const pro = !!window.ExcerptlePro?.isPro?.();
    return `
      <button class="modal-x" type="button" data-act="close-modal" aria-label="Close">×</button>
      <h2>Excerptle Pro</h2>
      <p class="lede" id="pro-lede"${pro ? " hidden" : ""}>${PRO_COPY().blurb || "Excerptle Pro removes ads."}</p>
      <div id="pro-body">${proBodyHtml()}</div>
      <p id="pro-err" class="auth-err" role="alert"></p>
      <p class="pro-note">Want a bigger book bank? Leave a tip on <a href="https://ko-fi.com/provablelearningllc" target="_blank" rel="noopener noreferrer">Ko-fi</a>.</p>
    `;
  }

  function repaintProModal() {
    const body = $("#pro-body");
    if (body) body.innerHTML = proBodyHtml();
    // The modal usually opens before entitlement lands, so the pitch line has
    // to retract once the answer comes back as "already paying".
    const lede = $("#pro-lede");
    if (lede) lede.hidden = !!window.ExcerptlePro?.isPro?.();
    paintPro();
  }
  function openPro() {
    openModal(proModalHtml());
    window.ExcerptlePro?.refresh?.({ force: true }).then(repaintProModal);
  }
  function proErr(msg) {
    const el = $("#pro-err");
    if (el) el.textContent = msg || "";
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
  function saveProgress({ remote = true } = {}) {
    const all = progressMap();
    const key = String(state.playIndex);
    const row = {
      status: state.status,
      guesses: state.guesses,
      hints: state.hints,
      puzzleId: state.puzzle?.id,
      mode: state.mode,
      timeMs: Date.now() - state.startedAt,
      at: Date.now(),
    };
    all[key] = row;
    localStorage.setItem(K.progress, JSON.stringify(all));
    if (remote) syncProgressEntry({ [key]: row });
  }

  // The browser remains the fast, offline-first copy.  On sign-in we merge by
  // each row's timestamp, then send the union; this also lets a player finish
  // a round on one device and resume it on another.
  let progressSyncing = null;
  let pendingProgress = {};
  function progressConnection() {
    const api = (window.EXCERPTLE_API || window.BOOKLE_API || "").replace(/\/$/, "");
    const auth = window.BookleAuth?.session?.();
    return api && auth?.token ? { api, headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" } } : null;
  }
  function syncProgressEntry(entries) {
    pendingProgress = { ...pendingProgress, ...entries };
    return flushProgressEntries();
  }
  async function flushProgressEntries() {
    const connection = progressConnection();
    if (!connection || progressSyncing) return progressSyncing;
    progressSyncing = (async () => {
      try {
        while (Object.keys(pendingProgress).length) {
          const batch = pendingProgress;
          pendingProgress = {};
          await fetch(`${connection.api}/me/progress`, { method: "PUT", headers: connection.headers, body: JSON.stringify({ progress: batch }) });
        }
      } catch { /* The browser copy remains authoritative until the next retry. */ }
      finally {
        progressSyncing = null;
        if (Object.keys(pendingProgress).length) flushProgressEntries();
      }
    })();
    return progressSyncing;
  }
  async function syncProgress() {
    const connection = progressConnection();
    if (!connection || progressSyncing) return progressSyncing;
    progressSyncing = (async () => {
      try {
        const res = await fetch(`${connection.api}/me/progress`, { headers: connection.headers });
        if (!res.ok) return;
        const remote = (await res.json()).progress || {};
        const merged = { ...remote };
        for (const [index, row] of Object.entries(progressMap())) {
          if (!merged[index] || Number(row?.at || 0) >= Number(merged[index]?.at || 0)) merged[index] = row;
        }
        localStorage.setItem(K.progress, JSON.stringify(merged));
        await fetch(`${connection.api}/me/progress`, { method: "PUT", headers: connection.headers, body: JSON.stringify({ progress: merged }) });
      } catch { /* Sync is opportunistic; local progress remains intact. */ }
      finally {
        progressSyncing = null;
        if (Object.keys(pendingProgress).length) flushProgressEntries();
      }
    })();
    return progressSyncing;
  }

  function loadStats() {
    return {
      played: 0, wins: 0, currentStreak: 0, maxStreak: 0,
      dist: [0, 0, 0, 0, 0, 0], fails: 0, lastDaily: null, lastWinDate: null,
      practicePlayed: 0,
      ...loadJSON(K.stats, {}),
      // Battles overwrite the book's solo progress row, so they can't be
      // counted from `progress` after the fact — they get their own tally.
      battle: {
        played: 0, wins: 0, losses: 0, streak: 0, maxStreak: 0,
        hints: 0, guesses: 0, bestMs: null, lastAt: null,
        ...(loadJSON(K.stats, {}).battle || {}),
      },
    };
  }

  function dailyIndexNow() {
    const start = state.index?.startDate || START;
    const base = state.index?.dailyStartIndex ?? 600;
    return base + Math.max(0, daysBetween(start, utcDate()));
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
    const base = state.index.dailyStartIndex ?? 600;
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
  // Fixed wording so the tier label always matches the How-to-play table.
  const TIER_LABELS = [
    "First sentence", "First paragraph", "First few paragraphs",
    "First couple of pages", "First chapter",
  ];
  function hintLabels() {
    return TIER_LABELS;
  }

  // The emoji grid now lives only in tools/og-worker/share.js — a link
  // preview is text, so it can't draw the squares the card uses.
  function kindOf(mode) {
    return mode === "daily" ? "Daily" : mode === "battle" ? "Battle" : "Book";
  }

  /* Standing on this puzzle's board: among everyone (any hints), and among
     the players who took the same help. Both go in the share. */
  function ranksFor(idx, hints) {
    const board = lbFor(idx);
    const me = playerId();
    const bracket = board.filter((r) => r.hints === hints);
    return {
      overall: board.findIndex((r) => r.id === me) + 1,
      overallOf: board.length,
      bracket: bracket.findIndex((r) => r.id === me) + 1,
      bracketOf: bracket.length,
    };
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
    const r = ranksFor(state.playIndex, state.hints);
    return b64u.enc(JSON.stringify({
      v: 1,
      n: displayName().slice(0, 24),
      m: state.mode,
      w: state.status === "won" ? 1 : 0,
      g: state.guesses.length,
      h: state.hints,
      t: Math.max(1, Math.round((Date.now() - state.startedAt) / 1000)),
      br: r.bracket, bn: r.bracketOf,
      or: r.overall, on: r.overallOf,
    }));
  }

  function readShare(raw) {
    try {
      const d = JSON.parse(b64u.dec(raw));
      if (!d || d.v !== 1) return null;
      d.g = Math.min(Math.max(0, d.g | 0), MAX_GUESSES);
      d.h = Math.min(Math.max(0, d.h | 0), MAX_HINTS);
      d.n = String(d.n || "A player").slice(0, 24);
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
      // Reading the instructions is not part of the round.
      state.startedAt = Date.now();
      if (state.puzzle && state.status === "playing") {
        saveProgress();
        startElapsedTimer();
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

  let elapsedTimer = null;
  let progressCheckpointTimer = null;
  let accountProgressSyncTimer = null;
  function formatElapsed(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const remainder = String(seconds % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes % 60).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
  }
  function renderElapsed() {
    const time = $("#elapsed-time");
    if (!time || !state.puzzle) return;
    const elapsed = Date.now() - state.startedAt;
    time.textContent = formatElapsed(elapsed);
    time.dateTime = `PT${Math.max(0, Math.floor(elapsed / 1000))}S`;
  }
  function startElapsedTimer() {
    clearInterval(elapsedTimer);
    clearInterval(progressCheckpointTimer);
    clearInterval(accountProgressSyncTimer);
    renderElapsed();
    if (state.status === "playing") {
      elapsedTimer = setInterval(renderElapsed, 1000);
      // Persist time even before the player makes a guess, so a refresh or a
      // device switch resumes the same round instead of starting at zero.
      progressCheckpointTimer = setInterval(() => saveProgress({ remote: false }), 10000);
      // Account syncs are incremental, but do not need to happen every ten
      // seconds; page exit and game actions sync immediately.
      accountProgressSyncTimer = setInterval(() => saveProgress(), 5 * 60 * 1000);
    }
  }
  function stopElapsedTimer() {
    clearInterval(elapsedTimer);
    clearInterval(progressCheckpointTimer);
    clearInterval(accountProgressSyncTimer);
    elapsedTimer = null;
    progressCheckpointTimer = null;
    accountProgressSyncTimer = null;
    renderElapsed();
  }

  function renderExcerpt() {
    if (!state.puzzle) return;
    const t = tiers(state.puzzle);
    const labels = hintLabels();
    const idx = Math.min(state.hints, t.length - 1);
    // The hint count lives on the Hint button now — the label just names the tier.
    $("#tier-label").textContent = labels[idx] || "Excerpt";
    const ab = $("#author-reveal");
    if (ab) {
      const shown = state.hints >= MAX_HINTS && state.puzzle.author;
      ab.hidden = !shown;
      if (shown) ab.textContent = `Author: ${state.puzzle.author}`;
    }
    const box = $("#excerpt");
    box.textContent = t[idx] || "";
    box.classList.remove("fade");
    void box.offsetWidth;
    box.classList.add("fade");
    const kind =
      state.mode === "daily" ? `Daily #${state.playIndex}` :
      state.mode === "battle" ? `Battle #${state.playIndex}` :
      `Book bank #${state.playIndex}`;
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
    if (hb) hb.disabled = state.status !== "playing" || state.hints >= MAX_HINTS;
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
    // Losses are not ranked — filtered here too, so older saved rows drop out.
    return (all[String(idx)] || []).filter((r) => r.win);
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
    const auth = window.BookleAuth?.session?.();
    if (url && auth?.token) {
      try {
        fetch(`${url.replace(/\/$/, "")}/scores`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
          keepalive: true,
          body: JSON.stringify({ ...entry, puzzleIndex: state.playIndex }),
        }).catch(() => {});
      } catch { /* optional */ }
    }
  }

  function fmtTime(ms) {
    const t = Math.max(1, Math.round(ms / 1000));
    return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`;
  }

  // Longest tier we hold for this book — the first chapter — gives an honest size.
  function chapterWords(p) {
    const t = (p.texts || []).reduce((a, b) => (b.length > a.length ? b : a), "");
    const n = t.trim().split(/\s+/).filter(Boolean).length;
    if (!n) return null;
    return n < 1000 ? `${n}` : `${(Math.round(n / 100) / 10).toFixed(1)}k`;
  }

  // Spent squares in wine, unspent left empty — the same story the share grid tells.
  function blocks(used, total, label) {
    let out = `<span class="sq-row" role="img" aria-label="${label}">`;
    for (let i = 0; i < total; i++) out += `<span class="sq${i < used ? " on" : ""}"></span>`;
    return out + "</span>";
  }

  function postGameHtml() {
    const p = state.puzzle;
    const timeMs = Date.now() - state.startedAt;
    const me = playerId();
    const board = lbFor(state.playIndex);
    const rank = board.findIndex((r) => r.id === me) + 1;
    // Same-hint bracket: the fair comparison is against players who took as much help.
    const bracket = board.filter((r) => r.hints === state.hints);
    const bRank = bracket.findIndex((r) => r.id === me) + 1;
    const top = (bracket.length > 1 ? bracket.slice(0, 5) : [])
      .map((r, i) => `<tr class="${r.id === me ? "you" : ""}"><td>${i + 1}</td><td>${escapeHtml(r.name)}</td><td>${r.guesses}</td><td>${fmtTime(r.timeMs)}</td></tr>`)
      .join("");
    const won = state.status === "won";
    const lostLine = state.beatenBy ? `${escapeHtml(state.beatenBy)} got there first` : "Out of guesses";
    const words = chapterWords(p);
    const gut = p.source?.gutenberg;
    const hintWord = `${state.hints} hint${state.hints === 1 ? "" : "s"}`;
    const r = ranksFor(state.playIndex, state.hints);
    const rankLine = won && (r.bracket || r.overall)
      ? `<p class="rank-line">
           ${r.bracket ? `<span>#<b>${r.bracket}</b> of ${r.bracketOf} at ${hintWord}</span>` : ""}
           ${r.overall ? `<span>#<b>${r.overall}</b> of ${r.overallOf} overall</span>` : ""}
         </p>`
      : "";
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
          ${words ? `<div><dt>Chapter 1</dt><dd>${words} words</dd></div>` : ""}
          ${gut ? `<div><dt>Gutenberg</dt><dd>#${escapeHtml(String(gut))}</dd></div>` : ""}
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
        <div class="stat-row">
          <span class="stat-k">Time</span>
          <span class="stat-v">${fmtTime(timeMs)}</span>
        </div>
      </section>

      ${rankLine || top ? `<section class="pg-sec pg-rank">
        ${rankLine}
        ${top ? `<table class="mini-lb"><thead><tr><th>#</th><th>Player</th><th>Guesses</th><th>Time</th></tr></thead><tbody>${top}</tbody></table>` : ""}
      </section>` : ""}

      <div class="row pg-actions">
        <button class="btn" type="button" data-act="share">Share</button>
        <a class="btn ghost" href="#/ranks?i=${state.playIndex}">Full leaderboard</a>
        <a class="btn ghost" href="${p.source?.url || "https://www.gutenberg.org/"}" target="_blank" rel="noopener">Gutenberg</a>
      </div>
    `;
  }

  // Playing: story first, "guess more" under it. Finished: CTA on top, then the
  // result card, then the excerpt as far as you revealed it.
  function placeMore(done) {
    const more = $("#more");
    const game = $("#game");
    const card = $(".daily-card");
    if (!more || !game || !card) return;
    if (done) game.insertBefore(more, card);
    else game.insertBefore(more, card.nextSibling);
    card.classList.toggle("done", done);
  }

  function renderResult() {
    const box = $("#result");
    const form = $("#form");
    const more = $("#more");
    const battle = state.mode === "battle";
    if (state.status === "playing") {
      box.classList.add("hidden");
      form.classList.remove("hidden");
      if (more) more.classList.toggle("hidden", battle);
      placeMore(false);
      window.ExcerptleAds?.clear();
      return;
    }
    form.classList.add("hidden");
    if (more) more.classList.toggle("hidden", battle);
    placeMore(!battle);
    box.classList.remove("hidden");
    box.innerHTML = postGameHtml();
    // Fresh <ins> per finished game — see js/ads.js.
    window.ExcerptleAds?.render();
  }

  function recordFinish() {
    const timeMs = Date.now() - state.startedAt;
    stopElapsedTimer();
    saveProgress();
    if (state.status === "won") {
      pushLb({
        id: playerId(),
        name: displayName(),
        guesses: state.guesses.length,
        hints: state.hints,
        timeMs,
        win: true,
        at: Date.now(),
      });
    }
    if (state.mode === "battle") {
      const s = loadStats();
      const b = s.battle;
      b.played += 1;
      b.hints += state.hints;
      b.guesses += state.guesses.length;
      b.lastAt = Date.now();
      if (state.status === "won") {
        b.wins += 1;
        b.streak += 1;
        b.maxStreak = Math.max(b.maxStreak, b.streak);
        if (b.bestMs == null || timeMs < b.bestMs) b.bestMs = timeMs;
      } else {
        b.losses += 1;
        b.streak = 0;
      }
      localStorage.setItem(K.stats, JSON.stringify(s));
      return;
    }
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
    if (state.hints >= MAX_HINTS) {
      setMsg("No more hints.");
      return;
    }
    state.hints += 1;
    setMsg("");
    saveProgress();
    renderExcerpt();
    bump($("#count-hints"));
    bump($("#tier-label"));
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
      setMsg("");
      recordFinish();
      if (state.battle) battleSend({ type: "win", name: displayName(), guesses: state.guesses.length, hints: state.hints });
    } else if (state.guesses.length >= MAX_GUESSES) {
      state.status = "lost";
      setMsg("No more guesses.");
      recordFinish();
      if (state.battle) battleSend({ type: "lose", name: displayName() });
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

  async function startPlay({ playIndex, mode, resume = true, fresh = false, showHow = true }) {
    clearInterval(elapsedTimer);
    clearInterval(progressCheckpointTimer);
    clearInterval(accountProgressSyncTimer);
    elapsedTimer = null;
    progressCheckpointTimer = null;
    accountProgressSyncTimer = null;
    await loadIndex();
    show("game");
    state.mode = mode || (playIndex >= (state.index.dailyStartIndex ?? 600) ? "daily" : "preset");
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
    state.beatenBy = null;
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
      startElapsedTimer();
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
    leaveBattle();
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

      <!-- Battle is its own way in, not a modifier on the picks above, so it
           sits at the end with the only two ways to enter one. -->
      <div class="modal-sep"><span>Or play a friend</span></div>

      <div class="choice">
        <span class="choice-text"><b>Battle mode</b><span>Same book, head to head. First correct title wins.</span></span>
        <span class="choice-go">
          <button class="btn" type="button" data-act="battle-create">Create room</button>
        </span>
      </div>

      <div class="choice">
        <span class="choice-text"><b>Join a room</b><span>Paste a friend’s code</span></span>
        <span class="choice-go">
          <input id="join-code" type="text" maxlength="8" placeholder="abc123" autocapitalize="off" spellcheck="false">
          <button class="btn ghost" type="button" data-act="battle-join">Join</button>
        </span>
      </div>
    `;
  }

  function pickIndex(n) {
    closeModal();
    leaveBattle();
    const target = `#/play/${n}`;
    // Setting the hash routes for us; if we're already there it won't fire.
    if (location.hash === target) startPlay({ playIndex: n, mode: "preset" });
    else location.hash = target;
  }

  function pickById(raw) {
    const n = parseInt(raw, 10);
    const max = presetCount();
    if (!Number.isInteger(n) || n < 0) return pickError("Enter a book ID.");
    playById(raw);
  }

  /* What a recipient sees on arrival. Result only — no title, no excerpt
     detail — so opening a friend's link never spoils the book. */
  function sharedResultHtml(d, idx) {
    const score = d.w ? `${d.g}/${MAX_GUESSES}` : `X/${MAX_GUESSES}`;
    const hintWord = `${d.h} hint${d.h === 1 ? "" : "s"}`;
    const stand = [
      d.br ? `#<b>${d.br}</b> of ${d.bn} at ${hintWord}` : "",
      d.or ? `#<b>${d.or}</b> of ${d.on} overall` : "",
    ].filter(Boolean);
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
          ${d.t ? `<div class="stat-row">
            <span class="stat-k">Time</span>
            <span class="stat-v">${fmtTime(d.t * 1000)}</span>
          </div>` : ""}
        </div>
        ${stand.length ? `<p class="sc-rank">${stand.join(" · ")}</p>` : ""}
      </div>
      <p class="lede sc-cta">Can you guess better?</p>
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
        <p class="lede">We sent a 6-digit code to <strong>${escapeHtml(email)}</strong>.</p>
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
      <p class="lede">Sign in with Google or an email code to manage your account and Excerptle Pro.</p>
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
    const v = window.ExcerptlePro?.view?.() || { phase: "off", pro: false };
    const proStatus = v.phase === "active" ? "Active" :
      v.phase === "canceling" ? "Active — ending at period end" :
      v.phase === "past_due" ? "Payment issue" :
      v.phase === "loading" ? "Checking…" :
      v.phase === "error" ? "Status unavailable" : "Free";
    openModal(`
      <button class="modal-x" type="button" data-act="close-modal" aria-label="Close">×</button>
      <h2>Account</h2>
      <p><strong>Email</strong><br>${escapeHtml(s.email)}</p>
      <p><strong>Sign-in method</strong><br>${s.provider === "google" ? "Google" : "Email code"}</p>
      <p><strong>Excerptle Pro</strong><br><span id="account-pro">${proStatus}</span></p>
      <p><button class="btn ghost" type="button" data-act="sign-out">Sign out</button></p>
    `);
  }
  function openHow() {
    openModal(`
      <button class="modal-x" type="button" data-act="close-modal" aria-label="Close">×</button>
      <h2>How to play</h2>
      <p class="how-intro">You see the <strong>first sentence</strong> of a book. Name the book in <strong>six guesses</strong>.</p>
      <p class="how-sub">Stuck? Take a hint. A hint doesn’t tell you the answer — it <strong>shows you more of the book</strong>:</p>
      <table class="how-table">
        <tbody>
          <tr><th>Start</th><td>The first sentence</td></tr>
          <tr><th>Hint 1</th><td>The first paragraph</td></tr>
          <tr><th>Hint 2</th><td>The first few paragraphs</td></tr>
          <tr><th>Hint 3</th><td>The first couple of pages</td></tr>
          <tr><th>Hint 4</th><td>The whole first chapter</td></tr>
          <tr><th>Hint 5</th><td>The author’s name</td></tr>
        </tbody>
      </table>
      <ul class="how-notes">
        <li>Only hints reveal more text — a wrong guess never does.</li>
        <li>If a guess includes a distinctive word from the title, you’ll be told how many key title words remain — never which words they are.</li>
        <li><strong>Close spelling counts.</strong> “Pride and Predjudice” is fine, and you can drop a leading “The”. A vague one-word guess such as “great” does not solve the book or earn a title-word nudge; try more of the title.</li>
        <li>The fewer hints and guesses you use, the better you score.</li>
      </ul>
      <p><button class="btn" type="button" data-act="close-modal">Close</button></p>
    `);
  }

  function renderBank() {
    show("screen-bank");
    const presets = state.index.presetCount || state.index.order.length;
    const filter = $("#bank-filter").value;
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
    const jump = parseInt($("#bank-jump").value, 10);
    if (Number.isInteger(jump)) {
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
    $("#bank-pager").innerHTML = `
      ${page > 1 ? `<button class="btn ghost" type="button" data-page="${page - 1}">Prev</button>` : `<span class="pager-gap"></span>`}
      <span class="pager-at">Page ${page} / ${maxPage}</span>
      ${page < maxPage ? `<button class="btn ghost" type="button" data-page="${page + 1}">Next</button>` : `<span class="pager-gap"></span>`}`;
  }

  function labelFor(n) {
    return n >= (state.index?.dailyStartIndex ?? 600) ? `Daily #${n}` : `Book #${n}`;
  }

  const rankSort = (a, b) => {
    if (a.hints !== b.hints) return a.hints - b.hints;
    if (a.timeMs !== b.timeMs) return a.timeMs - b.timeMs;
    return a.guesses - b.guesses;
  };
  // The server carries no row id, so your own remote row is recognised by the
  // values you played it with.
  const rankKey = (r) => `${r.name}|${r.hints}|${r.guesses}|${r.timeMs}`;
  function lbTable(rows) {
    if (!rows.length) return "";
    return `<div class="lb"><table><thead><tr><th>#</th><th>Player</th><th>Hints</th><th>Guesses</th><th>Time</th></tr></thead><tbody>${rows
      .slice(0, 50)
      .map((r, i) => `<tr class="${r.mine ? "you" : ""}"><td>${i + 1}</td><td>${escapeHtml(r.name)}</td><td>${r.hints}</td><td>${r.guesses}</td><td>${Math.round(r.timeMs / 1000)}s</td></tr>`)
      .join("")}</tbody></table></div>`;
  }

  function renderRanks() {
    show("screen-ranks");
    const params = new URLSearchParams((location.hash.split("?")[1] || "") + "&" + location.search.slice(1));
    const fallback = dailyIndexNow();
    if (!$("#lb-index").value) $("#lb-index").value = params.get("i") || fallback;
    // The number field takes any book; the tick narrows it to the ones this
    // browser has actually finished, so you can find a board worth reading.
    const finished = Object.entries(progressMap())
      .filter(([, r]) => r && r.status !== "playing")
      .map(([k]) => parseInt(k, 10))
      .filter(Number.isInteger)
      .sort((a, b) => a - b);
    if ($("#lb-mine")?.checked && !finished.length) {
      $("#lb-pick")?.classList.add("hidden");
      $("#lb-index").classList.remove("hidden");
      $("#lb-body").innerHTML = `<p class="lede">Finish a book and its board shows up here.</p>`;
      return;
    }
    const onlyMine = !!$("#lb-mine")?.checked && finished.length > 0;
    const pick = $("#lb-pick");
    if (pick) {
      pick.classList.toggle("hidden", !onlyMine);
      $("#lb-index").classList.toggle("hidden", onlyMine);
      if (onlyMine) {
        const want = parseInt($("#lb-index").value, 10);
        const chosen = finished.includes(want) ? want : finished[0];
        pick.innerHTML = finished
          .map((n) => `<option value="${n}"${n === chosen ? " selected" : ""}>${labelFor(n)}</option>`)
          .join("");
        $("#lb-index").value = chosen;
      }
    }
    // Book #0 is a real book, so a plain || would send it to today's daily.
    const typed = parseInt($("#lb-index").value, 10);
    const idx = Number.isInteger(typed) && typed >= 0 ? typed : fallback;
    const hintF = $("#lb-hints").value;
    const all = loadJSON(K.lb, {});
    const me = playerId();
    // Every puzzle has its own board, and only solves are ranked.
    let local = (all[String(idx)] || []).filter((r) => r.win).map((r) => ({ ...r, mine: r.id === me }));
    if (hintF !== "any") local = local.filter((r) => r.hints === parseInt(hintF, 10));
    local.sort(rankSort);
    $("#lb-body").innerHTML = lbTable(local);
    const api = (window.EXCERPTLE_API || window.BOOKLE_API || "").replace(/\/$/, "");
    if (!api) return;
    const query = new URLSearchParams({ puzzleIndex: idx });
    if (hintF !== "any") query.set("hints", hintF);
    fetch(`${api}/scores?${query}`).then((r) => (r.ok ? r.json() : null)).then((data) => {
      if (!data?.scores || parseInt($("#lb-index").value, 10) !== idx || $("#lb-hints").value !== hintF) return;
      // The remote board is merged, never substituted: a signed-out player's
      // score never reaches the server, and replacing the table would blank
      // the row they just earned.
      const mineKeys = new Set(local.filter((r) => r.mine).map(rankKey));
      const remote = data.scores.map((r) => ({ ...r, mine: mineKeys.has(rankKey(r)) }));
      const seen = new Set(remote.map(rankKey));
      const merged = remote.concat(local.filter((r) => !seen.has(rankKey(r))));
      merged.sort(rankSort);
      $("#lb-body").innerHTML = lbTable(merged);
    }).catch(() => {});
  }

  /* Everything the player has actually done, read back out of the progress
     map. The leaderboard only ever shows one puzzle, so this is the only
     place a total lives. */
  function summarize() {
    const base = state.index?.dailyStartIndex ?? 600;
    const blank = () => ({ played: 0, wins: 0, losses: 0, hints: 0, guesses: 0, bestMs: null });
    const books = blank();
    const daily = blank();

    for (const [k, r] of Object.entries(progressMap())) {
      if (!r || r.status === "playing") continue;
      const bucket = parseInt(k, 10) >= base ? daily : books;
      bucket.played += 1;
      bucket.hints += r.hints || 0;
      bucket.guesses += (r.guesses || []).length;
      if (r.status === "won") {
        bucket.wins += 1;
        const t = r.timeMs || 0;
        if (t > 0 && (bucket.bestMs == null || t < bucket.bestMs)) bucket.bestMs = t;
      } else {
        bucket.losses += 1;
      }
    }
    const all = blank();
    for (const b of [books, daily]) {
      all.played += b.played; all.wins += b.wins; all.losses += b.losses;
      all.hints += b.hints; all.guesses += b.guesses;
      if (b.bestMs != null && (all.bestMs == null || b.bestMs < all.bestMs)) all.bestMs = b.bestMs;
    }
    return { all, books, daily, stats: loadStats() };
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

  function renderStats() {
    show("screen-stats");
    const { books, daily, stats } = summarize();
    const b = stats.battle;
    const best = (ms) => (ms != null ? fmtTime(ms) : "—");
    const rows = (...pairs) =>
      `<dl class="pg-stats">${pairs.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;

    /* Daily, Book bank and Battle mode are three ways of playing the same game,
       not a ranking of them, so they share one type scale. The page title is
       the only level above them. */
    $("#stats-body").innerHTML = `
      <section class="s-block">
        <h2>Daily</h2>
        <div class="stat-grid">
          ${tile(daily.wins, "Completed")}
          ${tile(stats.currentStreak, "Streak")}
          ${tile(stats.maxStreak, "Best streak")}
          ${tile(pct(daily.wins, daily.played), "Win rate")}
        </div>
        ${rows(["Avg guesses", avg(daily.guesses, daily.played)],
               ["Avg hints", avg(daily.hints, daily.played)],
               ["Fastest", best(daily.bestMs)])}
      </section>

      <section class="s-block">
        <h2>Book bank</h2>
        <div class="stat-grid">
          ${tile(books.wins, "Completed")}
          ${tile(books.played, "Played")}
          ${tile(pct(books.wins, books.played), "Win rate")}
        </div>
        ${rows(["Avg guesses", avg(books.guesses, books.played)],
               ["Avg hints", avg(books.hints, books.played)],
               ["Fastest", best(books.bestMs)])}
      </section>

      <section class="s-block">
        <h2>Battle mode</h2>
        ${b.played ? `
          <div class="stat-grid">
            ${tile(b.wins, "Won")}
            ${tile(b.played, "Battles")}
            ${tile(pct(b.wins, b.played), "Win rate")}
            ${tile(b.streak, "Streak")}
          </div>
          ${rows(["Best streak", b.maxStreak],
                 ["Fastest win", best(b.bestMs)],
                 ["Avg guesses", avg(b.guesses, b.played)],
                 ["Avg hints", avg(b.hints, b.played)])}`
          : `<p class="lede">No battles yet. Create a room from <button class="linkish" type="button" data-act="open-play">New game</button> and send a friend the link.</p>`}
      </section>
    `;
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

  /* Nobody is dropped into a puzzle by surprise: the room fills up, both
     players are listed, and the host decides when it starts. */
  function renderBattleLobby(code, status, link) {
    show("screen-battle");
    const b = state.battle || {};
    const idx = state.battlePending;
    const host = b.role !== "guest";
    const signedIn = !!window.BookleAuth?.session?.();
    const them = b.peerName;
    const ready = !!them;
    const startable = host && ready;

    const who = `
      <li class="who-row">
        <span class="who-dot on" aria-hidden="true"></span>
        ${signedIn
          ? `<span class="who-name">${escapeHtml(displayName())}</span>`
          : `<input id="battle-name" class="who-input" type="text" maxlength="24"
                    value="${escapeHtml(displayName() === "Anonymous" ? "" : displayName())}"
                    placeholder="Your name" aria-label="Your display name">`}
        <span class="who-tag">You${host ? " · host" : ""}</span>
      </li>
      <li class="who-row${ready ? "" : " waiting"}">
        <span class="who-dot${ready ? " on" : ""}" aria-hidden="true"></span>
        <span class="who-name">${ready ? escapeHtml(them) : "Waiting…"}</span>
        <span class="who-tag">${host ? "Guest" : "Host"}</span>
      </li>`;

    $("#battle-body").innerHTML = `
      <section class="b-sec">
        ${idx ? `<div class="story-bar"><span class="story-id">Book bank #${idx}</span></div>` : ""}
        <p class="lede">${escapeHtml(status)}</p>
        <div class="battle-code">${escapeHtml(code || "……")}</div>
        <p class="b-actions"><button class="btn ghost" type="button" data-act="copy-battle">Copy link</button></p>
      </section>

      <section class="b-sec">
        <h2>In the lobby</h2>
        <ul class="who">${who}</ul>
        ${host
          ? `<p><button class="btn full" type="button" data-act="battle-start" ${startable ? "" : "disabled"}>
               ${startable ? "Start battle" : "Waiting for a friend to join…"}</button></p>`
          : `<p class="lede">${ready ? "Waiting for the host to start…" : "Connecting…"}</p>`}
        <p class="lede b-rules">Same book. First correct title wins. A hint either of you takes is shown to both.</p>
      </section>

      <section class="b-sec">
        <p class="b-actions"><button class="btn ghost" type="button" data-act="battle-leave">Leave battle</button></p>
      </section>
    `;
    state.battle = state.battle || {};
    if (link) state.battle.link = link;
  }

  function repaintLobby() {
    const b = state.battle;
    if (!b || !$("#battle-body") || $("#screen-battle").classList.contains("hidden")) return;
    renderBattleLobby(b.code, b.status || "", b.link);
  }

  function leaveBattle() {
    try { state.battle?.peer?.destroy(); } catch { /* */ }
    state.battle = null;
  }

  async function battleHost(index) {
    await loadIndex();
    const playIndex = index || randomPresetIndex();
    const code = battleCode();
    const id = "bk-" + code;
    const link = `${origin()}?b=${code}&p=${playIndex}`;
    state.battlePending = playIndex;
    renderBattleLobby(code, "Starting room…", link);
    try {
      await loadPeer();
    } catch {
      $("#battle-body").insertAdjacentHTML("beforeend", `<p>Could not load battle network. Try again on Wi‑Fi.</p>`);
      return;
    }
    const peer = new window.Peer(id);
    state.battle = { role: "host", peer, code, playIndex, link, status: "Starting room…" };
    peer.on("open", () => {
      state.battle.status = "Waiting for your friend… share the link.";
      repaintLobby();
    });
    peer.on("error", (e) => {
      setMsg(String(e));
    });
    peer.on("connection", (conn) => {
      state.battle.conn = conn;
      conn.on("open", () => {
        // Presence only. The host still has to press Start.
        conn.send({ type: "hello", playIndex, name: displayName() });
        state.battle.status = "Your friend is here. Start when you’re ready.";
        repaintLobby();
      });
      conn.on("data", onBattleData);
      conn.on("close", () => {
        state.battle.peerName = null;
        state.battle.status = "Your friend left the room.";
        repaintLobby();
      });
    });
  }

  async function battleJoin(code) {
    code = (code || "").trim().toLowerCase();
    if (!code) return;
    await loadIndex();
    const params = new URLSearchParams(location.search);
    const fromLink = parseInt(params.get("p"), 10);
    const playIndex = fromLink >= 0 && fromLink < presetCount() ? fromLink : 0;
    try {
      await loadPeer();
    } catch {
      alert("Could not load battle network.");
      return;
    }
    const peer = new window.Peer();
    state.battle = { role: "guest", peer, code, playIndex, status: `Joining ${code}…` };
    state.battlePending = playIndex;
    renderBattleLobby(code, state.battle.status, null);
    peer.on("open", () => {
      const conn = peer.connect("bk-" + code);
      state.battle.conn = conn;
      conn.on("open", () => {
        conn.send({ type: "hello", name: displayName() });
        state.battle.status = "In the room. Waiting for the host to start.";
        repaintLobby();
      });
      conn.on("data", onBattleData);
      conn.on("close", () => {
        state.battle.peerName = null;
        state.battle.status = "The host left the room.";
        repaintLobby();
      });
    });
    peer.on("error", (e) => {
      state.battle.status = `Could not join: ${String(e)}`;
      repaintLobby();
    });
  }

  async function onBattleData(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "hello") {
      state.battle.peerName = msg.name || (state.battle.role === "guest" ? "Host" : "Guest");
      if (msg.playIndex && state.battle.role === "guest") {
        state.battle.playIndex = msg.playIndex;
        state.battlePending = msg.playIndex;
        state.battle.status = "In the room. Waiting for the host to start.";
      }
      if (state.battle.role === "host") state.battle.status = "Your friend is here. Start when you’re ready.";
      repaintLobby();
    }
    if (msg.type === "name") {
      state.battle.peerName = msg.name || state.battle.peerName;
      repaintLobby();
    }
    if (msg.type === "start" && state.battle.role === "guest") {
      const idx = msg.playIndex || state.battle.playIndex;
      await startPlay({ playIndex: idx, mode: "battle", fresh: true });
      setMsg(`${state.battle.peerName || "Host"} started the battle. First title wins.`);
    }
    if (msg.type === "hint" && typeof msg.hints === "number") {
      if (msg.hints > state.hints && state.status === "playing") {
        state.hints = msg.hints;
        setMsg("Your opponent took a hint — you see it too.");
        renderExcerpt();
        bump($("#count-hints"));
        bump($("#tier-label"));
      }
    }
    if (msg.type === "win" && state.status === "playing") {
      state.status = "lost";
      state.beatenBy = msg.name || "Your opponent";
      setMsg(`${state.beatenBy} guessed first.`);
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
    const qShare = params.get("s");
    if (qBattle && !parts.length) return { page: "battle-join", code: qBattle, playIndex: qPlay };
    if (qPlay && !parts.length) return { page: "play", playIndex: parseInt(qPlay, 10), share: qShare };
    const page = parts[0] || "home";
    if (page === "play" && parts[1]) return { page: "play", playIndex: parseInt(parts[1], 10) };
    if (page === "battle" && parts[1]) return { page: "battle-join", code: parts[1] };
    return { page, playIndex: qPlay ? parseInt(qPlay, 10) : undefined };
  }

  /* The tab has to say which screen you're on: every hash route names itself.
     The daily is the landing page, so it keeps the plain title. */
  const TITLES = {
    home: "Guess The Book",
    bank: "All Books",
    ranks: "Leaderboard",
    stats: "Stats",
    settings: "Settings",
    legal: "Privacy & Terms",
    support: "Support",
    news: "News",
    battle: "Battle Mode",
    "battle-join": "Battle Mode",
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
    // Consume ?b= / ?p= / ?s= once. Left in place they hijack every later
    // navigation back to "#/".
    if (location.search && (params0().get("b") || params0().get("p") || params0().get("s"))) {
      history.replaceState(null, "", location.pathname + location.hash);
    }
    setTitle(r.page, r.playIndex);
    const screens = { news: "screen-news", support: "screen-support", settings: "screen-settings", legal: "screen-legal" };
    if (r.page === "bank") return renderBank();
    if (r.page === "ranks") return renderRanks();
    if (r.page === "stats") return renderStats();
    if (r.page === "settings") return renderSettings();
    if (r.page === "pro") {
      // #/pro is a one-shot: it's how the nav and Stripe's return URL ask for
      // the modal. Left in the URL it reopens on every reload, so spend it.
      history.replaceState(null, "", location.pathname + "#/");
      await startPlay({ playIndex: dailyIndexNow(), mode: "daily" });
      openPro();
      return;
    }
    if (screens[r.page]) return show(screens[r.page]);
    if (r.page === "battle-join") return battleJoin(r.code);
    if (r.page === "battle") return battleHost();
    if (r.page === "play" && Number.isInteger(r.playIndex) && r.playIndex >= 0) {
      const mode = r.playIndex >= (state.index.dailyStartIndex ?? 600) ? "daily" : "preset";
      const shared = r.share ? readShare(r.share) : null;
      await startPlay({ playIndex: r.playIndex, mode, showHow: !shared });
      // The friend's card lands on top of the puzzle they were beaten on.
      if (shared) openModal(sharedResultHtml(shared, r.playIndex));
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
    if (e.key === "Enter" && e.target?.id === "play-id-input") {
      e.preventDefault();
      pickById(e.target.value);
    }
    if (e.key === "Enter" && e.target?.id === "auth-email") {
      e.preventDefault();
      document.querySelector('[data-act="auth-email"]')?.click();
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
    if (act === "open-play") openPlay();
    if (act === "open-how") openHow();
    if (act === "open-auth") openAuth();
    if (act === "open-account") openAccount();
    if (act === "open-pro") openPro();
    if (act === "pro-refresh") {
      proErr("");
      await window.ExcerptlePro?.refresh?.({ force: true });
      repaintProModal();
    }
    if (act === "pro-checkout-monthly" || act === "pro-checkout-yearly" || act === "pro-portal") {
      const btn = e.target.closest("[data-act]");
      proErr("");
      if (btn) { btn.disabled = true; btn.textContent = "Opening Stripe…"; }
      try {
        await (act === "pro-checkout-monthly" ? window.ExcerptlePro.checkout("monthly") : act === "pro-checkout-yearly" ? window.ExcerptlePro.checkout("yearly") : window.ExcerptlePro.portal());
      } catch (err) {
        proErr(err.message || String(err));
        repaintProModal();
      }
    }
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
    if (act === "hint") onHint();
    if (act === "play-today" || act === "pick-today") {
      closeModal();
      leaveBattle();
      location.hash = "#/";
      startPlay({ playIndex: dailyIndexNow(), mode: "daily" });
    }
    if (act === "play-random") playRandom();
    if (act === "pick-random") pickIndex(randomPresetIndex(state.playIndex));
    if (act === "pick-id") pickById($("#play-id-input")?.value);
    if (act === "share") {
      const btn = e.target.closest("[data-act]");
      try {
        // Just the link — the card is what the link previews as.
        await navigator.clipboard.writeText(shareUrl());
        if (btn) {
          btn.textContent = "Copied ✓";
          setTimeout(() => { btn.textContent = "Share"; }, 2000);
        }
      } catch {
        setMsg("Could not copy.");
      }
    }
    if (act === "battle-leave") {
      leaveBattle();
      state.battlePending = null;
      location.hash = "#/";
      startPlay({ playIndex: dailyIndexNow(), mode: "daily" });
    }
    if (act === "battle-create") {
      closeModal();
      battleHost();
    }
    if (act === "battle-join") {
      const code = ($("#battle-join-code")?.value || $("#join-code")?.value || "").trim();
      if (!code) return;
      closeModal();
      battleJoin(code);
    }
    if (act === "battle-start" && state.battle?.role === "host") {
      const idx = state.battle.playIndex;
      battleSend({ type: "start", playIndex: idx });
      await startPlay({ playIndex: idx, mode: "battle", fresh: true });
      setMsg("Battle on. First title wins.");
    }
    if (act === "copy-battle" && state.battle?.link) {
      await navigator.clipboard.writeText(state.battle.link);
      const btn = e.target.closest("[data-act]");
      if (btn) {
        btn.textContent = "Copied ✓";
        setTimeout(() => { btn.textContent = "Copy link"; }, 2000);
      }
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
    if (e.target.id === "battle-name") {
      localStorage.setItem(K.name, e.target.value.trim().slice(0, 24));
      battleSend({ type: "name", name: displayName() });
    }
    if (e.target.id === "bank-filter") renderBank();
    if (e.target.id === "lb-hints") renderRanks();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModal();
      setNav(false);
    }
  });
  $("#bank-jump")?.addEventListener("change", () => renderBank());
  $("#lb-index")?.addEventListener("change", () => renderRanks());
  $("#lb-mine")?.addEventListener("change", () => renderRanks());
  $("#lb-pick")?.addEventListener("change", () => {
    $("#lb-index").value = $("#lb-pick").value;
    renderRanks();
  });
  $("#modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal();
  });

  window.addEventListener("hashchange", () => {
    setNav(false);
    go();
  });
  // Browsers may suspend timers in a background tab. Save the exact elapsed
  // time at that boundary instead of relying solely on the 10-second check.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state.puzzle && state.status === "playing") saveProgress();
  });
  window.addEventListener("pagehide", () => {
    if (state.puzzle && state.status === "playing") saveProgress();
  });
  document.addEventListener("bookle-auth", () => {
    paintAuth();
    syncProgress();
  });
  // Entitlement arriving late must repaint the badge, the open modal, and the
  // ad slot — someone who just paid shouldn't have to reload to lose the ad.
  document.addEventListener("excerptle-pro", () => {
    paintPro();
    if ($("#pro-body")) repaintProModal();
    if ($("#account-pro")) openAccount();
  });
  // Returning with the browser Back button restores the page from its cache;
  // reset the temporary “Opening Stripe…” button state and refresh billing.
  window.addEventListener("pageshow", () => {
    if (!$("#pro-body")) return;
    proErr("");
    repaintProModal();
    window.ExcerptlePro?.refresh?.({ force: true }).then(repaintProModal);
  });
  window.ExcerptlePro?.refresh?.();
  applyTheme();
  paintAuth();
  go();
})();
