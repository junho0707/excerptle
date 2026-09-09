/* Post-game ad slot. One placement, one impression per finished game.

   Rules this file exists to keep:
   - Nothing loads unless EXCERPTLE_ADS is enabled *and* both IDs are set.
   - Pro is ad-free, checked at render time, not just at boot.
   - Excerptle is a single page with hash routing, so there is no page load per
     game. AdSense wants one request per genuine content view, which means a
     *fresh* <ins> node each time — pushing twice against the same node throws,
     and refreshing on a timer is a policy violation. Hence clear() + render().
   - Manual unit only. Auto ads stay off in the console; they would drop ads
     beside the guess input, which is the classic accidental-click ban. */
window.ExcerptleAds = (() => {
  const SRC = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";
  let scriptEl = null;

  const cfg = () => window.EXCERPTLE_ADS || {};
  const host = () => document.getElementById("ad");

  /* The dashed box is a layout aid, not something a visitor should ever meet.
     "dev" keeps it on localhost and off everywhere else, so shipping during
     the approval window doesn't need a flag flipped by hand. */
  function wantPlaceholder() {
    const v = cfg().placeholder;
    if (v === true) return true;
    if (v === "dev") {
      const h = location.hostname;
      return h === "localhost" || h === "0.0.0.0" || h === "::1" || h === "[::1]"
        || /^127\.\d+\.\d+\.\d+$/.test(h) || h.endsWith(".local") || h === "";
    }
    return false;
  }

  function configured() {
    const c = cfg();
    return !!(c.enabled && c.client && c.slot);
  }
  function active() {
    return configured() && !window.ExcerptlePro?.isPro?.();
  }

  /* index.html carries the loader in <head> — AdSense needs it there before
     approval, since that tag is what the reviewer's crawler looks for. Adopt
     it rather than appending a second copy: loading adsbygoogle.js twice
     double-counts and is a good way to get flagged. */
  function loadScript() {
    if (scriptEl) return;
    scriptEl = document.querySelector(`script[src^="${SRC}"]`);
    if (scriptEl) return;
    scriptEl = document.createElement("script");
    scriptEl.async = true;
    scriptEl.crossOrigin = "anonymous";
    scriptEl.src = `${SRC}?client=${encodeURIComponent(cfg().client)}`;
    document.head.appendChild(scriptEl);
  }

  function clear() {
    const el = host();
    if (!el) return;
    el.classList.add("hidden");
    el.innerHTML = "";
  }

  function render() {
    const el = host();
    if (!el) return;
    el.innerHTML = "";
    if (!active()) {
      // Before approval there is no ad to draw. An empty dashed box just reads
      // as a broken page, so show it only when explicitly asked for.
      // Pro sees no box either — otherwise testing Pro locally still shows an ad frame.
      if (configured() || !wantPlaceholder() || window.ExcerptlePro?.isPro?.()) return clear();
      el.classList.remove("hidden");
      el.innerHTML = '<span class="ad-label">Advertisement</span><div class="slot">Post-game only</div>';
      return;
    }
    loadScript();
    el.classList.remove("hidden");

    const label = document.createElement("span");
    label.className = "ad-label";
    label.textContent = "Advertisement";

    const ins = document.createElement("ins");
    ins.className = "adsbygoogle";
    ins.style.display = "block";
    ins.dataset.adClient = cfg().client;
    ins.dataset.adSlot = cfg().slot;
    ins.dataset.adFormat = "auto";
    ins.dataset.fullWidthResponsive = "true";

    el.append(label, ins);
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      clear();
    }
  }

  // Buying Pro mid-session should take the ad away without a reload.
  document.addEventListener("excerptle-pro", () => {
    if (host() && !host().classList.contains("hidden") && !active()) clear();
  });

  return { render, clear, active, configured };
})();
