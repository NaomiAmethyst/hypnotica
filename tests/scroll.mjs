/* Opening something starts at the top; coming back lands where you left.

   jsdom does no layout, so nothing here can prove the page *looks* right. What
   it can prove is the bookkeeping underneath: which position was remembered for
   which view, what the app asked the window to scroll to, and whether the
   windowed grid was made tall enough for that position to exist before the
   scroll was attempted. Those are the parts that break silently.

   `scrollY` is made settable so a scroll can be simulated; the app's own calls
   to `scrollTo` move it, exactly as a browser would.

     node tests/scroll.mjs /path/to/www
*/
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readIndex } from "./readindex.mjs";

const ROOT = process.argv[2] || fileURLToPath(new URL("../www", import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const vc = new VirtualConsole();
vc.on("jsdomError", e => { if (!/Not implemented/.test(e.message)) console.log("  [jsdom]", e.message); });
const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "index.html"), "utf8"), {
  url: "http://localhost:9/", runScripts: "outside-only",
  pretendToBeVisual: true, virtualConsole: vc,
});
const { window } = dom, doc = window.document;

window.fetch = async (url) => {
  const name = String(url).replace(/^https?:\/\/[^/]+\//, "").split("?")[0];
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
  const text = fs.readFileSync(file, "utf8");
  return { ok: true, status: 200, headers: { get: () => String(text.length) },
    json: async () => JSON.parse(text), text: async () => text, clone() { return this; } };
};
window.caches = { async open() { return { async keys() { return []; }, async put() {},
  async delete() { return true; }, async match() {}, async add() {} }; },
  async match() {}, async keys() { return []; }, async delete() { return true; } };
window.Audio = class { constructor() { this.paused = true; this._l = {}; }
  addEventListener(k, f) { (this._l[k] ||= []).push(f); }
  play() { return Promise.resolve(); } pause() {} removeAttribute() {} };
window.MediaMetadata = class {};
window.Response = class {};
window.Request = class { constructor(u) { this.url = String(u); } };
window.navigator.mediaSession = { setActionHandler() {}, set metadata(v) {} };
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };

/* A window that can be scrolled, and remembers being asked to. */
let y = 0;
const asked = [];
Object.defineProperty(window, "scrollY", { get: () => y, configurable: true });
window.scrollTo = (_x, to) => { asked.push(to); y = Number(to) || 0; };
// rAF exists in jsdom with pretendToBeVisual, but keep it prompt.
window.requestAnimationFrame = fn => setTimeout(fn, 0);

window.eval(fs.readFileSync(path.join(ROOT, "app.js"), "utf8"));

const $ = s => doc.querySelector(s);
const $$ = s => [...doc.querySelectorAll(s)];
const total = () => Number(($(".count")?.textContent || "").replace(/,/g, "")
  .match(/of\s+([0-9]+)/)?.[1] ?? 0);
const go = async (hash) => {
  window.location.hash = hash;
  window.dispatchEvent(new window.Event("hashchange"));
  await sleep(140);
};

const index = readIndex(ROOT);
for (let n = 0; n < 90 && total() < index.items.length; n++) await sleep(100);
await sleep(200);

console.log("\n== the browser is told to keep out of it ==");
// jsdom does not implement history.scrollRestoration, so the app's guard skips
// the assignment. Assert what this environment can actually answer: that the
// app sets it where it exists, and does not blow up where it does not.
if ("scrollRestoration" in window.history) {
  ok("scroll restoration is manual", window.history.scrollRestoration === "manual",
     String(window.history.scrollRestoration));
} else {
  ok("left alone where the browser has no such setting",
     window.history.scrollRestoration === undefined);
}

console.log("\n== opening an item ==");
const cards = $$(".card").length;
ok("the library drew a window of cards", cards > 0, `${cards} cards`);
y = 4200;                                  // as if the reader had scrolled down
asked.length = 0;
const first = index.items.find(i => i.audio) || index.items[0];
await go(`#/item/${encodeURIComponent(first.id)}`);
ok("goes to the top", asked.includes(0), asked.join(",") || "never scrolled");
ok("...and is at the top", y === 0, String(y));

console.log("\n== back to the library ==");
asked.length = 0;
await go("#/");
await sleep(80);
ok("returns to where the reader was", asked.includes(4200),
   asked.join(",") || "never scrolled");
ok("...and the grid is tall enough to hold that position",
   $$(".card").length >= cards, `${$$(".card").length} cards, was ${cards}`);

console.log("\n== a second item, then back again ==");
y = 1500;
asked.length = 0;
const second = index.items[3] || first;
await go(`#/item/${encodeURIComponent(second.id)}`);
ok("forward is still the top", y === 0, String(y));
asked.length = 0;
await go("#/");
await sleep(80);
ok("back is the newer position, not the older one", y === 1500, String(y));

console.log("\n== redrawing while somebody is using the page ==");
// Both of these are redraws the reader did not ask for: a filter applied, or
// transcript hits landing behind a search. Neither may take the caret or the
// reader's place on the page.
await go("#/");
await sleep(120);
const box = $("#q");
box.focus();
y = 3000; asked.length = 0;
box.value = "woodland";
box.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(700);
// The element itself is replaced by the redraw; what must survive is the
// caret being in the search box, not the identity of the node holding it.
ok("typing keeps the caret", doc.activeElement?.id === "q",
   `focus is on ${doc.activeElement?.id || "nothing"}`);
ok("...and does not move the page", asked.every(v => v === 3000),
   asked.join(",") || "(none)");

box.value = ""; box.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(400);
const facet = doc.querySelector("details.facet");
if (facet) { facet.open = true; facet.dispatchEvent(new window.Event("toggle")); }
await sleep(120);
const chip = doc.querySelector('.facet [data-act="facet"]');
y = 2500; asked.length = 0;
chip?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(500);
ok("choosing a tag holds the reader's place",
   asked.length > 0 && asked.every(v => v === 2500), asked.join(",") || "(none)");
ok("...and no stale position arrives late", y === 2500, String(y));

console.log("\n== scrolling inside a facet panel ==");
// The tag list is its own scrolling box, and choosing a tag redraws the view.
// Restoring the window's position says nothing about the box: it is a different
// element each time, starting at the top, which is what "it jumps back" means.
{
  const panel = doc.querySelector("details.facet");
  panel.open = true;
  panel.dispatchEvent(new window.Event("toggle"));
  await sleep(150);
  const key = panel.dataset.panel;
  const body = () => doc.querySelector(`details.facet[data-panel="${key}"] .fbody`);
  body().scrollTop = 260;                       // as if scrolled down the tag list
  const tag = doc.querySelector(`details.facet[data-panel="${key}"] [data-act="facet"]`);
  tag.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(400);
  ok("the tag list stays where it was scrolled to", body()?.scrollTop === 260,
     `scrollTop is ${body()?.scrollTop}`);
}

console.log("\n== a view with nothing remembered ==");
y = 900;
await go("#/authors");
ok("starts at the top", y === 0, String(y));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
