/* Tag filtering: any / all / not, how they combine, and the tag kinds.
   Runs against the two-author fixture, whose tags are known and canonical:
     voxa-1   5m  Audience: F4M  Femdom    Induction: Confusion
                  Production: Subliminals  Trigger: Snap        Audio, Hypnosis
     voxa-2  25m  Audience: F4A  Femdom    Compulsion: Relisten Audio
     voxa-3  45m  Audience: F4M  ASMR-ish  Production: Whispers Free Files
     nyx-4   10m  Audience: F4A  ASMR-ish  Trigger: Snap
                  Induction: Conversational                     Audio, Roleplay   */
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs"; import path from "node:path";

import { fileURLToPath } from "node:url";
const ROOT = process.argv[2] || fileURLToPath(new URL("../www", import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { c ? (pass++, console.log("  ok   " + n))
                                 : (fail++, console.log("  FAIL " + n + " " + e)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function app(filters, store) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => { if (!/Not implemented/.test(e.message)) console.log("  [jsdom]", e.message); });
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "index.html"), "utf8"),
    { url: "http://localhost:9/", runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom, doc = window.document;
  window.fetch = async u => {
    const p = path.join(ROOT, String(u).replace(/^https?:\/\/[^/]+\//, "").split("?")[0]);
    if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
    const b = fs.readFileSync(p);
    return { ok: true, status: 200, headers: { get: () => String(b.length) },
      json: async () => JSON.parse(b.toString()), text: async () => b.toString(), clone() { return this; } };
  };
  window.caches = { async open() { return { async keys() { return []; }, async put() {},
    async delete() {}, async match() {} }; }, async match() {}, async delete() {}, async keys() { return []; } };
  window.Audio = class { constructor() { this.paused = true; this.currentTime = 0; this.duration = 0;
    this.playbackRate = 1; this._l = {}; } addEventListener(k, f) { (this._l[k] ||= []).push(f); }
    play() { this.paused = false; return Promise.resolve(); } pause() {} removeAttribute() {} load() {} };
  window.MediaMetadata = class {}; window.Response = class {}; window.Request = class {};
  window.navigator.mediaSession = { setActionHandler() {}, set metadata(v) {} };
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  if (filters) window.localStorage.setItem("hyp.filters", JSON.stringify(filters));
  // What the reader has done, seeded before the app reads it: the modules cache
  // on first read, so this has to be in place before app.js runs at all.
  for (const [k, v] of Object.entries(store || {})) {
    window.localStorage.setItem(k, JSON.stringify(v));
  }
  window.eval(fs.readFileSync(path.join(ROOT, "app.js"), "utf8"));
  await sleep(250);

  const $ = s => doc.querySelector(s), $$ = s => [...doc.querySelectorAll(s)];
  const open = panel => { const d = doc.querySelector(`details.facet[data-panel="${panel}"]`);
    if (d && !d.open) { d.open = true; d.dispatchEvent(new window.Event("toggle")); } };
  const openAll = () => $$("details.facet").forEach(d => {
    if (!d.open) { d.open = true; d.dispatchEvent(new window.Event("toggle")); } });
  const chip = (key, v) => { openAll();
    return $$(`[data-act="facet"]`).find(b => b.dataset.key === key && b.dataset.v === v); };
  const hit = (el, alt = false) =>
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, altKey: alt }));
  const check = (id, on) => { const el = $(id); el.checked = on;
    el.dispatchEvent(new window.Event("change", { bubbles: true })); };
  const typeIn = async (id, v) => { const el = $(id); el.value = v;
    el.dispatchEvent(new window.Event("input", { bubbles: true })); await sleep(320); };
  return {
    window, doc, $, $$, open, openAll, check, typeIn,
    panels: () => $$("details.facet").map(d => d.dataset.panel),
    titles: () => $$(".card h3 a").map(a => a.textContent).sort(),
    n: () => $$(".card").length,
    // click a chip until it reaches the wanted state
    async set(key, v, mode) {
      const want = { any: 1, all: 2, not: 3, "": 0 }[mode];
      for (let i = 0; i < 4; i++) {
        const c = chip(key, v);
        if (!c) throw new Error(`no chip for ${v}`);
        const now = c.className.includes("f-any") ? 1 : c.className.includes("f-all") ? 2
                  : c.className.includes("f-not") ? 3 : 0;
        if (now === want) return;
        hit(c); await sleep(30);
      }
      throw new Error(`could not set ${v} to ${mode}`);
    },
    async altClick(key, v) { hit(chip(key, v), true); await sleep(30); },
    saved: () => JSON.parse(window.localStorage.getItem("hyp.filters")),
  };
}

