/* Email-first auth. Google + (code OR password). No passkeys. */
window.BookleAuth = (() => {
  const SESSION = "bookle.auth.session";
  const USERS = "bookle.auth.users";
  const PENDING = "bookle.auth.pending";

  function session() {
    try {
      return JSON.parse(localStorage.getItem(SESSION) || "null");
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

  function parseGoogleJwt(cred) {
    const payload = cred.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  }

  async function sendCode(email) {
    const api = window.BOOKLE_API;
    if (api) {
      const res = await fetch(`${api.replace(/\/$/, "")}/auth/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error("Could not send a code.");
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
      finish({ email, name: data.name || email.split("@")[0], provider: "email", uid: data.uid || email });
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

  async function signInPassword(email, password) {
    if (!password || password.length < 8) throw new Error("Password must be at least 8 characters.");
    const api = window.BOOKLE_API;
    if (api) {
      const res = await fetch(`${api.replace(/\/$/, "")}/auth/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error("Email or password didn’t match.");
      const data = await res.json();
      finish({ email, name: data.name || email.split("@")[0], provider: "email", uid: data.uid || email });
      return;
    }
    const hash = await sha256(`${email.toLowerCase()}::${password}`);
    const all = users();
    const rec = all[email.toLowerCase()];
    if (rec?.passwordHash && rec.passwordHash !== hash) {
      throw new Error("Email or password didn’t match.");
    }
    all[email.toLowerCase()] = { passwordHash: hash, provider: "email" };
    saveUsers(all);
    finish({ email, name: email.split("@")[0], provider: "email", uid: email.toLowerCase() });
  }

  function finish(s) {
    s.email = s.email.toLowerCase();
    setSession(s);
    if (s.name) localStorage.setItem("bookle.name", s.name.slice(0, 24));
  }

  function signOut() {
    setSession(null);
  }

  async function googleSignIn() {
    const cid = window.BOOKLE_GOOGLE_CLIENT_ID;
    if (!cid) {
      throw new Error("Google sign-in needs EXCERPTLE_GOOGLE_CLIENT_ID in js/config.js.");
    }
    await loadGis();
    return new Promise((resolve, reject) => {
      window.google.accounts.id.initialize({
        client_id: cid,
        callback: (resp) => {
          try {
            const p = parseGoogleJwt(resp.credential);
            finish({
              email: p.email,
              name: p.name || p.email.split("@")[0],
              provider: "google",
              uid: p.sub,
            });
            resolve(session());
          } catch (e) {
            reject(e);
          }
        },
      });
      window.google.accounts.id.prompt();
    });
  }

  function loadGis() {
    if (window.google?.accounts?.id) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.onload = resolve;
      s.onerror = () => reject(new Error("Could not load Google sign-in."));
      document.head.appendChild(s);
    });
  }

  return {
    session,
    signOut,
    validEmail,
    sendCode,
    verifyCode,
    signInPassword,
    googleSignIn,
  };
})();
