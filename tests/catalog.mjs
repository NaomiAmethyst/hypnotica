/* The catalogue: does a second visit avoid the network, and does a rebuild cost
   only what changed?

   jsdom has no IndexedDB, so the app's storage path is never exercised by the
   other tests -- they all run the cold path and pass by falling back. This
   supplies just enough of a database to answer the two questions that matter:

     1. a repeat visit draws from storage and fetches no pages at all;
     2. a rebuild that changed one page fetches one page.

   Every fetch is counted, so "did not download it again" is a measurement
   rather than an impression.

     node tests/catalog.mjs /path/to/www
*/
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.argv[2] || fileURLToPath(new URL("../www", import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- the smallest IndexedDB that Catalog actually uses ------------------- */
function fakeIndexedDB(store = new Map()) {
  const fire = (request, value) => {
    request.result = value;
    setTimeout(() => request.onsuccess && request.onsuccess(), 0);
    return request;
  };
  const objectStore = () => ({
    get: key => fire({}, store.get(key)),
    getAll: () => fire({}, [...store.values()]),
    getAllKeys: () => fire({}, [...store.keys()]),
    put: (value, key) => { store.set(key, value); return fire({}, undefined); },
    delete: key => { store.delete(key); return fire({}, undefined); },
  });
  const db = {
    objectStoreNames: { contains: () => true, [Symbol.iterator]: function* () {} },
    createObjectStore: () => objectStore(),
    deleteObjectStore: () => {},
    transaction: () => ({ objectStore }),
  };
  return {
    store,
    open() {
      const request = {};
      setTimeout(() => {
        if (request.onupgradeneeded) { request.result = db; request.onupgradeneeded(); }
        request.result = db;
        request.onsuccess && request.onsuccess();
      }, 0);
      return request;
    },
  };
}

/* ---- one visit ----------------------------------------------------------- */
async function visit(idb, { rewrite } = {}) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => { if (!/Not implemented/.test(e.message)) console.log("  [jsdom]", e.message); });
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "index.html"), "utf8"), {
    url: "http://localhost:9/", runScripts: "outside-only",
    pretendToBeVisual: true, virtualConsole: vc,
  });
  const { window } = dom;
  const fetched = [];

  window.fetch = async (url) => {
    const name = String(url).replace(/^https?:\/\/[^/]+\//, "").split("?")[0];
    fetched.push(name);
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
    let text = fs.readFileSync(file, "utf8");
    if (rewrite) {
      try { text = rewrite(name, text); }
      catch { throw new TypeError("Failed to fetch"); }
    }
    return {
      ok: true, status: 200,
      headers: { get: () => String(text.length) },
      json: async () => JSON.parse(text),
      text: async () => text,
      clone() { return this; },
    };
  };
  window.indexedDB = idb;
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

  window.eval(fs.readFileSync(path.join(ROOT, "app.js"), "utf8"));
  // Long enough for the pages to land; the app redraws as each arrives.
  for (let n = 0; n < 60; n++) {
    await sleep(80);
    const count = window.document.querySelector(".count");
    if (count && /of\s+[0-9]/.test(count.textContent) && fetched.length > 1) break;
  }
  await sleep(400);
  const count = window.document.querySelector(".count")?.textContent || "";
  return { fetched, shown: Number(count.replace(/,/g, "").match(/of\s+([0-9]+)/)?.[1] ?? 0) };
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "data/manifest.json"), "utf8"));
const pages = Object.keys(manifest.files).filter(n => n.startsWith("index/"));
const total = JSON.parse(fs.readFileSync(path.join(ROOT, "data/index.json"), "utf8")).total;

console.log("\n== first visit ==");
const idb = fakeIndexedDB();
const first = await visit(idb);
ok("fetches every page", pages.every(p => first.fetched.includes(`data/${p}`)),
   `${first.fetched.filter(f => f.startsWith("data/index/")).length} of ${pages.length}`);
ok("shows the whole library", first.shown === total, `${first.shown} of ${total}`);
ok("stores what it fetched", idb.store.size >= pages.length, `${idb.store.size} records`);

console.log("\n== second visit, nothing rebuilt ==");
const second = await visit(idb);
const refetched = second.fetched.filter(f => f.startsWith("data/index/"));
ok("fetches no pages at all", refetched.length === 0, `${refetched.length} refetched`);
ok("still asks the manifest", second.fetched.includes("data/manifest.json"));
ok("shows the whole library from storage", second.shown === total,
   `${second.shown} of ${total}`);

console.log("\n== after a rebuild that changed one page ==");
const changed = pages[1] || pages[0];
const third = await visit(idb, {
  rewrite: (name, text) => {
    if (name !== "data/manifest.json") return text;
    const m = JSON.parse(text);
    m.files[changed] = { ...m.files[changed], hash: "0000000000000000" };
    return JSON.stringify(m);
  },
});
const again = third.fetched.filter(f => f.startsWith("data/index/"));
ok("fetches exactly the page that moved",
   again.length === 1 && again[0] === `data/${changed}`, again.join(", ") || "none");
ok("...and the library is still whole", third.shown === total,
   `${third.shown} of ${total}`);

console.log("\n== after the data format itself changed ==");
const fourth = await visit(idb, {
  rewrite: (name, text) => {
    if (name !== "data/manifest.json") return text;
    const m = JSON.parse(text);
    m.schema = Number(m.schema || 0) + 1;   // a shape change, not a content one
    return JSON.stringify(m);
  },
});
const all = fourth.fetched.filter(f => f.startsWith("data/index/"));
ok("drops everything and fetches every page again", all.length === pages.length,
   `${all.length} of ${pages.length}`);
ok("...and the library is whole", fourth.shown === total, `${fourth.shown} of ${total}`);

console.log("\n== a schema change with no network ==");
const held = new Map(idb.store);
const offline = await visit(fakeIndexedDB(held), {
  rewrite: (name, text) => {
    if (name === "data/manifest.json") {
      const m = JSON.parse(text);
      m.schema = Number(m.schema || 0) + 9;
      return JSON.stringify(m);
    }
    if (name === "data/index.json") throw new Error("offline");
    return text;
  },
});
ok("keeps the library it already had", offline.shown === total,
   `${offline.shown} of ${total}`);
ok("...and does not empty the store", held.size > 1, `${held.size} records`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
