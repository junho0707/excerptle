import { kindOf } from "./share.js";

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
const ink = "#302820", wine = "#7a1f2b", muted = "#796d60", paper = "#f4efe4";
const text = (x, y, size, value, color = ink, serif = false, extra = "") =>
  `<text x="${x}" y="${y}" font-family="${serif ? "DejaVu Serif" : "DejaVu Sans"}" font-size="${size}" fill="${color}" ${extra}>${esc(value)}</text>`;
const rect = (x,y,w,h,fill,extra="") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" ${extra}/>`;
function wrap(value, max = 54) {
  const words = String(value || "").trim().split(/\s+/);
  const lines = []; let line = "";
  for (const word of words) {
    if ((line + " " + word).trim().length > max && line) { lines.push(line); line = word; }
    else line = (line + " " + word).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}
// The one call-to-action shape: a wine pill that sizes itself to its label.
function cta(y, label) {
  const w = label.length * 16 + 70;
  return rect(64,y,w,64,wine,'rx="7"')
    + text(64 + w/2, y+41, 22, label, paper, false, 'text-anchor="middle" letter-spacing="1"');
}
function squares(x,y,used,total,won=false) {
  return Array.from({length:total}, (_,i) => rect(x+i*48,y,36,36,i<used ? won && i===used-1 ? "#54765c" : wine : "none", 'rx="4" stroke="#c9beac" stroke-width="2"')).join("");
}

// SVG is the code-native layout; both the Worker and preview tool render it to PNG.
export function cardSvg(d, idx, { openingSentence = "", iconHref = "" } = {}) {
  const done = !d.invite && !!d.c;
  const label = d.invite ? "BATTLE INVITATION"
    : !d.c && d.m === "daily" ? "TODAY'S OPENING SENTENCE"
    : `${kindOf(d.m).toUpperCase()} · #${idx}`;
  // Long names must not run past the card edge; clamp the whole line, not the name.
  const fit = (line) => line.length * 16 > 1072 ? 'textLength="1072" lengthAdjust="spacingAndGlyphs"' : "";
  let body = "";
  if (done) {
    const who = `${d.n} ${d.w ? "solved it." : "gave it a try."}`;
    body = text(64,190,29,who,ink,false,fit(who))
      + text(64,263,19,label,wine,false,'letter-spacing="2"')
      + text(58,389,116,d.w ? `${d.g}/6` : "X/6",wine,true)
      + text(67,443,25,`${d.h} hint${d.h===1 ? "" : "s"}`,muted)
      + cta(472,"CAN YOU ALSO GUESS THE BOOK?")
      + rect(733,242,403,286,"#ebe3d2",'rx="12"')
      + text(775,288,17,"THE RESULT",muted,false,'letter-spacing="3"')
      + text(775,335,21,"Guesses",ink)
      + squares(775,355,d.g,6,!!d.w)
      + text(775,438,21,"Hints",ink)
      + squares(775,458,d.h,5);
  } else if (d.invite) {
    const who = `${d.n} invited you.`;
    body = text(64,190,29,who,ink,false,fit(who))
      + text(64,263,19,label,wine,false,'letter-spacing="2"')
      + text(61,335,61,"A battle of",wine,true)
      + text(61,402,61,"book smarts.",wine,true)
      + text(64,457,25,"Same book. First to guess wins.",muted)
      + text(64,513,29,"Join the battle →",ink,true)
      + rect(788,282,132,178,wine,'rx="10"')
      + rect(976,326,132,178,"#ebe3d2",'rx="10" stroke="#b9a994" stroke-width="2"')
      + text(854,390,65,"?",paper,true,'text-anchor="middle"')
      + text(1042,435,65,"?",wine,true,'text-anchor="middle"')
      + text(948,413,20,"VS",muted,false,'text-anchor="middle"');
  } else {
    const lines = wrap(openingSentence || "The first sentence of this book is waiting for you.");
    const who = `${d.n} shared this book with you.`;
    body = text(64,190,29,who,ink,false,fit(who))
      + text(64,263,19,label,wine,false,'letter-spacing="2"')
      + lines.map((line, i) => text(64,318 + i * 40,29, line, ink, true)).join("")
      + cta(464, d.m === "daily" ? "GUESS THE BOOK" : "GUESS THIS BOOK");
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    ${rect(0,0,1200,630,paper)}
    ${rect(0,0,1200,9,wine)}
    ${iconHref ? `<image href="${iconHref}" x="64" y="35" width="55" height="55"/>` : ""}
    ${text(iconHref ? 133 : 64,69,31,"EXCERPTLE",wine,true,'letter-spacing="4"')}
    ${text(iconHref ? 135 : 65,92,16,"GUESS THE BOOK",muted,false,'letter-spacing="2"')}
    ${rect(64,120,1072,1,"#cfc3b1")}
    ${body}
    ${text(1136,590,22,"excerptle.io",wine,false,'text-anchor="end"')}
  </svg>`;
}
