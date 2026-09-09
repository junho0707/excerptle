/* Email-first auth. Google + (code OR password). No passkeys. */
window.BookleAuth = (() => {
  const SESSION = "bookle.auth.session";
  const USERS = "bookle.auth.users";
  const PENDING = "bookle.auth.pending";

  function session() {
    try {
      const s = JSON.parse(localStorage.getItem(SESSION) || "null");
      if ((window.EXCERPTLE_API || window.BOOKLE_API) && (!s?.token || !s.expiresAt || s.expiresAt * 1000 <= Date.now())) return null;
      return s;
    } catch {
      return null;
    }
  }
  function setSession(s) {
    if (!s) localStorage.removeItem(SESSION);
    else localStorage.setItem(SESSION, JSON.stringify(s));
    document.dispatchEvent(new CustomEvent("bookle-auth", { detail: s }));
  }
  function users() {
    try {
      return JSON.parse(localStorage.getItem(USERS) || "{}");
    } catch {
      return {};
    }
  }
  function saveUsers(u) {
    localStorage.setItem(USERS, JSON.stringify(u));
  }

  function validEmail(s) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
  }

  async function sha256(s) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function sendCode(email) {
    const api = window.BOOKLE_API;
    if (api) {
      const res = await fetch(`${api.replace(/\/$/, "")}/auth/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not send a code.");
      const data = await res.json().catch(() => ({}));
      return { hasPassword: !!data.hasPassword, demoCode: null };
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    sessionStorage.setItem(
      PENDING,
      JSON.stringify({ email, code, exp: Date.now() + 10 * 60 * 1000 })
    );
    return { hasPassword: !!users()[email.toLowerCase()]?.passwordHash, demoCode: code };
  }

  async function verifyCode(email, code) {
    const api = window.BOOKLE_API;
    if (api) {
      const res = await fetch(`${api.replace(/\/$/, "")}/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      if (!res.ok) throw new Error("That code didn’t work.");
      const data = await res.json();
      finish(data);
      return;
    }
    const pending = JSON.parse(sessionStorage.getItem(PENDING) || "null");
    if (!pending || pending.email !== email || pending.exp < Date.now()) {
      throw new Error("Code expired. Send a new one.");
    }
    if (String(code).trim() !== String(pending.code)) throw new Error("That code didn’t work.");
    sessionStorage.removeItem(PENDING);
    finish({ email, name: email.split("@")[0], provider: "email", uid: email.toLowerCase() });
  }

  async function setPassword(password) {
    if (!password || password.length < 8) throw new Error("Password must be at least 8 characters.");
    const api = window.BOOKLE_API;
    if (api) {
      const s = session();
      if (!s?.token) throw new Error("Verify your email first.");
      const res = await fetch(`${api.replace(/\/$/, "")}/me/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.token}` },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Could not save password.");
      return;
    }
    const email = session()?.email;
    if (!email) throw new Error("Verify your email first.");
    const hash = await sha256(`${email.toLowerCase()}::${password}`);
    const all = users();
    const rec = all[email.toLowerCase()];
    all[email.toLowerCase()] = { passwordHash: hash, provider: "email" };
    saveUsers(all);
  }

  function finish(s) {
    s.email = s.email.toLowerCase();
    setSession(s);
    if (s.name) localStorage.setItem("bookle.name", s.name.slice(0, 24));
  }

  function signOut() {
    const s = session();
    const api = window.EXCERPTLE_API || window.BOOKLE_API;
    if (api && s?.token) fetch(`${api.replace(/\/$/, "")}/auth/logout`, {
      method: "POST", headers: { Authorization: `Bearer ${s.token}` }, keepalive: true,
    }).catch(() => {});
    setSession(null);
  }

  const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
  const POPUP_W = 500;
  const POPUP_H = 620;

  // Centre the chooser on the screen, not on the browser window: a window
  // parked in the right half of the display would otherwise throw the popup
  // out to the right edge. Clamped so it can never open partly offscreen.
  function popupFeatures() {
    const w = POPUP_W;
    const h = POPUP_H;
    const availLeft = screen.availLeft ?? 0;
    const availTop = screen.availTop ?? 0;
    const availW = screen.availWidth || screen.width || window.outerWidth || w;
    const availH = screen.availHeight || screen.height || window.outerHeight || h;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    const left = Math.round(clamp(availLeft + (availW - w) / 2, availLeft, availLeft + Math.max(0, availW - w)));
    const top = Math.round(clamp(availTop + (availH - h) / 2.4, availTop, availTop + Math.max(0, availH - h)));
    return `popup=yes,width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`;
  }

  function redirectUri() {
    return location.origin + location.pathname.replace(/[^/]*$/, "") + "oauth.html";
  }

  // Classic centred account-chooser window (OAuth implicit flow), not One Tap.
  function googleSignIn() {
    const cid = window.BOOKLE_GOOGLE_CLIENT_ID;
    if (!cid) {
      return Promise.reject(
        new Error("Google sign-in needs EXCERPTLE_GOOGLE_CLIENT_ID in js/config.js.")
      );
    }
    const state = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
    const url = `${GOOGLE_AUTH}?${new URLSearchParams({
      client_id: cid,
      redirect_uri: redirectUri(),
      response_type: "token",
      scope: "openid email profile",
      include_granted_scopes: "true",
      prompt: "select_account",
      state,
    })}`;
    // Opened straight off the click so the browser doesn't treat it as a blocked popup.
    const win = window.open(url, "excerptle-google", popupFeatures());
    if (!win) return Promise.reject(new Error("Your browser blocked the sign-in window."));
    win.focus?.();

    return new Promise((resolve, reject) => {
      let done = false;
      const finishUp = (fn, arg) => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMessage);
        clearInterval(closedTimer);
        try { win.close(); } catch { /* already gone */ }
        fn(arg);
      };
      function onMessage(e) {
        if (e.origin !== location.origin) return;
        const d = e.data;
        if (!d || d.source !== "excerptle-oauth" || d.state !== state) return;
        if (d.error || !d.accessToken) {
          finishUp(reject, new Error("Google sign-in was cancelled."));
          return;
        }
        finishUp(resolve, d.accessToken);
      }
      window.addEventListener("message", onMessage);
      const closedTimer = setInterval(() => {
        if (win.closed) finishUp(reject, new Error("Google sign-in window closed."));
      }, 400);
    }).then(googleProfile);
  }

  async function googleProfile(token) {
    const api = window.EXCERPTLE_API || window.BOOKLE_API;
    if (api) {
      const res = await fetch(`${api.replace(/\/$/, "")}/auth/google`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Google sign-in failed.");
      finish(data);
      return session();
    }
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error("Could not read your Google profile.");
    const p = await res.json();
    if (!p.email) throw new Error("Google didn’t share an email address.");
    finish({
      email: p.email,
      name: p.name || p.email.split("@")[0],
      provider: "google",
      uid: p.sub,
    });
    return session();
  }

  return {
    session,
    signOut,
    validEmail,
    sendCode,
    verifyCode,
    setPassword,
    googleSignIn,
  };
})();