const ids = t => t.map(x => x.replace(/^(\w+) Track (\d)$/, "$1-$2").toLowerCase()).join(",");

console.log("\n== any ==");
{
  const h = await app();
  await h.set("tags", "Femdom", "any");
  ok("any:[Femdom] -> the two Femdom items", ids(h.titles()) === "voxa-1,voxa-2", ids(h.titles()));
  await h.set("tags", "ASMR-ish", "any");
  ok("any:[Femdom,ASMR-ish] -> the union, all four", h.n() === 4, `${h.n()}`);
}

console.log("\n== all ==");
{
  const h = await app();
  await h.set("tags", "Femdom", "all");
  await h.set("tags", "Audience: F4M", "all");
  ok("all:[Femdom,F4M] -> only the item carrying both", ids(h.titles()) === "voxa-1", ids(h.titles()));
  await h.set("tags", "ASMR-ish", "all");
  ok("all:[Femdom,F4M,ASMR-ish] -> nothing carries all three", h.n() === 0, `${h.n()}`);
}

console.log("\n== not ==");
{
  const h = await app();
  await h.set("tags", "Audience: F4M", "not");
  ok("not:[F4M] hides every F4M item", ids(h.titles()) === "nyx-4,voxa-2", ids(h.titles()));
  await h.set("tags", "Audience: F4A", "not");
  ok("adding not:[F4A] takes those out too", h.n() === 0, `${h.n()}`);
}

console.log("\n== combined ==");
{
  const h = await app();
  await h.set("tags", "ASMR-ish", "any");
  await h.set("tags", "Audience: F4A", "not");
  ok("any:[ASMR-ish] + not:[F4A]", ids(h.titles()) === "voxa-3", ids(h.titles()));
}
{
  const h = await app();
  const h0 = await app({ spoil: true });
  await h0.set("tags", "Trigger: Snap", "all");
  await h0.set("tags", "Femdom", "not");
  ok("all:[Trigger: Snap] + not:[Femdom]", ids(h0.titles()) === "nyx-4", ids(h0.titles()));
}
{
  const h = await app();
  await h.set("tags", "Audience: F4M", "not");
  await h.set("cats", "Audio", "any");
  ok("a tag exclusion and a category selection combine",
     ids(h.titles()) === "nyx-4,voxa-2", ids(h.titles()));
}

console.log("\n== interaction ==");
{
  const h = await app();
  await h.altClick("tags", "Femdom");
  ok("alt-click steps backwards, straight to not", h.saved().tags.not.join() === "Femdom",
     JSON.stringify(h.saved().tags));
  ok("...and it filters", ids(h.titles()) === "nyx-4,voxa-3", ids(h.titles()));
}
{
  const h = await app();
  await h.set("tags", "Femdom", "any");
  await h.set("tags", "Audience: F4M", "not");
  const bar = h.$$('.fsel [data-act="facetOff"]');
  ok("chosen tags are listed outside the panel", bar.length === 2, `${bar.length}`);
  bar[0].dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  await sleep(40);
  ok("the ✕ on one removes just that tag",
     h.$$('.fsel [data-act="facetOff"]').length === 1, `${h.$$('.fsel [data-act="facetOff"]').length}`);
  h.$('[data-act="facetClear"]').dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  await sleep(40);
  ok("Clear drops the rest", h.n() === 4 && !h.$(".fsel"), `${h.n()}`);
}
{
  const h = await app();
  const snap = h.$$('[data-act="facet"]').find(b => b.dataset.v === "Production: Whispers");
  ok("each tag shows how many items it would match", snap.querySelector("i").textContent === "1",
     snap?.querySelector("i")?.textContent);
}
{
  const h = await app();
  const card = h.$('.card .tag[data-act="tag"]');
  const v = card.dataset.tag;
  card.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  await sleep(40);
  ok("clicking a tag on a card selects it", h.saved().tags.any.join() === v, JSON.stringify(h.saved().tags));
}

