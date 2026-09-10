/* Google Web OAuth client ID only (…apps.googleusercontent.com).
   NEVER put the client secret in this file or anywhere in the frontend. */
window.EXCERPTLE_GOOGLE_CLIENT_ID = "1084292631320-lat25fml3s4n627i4c9aur7a4752cmrm.apps.googleusercontent.com";
window.BOOKLE_GOOGLE_CLIENT_ID = window.EXCERPTLE_GOOGLE_CLIENT_ID;
window.EXCERPTLE_API = "https://excerptle-api.winter-glade-cbab.workers.dev";
window.BOOKLE_API = window.EXCERPTLE_API;

/* Local testing, both gated on hostname so neither can fire on the live site
   however the query string is dressed up:

     ?demo=1    no backend at all. js/auth.js runs its localStorage-only path
                and prints the sign-in code on screen instead of mailing it.
     ?api=local the real Worker on :8787 (backend/ $ npx wrangler dev), against
                a local D1. This is the one that catches a frontend and an API
                that disagree — the failure ?demo=1 cannot see, because there
                is no API to disagree with. */
if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  const flag = new URLSearchParams(location.search);
  if (flag.get("demo") === "1") window.EXCERPTLE_API = "";
  else if (flag.get("api") === "local") window.EXCERPTLE_API = "http://127.0.0.1:8787";
  window.BOOKLE_API = window.EXCERPTLE_API;
}

/* Ads. Nothing is requested from Google until `enabled` is true AND both IDs
   are filled in, so this file is safe to ship before AdSense approves the site.
   On approval: paste the pub ID + the display unit's slot ID, flip `enabled`,
   deploy, and add /ads.txt. Auto ads stay OFF in the AdSense console — the only
   placement is the post-game slot, which is the one spot that can't cause an
   accidental click on a live game. See MONETIZATION.md. */
window.EXCERPTLE_ADS = {
  enabled: false,
  client: "ca-pub-2005015845685746",
  slot: "",             // from the Display unit you create AFTER approval
                        // (NOT the 7855100651 customer ID — different number)
  placeholder: "dev",   // dashed box on localhost only; never in production
};

/* Stripe. Keys never touch the frontend — the browser only ever calls our own
   API, which talks to Stripe server-side:
     GET  /billing/status    -> { pro, status, currentPeriodEnd, cancelAtPeriodEnd, price }
     POST /billing/checkout  -> { url }   (Stripe Checkout session)
     POST /billing/portal    -> { url }   (Stripe Billing Portal session)
   Until EXCERPTLE_API is set, the Pro modal says billing isn't connected yet
   rather than pretending anyone is subscribed. */
window.EXCERPTLE_PRO = {
  priceLabel: "$3/month",
  blurb: "Excerptle Pro removes ads.",
};
