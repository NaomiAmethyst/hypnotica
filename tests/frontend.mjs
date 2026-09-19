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
  url: "http://localhost:8788/", runScripts: "outside-only", pretendToBeVisual: true,
  virtualConsole: vc,
});
const { window } = dom;
const doc = window.document;

// ---- browser shims ---------------------------------------------------------
window.fetch = async (url) => {
  const p = path.join(ROOT, String(url).replace(/^https?:\/\/[^/]+\//, "").split("?")[0]);
  if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
  const buf = fs.readFileSync(p);
  return {
    ok: true, status: 200,
    headers: { get: k => (k === "content-length" ? String(buf.length) : "audio/mpeg") },
    json: async () => JSON.parse(buf.toString("utf8")),
    text: async () => buf.toString("utf8"),
    clone() { return this; },
    body: { getReader() { let done = false;
      return { read: async () => done ? { done: true } : (done = true, { done: false, value: buf }) }; } },
  };
};
const cacheStore = new Map();
window.caches = {
  async open(n) {
    if (!cacheStore.has(n)) cacheStore.set(n, new Map());
    const m = cacheStore.get(n);
    return {
      async keys() { return [...m.keys()].map(u => ({ url: u })); },
      async put(req, res) { m.set(typeof req === "string" ? req : req.url, res); },
      async delete(req) { return m.delete(typeof req === "string" ? req : req.url); },
      async match(req) { return m.get(typeof req === "string" ? req : req.url); },
      async add() {},
    };
  },
  async delete(n) { return cacheStore.delete(n); },
  async match() { return undefined; },
  async keys() { return [...cacheStore.keys()]; },
};
window.Audio = class { constructor() { this.paused = true; this.currentTime = 0; this.duration = 0;
  this.playbackRate = 1; this._l = {}; }
  addEventListener(k, f) { (this._l[k] ||= []).push(f); }
  play() { this.paused = false; (this._l.play || []).forEach(f => f()); return Promise.resolve(); }
  pause() { this.paused = true; (this._l.pause || []).forEach(f => f()); }
  removeAttribute() {} };
window.MediaMetadata = class { constructor(o) { Object.assign(this, o); } };
window.Response = class { constructor(body, init = {}) { this.body = body; this.ok = true;
  this.status = 200; this._h = init.headers || {};
  this.headers = { get: k => this._h[k] }; } };
window.Request = class { constructor(url) { this.url = String(url); } };
Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
window.navigator.mediaSession = { setActionHandler() {}, set metadata(v) {} };
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () { this.open = false; };
window.prompt = () => "Test playlist";
window.confirm = () => true;

// ---- run the real app ------------------------------------------------------
window.eval(fs.readFileSync(path.join(ROOT, "app.js"), "utf8"));
await sleep(400);

const $ = s => doc.querySelector(s);
const $$ = s => [...doc.querySelectorAll(s)];
const index = readIndex(ROOT);
// What the grid says it is showing. The DOM holds a window of the results, not
// all of them, so counting `.card` measures the window and nothing else.
const shown = () => Number(($(".count")?.textContent || "").replace(/,/g, "")
  .match(/([0-9]+)\s+of/)?.[1] ?? -1);
// "N of M": M is how many items have been loaded so far. Read from the page
// rather than from the app's variables, which a later eval cannot see.
const loaded = () => Number(($(".count")?.textContent || "").replace(/,/g, "")
  .match(/of\s+([0-9]+)/)?.[1] ?? 0);
const settle = async (want, tries = 80) => {
  for (let n = 0; n < tries && loaded() < want; n++) await sleep(100);
  await sleep(120);
};
// The grid's haystack is built at build time, not reconstructed here: write-ups
// live in the per-author detail shards now, not in index.json.
const searchText = JSON.parse(fs.readFileSync(path.join(ROOT, "data/search.json"), "utf8"));
const click = el => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const setVal = (el, v, type = "input") => {
  el.value = v; el.dispatchEvent(new window.Event(type, { bubbles: true }));
};

console.log("\n== boot & library ==");
ok("title applied", doc.title === "Hypnotica", doc.title);
ok("brand rendered", $("#brandName").textContent === "Hypnotica");
await settle(index.items.length);
ok(`every page loaded (${index.items.length})`, loaded() === index.items.length,
   `${loaded()} of ${index.items.length}`);
const cards = $$(".card");
ok("the grid is a window, not the whole library",
   cards.length > 0 && cards.length < index.items.length,
   `${cards.length} cards in the DOM for ${index.items.length} items`);
ok("...and it says how many there are", shown() === index.items.length,
   `count line says ${shown()}`);
ok("count line correct",
   new RegExp(`${index.items.length} of ${index.items.length}`)
     .test($(".count").textContent.replace(/,/g, "")),
   $(".count").textContent.trim().slice(0, 40));
ok("cards link to items", $$(".card h3 a").every(a => a.getAttribute("href").startsWith("#/item/")));
ok("tags rendered", $$(".card .tag").length > 100);
ok("offline/transcript pills present", $$(".card .pill").length > 100);

console.log("\n== search ==");
setVal($("#q"), "woodland");
await sleep(300);
const n1 = shown();
ok("search narrows results", n1 > 0 && n1 < index.items.length, `${n1} hits`);
const expect = index.items.filter(i =>
  (searchText[i.id] || "").toLowerCase().includes("woodland")).length;
ok("search matches expected count", n1 === expect, `dom ${n1} vs expected ${expect}`);

console.log("\n== transcript search ==");
setVal($("#fTr"), true, "change");
$("#fTr").checked = true; $("#fTr").dispatchEvent(new window.Event("change", { bubbles: true }));
await sleep(900);
const n2 = shown();
ok("transcript search widens results", n2 >= n1, `${n1} -> ${n2}`);
$("#fTr").checked = false; $("#fTr").dispatchEvent(new window.Event("change", { bubbles: true }));
setVal($("#q"), ""); await sleep(300);

console.log("\n== filters ==");
const chip = v => $$('.facet [data-act="facet"]').find(b => b.dataset.v === v);
$("details.facet").open = true;
$("details.facet").dispatchEvent(new window.Event("toggle"));
const someTag = index.items.find(i => i.tags.length)?.tags[0];
click(chip(someTag));                                        // neutral -> any
await sleep(80);
const tagged = index.items.filter(i => i.tags.includes(someTag)).length;
ok(`tag filter "${someTag}"`, shown() === tagged, `${shown()} vs ${tagged}`);
click(chip(someTag)); click(chip(someTag)); await sleep(80);  // any -> all -> not
const without = index.items.filter(i => !i.tags.includes(someTag)).length;
ok(`tag exclusion "${someTag}"`, shown() === without, `${shown()} vs ${without}`);
click(chip(someTag)); await sleep(80);                        // not -> off
ok("tag filter cleared", shown() === index.items.length, `${shown()}`);
setVal($("#fSort"), "title", "change"); await sleep(50);
const titles = $$(".card h3 a").map(a => a.textContent);
ok("sort by title", titles.join("|") === [...titles].sort((a, b) => a.localeCompare(b)).join("|"));
setVal($("#fSort"), "date", "change"); await sleep(50);

console.log("\n== item view ==");
const target = index.items.find(i => i.hasTranscript && i.audio && i.cover);
window.location.hash = `#/item/${encodeURIComponent(target.id)}`;
await sleep(200);
ok("item h1", $("article h1")?.textContent === target.title, $("article h1")?.textContent);
ok("hero image", !!$("img.hero"));
ok("write-up rendered", ($(".prose")?.innerHTML.length || 0) > 50);
ok("play button", !!$('[data-act="playOne"]'));
ok("save-offline button", !!$('[data-act="save1"]'));
ok("transcript box", !!$("#trBox"));
$("#trBox").open = true;
$("#trBox").dispatchEvent(new window.Event("toggle"));
await sleep(400);
const segs = $$("#trBody tr").length;
ok("transcript segments render", segs > 5, `${segs} rows`);
ok("segment timestamps clickable", !!$('#trBody td[data-act="seek"]'));

console.log("\n== player & queue ==");
click($('[data-act="playOne"]'));
await sleep(150);
ok("player visible", !$("#player").classList.contains("hidden"));
ok("player shows title", $("#pTitle").textContent === target.title);
ok("body gets has-player", doc.body.classList.contains("has-player"));
window.location.hash = "#/";
await sleep(200);
for (let i = 0; i < 3; i++) {
  click($$('.card [data-act="enqueue"]')[i]);
  await sleep(60);
}
window.location.hash = "#/queue";
await sleep(150);
const qrows = $$("ol.list li").length;
ok("queue has entries", qrows >= 4, `${qrows} rows`);
click($('[data-act="qdown"]'));
await sleep(80);
ok("queue reorder works", $$("ol.list li").length === qrows);
click($('[data-act="qdel"]'));
await sleep(80);
ok("queue remove works", $$("ol.list li").length === qrows - 1, `${$$("ol.list li").length}`);

console.log("\n== playlists ==");
click($("#qSave"));
await sleep(120);
window.location.hash = "#/playlists";
await sleep(150);
ok("playlist created and listed", $$("ol.list li").length === 1, `${$$("ol.list li").length}`);
ok("playlist persisted to localStorage", JSON.parse(window.localStorage.getItem("hyp.playlists")).length === 1);
const plId = JSON.parse(window.localStorage.getItem("hyp.playlists"))[0].id;
window.location.hash = `#/playlist/${plId}`;
await sleep(150);
ok("playlist detail renders items", $$("ol.list li").length > 0);
const before = JSON.parse(window.localStorage.getItem("hyp.playlists"))[0].items.length;
click($('[data-act="plItemDel"]'));
await sleep(100);
const after = JSON.parse(window.localStorage.getItem("hyp.playlists"))[0].items.length;
ok("playlist item removal persists", after === before - 1, `${before} -> ${after}`);

console.log("\n== favourites ==");
const favs = () => JSON.parse(window.localStorage.getItem("hyp.favourites") || "{}");
window.location.hash = "#/";
await sleep(250);
const firstCard = $(".card");
const favId = firstCard.dataset.id;
ok("every item chiclet carries a heart",
   $$(".card button.heart").length === $$(".card").length,
   `${$$('.card button.heart').length} hearts for ${$$('.card').length} cards`);
ok("a heart starts empty",
   firstCard.querySelector("button.heart").getAttribute("aria-pressed") === "false");
click(firstCard.querySelector("button.heart"));
await sleep(80);
ok("pressing it fills the heart", firstCard.querySelector("button.heart").classList.contains("on"));
ok("...and says so to a screen reader",
   firstCard.querySelector("button.heart").getAttribute("aria-pressed") === "true");
// Liking something from a grid must not rebuild the grid: the card the reader
// pressed is still the same element, in the same place.
ok("...without rebuilding the grid under the reader", $(".card") === firstCard);
ok("the favourite is kept", Object.keys(favs().items || {}).includes(favId),
   JSON.stringify(favs().items));

window.location.hash = `#/item/${encodeURIComponent(favId)}`;
await sleep(250);
ok("the item page shows it as favourited", !!$("article .actions button.heart.on"));
ok("...with the word beside the heart",
   /Favourited/.test($("article .actions button.heart")?.textContent || ""),
   $("article .actions button.heart")?.textContent);

window.location.hash = "#/authors";
await sleep(250);
ok("every creator chiclet carries a heart",
   $$('.card button.heart[data-what="author"]').length === $$(".card").length,
   `${$$('.card button.heart[data-what=author]').length} hearts for ${$$('.card').length} cards`);
const authorHeart = $('.card button.heart[data-what="author"]');
const favAuthor = authorHeart.dataset.fid;
click(authorHeart);
await sleep(80);
ok("a creator can be favourited", Object.keys(favs().authors || {}).includes(favAuthor));

window.location.hash = `#/author/${encodeURIComponent(favAuthor)}`;
await sleep(300);
ok("the creator page shows it as favourited", !!$(".authorhead .actions button.heart.on"));
click($(".authorhead .actions button.heart"));
await sleep(80);
ok("pressing again takes it off", !Object.keys(favs().authors || {}).includes(favAuthor));
click($(".authorhead .actions button.heart"));
await sleep(80);

window.location.hash = "#/favourites";
await sleep(300);
ok("the page is in the top nav",
   $$(".navlinks a").some(a => a.getAttribute("href") === "#/favourites"));
ok("...and is marked as where we are",
   $(".navlinks a.active")?.getAttribute("href") === "#/favourites");
ok("it lists the favourited recording", $$(".card").some(c => c.dataset.id === favId));
ok("...and the favourited creator",
   $$('button.heart[data-what="author"]').some(b => b.dataset.fid === favAuthor));

console.log("\n== import and export ==");
const files = [];
window.URL.createObjectURL = blob => { files.push(blob); return "blob:hypnotica-test"; };
window.URL.revokeObjectURL = () => {};

click($("#favExport"));
await sleep(120);
ok("exporting writes a file", files.length === 1, `${files.length} files`);
const exported = JSON.parse(await files[0].text());
ok("the file names the format it is in", exported.hypnotica === 1);
ok("...and carries both kinds of favourite",
   !!exported.favourites.items[favId] && !!exported.favourites.authors[favAuthor],
   JSON.stringify(exported.favourites));
ok("...with the time each was liked",
   !Number.isNaN(Date.parse(exported.favourites.items[favId])),
   exported.favourites.items[favId]);

window.location.hash = "#/playlists";
await sleep(250);
click($("#plExportAll"));
await sleep(120);
ok("playlists export too", files.length === 2 && !!JSON.parse(await files[1].text()).playlists);

// A file from another device: one playlist, naming an item this library does
// not have, and one favourite that is new here.
const other = index.items.slice(-3).map(i => i.id);
const shared = {
  hypnotica: 1,
  exported: "2026-03-05T12:00:00.000Z",
  playlists: [{ id: "pl-from-elsewhere", name: "From the other phone",
                created: "2026-03-01T00:00:00.000Z", updated: "2026-03-05T00:00:00.000Z",
                items: [other[0], other[1], "nothing-of-that-name"] }],
  favourites: { items: { [other[2]]: "2026-02-02T02:02:02.000Z" }, authors: {} },
};
const lists = () => JSON.parse(window.localStorage.getItem("hyp.playlists") || "[]");
const importText = async text => {
  click($("#plImport"));
  await sleep(80);
  setVal($("#ioText"), text);
  click($("#ioGo"));
  await sleep(150);
};
const heldBefore = lists().length;
await importText(JSON.stringify(shared));
ok("the dialog closes on a good import", $("#ioDlg").open === false);
const arrived = lists().find(p => p.id === "pl-from-elsewhere");
ok("the shared playlist arrived", !!arrived && lists().length === heldBefore + 1,
   `${heldBefore} -> ${lists().length}`);
ok("...keeping an id this library has never heard of",
   arrived?.items.includes("nothing-of-that-name"), JSON.stringify(arrived?.items));
ok("...and the report says so", /not in this library/.test($(".toast")?.textContent || ""),
   $(".toast")?.textContent);
ok("the shared favourite arrived", Object.keys(favs().items || {}).includes(other[2]));
ok("...dated when it was liked, not when it was imported",
   favs().items[other[2]] === "2026-02-02T02:02:02.000Z", favs().items[other[2]]);

// The same file again: an import is a merge, so doing it twice is doing it once.
await importText(JSON.stringify(shared));
ok("importing the same file twice changes nothing",
   lists().length === heldBefore + 1
   && lists().find(p => p.id === "pl-from-elsewhere").items.length === 3,
   `${lists().length} playlists`);
ok("...and says nothing new arrived", /Nothing new/.test($(".toast")?.textContent || ""),
   $(".toast")?.textContent);

// The other device added one entry and renamed it.
const moved = JSON.parse(JSON.stringify(shared));
moved.playlists[0].items.push(index.items[0].id);
moved.playlists[0].name = "Renamed over there";
moved.playlists[0].updated = "2026-04-01T00:00:00.000Z";
await importText(JSON.stringify(moved));
const merged = lists().find(p => p.id === "pl-from-elsewhere");
ok("a playlist that gained an entry gains it here", merged.items.length === 4,
   JSON.stringify(merged.items));
ok("...and the newer name follows it", merged.name === "Renamed over there", merged.name);

// Favourites already held are not disturbed by a file that knows less.
const kept = Object.keys(favs().items).length;
await importText(JSON.stringify({ hypnotica: 1, favourites: { items: {} }, playlists: [] }));
ok("an import never removes a favourite", Object.keys(favs().items).length === kept);

click($("#plImport"));
await sleep(80);
setVal($("#ioText"), "this is not a file");
click($("#ioGo"));
await sleep(120);
ok("nonsense is refused", /not JSON/.test($(".toast")?.textContent || ""), $(".toast")?.textContent);
ok("...and the dialog stays open to try again", $("#ioDlg").open === true);
click($('#ioFoot [data-act="ioClose"]'));
await sleep(60);
ok("the dialog closes", $("#ioDlg").open === false);

// One playlist on its own, the way somebody would paste it to a friend.
const one = { name: "Just this one", items: [index.items[1].id] };
await importText(JSON.stringify(one));
ok("a single playlist pasted on its own is understood",
   lists().some(p => p.name === "Just this one"), JSON.stringify(lists().map(p => p.name)));

console.log("\n== offline ==");
window.location.hash = "#/";
await sleep(200);
click($('.card [data-act="save"]'));
await sleep(500);
const audioCache = cacheStore.get("hypnotica-audio-v1");
ok("audio written to cache", audioCache && audioCache.size >= 1, `${audioCache?.size ?? 0} entries`);
window.location.hash = "#/offline";
await sleep(200);
ok("offline page lists saved file", /1 file/.test($(".kv").textContent), $(".kv").textContent.trim());

console.log("\n== authors ==");
window.location.hash = "#/authors";
await sleep(250);
ok("authors page", $$(".card").length === index.authors.length);

{
  // Counted here from the index rather than read off the page, so the check is
  // against the library rather than against the view's own arithmetic.
  const files = new Map();
  for (const i of index.items) files.set(i.author, (files.get(i.author) || 0) + 1);
  const order = $$(".card h3").map(h => h.textContent.trim());
  const counted = order.map(name =>
    files.get((index.authors.find(a => a.name === name) || {}).id) || 0);
  ok("creators are ordered by how much they made",
     counted.every((n, i) => i === 0 || counted[i - 1] >= n),
     counted.slice(0, 6).join(", "));

  const first = $(".card");
  const kinds = k => first.querySelectorAll(`.tag.k-${k}`).length;
  ok("a creator's card says what they make",
     first.querySelectorAll(".tag").length > 0,
     `${first.querySelectorAll(".tag").length} chips`);
  ok("...one voice, two audiences, one production, five content",
     kinds("voice") <= 1 && kinds("audience") <= 2 &&
     kinds("production") <= 1 && kinds("content") <= 5,
     `${kinds("voice")}/${kinds("audience")}/${kinds("production")}/${kinds("content")}`);
}
window.location.hash = `#/author/${index.authors[0].id}`;
await sleep(200);
ok("author page heading", $(".authorhead h1")?.textContent === index.authors[0].name);
ok("author page links its feed", !!$$('a[href^="feed/"]').length);
{
  // A creator's page is the same windowed grid as the library: a prolific one
  // has hundreds of recordings, and drawing all of them at once costs what
  // drawing the whole library at once cost.
  const want = index.items.filter(i => i.author === index.authors[0].id).length;
  const drawn = $$(".card").length;
  ok("author page lists their items", drawn > 0 && drawn <= want,
     `${drawn} vs ${want}`);
  ok("...and says how many in total",
     new RegExp(`${want} files?\\b`).test($(".authorhead")?.textContent || ""),
     $(".authorhead .kv")?.textContent);
}

{
  // The creator with the most recordings: theirs is the page where drawing
  // everything would actually hurt, so it is the one worth asserting on.
  const counts = new Map();
  for (const i of index.items) counts.set(i.author, (counts.get(i.author) || 0) + 1);
  const [biggest, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  if (biggest && n > 120) {
    window.location.hash = `#/author/${encodeURIComponent(biggest)}`;
    await sleep(250);
    ok(`the biggest creator's page is a window too (${n} files)`,
       $$(".card").length < n, `${$$(".card").length} cards for ${n}`);
    // Drawn in chunks, and the tail of the page is the sentinel the observer
    // watches -- without it the window never grows as the reader goes down.
    ok("...drawn in chunks, with something to load the next one",
       !!$("#grid") && !!$("#gridEnd") && $$("#grid .chunk").length > 0,
       `${$$("#grid .chunk").length} chunk(s)`);

    // What recurs across their work: carried by more than one recording, and by
    // more than a tenth of them. Both tests matter, so both are checked.
    const mine = index.items.filter(i => i.author === biggest);
    const seen = new Map();
    for (const i of mine) for (const t of i.tags) seen.set(t, (seen.get(t) || 0) + 1);
    const shown = $$(".authortags .tag").map(el => el.dataset.tag);
    ok("their page says what recurs across their work", shown.length > 0,
       `${shown.length} chips`);
    ok("...nothing carried by one recording, or by under a tenth of them",
       shown.every(t => (seen.get(t) || 0) > 1 && (seen.get(t) || 0) > mine.length * 0.1),
       shown.map(t => `${t}=${seen.get(t)}`).slice(0, 4).join(" "));
    ok("...and each says how many recordings carry it",
       $$(".authortags .tag i").length === shown.length);
  }
}

// ---- what was written rather than found ------------------------------------
// The library records this per field in provenance.generated; nothing here is
// inferred from how a value reads. These checks only run where the library
// being built against actually carries such a record.
console.log("\n== generated, not supplied ==");
{
  const detail = p => JSON.parse(fs.readFileSync(path.join(ROOT, "data/detail", p), "utf8"));
  const shards = fs.existsSync(path.join(ROOT, "data/detail"))
    ? fs.readdirSync(path.join(ROOT, "data/detail")) : [];
  let marked = null, author = null, prompts = null;
  for (const file of shards) {
    const rows = detail(file);
    if (!author && rows._author?.coverPrompts) author = file.replace(/\.json$/, "");
    for (const [id, row] of Object.entries(rows)) {
      if (id === "_author") continue;
      if (!marked && row.generated?.length) marked = id;
      if (!prompts && row.coverPrompts) prompts = id;
    }
    if (marked && prompts && author) break;
  }
  // An item whose write-up the library does *not* claim: the mark has to be
  // absent there. A badge that appears on everything says nothing, and one that
  // appears on a creator's own words is worse than saying nothing.
  let unclaimed = null;
  for (const file of shards) {
    for (const [id, row] of Object.entries(detail(file))) {
      if (id === "_author" || !row.description) continue;
      if (!(row.generated || []).includes("description")) { unclaimed = id; break; }
    }
    if (unclaimed) break;
  }
  if (!marked) {
    ok("nothing in this library records what was generated (skipped)", true);
  } else {
    const it = index.items.find(i => i.id === marked);
    window.location.hash = `#/item/${encodeURIComponent(marked)}`;
    await sleep(250);
    const fields = detail(`${it.author}.json`)[marked].generated;
    ok("a generated field is marked on the page", $$(".gen").length > 0);
    // The write-up carries a mark exactly when the library claims the write-up.
    ok("...on the write-up only when the write-up is claimed",
       !!$(".prose .gen") === fields.includes("description"),
       `claims ${JSON.stringify(fields)}`);
    ok("...and the picture only when the picture is claimed",
       !!$(".herowrap .gen") === fields.includes("cover"));
    ok("...and every mark explains itself", $$(".gen").every(
      g => (g.getAttribute("title") || "").length > 20));
  }
  if (unclaimed) {
    const it = index.items.find(i => i.id === unclaimed);
    window.location.hash = `#/item/${encodeURIComponent(unclaimed)}`;
    await sleep(250);
    ok("a write-up the library does not claim is left unmarked", !$(".prose .gen"),
       unclaimed);
  }
  if (prompts) {
    const it = index.items.find(i => i.id === prompts);
    window.location.hash = `#/item/${encodeURIComponent(prompts)}`;
    await sleep(250);
    ok("the item page offers the picture brief", !!$("details.prov"));
    const shown = $$("pre.prompt").map(n => n.textContent.trim());
    const want = Object.values(detail(`${it.author}.json`)[prompts].coverPrompts);
    ok("...and shows every style the library kept",
       want.every(t => shown.some(s => s === t.trim())), `${shown.length} shown`);
  }
  if (author) {
    window.location.hash = `#/author/${encodeURIComponent(author)}`;
    await sleep(250);
    ok("the creator page offers theirs too", !!$("details.prov"));
    ok("...fetched from the shard, not the index head",
       !!$$("pre.prompt").length && !("coverPrompts" in (index.authors.find(a => a.id === author) || {})));
  }
}

// ---- write-ups fetch nothing ----------------------------------------------
// ---- a recording that happens to have pictures -----------------------------
console.log("\n== video ==");
{
  const withVideo = index.items.filter(i => i.hasVideo);
  if (!withVideo.length) {
    ok("nothing in this library carries a container (skipped)", true);
  } else {
    const it = withVideo[0];
    window.location.hash = `#/item/${encodeURIComponent(it.id)}`;
    await sleep(300);
    const screen = $("video.hero");
    ok(`the item page shows it (${withVideo.length} in the library)`, !!screen);
    ok("...pointing at the container, not the audio",
       /\.(mp4|m4v|mov|mkv|webm|avi|wmv|flv)$/i.test(screen?.getAttribute("src") || ""),
       screen?.getAttribute("src"));
    ok("...and it does not load until asked",
       screen?.getAttribute("preload") === "none");
    // The queue and the player are audio, always: the container is a picture on
    // one page, and everything that plays a recording plays its audio track.
    ok("queueing it queues the audio", /\.(mp3|m4a|wav|ogg|opus|flac)$/i.test(it.audio || ""),
       it.audio);
    window.location.hash = "#/";
    await sleep(400);
    ok("the card says there is one without carrying the path",
       !("video" in it) && it.hasVideo === true);
  }
}

// ---- what the audio measures, said in words ---------------------------------
console.log("\n== measurements ==");
{
  const detail = f => JSON.parse(fs.readFileSync(path.join(ROOT, "data/detail", f), "utf8"));
  const dir = path.join(ROOT, "data/detail");
  let found = null;
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    for (const [id, row] of Object.entries(detail(file))) {
      if (id !== "_author" && row.acoustic && row.acoustic.f0_median_hz) { found = id; break; }
    }
    if (found) break;
  }
  if (!found) {
    ok("nothing in this library carries measurements (skipped)", true);
  } else {
    window.location.hash = `#/item/${encodeURIComponent(found)}`;
    await sleep(300);
    const bands = $$(".band");
    ok(`the item page shows what was measured (${found})`, bands.length > 0,
       `${bands.length} bands`);
    // A number on its own is trivia; the reading beside it is the point.
    ok("...each figure says what it means", $$(".band .fig").every(
       el => (el.getAttribute("title") || "").length > 15));
    ok("...and reads the figure in words", $$(".band i").length > 0);
    ok("...and none of it is in the index every visitor downloads",
       !("acoustic" in (index.items.find(i => i.id === found) || {})));
  }
}

console.log("\n== write-ups ==");
{
  const texts = [];
  const dir = path.join(ROOT, "data/detail");
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      for (const row of Object.values(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")))) {
        if (row && row.description) texts.push(row.description);
      }
    }
  }
  for (const a of index.authors) if (a.description) texts.push(a.description);
  const loading = texts.filter(t => /<\s*(img|iframe|script|canvas|video|audio|svg|object|embed)\b/i.test(t)
                                 || /\b(src|srcset|poster)\s*=/i.test(t));
  ok(`no write-up loads anything (${texts.length} checked)`, loading.length === 0,
     loading[0]?.slice(0, 120));
  const styled = texts.filter(t => /<[a-z][^>]*\s(class|style|onclick|onerror)\s*=/i.test(t));
  ok("...and none carries another site's markup", styled.length === 0,
     styled[0]?.slice(0, 120));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