console.log("\n== persistence ==");
{
  const h = await app();
  await h.set("tags", "Femdom", "all");
  await h.set("tags", "Audience: F4A", "not");
  const s = h.saved();
  ok("selections are written to localStorage",
     s.tags.all.join() === "Femdom" && s.tags.not.join() === "Audience: F4A",
     JSON.stringify(s.tags));
  const h2 = await app(s);
  ok("and are restored on the next visit", ids(h2.titles()) === "voxa-1", ids(h2.titles()));
}
{
  const h = await app({ q: "", author: "", tag: "ASMR-ish", cat: "Audio", sort: "date" });
  ok("an old single-tag filter migrates to any:[…]",
     h.saved().tags.any.join() === "ASMR-ish" && h.saved().cats.any.join() === "Audio",
     JSON.stringify({ t: h.saved().tags, c: h.saved().cats }));
  ok("...and still filters the same way", ids(h.titles()) === "nyx-4", ids(h.titles()));
  ok("the superseded keys are dropped",
     !("tag" in h.saved()) && !("cat" in h.saved()), JSON.stringify(Object.keys(h.saved())));
}

console.log("\n== tag kinds ==");
{
  const h = await app();
  const panels = h.panels();
  ok("each kind gets its own section",
     ["tags:audience", "tags:induction", "tags:production", "tags:content", "cats"]
       .every(x => panels.includes(x)), panels.join("|"));
  ok("spoiler kinds are not shown by default",
     !panels.includes("tags:trigger") && !panels.includes("tags:compulsion"), panels.join("|"));
  ok("a tag chip shows its value, not its prefix",
     h.$$('[data-act="facet"]').some(b => b.dataset.v === "Audience: F4M"
        && b.textContent.trim().startsWith("F4M")),
     h.$$('[data-act="facet"]').find(b => b.dataset.v === "Audience: F4M")?.textContent);
  ok("trigger tags are kept off the cards",
     !h.$$(".card .tag").some(t => /Snap/.test(t.textContent)),
     h.$$(".card .tag").map(t => t.textContent).join("|"));
  ok("...but the card says how many are withheld",
     h.$$(".card .tag").some(t => /hidden/.test(t.textContent)));
  h.check("#fSpoil", true); await sleep(60);
  ok("show triggers reveals the sections",
     h.panels().includes("tags:trigger") && h.panels().includes("tags:compulsion"),
     h.panels().join("|"));
  ok("...and the trigger tags on cards",
     h.$$(".card .tag").some(t => /Snap/.test(t.textContent)));
}

console.log("\n== per-section clear ==");
{
  const h = await app();
  await h.set("tags", "Audience: F4M", "not");
  await h.set("tags", "Femdom", "any");
  const clearContent = h.$$('[data-act="facetClear"]').find(b => b.dataset.kind === "content");
  clearContent.dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  ok("clearing one section leaves a standing audience exclusion alone",
     h.saved().tags.not.join() === "Audience: F4M" && h.saved().tags.any.length === 0,
     JSON.stringify(h.saved().tags));
}

