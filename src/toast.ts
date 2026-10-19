/* "Link copied" — the one place the site copies a link and says so. Shared by
   the game and the static pages (which don't load app.js), so the two can't
   drift apart. The share button no longer opens the native share sheet: it
   always copies, and a toast confirms it, so the button's label never changes
   and the same thing happens on every device. */
window.ExcerptleToast = ((): ExcerptleToastApi => {
  let el: HTMLDivElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function ensure(): HTMLDivElement {
    if (el) return el;
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
    return el;
  }

  function show(text: string, ms = 2000): void {
    const t = ensure();
    clearTimeout(timer);
    t.textContent = text;
    // A frame later, so a live region that was just created still announces it.
    requestAnimationFrame(() => t.classList.add("on"));
    timer = setTimeout(() => t.classList.remove("on"), ms);
  }

  async function writeText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch { /* no clipboard API, or no permission: try the old way */ }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* ok stays false */ }
    ta.remove();
    return ok;
  }

  // On failure the link goes in the toast, and stays up longer, so it can
  // still be copied by hand.
  async function copyLink(url: string): Promise<void> {
    if (await writeText(url)) show("Link copied");
    else show(`Couldn’t copy — link: ${url}`, 8000);
  }

  return { show, copyLink };
})();
