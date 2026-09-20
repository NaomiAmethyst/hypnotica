/* Queue playback: auto-advance, and the ways it used to stall.
   Uses a media element that models the real one - src resets readyState and
   duration, metadata arrives a tick later, and tracks actually reach `ended`. */
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

const TICK = 4;      // ms of wall clock per virtual second
const DUR = 40;      // virtual seconds per track

/* Timers drift when the box is busy, so nothing here waits a fixed span: each
   check polls for the state it wants and only gives up after a generous stall. */
const waitFor = async (fn, ms = 5000) => {
  for (let t = 0; t < ms; t += 10) { if (fn()) return true; await sleep(10); }
  return false;
};

async function app({ positions, queue, broken = new Set(), tick = TICK, dur = DUR } = {}) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", e => { if (!/Not implemented/.test(e.message)) console.log("  [jsdom]", e.message); });
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "index.html"), "utf8"), {
    url: "http://localhost:8788/", runScripts: "outside-only", pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom, doc = window.document;

  window.fetch = async (url) => {
    const p = path.join(ROOT, String(url).replace(/^https?:\/\/[^/]+\//, "").split("?")[0]);
    if (!fs.existsSync(p)) return { ok: false, status: 404, json: async () => ({}) };
    const buf = fs.readFileSync(p);
    return { ok: true, status: 200, json: async () => JSON.parse(buf.toString("utf8")),
      text: async () => buf.toString("utf8"), clone() { return this; },
      headers: { get: k => (k === "content-length" ? String(buf.length) : "audio/mpeg") },
      body: { getReader() { let d = false;
        return { read: async () => d ? { done: true } : (d = true, { done: false, value: buf }) }; } } };
  };
  window.caches = { async open() { const m = new Map();
      return { async keys() { return []; }, async put() {}, async delete() {}, async match() {} }; },
    async delete() {}, async match() {}, async keys() { return []; } };

  const played = [];
  window.Audio = class {
    constructor() { this._l = {}; this.paused = true; this.playbackRate = 1; this.preload = "";
      this._src = ""; this.readyState = 0; this.duration = NaN; this._t = 0;
      this._pending = null; this._timer = null; }
    addEventListener(k, f) { (this._l[k] ||= []).push(f); }
    removeAttribute(k) { if (k === "src") { this._src = ""; this._empty(); } }
    load() { this._empty(); }
    _fire(k) { for (const f of (this._l[k] || []).slice()) f(); }
    _empty() { clearInterval(this._timer); this._timer = null;
      this.readyState = 0; this.duration = NaN; this._t = 0; this._pending = null; }
    get src() { return this._src ? new URL(this._src, "http://localhost:8788/").href : ""; }
    set src(v) {
      this._src = String(v); played.push(String(v).split("/").pop().replace(/\.\w+$/, ""));
      this._empty();
      setTimeout(() => {
        if (this._src !== v) return;
        if (broken.has(v)) { this._fire("error"); return; }
        this.readyState = 4; this.duration = dur;
        if (this._pending != null) { this._t = this._pending; this._pending = null; }
        this._fire("durationchange"); this._fire("loadedmetadata");
        if (!this.paused) this._run();
      }, tick);
    }
    get currentTime() { return this._t; }
    set currentTime(v) {
      if (this.readyState === 0) { this._pending = v; return; }
      this._t = v; this._fire("timeupdate"); if (!this.paused) this._run();
    }
    play() { this.paused = false; this._fire("play");
      if (this.readyState >= 3) this._run(); return Promise.resolve(); }
    pause() { this.paused = true; clearInterval(this._timer); this._timer = null; this._fire("pause"); }
    _run() {
      clearInterval(this._timer);
      this._timer = setInterval(() => {
        if (this.paused) return;
        this._t += 1;
        if (this._t >= this.duration) {
          this._t = this.duration;
          clearInterval(this._timer); this._timer = null; this.paused = true;
          this._fire("timeupdate"); this._fire("ended");
          return;
        }
        this._fire("timeupdate");
      }, tick);
    }
  };
  window.MediaMetadata = class { constructor(o) { Object.assign(this, o); } };
  window.Response = class { constructor(b, i = {}) { this.body = b; this.ok = true; this.status = 200;
    this._h = i.headers || {}; this.headers = { get: k => this._h[k] }; } };
  window.Request = class { constructor(u) { this.url = String(u); } };
  Object.defineProperty(window.navigator, "onLine", { value: true, configurable: true });
  window.navigator.mediaSession = { setActionHandler() {}, set metadata(v) {} };
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.prompt = () => "x"; window.confirm = () => true;

  if (positions) window.localStorage.setItem("hyp.positions", JSON.stringify(positions));
  if (queue) window.localStorage.setItem("hyp.queue", JSON.stringify(queue));

  window.eval(fs.readFileSync(path.join(ROOT, "app.js"), "utf8"));
  // Wait for the catalogue, not for a guess at how long it takes. The items
  // arrive a page at a time, and a queue entry whose page has not landed is an
  // id the player does not know yet -- which is a different thing from the
  // stale id these tests are about.
  let seen = -1;
  for (let n = 0; n < 120; n++) {
    await sleep(80);
    const count = doc.querySelector(".count")?.textContent || "";
    const now = Number(count.replace(/,/g, "").match(/of\s+([0-9]+)/)?.[1] ?? -1);
    if (now > 0 && now === seen) break;
    seen = now;
  }
  await sleep(120);
  const $ = s => doc.querySelector(s);
  return { window, doc, played, $,
    click: el => el && el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })),
    title: () => $("#pTitle").textContent,
    state: () => JSON.parse(window.localStorage.getItem("hyp.queue") || "null"),
    store: k => JSON.parse(window.localStorage.getItem(k) || "null"),
    // build a queue without playing it, then start from the top
    async queueUp(ids) {
      for (const id of ids) {
        window.location.hash = `#/item/${encodeURIComponent(id)}`;
        await sleep(40);
        this.click($('[data-act="enqueue1"]'));
        await sleep(20);
      }
    },
  };
}

