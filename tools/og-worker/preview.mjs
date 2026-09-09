import { readFile, writeFile, mkdir } from "node:fs/promises";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { cardSvg } from "./card.js";
import { unfurl } from "./share.js";

const root = new URL("./", import.meta.url);
await initWasm(await readFile(new URL("node_modules/@resvg/resvg-wasm/index_bg.wasm", root)));
const fonts = await Promise.all(["DejaVuSerif", "DejaVuSans"].map(n => readFile(new URL(`fonts/${n}.ttf`, root))));
const iconHref = `data:image/png;base64,${(await readFile(new URL("../../assets/icon-192.png", root))).toString("base64")}`;
const output = new URL("../../dist/share-previews/", root);
await mkdir(output, { recursive: true });
const base = {n:"Junho",m:"daily",c:0,w:0,g:0,h:0,t:0};
export const examples = [
  ["a-uncompleted-daily", "A · Uncompleted daily", {...base}, 642],
  ["b-uncompleted-question-bank", "B · Uncompleted question bank", {...base,m:"preset"}, 42],
  ["c-completed-daily", "C · Completed daily", {...base,c:1,w:1,g:3,h:1,t:84}, 642],
  ["d-completed-question-bank", "D · Completed question bank", {...base,m:"preset",c:1,w:1,g:4,h:2,t:132}, 42],
  ["e-battle-invitation", "E · Battle invitation", {...base,m:"battle",invite:true}, 42],
];
const png = svg => {
  const r = new Resvg(svg, { font:{fontBuffers:fonts} });
  const rendered = r.render();
  try { return rendered.asPng(); } finally { rendered.free(); r.free(); }
};
let sheet = "";
let html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Excerptle sharing previews</title><style>body{margin:32px;background:#e5dfd3;color:#302820;font:16px system-ui}main{max-width:1200px;margin:auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:32px}img{width:100%;border-radius:8px}h1{max-width:1200px;margin:0 auto 32px}h2{font-size:17px}p{line-height:1.5}</style><h1>Excerptle · Five ways to share</h1><main>';
for (const [i,[slug,label,d,idx]] of examples.entries()) {
  const svg = cardSvg(d,idx,{ iconHref, openingSentence: !d.c && !d.invite ? "It is a truth universally acknowledged, that a single man in possession of a good fortune must be in want of a wife." : "" });
  await writeFile(new URL(slug+".png",output),png(svg));
  const {title,description} = unfurl(d,idx);
  html += `<article><h2>${label}</h2><a href="${slug}.png"><img src="${slug}.png"></a><p><b>${title}</b><br>${description}</p></article>`;
  const x = (i%2)*640+20, y=Math.floor(i/2)*390+55;
  sheet += `<text x="${x}" y="${y-15}" font-family="DejaVu Sans" font-size="18" fill="#302820">${label}</text><svg x="${x}" y="${y}" width="600" height="315" viewBox="0 0 1200 630">${svg.replace(/^<svg[^>]*>/,"").replace(/<\/svg>$/,"")}</svg>`;
}
await writeFile(new URL("index.html",output),html+"</main>");
await writeFile(new URL("all-five.png",output),png(`<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="1170"><rect width="1280" height="1170" fill="#e5dfd3"/>${sheet}</svg>`));
console.log("Previews: dist/share-previews/index.html");
