/* Email-first auth. Google + (code OR password). No passkeys. */
window.BookleAuth = ((): BookleAuthApi => {
  /** A demo-mode account, kept in localStorage when there is no API. */
  interface LocalUser {
    passwordHash?: string;
    kdf?: KdfSettings;
    provider?: string;
  }
  type ApiError = Error & { status?: number };

  const SESSION = "bookle.auth.session";
  const USERS = "bookle.auth.users";
  const PENDING = "bookle.auth.pending";

  function session(): AuthSession | null {
    try {
      const s: AuthSession | null = JSON.parse(localStorage.getItem(SESSION) || "null");
      if ((window.EXCERPTLE_API || window.BOOKLE_API) && (!s?.token || !s.expiresAt || s.expiresAt * 1000 <= Date.now())) return null;
      return s;
    } catch {
      return null;
    }
  }
  function setSession(s: AuthSession | null): void {
    if (!s) localStorage.removeItem(SESSION);
    else localStorage.setItem(SESSION, JSON.stringify(s));
    document.dispatchEvent(new CustomEvent("bookle-auth", { detail: s }));
  }
  // localStorage is shared by tabs, but CustomEvents are not. Mirror an
  // account change so a stale tab cannot continue saving under the prior user.
  window.addEventListener?.("storage", (e) => {
    if (e.key === SESSION) document.dispatchEvent(new CustomEvent("bookle-auth", { detail: session() }));
  });
  function users(): Record<string, LocalUser> {
    try {
      return JSON.parse(localStorage.getItem(USERS) || "{}");
    } catch {
      return {};
    }
  }
  function saveUsers(u: Record<string, LocalUser>): void {
    localStorage.setItem(USERS, JSON.stringify(u));
  }

  // Both names are set by js/config.js; reading only one of them is how
  // sendCode used to fall through to the demo path on a live site.
  function api(): string {
    return String(window.EXCERPTLE_API || window.BOOKLE_API || "").replace(/\/$/, "");
  }
  async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
    const res = await fetch(`${api()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    // Whatever the API answered; its shape is the caller's to name.
    const data: T & { error?: string } = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong. Try again."), { status: res.status });
    return data;
  }

  function validEmail(s: unknown): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "").trim());
  }

  /* The password is stretched here, in the browser, and only the derived key
     ever leaves. Not a flourish: a Workers free-plan request gets 10ms of CPU
     and PBKDF2 at a defensible cost needs ~73ms, so stretching server-side
     does not run at all. The work lands on a device with CPU to spare, and an
     attacker holding a copy of the database still has to pay it per guess.
     The server picks the iteration count and enforces a floor; a client that
     asked for less would only be describing its own account. */
  const KDF_FALLBACK = { iterations: 600000, saltBytes: 16 };
  let kdfPromise: Promise<{ iterations?: unknown; saltBytes?: unknown }> | null = null;
  // An API older than this file has no /auth/kdf, and its /me/password wants a
  // field we no longer send — it would answer a derived key with a complaint
  // about password length. Say what is actually wrong instead.
  async function kdfParams(): Promise<{ iterations: number; saltBytes: number }> {
    if (!api()) return KDF_FALLBACK;
    // Only a real answer is remembered: caching a dropped connection would
    // keep failing long after the connection came back.
    if (!kdfPromise) {
      kdfPromise = (async () => {
        let res: Response;
        try {
          res = await fetch(`${api()}/auth/kdf`);
        } catch {
          throw new Error("Could not reach the server. Check your connection and try again.");
        }
        if (res.status === 404) throw new Error("Passwords aren’t enabled on the server yet. Sign in with an email code for now.");
        if (!res.ok) throw new Error("Could not reach the server. Check your connection and try again.");
        return res.json();
      })();
      // A 404 is settled news; anything else is worth asking again.
      kdfPromise.catch((e: Error) => {
        if (!/aren’t enabled/.test(e.message)) kdfPromise = null;
      });
    }
    const p = await kdfPromise;
    return {
      iterations: Number(p?.iterations) || KDF_FALLBACK.iterations,
      saltBytes: Number(p?.saltBytes) || KDF_FALLBACK.saltBytes,
    };
  }

  const hex = (bytes: ArrayBuffer | Uint8Array): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

  async function deriveKey(password: string, salt: string, iterations: number): Promise<string> {
    if (!salt || !iterations) throw new Error("Could not read the password settings. Reload and try again.");
    const material = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
    );
    // The email is not in here: the salt already makes this account-specific,
    // and folding it in would break every stored password on an email change.
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations, hash: "SHA-256" },
      material, 256
    );
    return hex(bits);
  }

  async function sha256(s: string): Promise<string> {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /* Which of the three doors this address goes through: a new account (code),
     a returning one with a password (password), or a returning one without
     (code again). Asked before any mail is sent. */
  async function checkEmail(email: string): Promise<EmailCheck> {
    if (api()) {
      try {
        const data = await post<{ account?: boolean; hasPassword?: boolean; kdf?: KdfSettings }>("/auth/check", { email });
        return { account: !!data.account, hasPassword: !!data.hasPassword, kdf: data.kdf || null };
      } catch (e) {
        // An API deployed before this frontend has no /auth/check. Sending a
        // code still works, so fall back to it rather than locking the door.
        if ((e as ApiError).status !== 404) throw e;
        return { account: false, hasPassword: false };
      }
    }
    const rec = users()[String(email).toLowerCase()];
    return { account: !!rec, hasPassword: !!rec?.passwordHash, kdf: rec?.kdf || null };
  }

  async function signInWithPassword(email: string, password: string, kdf?: KdfSettings | null): Promise<AuthSession | null> {
    if (!password) throw new Error("Enter your password.");
    // Handed down from the checkEmail that sent us to the password screen;
    // asked for again only if this was called cold.
    const params = kdf || (await checkEmail(email)).kdf;
    if (!params) throw new Error("Wrong email or password.");
    const key = await deriveKey(password, params.salt, params.iterations);
    if (api()) {
      finish(await post<AuthSession>("/auth/login", { email, key }));
      return session();
    }
    const rec = users()[String(email).toLowerCase()];
    if (!rec?.passwordHash || rec.passwordHash !== await sha256(`v2:${params.salt}:${key}`)) {
      throw new Error("Wrong email or password.");
    }
    finish({ email, name: email.split("@")[0], provider: "password", uid: email.toLowerCase(), hasPassword: true });
    return session();
  }

  async function sendCode(email: string): Promise<SentCode> {
    if (api()) {
      const data = await post<{ hasPassword?: boolean; devCode?: string }>("/auth/email", { email });
      // devCode only ever arrives from a local Worker with no mail configured.
      return { hasPassword: !!data.hasPassword, demoCode: data.devCode || null };
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    sessionStorage.setItem(
      PENDING,
      JSON.stringify({ email, code, exp: Date.now() + 10 * 60 * 1000 })
    );
    return { hasPassword: !!users()[email.toLowerCase()]?.passwordHash, demoCode: code };
  }

  async function verifyCode(email: string, code: unknown): Promise<void> {
    if (api()) {
      finish(await post<AuthSession>("/auth/verify", { email, code }));
      return;
    }
    const pending: { email: string; code: string; exp: number } | null = JSON.parse(sessionStorage.getItem(PENDING) || "null");
    if (!pending || pending.email !== email || pending.exp < Date.now()) {
      throw new Error("Code expired. Send a new one.");
    }
    if (String(code).trim() !== String(pending.code)) throw new Error("That code didn’t work.");
    sessionStorage.removeItem(PENDING);
    const rec = users()[email.toLowerCase()];
    finish({ email, name: email.split("@")[0], provider: "email", uid: email.toLowerCase(), hasPassword: !!rec?.passwordHash });
  }

  function hasPassword(): boolean {
    return !!session()?.hasPassword;
  }
  // The session carries it, so Settings can tell "set" from "change" without
  // another round trip.
  function markPassword(has: boolean): void {
    const s = session();
    if (s) setSession({ ...s, hasPassword: has });
  }

  // Replacing or removing a password means proving the current one, which
  // means deriving it against the salt it was made with, not the new one.
  async function currentKey(email: string, current: string | undefined): Promise<string | null> {
    const params = (await checkEmail(email)).kdf;
    if (!params) return null;
    return deriveKey(current || "", params.salt, params.iterations);
  }

  async function setPassword(password: string, current?: string): Promise<void> {
    if (!password || password.length < 8) throw new Error("Password must be at least 8 characters.");
    const s = session();
    if (!s) throw new Error("Verify your email first.");
    const email = s.email.toLowerCase();
    const { iterations, saltBytes } = await kdfParams();
    const salt = hex(crypto.getRandomValues(new Uint8Array(saltBytes)));
    const key = await deriveKey(password, salt, iterations);
    const proof = await currentKey(email, current);
    if (api()) {
      await post("/me/password", { key, salt, iterations, ...(proof ? { currentKey: proof } : {}) }, s.token);
      markPassword(true);
      return;
    }
    const all = users();
    const rec = all[email];
    if (rec?.passwordHash && rec.passwordHash !== await sha256(`v2:${rec.kdf?.salt}:${proof}`)) {
      throw new Error("Current password is wrong.");
    }
    all[email] = { ...rec, passwordHash: await sha256(`v2:${salt}:${key}`), kdf: { salt, iterations }, provider: "email" };
    saveUsers(all);
    markPassword(true);
  }

  async function removePassword(current: string): Promise<void> {
    const s = session();
    if (!s) throw new Error("Sign in first.");
    const email = s.email.toLowerCase();
    const proof = await currentKey(email, current);
    if (api()) {
      await post("/me/password", { remove: true, currentKey: proof }, s.token);
      markPassword(false);
      return;
    }
    const all = users();
    const rec = all[email];
    if (!rec?.passwordHash || rec.passwordHash !== await sha256(`v2:${rec.kdf!.salt}:${proof}`)) {
      throw new Error("Current password is wrong.");
    }
    delete all[email].passwordHash;
    delete all[email].kdf;
    saveUsers(all);
    markPassword(false);
  }

  function finish(s: AuthSession): void {
    s.email = s.email.toLowerCase();
    setSession(s);
    if (s.name) localStorage.setItem("bookle.name", s.name.slice(0, 24));
  }

  async function updateProfile(name: unknown): Promise<{ uid?: string; name: string }> {
    const s = session();
    if (!s) throw new Error("Sign in first.");
    const clean = String(name ?? "").trim().replace(/\s+/g, " ");
    if ([...clean].length > 24 || /[\u0000-\u001f\u007f]/.test(clean)) throw new Error("Use up to 24 visible characters.");
    if (api()) {
      const saved = await post<{ uid?: string; name: string }>("/me/profile", { name: clean }, s.token);
      setSession({ ...s, name: saved.name, uid: saved.uid || s.uid });
      localStorage.setItem("bookle.name", saved.name);
      return saved;
    }
    const saved = clean || "Anonymous";
    setSession({ ...s, name: saved });
    localStorage.setItem("bookle.name", saved);
    return { uid: s.uid, name: saved };
  }

  function signOut(): void {
    const s = session();
    if (api() && s?.token) fetch(`${api()}/auth/logout`, {
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
  function popupFeatures(): string {
    const w = POPUP_W;
    const h = POPUP_H;
    // availLeft/availTop are non-standard (no Safari), hence the fallbacks.
    const scr: Screen & { availLeft?: number; availTop?: number } = screen;
    const availLeft = scr.availLeft ?? 0;
    const availTop = scr.availTop ?? 0;
    const availW = screen.availWidth || screen.width || window.outerWidth || w;
    const availH = screen.availHeight || screen.height || window.outerHeight || h;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
    const left = Math.round(clamp(availLeft + (availW - w) / 2, availLeft, availLeft + Math.max(0, availW - w)));
    const top = Math.round(clamp(availTop + (availH - h) / 2.4, availTop, availTop + Math.max(0, availH - h)));
    return `popup=yes,width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`;
  }

  function redirectUri(): string {
    return location.origin + location.pathname.replace(/[^/]*$/, "") + "oauth.html";
  }

  // Classic centred account-chooser window (OAuth implicit flow), not One Tap.
  function googleSignIn(): Promise<AuthSession | null> {
    const cid = window.BOOKLE_GOOGLE_CLIENT_ID;
    if (!cid) {
      return Promise.reject(
        new Error("Google sign-in needs EXCERPTLE_GOOGLE_CLIENT_ID in src/config.ts.")
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

    return new Promise<string>((resolve, reject) => {
      let done = false;
      const finishUp = <A>(fn: (arg: A) => void, arg: A) => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMessage);
        clearInterval(closedTimer);
        try { win.close(); } catch { /* already gone */ }
        fn(arg);
      };
      function onMessage(e: MessageEvent) {
        if (e.origin !== location.origin) return;
        const d: { source?: string; state?: string; error?: string; accessToken?: string } | null = e.data;
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

  async function googleProfile(token: string): Promise<AuthSession | null> {
    if (api()) {
      finish(await post<AuthSession>("/auth/google", { accessToken: token }));
      return session();
    }
    const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error("Could not read your Google profile.");
    const p: { email?: string; name?: string; sub?: string } = await res.json();
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
    checkEmail,
    sendCode,
    verifyCode,
    signInWithPassword,
    hasPassword,
    setPassword,
    removePassword,
    updateProfile,
    googleSignIn,
  };
})();