const index = readIndex(ROOT);
const [A, B, C] = index.items.filter(i => i.audio).slice(0, 3);
const stem = it => it.audio.split("/").pop().replace(/\.\w+$/, "");

const order = (h, items) => h.played.join(",") === items.map(stem).join(",");

console.log("\n== auto-advance ==");
{
  const h = await app();
  await h.queueUp([A.id, B.id, C.id]);
  await waitFor(() => h.played.length === 3);
  ok("plays every entry in order", order(h, [A, B, C]), h.played.join(","));
  await waitFor(() => h.state()?.index === 2);
  ok("stops on the last entry", h.state().index === 2, JSON.stringify(h.state()?.index));
  ok("player still shows the last track", h.title() === C.title, h.title());
  await sleep(DUR * TICK + 200);
  ok("and does not wrap round to the start", h.played.length === 3, h.played.join(","));
}

console.log("\n== Play next ==");
{
  const h = await app();
  window: {
    h.window.location.hash = `#/item/${encodeURIComponent(A.id)}`;
    await sleep(60);
    h.click(h.$('[data-act="playOne"]'));
    await sleep(20);
    h.window.location.hash = `#/item/${encodeURIComponent(C.id)}`;
    await sleep(60);
    h.click(h.$('[data-act="next1"]'));
    await sleep(20);
  }
  ok("Play next inserts after the current track",
    h.state().queue.join(",") === [A.id, C.id].join(","), h.state().queue.join(","));
  await waitFor(() => h.played.length === 2);
  ok("queue runs on into the inserted track", order(h, [A, C]), h.played.join(","));
}

console.log("\n== a broken file does not swallow the queue ==");
{
  const h = await app({ broken: new Set([B.audio]) });
  await h.queueUp([A.id, B.id, C.id]);
  await waitFor(() => h.played.length === 3);
  ok("steps over the unplayable entry", order(h, [A, B, C]), h.played.join(","));
  await waitFor(() => h.title() === C.title);
  ok("lands on the last good track", h.title() === C.title, h.title());
}

