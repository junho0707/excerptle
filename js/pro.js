/* Excerptle Pro — subscription state. Stripe lives entirely on the backend;
   this only reads /billing/status and hands the user off to Stripe-hosted
   pages (Checkout to buy, Billing Portal to manage). No card data, no keys,
   no price IDs in the browser.

   Privilege, for now: ad-free. `isPro()` is the only thing ads.js asks. */
window.ExcerptlePro = (() => {
  const CACHE = "bookle.pro.v2";
  const DEV = "bookle.pro.dev"; // local-only override; ignored once an API is set
  const MAX_AGE = 24 * 60 * 60 * 1000;

  // Ad-free is the only privilege, so trusting a day-old cached "yes" costs
  // nothing and stops ads flashing in before /billing/status answers.
  let cur = read();
  let inflight = null;

  function api() {
    return (window.EXCERPTLE_API || window.BOOKLE_API || "").replace(/\/$/, "");
  }
  function session() {
    return window.BookleAuth?.session?.() || null;
  }
  function read() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE) || "null");
      if (c && c.uid === session()?.uid && session()?.token && Date.now() - (c.at || 0) < MAX_AGE) return c;
    } catch { /* fall through */ }
    return null;
  }
  function write(s) {
    cur = s ? { ...s, uid: session()?.uid, at: Date.now() } : null;
    if (cur) localStorage.setItem(CACHE, JSON.stringify(cur));
    else localStorage.removeItem(CACHE);
    document.dispatchEvent(new CustomEvent("excerptle-pro", { detail: cur }));
    return cur;
  }

  /* currentPeriodEnd arrives as unix seconds OR as an ISO-8601 string — both are
     in the documented contract. `iso * 1000` is NaN, and every comparison
     against NaN is false, which would quietly drop a paying subscriber back
     into ads. Normalise once, here. */
  function periodEndMs(v) {
    if (v == null) return null;
    if (typeof v === "number") return v * 1000;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }

  function devOverride() {
    return !api() && ["localhost", "127.0.0.1"].includes(location.hostname) && localStorage.getItem(DEV) === "1";
  }

  function isPro() {
    if (devOverride()) return true;
    if (!cur?.pro || cur.uid !== session()?.uid || !session()?.token) return false;
    if (Date.now() - cur.at >= MAX_AGE) return false;
    const end = periodEndMs(cur.currentPeriodEnd);
    return end === null || end > Date.now();
  }

  /* What the modal needs to know without doing its own thinking:
     "off"          — no API yet, or signed out: nothing to show but the pitch
     "loading"      — first fetch in flight
     "none"         — signed in, never subscribed
     "active"       — paying (or trialing); ads are off
     "canceling"    — active but set to end at period end
     "past_due"     — payment failed; Stripe is retrying
     "error"        — status call failed */
  function view() {
    if (devOverride()) return { phase: "active", pro: true, dev: true };
    if (!api()) return { phase: "off", reason: "no-api", pro: false };
    if (!session()?.token) return { phase: "off", reason: "signed-out", pro: false };
    if (cur && cur.uid !== session()?.uid) cur = null;
    if (!cur && inflight) return { phase: "loading", pro: false };
    if (!cur) return { phase: "error", pro: false };
    if (cur.error) return { phase: "error", pro: false, message: cur.message };
    const s = cur.status;
    if (s === "past_due" || s === "unpaid") return { phase: "past_due", pro: !!cur.pro, ...cur };
    if (isPro() && cur.cancelAtPeriodEnd) return { phase: "canceling", ...cur };
    if (isPro()) return { phase: "active", ...cur };
    return { ...cur, phase: "none", pro: false };
  }

  function headers() {
    const h = { "Content-Type": "application/json" };
    const s = session();
    // The backend issues this on /auth/verify | /auth/password | Google
    // verification. Until it does, these calls just come back 401 and the
    // modal says so rather than guessing.
    if (s?.token) h.Authorization = `Bearer ${s.token}`;
    return h;
  }

  async function refresh({ force = false } = {}) {
    // Signing out drops the entitlement. A missing API does not: it only means
    // we can't re-check right now, and a cached "pro" is still the honest
    // answer for its 24h — better than showing ads to someone who paid.
    if (!session()) {
      if (cur) write(null);
      return view();
    }
    if (!api()) return view();
    if (inflight) return inflight;
    const owner = session()?.uid;
    const ownerToken = session()?.token;
    inflight = (async () => {
      try {
        const res = await fetch(`${api()}/billing/status`, { headers: headers() });
        if (ownerToken !== session()?.token || owner !== session()?.uid) return view();
        if (res.status === 401) return write({ pro: false, error: true, message: "Sign in again to manage your subscription." });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const d = await res.json();
        if (ownerToken !== session()?.token) return view();
        return write({
          pro: !!d.pro,
          status: d.status || (d.pro ? "active" : "none"),
          currentPeriodEnd: d.currentPeriodEnd || null,
          cancelAtPeriodEnd: !!d.cancelAtPeriodEnd,
          price: d.price || null,
          hasCustomer: !!d.hasCustomer,
        });
      } catch (err) {
        // Keep any cached "pro: true" — a flaky network shouldn't start
        // showing ads to someone who paid.
        if (ownerToken !== session()?.token) return view();
        if (isPro()) return cur;
        return write({ pro: false, status: "none", error: true, message: String(err.message || err) });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  // Both hand off to a Stripe-hosted page, so the redirect *is* the result.
  async function hop(path, plan) {
    if (!api()) throw new Error("Billing isn’t connected yet.");
    if (!session()?.token) throw new Error("Sign in first — a subscription has to belong to an account.");
    const returnUrl = `${location.origin}${location.pathname}#/pro`;
    const res = await fetch(`${api()}${path}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ returnUrl, ...(plan ? { plan } : {}) }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "Stripe didn’t answer. Try again.");
    if (!d.url || !["checkout.stripe.com", "billing.stripe.com"].includes(new URL(d.url).hostname) || new URL(d.url).protocol !== "https:") throw new Error("Stripe didn’t return a checkout link.");
    location.href = d.url;
  }

  const checkout = (plan) => hop("/billing/checkout", plan);
  const portal = () => hop("/billing/portal");

  // Signing out drops the entitlement with the session. Signing *in* just
  // re-checks — clearing first would flash an ad at a returning subscriber.
  document.addEventListener("bookle-auth", (e) => {
    write(null);
    if (e.detail) Promise.resolve(inflight).finally(() => refresh({ force: true }));
  });

  window.addEventListener("focus", () => refresh());

  return { isPro, view, refresh, checkout, portal, state: () => cur };
})();