console.log("\n== duration ==");
{
  const h = await app();
  await h.typeIn("#fDurMin", "20");
  ok("a minimum in minutes filters on the file, not a tag",
     ids(h.titles()) === "voxa-2,voxa-3", ids(h.titles()));
  await h.typeIn("#fDurMax", "30");
  ok("a maximum narrows it further", ids(h.titles()) === "voxa-2", ids(h.titles()));
  await h.typeIn("#fDurMin", ""); await h.typeIn("#fDurMax", "");
  ok("clearing both restores everything", h.n() === 4, `${h.n()}`);
}
{
  const h = await app();
  ok("a derived Duration: tag is never offered as a facet",
     !h.$$('[data-act="facet"]').some(b => /^Duration:/.test(b.dataset.v)));
}

/* The Library facet: played, noted, liked, listed. None of it is in the build,
   so the fixture is seeded rather than tagged.
     voxa-1  liked, and written against      voxa-3  in a playlist
     voxa-2  liked                           nyx-4   played twice                */
console.log("\n== what you have done with it ==");
const WHEN = "2026-03-01T00:00:00.000Z";
const DID = {
  "hyp.favourites": { items: { "voxa-1": WHEN, "voxa-2": WHEN }, authors: {} },
  "hyp.notes": { "voxa-1": { text: "Worth keeping.", updated: WHEN } },
  "hyp.playlists": [{ id: "plfix", name: "Fixture list", items: ["voxa-3"],
                      created: 1, updated: 1 }],
  "hyp.history": { recent: [{ i: "nyx-4", t: WHEN, s: 600, c: true, d: "devfix" }],
                   plays: { "nyx-4": { f: WHEN, l: WHEN, c: { devfix: { n: 2, e: 0 } } } } },
};
{
  const h = await app(null, DID);
  ok("the panel is offered, after the ones about the recording",
     h.panels().at(-1) === "meta", h.panels().join(","));

  await h.set("meta", "favourite", "any");
  ok("any:[favourite] -> what has been liked", ids(h.titles()) === "voxa-1,voxa-2",
     ids(h.titles()));
  await h.set("meta", "note", "all");
  await h.set("meta", "favourite", "all");
  ok("all:[favourite,note] -> only the one that is both", ids(h.titles()) === "voxa-1",
     ids(h.titles()));

  await h.set("meta", "favourite", "");
  await h.set("meta", "note", "");
  await h.set("meta", "played", "not");
  ok("not:[played] -> everything not listened to yet",
     ids(h.titles()) === "voxa-1,voxa-2,voxa-3", ids(h.titles()));

  await h.set("meta", "played", "");
  await h.set("meta", "playlist", "any");
  ok("any:[in a playlist] -> the one in a list", ids(h.titles()) === "voxa-3", ids(h.titles()));
}
{
  const h = await app(null, DID);
  h.openAll();
  const count = v => h.$$('[data-act="facet"]')
    .find(b => b.dataset.key === "meta" && b.dataset.v === v)?.querySelector("i")?.textContent;
  ok("each chip counts what it would match", count("played") === "1" && count("favourite") === "2",
     `played=${count("played")} favourite=${count("favourite")}`);
  await h.set("meta", "favourite", "any");
  ok("...and the choice is remembered", h.saved().meta?.any.join() === "favourite",
     JSON.stringify(h.saved().meta));
}
{
  // A filter saved by an earlier visit has to survive being read back, which is
  // where a facet stored under a key the build did not have would come apart.
  const h = await app({ meta: { any: ["playlist"], all: [], not: [] } }, DID);
  ok("a Library facet kept from a previous visit still applies",
     ids(h.titles()) === "voxa-3", ids(h.titles()));
}
{
  // The facet has to work on a library nobody has touched yet: every chip is
  // empty, and choosing one is a way of finding out there is nothing.
  const h = await app();
  h.openAll();
  ok("with nothing done, the panel is still there", h.panels().includes("meta"));
  await h.set("meta", "played", "any");
  ok("...and asking for played gives nothing rather than everything", h.n() === 0, `${h.n()}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
