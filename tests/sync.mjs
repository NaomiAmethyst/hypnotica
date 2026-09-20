/* Sync, end to end: a real endpoint from the real binary, two browsers, and the
   key never leaving either of them in the clear.

   Everything here goes through the interface a person uses -- the menu, the
   pairing code, the share link -- because the parts that matter (the fingerprint
   naming the slot, the six digits, the read key in the fragment) are only worth
   anything if the buttons actually wire them up. */
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readQR } from "./qrread.mjs";

const ROOT = process.argv[2] || fileURLToPath(new URL("../www", import.meta.url));
const BIN = process.argv[3] || fileURLToPath(new URL("../bin/hypnotica", import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { c ? (pass++, console.log("  ok   " + n))
                                 : (fail++, console.log("  FAIL " + n + " " + e)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SYNC_WAIT = 6000;      // longer than the client's push debounce
const waitFor = async (fn, ms = 8000) => {
  for (let t = 0; t < ms; t += 25) { if (await fn()) return true; await sleep(25); }
  return false;
};

/* ---- endpoints, served by the binary under test --------------------------- */
/* Three of them, because how a library gets on to one is a choice the person
   running it makes: open to anybody, gated behind an invite, or shut. */
const running = [];
async function endpoint(...flags) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hyp-sync-"));
  const proc = spawn(BIN, ["serve", "-o", ROOT, "-p", "0", "--quiet", "--sync", dir, ...flags]);
  let url = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", chunk => {
    const m = /http:\/\/localhost:(\d+)/.exec(chunk);
    if (m && !url) url = `http://localhost:${m[1]}`;
  });
  const up = await waitFor(() => !!url, 10000);
  if (!up) { console.log("  FAIL an endpoint did not start"); process.exit(1); }
  running.push({ proc, dir });
  return { url, dir };
}
const open = await endpoint("--sync-open");
const base = open.url, syncDir = open.dir;
const done = code => {
  for (const r of running) { r.proc.kill(); fs.rmSync(r.dir, { recursive: true, force: true }); }
  process.exit(code);
};

/* ---- a browser ------------------------------------------------------------ */
/* IndexedDB, honouring a keyPath, because the key store puts whole records in
   and the catalogue's shim does not. */
function keyedIDB(store = new Map()) {
  const fire = value => {
    const req = { result: value };
    setTimeout(() => req.onsuccess && req.onsuccess(), 0);
    return req;
  };
  const objectStore = () => ({
    get: key => fire(store.get(key)),
    getAll: () => fire([...store.values()]),
    getAllKeys: () => fire([...store.keys()]),
    put: (value, key) => { store.set(key ?? value.id, value); return fire(undefined); },
    delete: key => { store.delete(key); return fire(undefined); },
  });
  const db = {
    objectStoreNames: { contains: () => true, [Symbol.iterator]: function* () {} },
    createObjectStore: () => objectStore(),
    transaction: () => ({ objectStore }),
  };
  return { store, open() {
    const req = {};
    setTimeout(() => {
      if (req.onupgradeneeded) { req.result = db; req.onupgradeneeded(); }
      req.result = db;
      req.onsuccess && req.onsuccess();
    }, 0);
    return req;
  } };
}

async function browser(name, opts = {}) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => { if (!/Not implemented/.test(e.message)) console.log(`  [${name}]`, e.message); });
  // `origin` puts the browser on the endpoint's own origin, which is what a site
  // served by a Hypnotica running --sync looks like.
  const here = opts.origin ? opts.origin + "/" : "http://localhost:8788/";
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "index.html"), "utf8"), {
    url: here, runScripts: "outside-only", pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom, doc = window.document;

  // Everything the crypto wants, from the platform underneath -- or, for
  // `insecure`, the half of it a browser offers on a page that is not secure.
  Object.defineProperty(window, "crypto", {
    value: opts.insecure ? { getRandomValues: b => globalThis.crypto.getRandomValues(b) }
                         : globalThis.crypto,
    configurable: true,
  });
  window.Response = globalThis.Response;
  window.Blob = globalThis.Blob;
  window.CompressionStream = globalThis.CompressionStream;
  window.DecompressionStream = globalThis.DecompressionStream;
  window.indexedDB = keyedIDB();
  window.btoa = globalThis.btoa; window.atob = globalThis.atob;

  const realFetch = globalThis.fetch;
  const SITE = here;
  const seen = [];
  window.fetch = async (url, init) => {
    const u = String(url);
    seen.push(u);
    // On the endpoint's own origin everything is real, files included.
    if (opts.origin) return realFetch(new URL(u, here).href, init);
    // Anything absolute that is not this site is an endpoint, and goes to the
    // network for real. The site's own files are read off disk. A browser made
    // with `offline` has nowhere to go at all, which is the static-host case.
    if (/^https?:\/\//.test(u) && !u.startsWith(SITE)) {
      if (opts.offline) throw new TypeError("nothing is listening");
      return realFetch(u, init);
    }
    const p = path.join(ROOT, u.replace(/^https?:\/\/[^/]+\//, "").split("?")[0]);
    if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
    const buf = fs.readFileSync(p);
    return { ok: true, status: 200, headers: { get: () => String(buf.length) },
      json: async () => JSON.parse(buf.toString("utf8")),
      text: async () => buf.toString("utf8"), clone() { return this; } };
  };
  window.caches = { async open() { return { async keys() { return []; }, async put() {},
    async delete() {}, async match() {}, async add() {} }; },
    async match() {}, async delete() {}, async keys() { return []; } };
  window.Audio = class { constructor() { this.paused = true; this.currentTime = 0;
    this.duration = 0; this.playbackRate = 1; this._l = {}; }
    addEventListener(k, f) { (this._l[k] ||= []).push(f); }
    play() { return Promise.resolve(); } pause() {} removeAttribute() {} load() {} };
  window.MediaMetadata = class {}; window.Request = class {};
  window.navigator.mediaSession = { setActionHandler() {}, set metadata(v) {} };
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.confirm = () => true;
  window.prompt = () => "x";

  window.eval(fs.readFileSync(path.join(ROOT, "app.js"), "utf8"));
  await sleep(500);
  const $ = s => doc.querySelector(s), $$ = s => [...doc.querySelectorAll(s)];
  return {
    name, window, doc, $, $$, seen,
    click: el => el && el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
    setVal: (el, v) => { el.value = v; el.dispatchEvent(new window.Event("input", { bubbles: true })); },
    go: async (hash) => { window.location.hash = hash; await sleep(250); },
    store: k => JSON.parse(window.localStorage.getItem(k) || "null"),
    put: (k, v) => window.localStorage.setItem(k, JSON.stringify(v)),
    text: () => doc.querySelector("main")?.textContent || "",
  };
}

console.log("\n== linking a second device ==");
const A = await browser("A");
const index = JSON.parse(fs.readFileSync(path.join(ROOT, "data/index.json"), "utf8"));
const firstPage = JSON.parse(fs.readFileSync(path.join(ROOT, "data/index/0.json"), "utf8"));
const liked = firstPage[0].id;

// Something for the other device to receive.
await A.go("#/item/" + encodeURIComponent(liked));
A.click(A.$("article .actions button.heart"));
await sleep(100);
ok("A has something to share", !!A.store("hyp.favourites")?.items?.[liked]);

A.click(A.$('[data-act="linkStart"]'));
await sleep(120);
ok("setting up asks for an address and nothing else",
   !!A.$("#lnkWhere") && !A.$("#lnkInvite"), A.$("#ioBody")?.textContent?.slice(0, 80));
A.setVal(A.$("#lnkWhere"), base);
A.click(A.$('[data-act="linkGo"]'));
const offered = await waitFor(() => !!A.$("#lnkText"));
ok("A offers a pairing code", offered, A.$("#ioBody")?.textContent?.slice(0, 120));
ok("...drawn as a scannable code", !!A.$("svg.qr"));
ok("...with the link kept behind a fold", !!A.$("details.astext"));

const link = A.$("#lnkText")?.value || "";
// Kept now: the dialog moves on to the digits once the other device answers.
const qrMarkup = A.$("svg.qr")?.outerHTML || "";
ok("the code carries an endpoint and a pairing id, not the group key",
   /#\/link\?e=.+&p=[a-z2-7]{26}&k=/.test(link) && !/gk=/.test(link), link.slice(0, 140));
ok("...and the group is registered under a name derived from the key",
   fs.existsSync(path.join(syncDir, "g")) && fs.readdirSync(path.join(syncDir, "g")).length === 1,
   fs.readdirSync(path.join(syncDir, "g")).join(","));

const B = await browser("B");
await B.go(link.slice(link.indexOf("#")));
ok("B is asked whether to join", /Link this device/.test(B.text()), B.text().slice(0, 100));
ok("...and the key is out of the address bar already",
   !/k=/.test(B.window.location.hash), B.window.location.hash);

B.click(B.$('[data-act="linkJoin"]'));
const shown = await waitFor(() => /\d{6}/.test(B.$(".sas")?.textContent || ""), 12000);
ok("B shows six digits to compare", shown, B.$(".sas")?.textContent);
const digitsA = await waitFor(() => /\d{6}/.test(A.$(".sas")?.textContent || ""), 12000);
ok("A shows them too", digitsA, A.$(".sas")?.textContent);
ok("...and they are the same six",
   (A.$(".sas")?.textContent || "").trim() === (B.$(".sas")?.textContent || "").trim(),
   `${A.$(".sas")?.textContent} vs ${B.$(".sas")?.textContent}`);

A.click(A.$('[data-act="linkConfirm"]'));
const joined = await waitFor(() => !!B.store("hyp.sync") && /Linked/.test(B.text()), 15000);
ok("B joins the group", joined, B.text().slice(0, 140));
const arrived = await waitFor(() => !!B.store("hyp.favourites")?.items?.[liked], 15000);
ok("...and takes what A had liked", arrived, JSON.stringify(B.store("hyp.favourites")));

console.log("\n== what the endpoint holds ==");
{
  const groups = fs.readdirSync(path.join(syncDir, "g"));
  const slots = fs.readdirSync(path.join(syncDir, "g", groups[0], "s"));
  ok("one slot per device, named by a fingerprint", slots.length === 2 &&
     slots.every(f => /^[a-z2-7]{26}\.json$/.test(f)), slots.join(","));
  const blob = JSON.parse(fs.readFileSync(path.join(syncDir, "g", groups[0], "s", slots[0]), "utf8"));
  ok("...holding ciphertext and nothing else", !!blob.ct && !!blob.sig && !blob.playlists);
  ok("...with the server's own arrival time on it", !!blob.recv, JSON.stringify(blob).slice(0, 80));
  const plain = JSON.stringify(blob);
  ok("...and no item id in the clear", !plain.includes(liked));
  ok("the pairing was thrown away once it was used",
     !fs.existsSync(path.join(syncDir, "pr")) ||
     fs.readdirSync(path.join(syncDir, "pr")).length === 0,
     fs.existsSync(path.join(syncDir, "pr")) ? fs.readdirSync(path.join(syncDir, "pr")).join(",") : "-");
}

console.log("\n== the code itself ==");
{
  const svg = qrMarkup;
  let got = null, why = "";
  try { got = readQR(svg); } catch (e) { why = e.message; }
  ok("the code reads back as the link it was drawn from", got && got.text === link,
     why || (got ? got.text.slice(0, 80) : "nothing read"));
  ok("...at a version with room to spare", !!got && got.version >= 1 && got.version <= 10,
     got ? `version ${got.version}` : "");
}

console.log("\n== sharing a view of it ==");
const shareLink = await (async () => {
  await A.go("#/profile");
  A.setVal(A.$("#meNameBox"), "Naomi");
  A.click(A.$('[data-act="meSave"]'));
  await sleep(200);
  A.click(A.$('[data-act="shareNew"][data-preset="choosing"]'));
  await waitFor(() => !!A.$(".sharelink"), 10000);
  return A.$(".sharelink")?.value || "";
})();
ok("a share has a link with its key in the fragment",
   /#\/p\?e=.+&k=[A-Za-z0-9_-]{40,}/.test(shareLink), shareLink.slice(0, 120));
{
  const id = fs.readdirSync(path.join(syncDir, "pf"))[0];
  ok("...and a slot of its own on the endpoint", !!id, "none published");
  const rec = JSON.parse(fs.readFileSync(path.join(syncDir, "pf", id), "utf8"));
  ok("...holding ciphertext, not a profile", !!rec.env && !JSON.stringify(rec).includes("Naomi"));
  const bare = await fetch(`${base}/profile/${id.replace(/\.json$/, "")}`);
  ok("...which the address alone does not open", bare.status === 403, String(bare.status));
}

const C = await browser("C");
await C.go(shareLink.slice(shareLink.indexOf("#")));
const opened = await waitFor(() => /Naomi/.test(C.text()), 10000);
ok("a reader with the link sees whose it is", opened, C.text().slice(0, 120));
ok("...and what they have been playing", /Lately|Most played|Favourites/.test(C.text()),
   C.text().slice(0, 200));
ok("...with the key taken out of the address bar", !/k=/.test(C.window.location.hash),
   C.window.location.hash);

await C.go("#/");
await sleep(300);
ok("browsing the library says whose view this is", /Reading/.test(C.text()), C.text().slice(0, 120));
ok("...and the cards say what they have heard",
   (C.$(".card .theirs")?.textContent || "").length > 0, C.$(".card .theirs")?.textContent || "none");
ok("...and the Library facet reads from the share",
   /what Naomi has done with it/.test(C.doc.querySelector('details.facet[data-panel="meta"]')?.textContent || ""),
   C.doc.querySelector('details.facet[data-panel="meta"]')?.textContent?.slice(0, 80) || "");

console.log("\n== how a library gets on to an endpoint ==");
{
  const asked = await endpoint("--sync-invite", "open-sesame");
  const D = await browser("D");
  D.click(D.$('[data-act="linkStart"]'));
  await sleep(100);
  D.setVal(D.$("#lnkWhere"), asked.url);
  D.click(D.$('[data-act="linkGo"]'));
  const wants = await waitFor(() => !!D.$("#lnkInvite"), 8000);
  ok("an endpoint that wants an invite asks for one, and only then", wants,
     D.$("#ioBody")?.textContent?.slice(0, 100));
  D.setVal(D.$("#lnkInvite"), "open-sesame");
  D.click(D.$('[data-act="linkGoInvite"]'));
  ok("...and the invite gets a library on to it", await waitFor(() => !!D.$("#lnkText"), 10000),
     D.$("#ioBody")?.textContent?.slice(0, 100));

  const shut = await endpoint();
  const E = await browser("E");
  E.click(E.$('[data-act="linkStart"]'));
  await sleep(100);
  E.setVal(E.$("#lnkWhere"), shut.url);
  E.click(E.$('[data-act="linkGo"]'));
  const refused = await waitFor(() =>
    /not taking new libraries/.test(E.$("#ioBody")?.textContent || ""), 8000);
  ok("a closed endpoint says so instead of asking for a token that would not help",
     refused, E.$("#ioBody")?.textContent?.slice(0, 120));
  ok("...and no group was made on it", !fs.existsSync(path.join(shut.dir, "g")));

  const F = await browser("F");
  F.click(F.$('[data-act="linkStart"]'));
  await sleep(100);
  F.setVal(F.$("#lnkWhere"), "http://localhost:1/");
  F.click(F.$('[data-act="linkGo"]'));
  const dead = await waitFor(() => /did not answer/.test(F.$("#ioBody")?.textContent || ""), 8000);
  ok("an address that answers nothing is called out, not treated as gated", dead,
     F.$("#ioBody")?.textContent?.slice(0, 120));
}

/* The ordinary case: a build dropped on a static host, with no endpoint behind
   it and nothing to link to. Nothing should reach for one, and everything that
   does not need one should work. */
console.log("\n== a library on a plain static host ==");
{
  const S = await browser("S", { offline: true });
  const asked = () => S.seen.filter(u => /\/(sync|pair|profile)(\/|$)/.test(u));
  ok("nothing is asked of an endpoint on a first visit", asked().length === 0, asked().join(","));
  ok("the menu offers to link a device", !!S.$('[data-act="linkStart"]'));
  ok("...and shows no sync status, rather than a broken one", !S.$("#syncLine"));


  // Using the library writes records, and a record change is what would push.
  await S.go("#/item/" + encodeURIComponent(liked));
  S.click(S.$("article .actions button.heart"));
  S.setVal(S.$("#noteText"), "Kept here.");
  S.click(S.$('[data-act="noteSave"]'));
  await sleep(300);
  ok("liking and noting still work", !!S.store("hyp.favourites")?.items?.[liked] &&
     S.store("hyp.notes")?.[liked]?.text === "Kept here.");
  await sleep(SYNC_WAIT);
  ok("...and still nothing is sent anywhere", asked().length === 0, asked().join(","));

  await S.go("#/profile");
  ok("the profile page says what linking would do", /Linking makes the key/.test(S.text()),
     S.text().slice(0, 120));
  ok("...and still offers to share, because pressing it is what asks where",
     !!S.$('[data-act="shareNew"]'));
  ok("...without having asked an endpoint anything to say so", asked().length === 0,
     asked().join(","));

  await S.go("#/history");
  ok("history is there and local", /kept here and nowhere else/i.test(S.text()),
     S.text().slice(0, 120));

  // The transfer file is the way out when there is no endpoint.
  await S.go("#/notes");
  S.click(S.$("#noteExport"));
  await sleep(150);
  ok("an export is still offered", !!S.$('[data-act="ioExportGo"]') || !!S.$("#ioExportGo"));
  ok("...with nothing asked of an endpoint to do it", asked().length === 0, asked().join(","));
}

console.log("\n== sharing from a library with one device ==");
{
  const G = await browser("G");
  await G.go("#/profile");
  G.click(G.$('[data-act="shareNew"][data-preset="plain"]'));
  await sleep(150);
  ok("sharing asks where to publish rather than refusing", !!G.$("#lnkWhere"),
     G.$("#ioBody")?.textContent?.slice(0, 100));
  G.setVal(G.$("#lnkWhere"), base);
  G.click(G.$('[data-act="linkGo"]'));
  const made = await waitFor(() => (G.store("hyp.shares") || []).length === 1, 15000);
  ok("...and publishes one once it has an address", made,
     JSON.stringify(G.store("hyp.shares")));
  ok("...having made a group with this one device in it", !!G.store("hyp.sync")?.endpoint);
  const groups = fs.readdirSync(path.join(syncDir, "g"));
  const mine = groups.map(g => fs.readdirSync(path.join(syncDir, "g", g, "s")).length);
  ok("...which the endpoint holds as a group of one", mine.includes(1), mine.join(","));
  const row = (G.store("hyp.shares") || [])[0];
  const H = await browser("H");
  await H.go(`#/p?e=${encodeURIComponent(base)}&k=${row.key}`);
  ok("and the share opens for somebody with the link",
     await waitFor(() => /Playlists|published/i.test(H.text()), 10000), H.text().slice(0, 120));
}

console.log("\n== a page that cannot do the cryptography ==");
{
  const I = await browser("I", { insecure: true });
  I.click(I.$('[data-act="linkStart"]'));
  await sleep(200);
  ok("linking explains why rather than throwing",
     /only on a secure page|HTTPS/.test(I.$("#ioBody")?.textContent || ""),
     I.$("#ioBody")?.textContent?.slice(0, 120));
  await I.go("#/profile");
  ok("...and the profile page says the same where somebody would look",
     /HTTPS or from localhost/.test(I.text()), I.text().slice(0, 200));
  I.click(I.$('[data-act="shareNew"][data-preset="plain"]'));
  await sleep(200);
  ok("...and sharing says it too, instead of failing at the first call",
     /only on a secure page|HTTPS/.test(I.$("#ioBody")?.textContent || ""),
     I.$("#ioBody")?.textContent?.slice(0, 120));
  ok("nothing was configured by any of that", !I.store("hyp.sync"));
}

console.log("\n== an endpoint on the site's own origin ==");
{
  const J = await browser("J", { origin: base });
  J.click(J.$('[data-act="linkStart"]'));
  const filled = await waitFor(() => (J.$("#lnkWhere")?.value || "") === base, 8000);
  ok("the address is filled in from the site being served with one", filled,
     J.$("#lnkWhere")?.value || "(empty)");
  ok("...and said so, rather than silently", /served with one/.test(J.$("#lnkHint")?.textContent || ""),
     J.$("#lnkHint")?.textContent);
  ok("...but is still there to be read and changed", !!J.$("#lnkWhere"));
}

console.log(`\n${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);