console.log("\n== a stale id does not swallow the queue ==");
{
  const h = await app({ queue: { queue: [A.id, "gone-from-the-index", C.id], index: 0 } });
  h.click(h.$("#pPlay"));                       // start playing the restored queue
  await waitFor(() => h.played.length === 2);
  ok("skips the dead entry", order(h, [A, C]), h.played.join(","));
  await waitFor(() => h.state()?.index === 2);
  ok("index points at the track that is playing", h.state().index === 2, JSON.stringify(h.state()?.index));
}

console.log("\n== resume position ==");
{
  const h = await app({ positions: { [B.id]: DUR - 5 } });   // saved right near the end
  await h.queueUp([A.id, B.id]);
  await waitFor(() => h.played.length === 2);
  // a resume into the tail would end B at once and push the queue straight past it
  await sleep(DUR * TICK / 2);
  ok("does not resume into the last seconds of the next track",
    order(h, [A, B]) && h.title() === B.title, `${h.played.join(",")} / ${h.title()}`);
}
{
  const tick = 12;
  const h = await app({ positions: { [B.id]: 12 }, tick });
  await h.queueUp([A.id, B.id]);
  // watch for the first playhead reading after the queue rolls on to B
  let first = null;
  for (let i = 0; i < 800 && first === null; i++) {
    await sleep(4);
    if (h.title() === B.title && h.$("#pNow").textContent !== "0:00") {
      const [m, sec] = h.$("#pNow").textContent.split(":").map(Number);
      first = m * 60 + sec;
    }
  }
  ok("a genuine mid-track position is still resumed", first !== null && first >= 12,
     `started at ${first}`);
}

/* Playing something is what writes a history, so it is tested where playback is
   modelled properly: a track that really reaches `ended` after a known number of
   virtual seconds. */
console.log("\n== what was played ==");
{
  const h = await app();
  await h.queueUp([A.id]);
  await waitFor(() => h.played.length === 1);
  await waitFor(() => (h.store("hyp.history")?.recent || []).length === 1);
  const hist = h.store("hyp.history") || {};
  const rec = (hist.recent || [])[0] || {};
  ok("a finished track becomes one sitting", (hist.recent || []).length === 1,
     JSON.stringify(hist.recent));
  ok("...filed against what was played", rec.i === A.id, rec.i);
  ok("...marked as finished", rec.c === true, JSON.stringify(rec));
  ok("...with the seconds actually heard", rec.s >= DUR - 3 && rec.s <= DUR, String(rec.s));
  const counts = Object.values(hist.plays?.[A.id]?.c || {});
  ok("...and counted once", counts.length === 1 && counts[0].n === 1, JSON.stringify(counts));
  ok("the title is kept beside the id", h.store("hyp.names")?.[A.id]?.t === A.title,
     JSON.stringify(h.store("hyp.names")?.[A.id]));
}

console.log("\n== a sitting too short to count ==");
{
  const h = await app({ dur: 12 });
  await h.queueUp([B.id]);
  await waitFor(() => h.played.length === 1);
  await sleep(12 * TICK + 300);
  ok("a recording given up on early leaves no trace",
     (h.store("hyp.history")?.recent || []).length === 0,
     JSON.stringify(h.store("hyp.history")?.recent));
}

console.log("\n== recording paused ==");
{
  const h = await app();
  h.window.location.hash = "#/history";
  await sleep(150);
  h.click(h.$("#histPause"));
  await sleep(80);
  ok("the control says it is paused", /Resume/.test(h.$("#histPause")?.textContent || ""),
     h.$("#histPause")?.textContent);
  await h.queueUp([A.id]);
  await waitFor(() => h.played.length === 1);
  await sleep(DUR * TICK + 300);
  ok("...and nothing is kept while it is",
     (h.store("hyp.history")?.recent || []).length === 0,
     JSON.stringify(h.store("hyp.history")?.recent));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
