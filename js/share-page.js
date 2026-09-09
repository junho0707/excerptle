/* Header + share buttons on the static pages (about, FAQ, how to play,
   privacy, support). Those pages don't load js/app.js, so this stands in for
   the two things the shared header needs from it — the hamburger menu and the
   sign-in tab's label — plus the share buttons: the native share sheet where
   the browser has one, a clipboard copy elsewhere.

   These buttons share the site root, not the page they sit on. The Worker
   renders the brand card for "/", and someone handed this link should land
   on the puzzle rather than on the rules. */
(function () {
  const RESET_MS = 2000;

  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-share]");
    if (!btn) return;

    const url = btn.dataset.shareUrl || location.href;
    const label = btn.textContent;

    if (navigator.share) {
      try {
        await navigator.share({
          title: btn.dataset.shareTitle || document.title,
          text: btn.dataset.shareText || "",
          url,
        });
        return;
      } catch (err) {
        // Dismissing the sheet is a decision, not a failure — don't then
        // quietly copy something the person just declined to send.
        if (err && err.name === "AbortError") return;
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = "Link copied ✓";
    } catch {
      btn.textContent = "Copy failed";
    }
    setTimeout(() => { btn.textContent = label; }, RESET_MS);
  });
})();

/* The header is byte-for-byte the game's, so the menu has to behave the same
   at every width: same dropdown, same hamburger, same close-on-outside-click. */
(function () {
  function setNav(open) {
    document.body.classList.toggle("nav-open", open);
    document.getElementById("nav-toggle")?.setAttribute("aria-expanded", String(open));
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="toggle-nav"]')) {
      setNav(!document.body.classList.contains("nav-open"));
      return;
    }
    if (!e.target.closest("#main-nav")) setNav(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setNav(false);
  });
})();

/* The sign-in tab says "Sign in" or your name in the game, and a header that
   changed wording between pages would read as a different header. auth.js
   isn't loaded here, so read the session it writes and match it. */
(function () {
  const tab = document.getElementById("auth-tab");
  if (!tab) return;
  let s = null;
  try {
    s = JSON.parse(localStorage.getItem("bookle.auth.session") || "null");
  } catch {
    return;
  }
  // Same expiry rule as auth.js. A stale session paints "Sign in", which is
  // what the game shows once it has checked.
  if (!s?.email || (s.expiresAt && s.expiresAt * 1000 <= Date.now())) return;
  tab.textContent = s.email.split("@")[0] || "Account";
  tab.href = "/#/account";
})();
