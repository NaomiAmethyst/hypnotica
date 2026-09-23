/* Hypnotica - offline-capable library browser, player and playlist manager. */
(() => {
"use strict";

const AUDIO_CACHE = "hypnotica-audio-v1";
const K = {
  playlists: "hyp.playlists",
  queue: "hyp.queue",
  pos: "hyp.positions",
  rate: "hyp.rate",
  filters: "hyp.filters",
  dlqueue: "hyp.dlqueue",
  favs: "hyp.favourites",
  plgone: "hyp.playlists.gone",
  sync: "hyp.sync",
  counters: "hyp.sync.counters",
  seen: "hyp.sync.seen",
  shares: "hyp.shares",
  sharesGone: "hyp.shares.gone",
  always: "hyp.always",
  follows: "hyp.follows",
  searches: "hyp.searches",
  searchesGone: "hyp.searches.gone",
  me: "hyp.me",
  devices: "hyp.devices",
  names: "hyp.names",
  notes: "hyp.notes",
  hist: "hyp.history",
  device: "hyp.device",
};

/* A deletion is kept as a record rather than left as an absence, so that a
   merge can tell "never had it" from "had it and let it go". They are pruned
   after this long: past that, a file old enough to still be asserting the
   addition is old enough to be wrong about everything else too. */
const TOMB_DAYS = 90;
const DAY = 86400000;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const nowISO = () => new Date().toISOString();

/* Which browser on which machine this is. Local and meaningless to anybody
   else: it exists so a play count can be held per device and summed for
   display, which is the only way a count survives being merged with a copy of
   itself. Nothing identifies a person, and nothing leaves until sync does. */
const Device = {
  held: null,
  id() {
    if (this.held) return this.held;
    let v = load(K.device, null);
    if (typeof v !== "string" || !v) {
      const r = new Uint8Array(8);
      if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(r);
      else for (let i = 0; i < r.length; i++) r[i] = Math.floor(Math.random() * 256);
      v = [...r].map(b => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
      save(K.device, v);
    }
    return (this.held = v);
  },
};

const fmtDur = s => {
  s = Math.round(s || 0); if (!s) return "";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
};
const clock = s => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(x).padStart(2, "0")}`;
};

let DATA = { site: {}, authors: [], items: [] };
let BY_ID = new Map(), BY_AUTHOR = new Map();
let SPOILERS = null, spoilersLoading = null;

/* ------------------------------------------------------------------ toast */
let toastTimer;
function toast(msg) {
  let el = $(".toast");
  if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.append(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

/* ------------------------------------------------------- offline storage */
const Offline = {
  saved: new Set(),
  claimed: false,
  queue: load(K.dlqueue, []),
  active: null,
  progress: 0,

  async init() {
    if (!("caches" in window)) return;
    try {
      const c = await caches.open(AUDIO_CACHE);
      for (const req of await c.keys()) this.saved.add(req.url);
    } catch {}
    if (this.queue.length) this.pump();
  },
  url(item) { return item.audio ? new URL(item.audio, location.href).href : null; },
  has(item) { return !!(item.audio && this.saved.has(this.url(item))); },
  isQueued(id) { return this.queue.includes(id) || this.active === id; },

  /* Ask the browser to keep what we store.

     Without a grant, Cache Storage is "best effort": the browser may evict it
     under storage pressure, and the person who downloaded six hours for a
     flight finds it gone at the gate. Asked at the first download rather than
     on load, because engagement is what browsers weigh when deciding, and
     because a page that asks before you have done anything is the wrong page.
     A refusal is not an error -- it is the behaviour we already had. */
  async claimStorage() {
    if (this.claimed || !navigator.storage?.persist) return;
    this.claimed = true;
    try {
      if (await navigator.storage.persisted?.()) return;
      await navigator.storage.persist();
    } catch {}
  },

  add(id) {
    const it = BY_ID.get(id);
    if (!it || !it.audio || this.has(it) || this.isQueued(id)) return;
    this.claimStorage();
    this.queue.push(id); save(K.dlqueue, this.queue);
    render(); this.pump();
  },
  addMany(ids) {
    this.claimStorage();
    let n = 0;
    for (const id of ids) {
      const it = BY_ID.get(id);
      if (it && it.audio && !this.has(it) && !this.isQueued(id)) { this.queue.push(id); n++; }
    }
    save(K.dlqueue, this.queue); render(); this.pump();
    toast(n ? `Queued ${n} file${n > 1 ? "s" : ""}` : "Nothing new to queue");
  },
  cancel(id) {
    this.queue = this.queue.filter(x => x !== id);
    save(K.dlqueue, this.queue); render();
  },
  clearQueue() { this.queue = []; save(K.dlqueue, this.queue); render(); },

  async remove(id) {
    const it = BY_ID.get(id); if (!it || !it.audio) return;
    try {
      const c = await caches.open(AUDIO_CACHE);
      await c.delete(this.url(it));
      this.saved.delete(this.url(it));
    } catch {}
    render();
  },
  async removeAll() {
    try { await caches.delete(AUDIO_CACHE); } catch {}
    this.saved.clear(); render(); toast("Removed all offline files");
  },

  async pump() {
    if (this.active || !this.queue.length) return;
    const id = this.queue[0];
    const it = BY_ID.get(id);
    if (!it || !it.audio) { this.queue.shift(); save(K.dlqueue, this.queue); return this.pump(); }
    this.active = id; this.progress = 0; render();
    try {
      const res = await fetch(it.audio);
      if (!res.ok) throw new Error(res.status);
      const total = +res.headers.get("content-length") || it.bytes || 0;
      const reader = res.body.getReader();
      const chunks = []; let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        if (total) {
          const p = got / total;
          if (p - this.progress > 0.02) { this.progress = p; paintProgress(); }
        }
      }
      const blob = new Blob(chunks, { type: res.headers.get("content-type") || "audio/mpeg" });
      const c = await caches.open(AUDIO_CACHE);
      await c.put(this.url(it), new Response(blob, { headers: {
        "content-type": blob.type, "content-length": blob.size, "accept-ranges": "bytes" } }));
      this.saved.add(this.url(it));
    } catch (e) {
      toast(`Could not save "${it.title}"`);
    }
    this.queue.shift(); save(K.dlqueue, this.queue);
    this.active = null; this.progress = 0; render();
    this.pump();
  },
};

function paintProgress() {
  const bar = $("#dlbar i");
  if (bar) bar.style.width = Math.round(Offline.progress * 100) + "%";
  const pc = $("#dlpct");
  if (pc) pc.textContent = Math.round(Offline.progress * 100) + "%";
}

/* --------------------------------------------------------------- playlists */
/* Unique even inside one millisecond: an import creating six playlists at once
   would otherwise give them all the same id. */
let listTick = 0;
const newListId = () => "pl" + Date.now().toString(36) + (listTick++).toString(36);

const Playlists = {
  all() { const v = load(K.playlists, []); return Array.isArray(v) ? v : []; },
  get(id) { return this.all().find(p => p.id === id); },
  write(list) { LIST_INDEX = null; save(K.playlists, list); Sync.soon(); },
  create(name, items = []) {
    const list = this.all();
    const pl = { id: newListId(), name: name || "Untitled playlist",
                 items: [...items], created: Date.now(), updated: Date.now() };
    list.push(pl); this.write(list); Names.keepAll(pl.items); return pl;
  },
  update(id, fn) {
    const list = this.all(); const pl = list.find(p => p.id === id);
    if (!pl) return; fn(pl); pl.updated = Date.now(); this.write(list);
  },
  /* A deleted playlist is remembered as deleted. The id is the whole record --
     what it held is on whatever device still has it, and that device is the one
     that needs telling. */
  remove(id) {
    this.write(this.all().filter(p => p.id !== id));
    const gone = this.gone(); gone[id] = nowISO(); this.writeGone(gone);
  },
  gone() {
    const v = load(K.plgone, null);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  },
  writeGone(gone) {
    const cut = Date.now() - TOMB_DAYS * DAY;
    for (const [id, t] of Object.entries(gone)) if (favTime(t) && favTime(t) < cut) delete gone[id];
    save(K.plgone, gone);
    Sync.soon();
  },
  /* An entry taken out of a playlist is remembered per playlist, for the same
     reason and with the same shape as an unliked favourite. Putting it back
     clears the record, because that is what putting it back means. */
  dropItem(id, i) {
    this.update(id, pl => {
      const item = pl.items[i];
      if (item === undefined) return;
      pl.items.splice(i, 1);
      if (pl.items.includes(item)) return;      // still there under another index
      (pl.removed ||= {})[item] = nowISO();
    });
  },
  /* Everything in any list, for the facet that asks whether a recording is in
     one. A set rather than a scan per item: a hundred lists of fifty is five
     thousand comparisons against every card otherwise. */
  itemIds() {
    const out = new Set();
    for (const p of this.all()) for (const id of p.items) out.add(id);
    return out;
  },
  addItems(id, ids) {
    this.update(id, pl => {
      for (const i of ids) {
        if (pl.items.includes(i)) continue;
        pl.items.push(i);
        if (pl.removed) delete pl.removed[i];
      }
    });
    Names.keepAll(ids);
  },
};

/* -------------------------------------------------------------- favourites */
/* Two bags of ids -- recordings and creators -- each remembering when it was
   liked, because "what I liked recently" is the order a favourites page wants
   and nothing else in the app records it.

   Held as the export writes it, so what is kept and what is shared are one
   shape to reason about and one shape to document. Times are ISO on disk and
   milliseconds in memory; a hand-written `["id", "id"]` list is accepted too,
   because someone will write one. */
const favTime = v => {
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? t : 0;
};

/* A Map, not an object: an id from a file somewhere else is a key nobody here
   chose, and `__proto__` is a key. */
function favBag(raw) {
  const bag = new Map();
  if (Array.isArray(raw)) {
    for (const id of raw) if (typeof id === "string" && id) bag.set(id, 0);
    return bag;
  }
  if (!raw || typeof raw !== "object") return bag;
  for (const [id, when] of Object.entries(raw)) if (id) bag.set(id, favTime(when));
  return bag;
}

/* What an id was called, kept beside the id itself.

   An item's id defaults to a slug of its title, so retitling one in the source
   gives it a new id and detaches every favourite, playlist entry, note and
   listening event that pointed at the old one. Nothing is lost -- an unknown id
   is kept rather than dropped -- but a note written by hand silently stops
   appearing, and a note is the one record here that cannot be regenerated from
   anything else.

   One entry per item referenced, not one per record, and the same map a shared
   profile will publish so a reader without this library can still see names. */
const Names = {
  held: null,
  read() {
    if (!this.held) {
      const raw = load(K.names, null);
      this.held = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    }
    return this.held;
  },
  keep(id) {
    const it = BY_ID.get(id);
    if (!it) return;                       // nothing here to take a name from
    const m = this.read(), was = m[id], a = authorName(it.author);
    if (was && was.t === it.title && was.a === a) return;
    m[id] = { t: it.title, a, u: nowISO() };
    save(K.names, m);
  },
  keepAll(ids) { for (const id of ids || []) this.keep(id); },
  of(id) { const n = this.read()[id]; return n && typeof n === "object" ? n : null; },
  /* Latest wins: a title that changed is a title that changed, and the newer
     record is the one that saw it. */
  take(id, row) {
    if (!id || !row || typeof row !== "object" || typeof row.t !== "string") return;
    const m = this.read(), was = m[id];
    if (was && favTime(was.u) >= favTime(row.u)) return;
    m[id] = { t: row.t.slice(0, 300), a: String(row.a || "").slice(0, 200), u: row.u || "" };
    save(K.names, m);
  },
  plain() { return { ...this.read() }; },
};

const Favourites = {
  held: null,
  read() {
    if (!this.held) {
      const raw = load(K.favs, null) || {};
      const gone = raw.removed && typeof raw.removed === "object" ? raw.removed : {};
      this.held = { items: favBag(raw.items), authors: favBag(raw.authors),
                    goneItems: favBag(gone.items), goneAuthors: favBag(gone.authors) };
    }
    return this.held;
  },
  bag(what) { return this.read()[what === "author" ? "authors" : "items"]; },
  /* Unliking is recorded, not merely done. Without this a merge cannot tell a
     device that never liked something from one that liked it and changed its
     mind, so the next sync hands it back. */
  gone(what) { return this.read()[what === "author" ? "goneAuthors" : "goneItems"]; },
  has(what, id) { return this.bag(what).has(id); },
  /* Most recently liked first. Entries with no time keep the order the file
     they came from listed them in, which is the only order such a file has. */
  ids(what) { return [...this.bag(what)].sort((a, b) => b[1] - a[1]).map(([id]) => id); },
  toggle(what, id) {
    const bag = this.bag(what), gone = this.gone(what);
    if (bag.has(id)) { bag.delete(id); gone.set(id, Date.now()); }
    else { gone.delete(id); bag.set(id, Date.now()); if (what !== "author") Names.keep(id); }
    this.write();
    return bag.has(id);
  },
  /* The earliest time wins. Two devices that both liked something disagree only
     about when, and the first time is the true one. Answers whether this was
     new here, which is what an import report counts. An addition older than a
     recorded removal is a file catching up with a decision already made. */
  add(what, id, when) {
    const bag = this.bag(what), gone = this.gone(what), t = favTime(when) || Date.now();
    const dropped = gone.get(id) || 0;
    if (dropped && dropped >= t) return false;
    if (dropped) gone.delete(id);
    if (!bag.has(id)) { bag.set(id, t); return true; }
    const held = bag.get(id);
    if (t && (!held || t < held)) bag.set(id, t);
    return false;
  },
  /* The other direction, and the same comparison: a removal older than the like
     it answers is stale, and loses. Reports whether anything actually went. */
  drop(what, id, when) {
    const bag = this.bag(what), gone = this.gone(what), t = favTime(when) || Date.now();
    const liked = bag.get(id) || 0;
    if (liked && liked > t) return false;
    const had = bag.delete(id);
    if (t > (gone.get(id) || 0)) gone.set(id, t);
    return had;
  },
  prune() {
    const cut = Date.now() - TOMB_DAYS * DAY;
    for (const which of ["goneItems", "goneAuthors"]) {
      const bag = this.read()[which];
      for (const [id, t] of bag) if (t && t < cut) bag.delete(id);
    }
  },
  write() { this.prune(); save(K.favs, this.plain()); Sync.soon(); },
  plain() {
    const out = bag => Object.fromEntries([...bag]
      .map(([id, t]) => [id, t ? new Date(t).toISOString() : ""]));
    const r = this.read();
    const o = { items: out(r.items), authors: out(r.authors) };
    const gi = out(r.goneItems), ga = out(r.goneAuthors);
    if (Object.keys(gi).length || Object.keys(ga).length) o.removed = { items: gi, authors: ga };
    return o;
  },
};

/* ------------------------------------------------------------------- notes */
/* A short note against an item: why it is kept, what it is for, what it did.

   Text, never HTML. A description arrives as sanitised markup because somebody
   else wrote it for publication; a note is typed here, into a box, and rendering
   it as anything but text would buy a formatting feature nobody asked for at the
   price of a whole class of problem.

   Emptying a note is how a note is deleted -- the entry stays, with a newer
   time, and is the tombstone. Where a merge displaces text that differs, the
   displaced version is kept beside it: losing something typed is the one loss
   people actually notice. */
const NOTE_MAX = 2000;

const Notes = {
  held: null,
  read() {
    if (!this.held) {
      const raw = load(K.notes, null);
      this.held = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    }
    return this.held;
  },
  row(id) { const n = this.read()[id]; return n && typeof n === "object" ? n : null; },
  text(id) { return this.row(id)?.text || ""; },
  isPrivate(id) { return !!this.row(id)?.private; },
  displaced(id) { return this.row(id)?.was || null; },
  has(id) { return !!this.text(id); },
  /* Most recently written first, which is the order a list of notes wants. */
  ids() {
    return Object.entries(this.read()).filter(([, n]) => n && n.text)
      .sort((a, b) => favTime(b[1].updated) - favTime(a[1].updated)).map(([id]) => id);
  },
  set(id, text, priv) {
    const m = this.read(), was = m[id];
    text = String(text ?? "").slice(0, NOTE_MAX);
    if (was && was.text === text && !!was.private === !!priv) return false;
    const row = { text, updated: nowISO() };
    if (priv) row.private = true;
    if (was && was.was) row.was = was.was;
    m[id] = row;
    if (text) Names.keep(id);
    this.write();
    return true;
  },
  clearDisplaced(id) {
    const row = this.row(id); if (!row || !row.was) return;
    delete row.was; this.write();
  },
  restore(id) {
    const row = this.row(id); if (!row || !row.was) return false;
    const back = row.was;
    const next = { text: back.text, updated: nowISO() };
    if (row.private) next.private = true;
    this.read()[id] = next;
    this.write();
    return true;
  },
  /* Last write wins, by the time on the note. Text that loses and is not the
     same as the winner is kept as `was` for one restore. */
  take(id, row) {
    if (!id || !row || typeof row !== "object" || typeof row.text !== "string") return false;
    const m = this.read(), held = m[id];
    const t = favTime(row.updated), h = held ? favTime(held.updated) : 0;
    if (held && h >= t) return false;
    const text = row.text.slice(0, NOTE_MAX);
    const next = { text, updated: row.updated || nowISO() };
    if (row.private) next.private = true;
    if (held && held.text && held.text !== text) next.was = { text: held.text, updated: held.updated };
    else if (held && held.was) next.was = held.was;
    m[id] = next;
    if (text) Names.keep(id);
    return true;
  },
  prune() {
    const m = this.read(), cut = Date.now() - TOMB_DAYS * DAY;
    for (const [id, n] of Object.entries(m)) {
      if (!n || typeof n !== "object") { delete m[id]; continue; }
      if (!n.text && favTime(n.updated) && favTime(n.updated) < cut) delete m[id];
    }
  },
  write() { this.prune(); save(K.notes, this.read()); Sync.soon(); },
  /* What leaves. A private note leaves in nothing, whatever a toggle says, and
     the displaced copy is nobody else's business. */
  plain(withPrivate = false) {
    const out = {};
    for (const [id, n] of Object.entries(this.read())) {
      if (!n || typeof n !== "object") continue;
      if (n.private && !withPrivate) continue;
      out[id] = { text: n.text || "", updated: n.updated || "" };
      if (n.private) out[id].private = true;
    }
    return out;
  },
};

/* ----------------------------------------------------------------- history */
/* What was played, when, and how often, in two layers.

   `recent` is the stream of sittings, and is what a timeline is drawn from. One
   entry is one sitting rather than one press of play: it opens once thirty
   seconds have really been heard, and closes when the item changes or after
   half an hour of quiet. `plays` is the summary that survives trimming -- first,
   last, and a count.

   The count is held per device and summed only for display. It cannot be summed
   on merge: a blob is a full merged view, so adding two views of the same
   history compounds it. Each device raises only its own number, a merge takes
   the higher of the two, and the total is the sum.

   Recording is always on, because a player that cannot remember what it played
   is a worse player and in an unlinked library the record has nowhere to go.
   The controls are a pause, for a sitting somebody would rather not keep, and a
   clear. */
const HIST_KEEP = 2000;               // sittings kept per device
const HIST_YEARS = 2;
const LISTEN_MIN = 30;                // seconds before a sitting counts
const LISTEN_GAP = 30 * 60;           // seconds of quiet that close one

const History = {
  held: null,
  read() {
    if (!this.held) {
      const raw = load(K.hist, null) || {};
      const obj = v => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
      this.held = {
        recent: Array.isArray(raw.recent) ? raw.recent.filter(e => e && typeof e === "object") : [],
        plays: obj(raw.plays),
        forget: obj(raw.forget),
        before: typeof raw.before === "string" ? raw.before : "",
        epoch: Number.isFinite(raw.epoch) ? raw.epoch : 0,
        paused: !!raw.paused,
      };
    }
    return this.held;
  },
  write() { save(K.hist, this.read()); Sync.soon(); },
  paused() { return this.read().paused; },
  setPaused(v) { this.read().paused = !!v; this.write(); },

  record(id, at, secs, done) {
    const h = this.read();
    if (h.paused || !id) return;
    const t = new Date(at || Date.now()).toISOString();
    if (h.before && t <= h.before) return;
    h.recent.push({ i: id, t, s: Math.max(0, Math.round(secs || 0)), c: !!done, d: Device.id() });
    const row = (h.plays[id] ||= { f: t, l: t, c: {} });
    if (!row.f || t < row.f) row.f = t;
    if (!row.l || t > row.l) row.l = t;
    const mine = (row.c[Device.id()] ||= { n: 0, e: h.epoch });
    if (mine.e !== h.epoch) { mine.n = 0; mine.e = h.epoch; }
    mine.n++;
    delete h.forget[id];                 // played again, so no longer forgotten
    Names.keep(id);
    this.trim(h);
    this.write();
  },

  /* Own events are trimmed by count, everything by age. A foreign event is
     another device's record and is left alone beyond the age limit. */
  trim(h) {
    const old = new Date(Date.now() - HIST_YEARS * 365 * DAY).toISOString();
    h.recent = h.recent.filter(e => typeof e.t === "string" && e.t > old);
    const mine = Device.id();
    let n = 0;
    for (let i = h.recent.length - 1; i >= 0; i--) {
      if (h.recent[i].d !== mine) continue;
      if (++n > HIST_KEEP) h.recent.splice(i, 1);
    }
  },

  /* Newest first, with anything forgotten filtered out rather than deleted on
     the spot: a watermark is cheaper than rewriting the stream, and an import
     that re-offers a forgotten sitting has to meet the same test. */
  events() {
    const h = this.read();
    return h.recent
      .filter(e => this.kept(h, e.i, e.t))
      .sort((a, b) => (b.t || "").localeCompare(a.t || ""))
      .map(e => ({ id: e.i, at: e.t, secs: e.s || 0, done: !!e.c, dev: e.d || "" }));
  },
  kept(h, id, t) {
    if (!id || typeof t !== "string") return false;
    if (h.before && t <= h.before) return false;
    const f = h.forget[id];
    return !(f && t <= f);
  },
  /* Total, first and last for one item, or null where nothing is held. */
  plays(id) {
    const h = this.read(), row = h.plays[id];
    if (!row || !this.kept(h, id, row.l || "")) return null;
    let n = 0;
    for (const c of Object.values(row.c || {})) n += Number(c?.n) || 0;
    return n ? { n, first: row.f || "", last: row.l || "" } : null;
  },
  played(id) { return !!this.plays(id); },
  /* Every id with a count that has survived a forget or a clear. Built once and
     handed to the facet, rather than asked item by item across a library. */
  playedIds() {
    const out = new Set();
    for (const id of Object.keys(this.read().plays)) if (this.plays(id)) out.add(id);
    return out;
  },
  /* Every item with a count, most played first. */
  ranked() {
    const h = this.read();
    return Object.keys(h.plays).map(id => ({ id, ...(this.plays(id) || {}) }))
      .filter(r => r.n).sort((a, b) => b.n - a.n || (b.last || "").localeCompare(a.last || ""));
  },
  forgetItem(id) {
    const h = this.read();
    h.forget[id] = nowISO();
    h.recent = h.recent.filter(e => e.i !== id);
    delete h.plays[id];
    this.write();
  },
  /* Everything. The watermark is what makes it stick through a later merge; the
     epoch is what lets this device's own counter start again from nothing.
     A count is not partly clearable, so an item played both before and after a
     clear can bring its older total back from a file that still holds it. */
  clear() {
    const h = this.read();
    h.before = nowISO(); h.recent = []; h.plays = {}; h.forget = {}; h.epoch++;
    this.write();
  },
  /* What this device publishes. Events are owned by whoever recorded them: a
     trimmed foreign event would otherwise arrive again from the device that
     still holds it, so nobody republishes anybody else's. */
  plainOwn() {
    const mine = Device.id(), o = this.plain();
    o.recent = o.recent.filter(e => e.d === mine);
    return o;
  },
  plain() {
    const h = this.read();
    const o = { recent: h.recent.filter(e => this.kept(h, e.i, e.t)), plays: {} };
    for (const [id, row] of Object.entries(h.plays)) {
      if (this.kept(h, id, row.l || "")) o.plays[id] = row;
    }
    if (h.before) o.before = h.before;
    if (Object.keys(h.forget).length) o.forget = { ...h.forget };
    return o;
  },
  /* A merge. Events union and are deduplicated on device and time; counts take
     the higher value per device, or the newer epoch outright; watermarks take
     the later of the two, and are applied to what arrives. */
  take(payload) {
    const h = this.read();
    let added = 0;
    if (payload.before && payload.before > h.before) h.before = payload.before;
    for (const [id, t] of Object.entries(payload.forget || {})) {
      if (typeof t === "string" && t > (h.forget[id] || "")) h.forget[id] = t;
    }
    const seen = new Set(h.recent.map(e => `${e.d}|${e.t}`));
    for (const e of payload.recent || []) {
      if (!e || typeof e.i !== "string" || typeof e.t !== "string") continue;
      if (!this.kept(h, e.i, e.t)) continue;
      const key = `${e.d || ""}|${e.t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      h.recent.push({ i: e.i, t: e.t, s: Math.max(0, Math.round(Number(e.s) || 0)),
                      c: !!e.c, d: String(e.d || "") });
      added++;
    }
    for (const [id, row] of Object.entries(payload.plays || {})) {
      if (!row || typeof row !== "object") continue;
      if (!this.kept(h, id, row.l || "")) continue;
      const held = (h.plays[id] ||= { f: row.f || "", l: row.l || "", c: {} });
      if (row.f && (!held.f || row.f < held.f)) held.f = row.f;
      if (row.l && (!held.l || row.l > held.l)) held.l = row.l;
      for (const [dev, c] of Object.entries(row.c || {})) {
        if (!c || typeof c !== "object") continue;
        const n = Number(c.n) || 0, e = Number(c.e) || 0;
        const mine = held.c[dev];
        if (!mine || e > (Number(mine.e) || 0)) held.c[dev] = { n, e };
        else if (e === (Number(mine.e) || 0) && n > (Number(mine.n) || 0)) mine.n = n;
      }
    }
    this.trim(h);
    this.write();
    return added;
  },
};

/* One sitting, watched as it happens.

   Seconds are counted from how far the position actually moved, so a seek to
   the end is not an hour listened and a paused tab is not anything at all. The
   sitting is handed to the history only once it has passed the threshold, which
   is why opening something by accident leaves no trace. */
const Listen = {
  id: null, at: 0, secs: 0, mark: 0, touched: 0, open: false,

  tick(it, t) {
    if (!it || !(t >= 0)) return;
    const now = Date.now();
    if (this.id !== it.id || (this.touched && now - this.touched > LISTEN_GAP * 1000)) {
      this.close();
      this.id = it.id; this.at = now; this.secs = 0; this.mark = t; this.open = true;
    }
    const d = t - this.mark;
    this.mark = t;
    this.touched = now;
    if (d > 0 && d < 5) this.secs += d;       // a jump is a seek, not listening
  },
  finished() { this.close(true); },
  close(done = false) {
    const id = this.id, secs = this.secs, at = this.at;
    this.id = null; this.open = false; this.secs = 0; this.mark = 0; this.touched = 0;
    if (id && secs >= LISTEN_MIN) History.record(id, at, secs, done);
  },
};

/* ------------------------------------------------------------------ crypto */
/* Everything sync needs, out of WebCrypto and nothing else.

   The group key is the whole secret. Everything else derives from it under
   distinct info strings, so holding one derivative yields neither the group key
   nor any sibling: the server is given the enrolment key, which lets it tell a
   member from a stranger, and is never given the content key, which is the only
   one that opens anything. */
const SALT = new Uint8Array(0);
const TE = new TextEncoder();
const subtle = () => globalThis.crypto?.subtle;

/* Browsers hand out the cryptography only on a secure page -- HTTPS, or
   localhost -- so a library served over plain http from a machine on the
   network has `crypto.subtle` undefined and can do none of this. Everything
   else still works; the only honest thing is to say which, and why. */
const canSync = () => !!subtle();
const INSECURE = "this page cannot do the cryptography sync needs: browsers offer it "
               + "only over HTTPS, or from localhost";

/* Chunked, because spreading a hundred thousand bytes into fromCharCode is a
   stack overflow on exactly the large blob this is for. */
function toB64(buf) {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}
function fromB64(text) {
  const raw = atob(String(text || ""));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
/* RFC 4648 base32, lower case and unpadded: an id that survives being read
   aloud, typed by somebody looking at a phone, and put in a URL. */
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function toB32(bytes) {
  let bits = 0, value = 0, out = "";
  for (const b of new Uint8Array(bytes)) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
const randomBytes = n => {
  const r = new Uint8Array(n);
  globalThis.crypto.getRandomValues(r);
  return r;
};
async function sha256(bytes) { return new Uint8Array(await subtle().digest("SHA-256", bytes)); }

/* An id is the first 128 bits of a hash, which is 26 characters of base32 and
   the same length wherever one appears: group, device, pairing, profile. */
const idFrom = bytes => toB32(bytes.slice(0, 16));

async function hkdf(secret, info, bytes = 32) {
  const key = await subtle().importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const out = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: TE.encode(info) }, key, bytes * 8);
  return new Uint8Array(out);
}
async function hmacKey(raw) {
  return subtle().importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function macOver(raw, method, path, body) {
  const sum = await sha256(body || new Uint8Array(0));
  const hex = [...sum].map(b => b.toString(16).padStart(2, "0")).join("");
  const key = await hmacKey(raw);
  const sig = await subtle().sign("HMAC", key,
    TE.encode(`hypnotica/auth/1\n${method}\n${path}\n${hex}`));
  return toB64(sig);
}

/* Compressed before it is encrypted, which is safe here because nothing an
   attacker chooses is mixed into a person's own favourites. The first byte says
   whether it happened, so a browser without the stream still reads a blob one
   with it wrote. */
async function squeeze(text) {
  const raw = TE.encode(text);
  if (!globalThis.CompressionStream) {
    const out = new Uint8Array(raw.length + 1); out[0] = 0; out.set(raw, 1); return out;
  }
  const cs = new CompressionStream("gzip");
  const packed = new Uint8Array(await new Response(
    new Blob([raw]).stream().pipeThrough(cs)).arrayBuffer());
  const out = new Uint8Array(packed.length + 1); out[0] = 1; out.set(packed, 1);
  return out;
}
async function unsqueeze(bytes) {
  const body = bytes.slice(1);
  if (bytes[0] !== 1) return new TextDecoder().decode(body);
  const ds = new DecompressionStream("gzip");
  return new Response(new Blob([body]).stream().pipeThrough(ds)).text();
}

async function seal(contentKey, text) {
  const key = await subtle().importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const n = randomBytes(12);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv: n }, key, await squeeze(text));
  return { n: toB64(n), ct: toB64(ct) };
}
async function unseal(contentKey, n, ct) {
  const key = await subtle().importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
  const plain = await subtle().decrypt({ name: "AES-GCM", iv: fromB64(n) }, key, fromB64(ct));
  return unsqueeze(new Uint8Array(plain));
}

/* ------------------------------------------------ playlists and favourites
                                                     as a file to carry away */
/* One file carries both, because somebody setting up a second device wants
   both and should not have to think about which file is which.

   An import is merged and never replaces: a file written on a phone that holds
   a quarter of the library must not take anything away from the machine that
   holds all of it. Ids it names that are not here are kept rather than dropped,
   so a playlist shared by somebody with more of the library than you fills in
   the day the rest of it arrives. */
const TRANSFER = 1;

const Share = {
  bundle({ playlists = null, favourites = false, notes = false, history = false,
           searches = false, secret = false, own = false } = {}) {
    const stamp = ms => (ms ? new Date(ms).toISOString() : "");
    const out = { hypnotica: TRANSFER, exported: nowISO() };
    if (DATA.site?.title) out.site = DATA.site.title;
    // Every id the file mentions, so it can carry their names: a file read on a
    // library that has been rebuilt since, or on somebody else's altogether,
    // shows what it is talking about instead of a column of slugs.
    const seen = new Set();
    if (playlists) {
      out.playlists = playlists.map(p => {
        const row = { id: p.id, name: p.name, created: stamp(p.created),
                      updated: stamp(p.updated), items: [...p.items] };
        if (p.removed && Object.keys(p.removed).length) row.removed = { ...p.removed };
        for (const id of row.items) seen.add(id);
        return row;
      });
      const gone = Playlists.gone();
      if (Object.keys(gone).length) out.playlistsRemoved = gone;
    }
    if (favourites) {
      out.favourites = Favourites.plain();
      for (const id of Object.keys(out.favourites.items)) seen.add(id);
    }
    if (notes) {
      // A private note is between a person and their own devices: it syncs, and
      // it leaves in nothing a third party ever sees.
      out.notes = Notes.plain(secret);
      for (const id of Object.keys(out.notes)) seen.add(id);
    }
    if (history) {
      out.history = own ? History.plainOwn() : History.plain();
      for (const e of out.history.recent) seen.add(e.i);
      for (const id of Object.keys(out.history.plays)) seen.add(id);
    }
    if (searches) {
      out.searches = Searches.all();
      const gone = Searches.gone();
      if (Object.keys(gone).length) out.searchesRemoved = gone;
    }
    /* The standing filter goes to this person's own devices and nowhere else.
       It is a list of what somebody would rather not be shown, which is a thing
       about them rather than about the library, and it has no business in a file
       that gets sent to anybody. */
    if (secret) {
      out.always = { ...ALWAYS };
      out.me = Me.read();
      // A share is the library's, not the device that happened to publish it:
      // rotating or revoking one from the phone is the same act as from the
      // machine it was made on.
      out.shares = Shares.all();
      const goneShares = Shares.gone();
      if (Object.keys(goneShares).length) out.sharesRemoved = goneShares;
      // The links, not what was fetched with them: every device asks for itself,
      // and a cached profile is somebody else's data to be holding twice.
      out.follows = Followed.all().map(r => ({ id: r.id, endpoint: r.endpoint,
                                               key: r.key, name: r.name, added: r.added }));
    }
    const names = {};
    for (const id of seen) { const n = Names.of(id); if (n) names[id] = n; }
    if (Object.keys(names).length) out.names = names;
    return out;
  },

  /* Lenient about what it is handed, strict about what it returns. A whole
     export, a bare list of playlists, or one playlist on its own all read the
     same way -- the last of those is what somebody gets when they copy one
     object out of a file to send to a friend. */
  parse(text) {
    let raw;
    try { raw = JSON.parse(text); } catch { throw new Error("That is not JSON."); }
    if (Array.isArray(raw)) raw = { playlists: raw };
    else if (raw && typeof raw === "object" && Array.isArray(raw.items)
             && !raw.playlists && !raw.favourites) raw = { playlists: [raw] };
    if (!raw || typeof raw !== "object") throw new Error("Nothing to import in that.");
    if (Number(raw.hypnotica ?? TRANSFER) > TRANSFER) {
      throw new Error("That file came from a newer Hypnotica.");
    }
    const obj = v => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    const lists = Array.isArray(raw.playlists) ? raw.playlists : [];
    const fav = obj(raw.favourites);
    const favGone = obj(fav.removed);
    const hist = obj(raw.history);
    const out = {
      playlists: lists.filter(p => p && typeof p === "object").map(p => ({
        id: typeof p.id === "string" ? p.id : "",
        name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : "Imported playlist",
        named: typeof p.name === "string" && !!p.name.trim(),
        created: favTime(p.created),
        updated: favTime(p.updated),
        items: (Array.isArray(p.items) ? p.items : []).filter(i => typeof i === "string" && i),
        removed: obj(p.removed),
      })),
      playlistsRemoved: obj(raw.playlistsRemoved),
      items: favBag(fav.items),
      authors: favBag(fav.authors),
      itemsGone: favBag(favGone.items),
      authorsGone: favBag(favGone.authors),
      notes: obj(raw.notes),
      names: obj(raw.names),
      searches: Array.isArray(raw.searches) ? raw.searches : [],
      searchesRemoved: obj(raw.searchesRemoved),
      // Read, so a sync blob can hand them over; never applied by an import.
      always: obj(raw.always),
      me: obj(raw.me),
      follows: Array.isArray(raw.follows) ? raw.follows : [],
      shares: Array.isArray(raw.shares) ? raw.shares : [],
      sharesRemoved: obj(raw.sharesRemoved),
      // Only ever in a sync blob: the keys of groups this one used to be, and a
      // note that this device's group has become part of another.
      ring: Array.isArray(raw.ring) ? raw.ring : [],
      moved: raw.moved && typeof raw.moved === "object" ? raw.moved : null,
      history: {
        recent: Array.isArray(hist.recent) ? hist.recent : [],
        plays: obj(hist.plays),
        forget: obj(hist.forget),
        before: typeof hist.before === "string" ? hist.before : "",
      },
    };
    const anyHistory = out.history.recent.length || Object.keys(out.history.plays).length
                    || Object.keys(out.history.forget).length || out.history.before;
    if (!out.playlists.length && !out.items.size && !out.authors.size
        && !out.itemsGone.size && !out.authorsGone.size
        && !Object.keys(out.playlistsRemoved).length && !out.searches.length
        && !Object.keys(out.notes).length && !anyHistory
        // A device's own blob can hold nothing but settings and still be worth
        // opening; an import file never carries these.
        && !out.moved && !out.ring.length && !out.shares.length && !out.follows.length
        && !Object.keys(out.me).length && !Object.keys(out.always).length) {
      throw new Error("No playlists, favourites, notes, searches or history in that file.");
    }
    return out;
  },

  /* Playlists are matched by id, which is how the same playlist on two devices
     stays one playlist through any number of round trips. A playlist that is
     already here gains the entries it is missing and keeps the ones it has;
     the name follows only if the file's copy was edited more recently. */
  merge(payload) {
    const report = { added: 0, updated: 0, items: 0, authors: 0, missing: 0,
                     dropped: 0, lists: 0, notes: 0, events: 0, searches: 0 };
    for (const [id, row] of Object.entries(payload.names || {})) Names.take(id, row);

    /* A playlist deleted elsewhere goes, unless it has been touched here since
       it was deleted there -- in which case somebody has used it more recently
       than somebody else threw it away, and the use wins. */
    let list = Playlists.all();
    const gone = Playlists.gone();
    for (const [id, when] of Object.entries(payload.playlistsRemoved || {})) {
      const t = favTime(when);
      if (!t) continue;
      if (!gone[id] || favTime(gone[id]) < t) gone[id] = when;
      const held = list.find(p => p.id === id);
      if (held && (held.updated || 0) <= t) {
        list = list.filter(p => p.id !== id);
        report.lists++;
      }
    }
    Playlists.writeGone(gone);

    const byId = new Map(list.map(p => [p.id, p]));
    for (const inc of payload.playlists) {
      if (inc.id && favTime(gone[inc.id]) > inc.updated) continue;   // deleted since
      const held = inc.id ? byId.get(inc.id) : null;
      if (held) {
        /* Entries this copy removed are not handed back by a file older than
           the removal, and entries that file removed go only if it is the more
           recently edited of the two. Both comparisons are against the times
           already recorded; neither invents one. */
        const mine = held.removed || {};
        const gained = inc.items.filter(id => !held.items.includes(id)
                                        && !(favTime(mine[id]) > inc.updated));
        const lost = [];
        for (const [id, when] of Object.entries(inc.removed || {})) {
          const t = favTime(when);
          if (!t || t <= (held.updated || 0)) continue;
          if (held.items.includes(id)) lost.push(id);
          (held.removed ||= {})[id] = when;
        }
        const rename = inc.named && inc.name !== held.name
                       && inc.updated > (held.updated || 0);
        if (!gained.length && !lost.length && !rename) continue;
        held.items.push(...gained);
        if (lost.length) held.items = held.items.filter(id => !lost.includes(id));
        if (rename) held.name = inc.name;
        held.updated = Date.now();
        report.updated++;
      } else {
        const pl = { id: inc.id && !byId.has(inc.id) ? inc.id : newListId(),
                     name: inc.name, items: [...inc.items],
                     created: inc.created || Date.now(),
                     updated: inc.updated || Date.now() };
        if (Object.keys(inc.removed || {}).length) pl.removed = { ...inc.removed };
        list.push(pl); byId.set(pl.id, pl); report.added++;
      }
    }
    Playlists.write(list);

    for (const [id, when] of payload.items) {
      if (Favourites.add("item", id, when)) report.items++;
    }
    for (const [id, when] of payload.authors) {
      if (Favourites.add("author", id, when)) report.authors++;
    }
    for (const [id, when] of payload.itemsGone || []) {
      if (Favourites.drop("item", id, when)) report.dropped++;
    }
    for (const [id, when] of payload.authorsGone || []) {
      if (Favourites.drop("author", id, when)) report.dropped++;
    }
    Favourites.write();

    for (const [id, row] of Object.entries(payload.notes || {})) {
      if (Notes.take(id, row)) report.notes++;
    }
    Notes.write();
    report.events = History.take(payload.history || {});
    report.searches = Searches.take(payload.searches, payload.searchesRemoved);

    report.missing = this.strangers(payload);
    return report;
  },

  /* What the file names that this build has never heard of. Not an error and
     not dropped -- said out loud, because the alternative is a playlist that
     silently arrives four entries short. */
  strangers(payload) {
    const ids = new Set();
    for (const p of payload.playlists) for (const id of p.items) ids.add(id);
    for (const [id] of payload.items) ids.add(id);
    for (const id of Object.keys(payload.notes || {})) ids.add(id);
    for (const id of Object.keys(payload.history?.plays || {})) ids.add(id);
    let n = [...ids].filter(id => !BY_ID.has(id)).length;
    for (const [id] of payload.authors) {
      if (!DATA.authors.some(a => a.id === id)) n++;
    }
    return n;
  },
};

/* ------------------------------------------------------------------- sync */
/* Carrying the records between a person's own devices.

   One slot per device, named by that device's key fingerprint, holding that
   device's whole current view. A device writes only its own slot and reads
   everyone else's, so two devices can never collide on one blob and a device
   that has been away for a week simply puts its state up when it returns.

   Nothing here happens until somebody links a device: with no endpoint there is
   no key, no group, and nothing for a server to know about. */
const ENVELOPE = 1;
const SYNC_DEBOUNCE = 4000;

const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");

async function signEnvelope(device, scope, counter, ct) {
  const msg = TE.encode(`hypnotica/env/1\n${scope}\n${device.fp}\n${counter}\n${hex(await sha256(ct))}`);
  const sig = await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, device.priv, msg);
  return toB64(sig);
}

/* Opened here rather than trusted: the endpoint holds the ciphertext and could
   hand back anything, so the fingerprint has to name the slot and the signature
   has to verify before a single field of it is believed. */
async function openEnvelope(content, scope, env) {
  if (Number(env.v) !== ENVELOPE) throw new Error("that blob came from a newer Hypnotica");
  const spki = fromB64(env.key);
  if (idFrom(await sha256(spki)) !== env.slot) throw new Error("key does not name its slot");
  const pub = await subtle().importKey("spki", spki,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ct = fromB64(env.ct);
  const msg = TE.encode(`hypnotica/env/1\n${scope}\n${env.slot}\n${env.counter}\n${hex(await sha256(ct))}`);
  const good = await subtle().verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromB64(env.sig), msg);
  if (!good) throw new Error("signature does not verify");
  return unseal(content, env.n, env.ct);
}

/* Every time in an incoming blob, held to the moment the server saw it.

   Merges resolve by comparing times across devices, and a machine whose clock is
   a year fast would otherwise win every comparison until somebody noticed -- and
   its notes would go on winning afterwards. The server cannot read a blob but it
   can say when it arrived, and nothing a device wrote can be newer than that. */
function clampPayload(payload, recv) {
  const cap = favTime(recv) || Date.now();
  const iso = new Date(cap).toISOString();
  const clampMap = m => {
    for (const [k, v] of Object.entries(m || {})) if (favTime(v) > cap) m[k] = iso;
  };
  const clampBag = bag => {
    for (const [k, v] of bag) if (v > cap) bag.set(k, cap);
  };
  for (const p of payload.playlists) {
    if (p.created > cap) p.created = cap;
    if (p.updated > cap) p.updated = cap;
    clampMap(p.removed);
  }
  clampMap(payload.playlistsRemoved);
  clampBag(payload.items); clampBag(payload.authors);
  clampBag(payload.itemsGone); clampBag(payload.authorsGone);
  for (const n of Object.values(payload.notes || {})) {
    if (favTime(n.updated) > cap) n.updated = iso;
  }
  const h = payload.history || {};
  for (const e of h.recent || []) if (favTime(e.t) > cap) e.t = iso;
  for (const row of Object.values(h.plays || {})) {
    if (favTime(row.f) > cap) row.f = iso;
    if (favTime(row.l) > cap) row.l = iso;
  }
  clampMap(h.forget);
  if (favTime(h.before) > cap) h.before = iso;
  return payload;
}

const Sync = {
  state: { busy: false, at: 0, error: "", devices: 0 },
  timer: null,

  conf() { const v = load(K.sync, null); return v && typeof v === "object" ? v : null; },
  on() { return !!this.conf()?.endpoint; },
  base() { return String(this.conf()?.endpoint || "").replace(/\/+$/, ""); },

  counter(scope) { return Number(load(K.counters, {})[scope]) || 0; },
  bump(scope, to) { const m = load(K.counters, {}); m[scope] = to; save(K.counters, m); },
  // Per group: a device keeps its fingerprint when it moves, and its counter in
  // the new group starts again from one.
  seenAt(group, slot) { return Number(load(K.seen, {})[`${group}/${slot}`]) || 0; },
  sawAt(group, slot, n) { const m = load(K.seen, {}); m[`${group}/${slot}`] = n; save(K.seen, m); },

  /* The membership MAC covers method, path and body, so it cannot be lifted from
     one request and used on another.

     `at` speaks as some other group -- one this library used to be -- with its
     keys and at its address; left out, it is the group this device is in. */
  async ask(method, path, payload, extra = {}, at = null) {
    const k = at ? at.k : await Keys.ready();
    const raw = payload === undefined ? new Uint8Array(0) : TE.encode(JSON.stringify(payload));
    const headers = { ...extra };
    if (k) headers["X-Hypnotica-Auth"] = await macOver(k.enrol, method, path, raw);
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch((at ? at.base : this.base()) + path, {
      method, headers, cache: "no-store",
      body: payload === undefined ? undefined : raw,
    });
    if (!r.ok) {
      let why = `${r.status}`;
      try { why = (await r.json()).error || why; } catch {}
      const e = new Error(why); e.status = r.status; throw e;
    }
    return r;
  },

  /* What the endpoint will let somebody do, asked before anything is typed.
     An endpoint that wants no token should not make a person discover that by
     being refused, and one that does should ask for it only then. */
  async policy(where) {
    const base = String(where || "").replace(/\/+$/, "");
    let r;
    // A refused connection arrives as "fetch failed", which tells somebody
    // typing an address nothing at all.
    try { r = await fetch(base + "/sync/", { cache: "no-store" }); }
    catch { throw new Error("that address did not answer"); }
    if (!r.ok) throw new Error(`that address answered ${r.status}`);
    const body = await r.json();
    return String(body.create || "invite");
  },

  async list(at = null) {
    const k = at ? at.k : await Keys.ready();
    const r = await this.ask("GET", `/sync/${k.group}/`, undefined, {}, at);
    const body = await r.json();
    return Array.isArray(body.slots) ? body.slots : [];
  },

  async envelope(k, scope, text, counter) {
    const { n, ct } = await seal(k.content, text);
    return { v: ENVELOPE, slot: k.device.fp, key: toB64(k.device.spki), counter,
             written: nowISO(), n, ct, sig: await signEnvelope(k.device, scope, counter, fromB64(ct)) };
  },

  /* This device's whole current view. Full state every time: at these sizes a
     delta would be complexity with nobody to pay for it, and a device returning
     from a week offline has nothing to replay. */
  async push(rows, at = null, moved = null) {
    const k = at ? at.k : await Keys.ready();
    const mine = (rows || []).find(r => r.slot === k.device.fp);
    const counter = Math.max(this.counter(k.group), mine ? mine.counter : 0) + 1;
    // A forwarding note is the address and nothing else: the state it would
    // otherwise carry is waiting at the address.
    const doc = moved
      ? { hypnotica: TRANSFER, exported: nowISO(), moved }
      : Share.bundle({ playlists: Playlists.all(), favourites: true, notes: true,
                       history: true, searches: true, secret: true, own: true });
    const ring = await Keys.ringOut(k.group);
    if (ring.length) doc.ring = ring;
    const env = await this.envelope(k, k.group, JSON.stringify(doc), counter);
    await this.ask("PUT", `/sync/${k.group}/${k.device.fp}`, env, {}, at);
    this.bump(k.group, counter);
  },

  async pull(rows) {
    const k = await Keys.ready();
    let took = 0, moved = null;
    for (const row of rows) {
      if (row.slot === k.device.fp) continue;
      if (row.counter <= this.seenAt(k.group, row.slot)) continue;   // never go backwards
      let env;
      try {
        env = await (await this.ask("GET", `/sync/${k.group}/${row.slot}`)).json();
      } catch { continue; }
      try {
        const text = await openEnvelope(k.content, k.group, env);
        const payload = clampPayload(Share.parse(text), env.recv);
        Share.merge(payload);
        // Only here. An imported file never sets what somebody would rather not
        // be shown, nor what they are called; a device of their own may.
        this.adoptAlways(payload.always);
        if (Me.take(payload.me)) Shares.refresh().catch(() => {});
        this.adoptFollows(payload.follows);
        Shares.take(payload.shares, payload.sharesRemoved);
        await Keys.takeRing(payload.ring);
        const to = await this.forwarding(k, payload.moved);
        if (to && (!moved || to.group < moved.group)) moved = to;
        this.sawAt(k.group, row.slot, row.counter);
        took++;
      } catch (e) {
        this.state.error = `a blob from another device would not open: ${e.message}`;
      }
    }
    return { took, moved };
  },

  /* A note left by a device that has gone to another group, which every device
     still here follows. Only ever downhill: two groups become the one whose id
     sorts first, so a note pointing anywhere else is either stale or a loop, and
     neither is worth following. */
  async forwarding(k, moved) {
    if (!moved || typeof moved !== "object") return null;
    let gk;
    try { gk = fromB64(String(moved.gk || "")); } catch { return null; }
    const e = String(moved.e || "").replace(/\/+$/, "");
    if (gk.length !== 32 || !/^https?:\/\//.test(e)) return null;
    const group = await groupOf(gk);
    return group < k.group ? { gk, e, group } : null;
  },

  /* Leaving this group for another. What this device holds comes with it and is
     merged there on the next pass; the group it leaves goes on the ring, so its
     shares can still be spoken for, with what is owed to it -- a note for the
     devices still there, if this is the device that decided, or else only its
     own slot cleared, since somebody else's note already says where to go. */
  async move(to, { note }) {
    const was = await Keys.ready();
    if (was) {
      if (was.group === await groupOf(to.gk)) return;
      Shares.stamp(was.group, this.base());
      const ring = await Keys.ring();
      // Notes already left elsewhere now point somewhere stale; rewritten on the
      // next pass, so a device still in a group two moves back comes straight here.
      for (const r of ring) if (r.state === "noted") r.state = "note";
      await Keys.keepRing(ring);
      await Keys.retire(was.gk, this.base(), note ? "note" : "leave");
    }
    save(K.sync, { endpoint: String(to.e).replace(/\/+$/, "") });
    save(K.devices, {});
    await Keys.create(to.gk);
  },

  /* What this device owes the groups it has left. Tried on every pass until it
     has gone through; nothing here is urgent and none of it can be lost. */
  async tidy() {
    const k = await Keys.ready();
    const ring = await Keys.ring();
    let changed = false;
    for (const r of ring) {
      if (r.state !== "note" && r.state !== "leave") continue;
      try {
        const at = { k: await Keys.derive(r.gk), base: r.e };
        if (r.state === "note") {
          await this.push(await this.list(at), at, { gk: toB64(k.gk), e: this.base() });
          r.state = "noted";
        } else {
          await this.ask("DELETE", `/sync/${r.group}/${at.k.device.fp}`, undefined, {}, at);
          r.state = "done";
        }
        changed = true;
      } catch {}
    }
    if (changed) await Keys.keepRing(ring);
  },

  async run() {
    if (!this.on() || this.state.busy) return;
    if (!canSync()) { this.state.error = INSECURE; paintSync(); return; }
    this.state.busy = true;
    paintSync();
    let again = false;
    try {
      const k = await Keys.ready();
      if (!k) return;
      Shares.stamp(k.group, this.base());
      const rows = await this.list();
      const { took, moved } = await this.pull(rows);
      if (moved) {
        // Everything already taken from here stays taken; the next pass is in
        // the group this one has become part of.
        await this.move(moved, { note: false });
        again = true;
        return;
      }
      await this.push(rows);
      await this.tidy();
      this.note(k, rows);
      // A share says it is live, so it is republished on the same beat the rest
      // of the state is: at a session boundary, not on every keystroke.
      if (Shares.all().length) await Shares.refresh();
      this.state.devices = rows.length;
      this.state.at = Date.now();
      this.state.error = "";
      // The profile page is a picture of this: the device list, when each was
      // last seen, the shares. Redrawn whether or not anything arrived, because
      // "I pressed it and nothing moved" is the same complaint either way.
      if (took || route().name === "profile") render();
    } catch (e) {
      this.state.error = String(e.message || e);
    } finally {
      this.state.busy = false;
      paintSync();
      if (again) setTimeout(() => this.run(), 0);
    }
  },

  /* The standing filter as another of this person's devices has it. Taken
     whole rather than merged: it is one setting, and two devices disagreeing
     about it should end with the one that spoke last, not with the union of
     what either would rather not see. */
  adoptAlways(next) {
    if (!next || typeof next !== "object") return;
    const mine = favTime(ALWAYS.updated), theirs = favTime(next.updated);
    // Same rule as the name: newer wins, and a device that has never pinned
    // anything takes what arrives rather than standing on an empty set.
    if (theirs < mine) return;
    if (theirs === mine && (alwaysCount() || ALWAYS.updated)) return;
    for (const key of ["tags", "cats", "meta"]) {
      const f = next[key] && typeof next[key] === "object" ? next[key] : {};
      ALWAYS[key] = { any: [...(f.any || [])], all: [...(f.all || [])], not: [...(f.not || [])] };
    }
    ALWAYS.off = !!next.off;
    ALWAYS.updated = next.updated || nowISO();
    save(K.always, ALWAYS);
  },

  /* Links another device has kept. Added, never removed: a device that has not
     synced since somebody stopped keeping one would otherwise put it back, and
     the list is small enough that the cost of an extra one is a fetch. */
  adoptFollows(rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    const held = Followed.all(), byId = new Map(held.map(r => [r.id, r]));
    let added = false;
    for (const r of rows) {
      if (!r || typeof r.id !== "string" || typeof r.key !== "string") continue;
      if (byId.has(r.id) || held.length >= FOLLOW_MAX) continue;
      held.push({ id: r.id, endpoint: r.endpoint, key: r.key,
                  name: r.name || "Someone", added: r.added || nowISO(),
                  fetched: "", favs: [], lists: [], plays: {} });
      byId.set(r.id, true);
      added = true;
    }
    if (added) { Followed.write(held); Followed.refresh().then(() => render()); }
  },

  /* The device list, kept from what the endpoint reports rather than from
     anything a device claims about itself. */
  note(k, rows) {
    const was = load(K.devices, {}) || {}, held = {};
    for (const r of rows) {
      const row = was[r.slot] || {
        name: r.slot === k.device.fp ? "This device" : `Device ${r.slot.slice(0, 4)}`,
      };
      row.seen = r.recv || nowISO();
      held[r.slot] = row;
    }
    save(K.devices, held);
  },

  /* Changes arrive in handfuls -- a playlist reordered is one write per move --
     so the push waits for the flurry to end rather than answering each one. */
  soon() {
    if (!this.on()) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), SYNC_DEBOUNCE);
  },

  /* Making the group: the key, the endpoint's knowledge that it exists, and this
     device's first slot. Either of the two things that need somewhere to publish
     -- linking a second device, or sharing a view of the library -- does this
     first, and a library with one device in its group is a perfectly ordinary
     thing to be. Nothing is kept if it does not finish. */
  async setUp(endpoint, invite) {
    if (!canSync()) throw new Error(INSECURE);
    const held = await Keys.ready();
    if (held) return held;
    save(K.sync, { endpoint: String(endpoint || "").replace(/\/+$/, "") });
    try {
      const k = await Keys.create();
      await this.ask("POST", `/sync/${k.group}`, { auth: toB64(k.enrol) },
        invite ? { "X-Hypnotica-Invite": invite } : {});
      await this.push([]);
      return k;
    } catch (e) {
      await this.forget();
      throw e;
    }
  },

  async forget() {
    save(K.sync, null); save(K.counters, {}); save(K.seen, {});
    await Keys.forget();
    this.state = { busy: false, at: 0, error: "", devices: 0 };
  },
};

/* ------------------------------------------------------------------- qr */
/* A QR encoder, and deliberately not a decoder.

   Scanning would mean a camera permission and an image-processing library, in a
   project that has no third-party JavaScript and no build step. Generating needs
   neither: the code carries a URL, every phone camera opens one of those, and
   the typed link covers a device without a camera. So this draws and nothing
   reads.

   Byte mode at error correction level M, versions 1 to 10, which is a comfortable
   margin over the hundred-odd characters a pairing or share link runs to. */
const QR_ECC_M = 0;                                  // the two bits that say "M"
const QR_BLOCKS = {                                  // [ecc per block, [count, data]...]
  1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]],
  4: [18, [[2, 32]]], 5: [24, [[2, 43]]], 6: [16, [[4, 27]]],
  7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
};
const QR_ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
                   7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

/* GF(256) with the QR primitive polynomial. Reed-Solomon over this field is what
   lets a scanner read a code through a thumbprint. */
const GF_EXP = new Uint8Array(512), GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x; GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
const gfMul = (a, b) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);

function qrGenerator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}
function qrRemainder(data, n) {
  const gen = qrGenerator(n);
  const out = new Array(data.length + n).fill(0);
  for (let i = 0; i < data.length; i++) out[i] = data[i];
  for (let i = 0; i < data.length; i++) {
    const lead = out[i];
    if (!lead) continue;
    for (let j = 0; j < gen.length; j++) out[i + j] ^= gfMul(gen[j], lead);
  }
  return out.slice(data.length);
}

const qrCapacity = v => QR_BLOCKS[v][1].reduce((n, [count, data]) => n + count * data, 0);

function qrVersionFor(bytes) {
  for (let v = 1; v <= 10; v++) {
    const headerBits = 4 + (v < 10 ? 8 : 16);
    if (bytes.length + Math.ceil(headerBits / 8) <= qrCapacity(v)) return v;
  }
  return 0;
}

/* Mode, length, data, terminator, padding -- then split into blocks and
   interleaved, which is what spreads a smudge across every block instead of
   destroying one. */
function qrCodewords(bytes, version) {
  const capacity = qrCapacity(version);
  const bits = [];
  const push = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(4, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  for (let i = 0; i < 4 && bits.length < capacity * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  }
  for (let i = 0; data.length < capacity; i++) data.push(i % 2 ? 0x11 : 0xec);

  const [eccPer, groups] = QR_BLOCKS[version];
  const blocks = [], eccs = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const block = data.slice(at, at + size);
      at += size;
      blocks.push(block);
      eccs.push(qrRemainder(block, eccPer));
    }
  }
  const out = [];
  const widest = Math.max(...blocks.map(b => b.length));
  for (let i = 0; i < widest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < eccPer; i++) for (const e of eccs) out.push(e[i]);
  return out;
}

const QR_MASKS = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (i, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];

function qrFormatBits(mask) {
  const value = (QR_ECC_M << 3) | mask;
  let rest = value << 10;
  for (let i = 14; i >= 10; i--) if (rest & (1 << i)) rest ^= 0x537 << (i - 10);
  return ((value << 10) | rest) ^ 0x5412;
}
function qrVersionBits(version) {
  let rest = version << 12;
  for (let i = 17; i >= 12; i--) if (rest & (1 << i)) rest ^= 0x1f25 << (i - 12);
  return (version << 12) | rest;
}

function qrMatrix(text) {
  const bytes = TE.encode(text);
  const version = qrVersionFor(bytes);
  if (!version) return null;                        // too long for a code worth showing
  const size = 17 + version * 4;
  const cells = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
  const put = (r, c, on) => { if (r >= 0 && c >= 0 && r < size && c < size) cells[r][c] = on ? 1 : 0; };

  const finder = (r, c) => {
    for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) {
      const inside = i >= 0 && i <= 6 && j >= 0 && j <= 6;
      const ring = inside && (i === 0 || i === 6 || j === 0 || j === 6 ||
                              (i >= 2 && i <= 4 && j >= 2 && j <= 4));
      put(r + i, c + j, ring);
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { put(6, i, i % 2 === 0); put(i, 6, i % 2 === 0); }
  for (const r of QR_ALIGN[version]) for (const c of QR_ALIGN[version]) {
    if ((r < 8 && c < 8) || (r < 8 && c > size - 9) || (r > size - 9 && c < 8)) continue;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      put(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) !== 1);
    }
  }
  put(size - 8, 8, true);                            // the one module always dark
  const reserve = (r, c) => { if (cells[r][c] === -1) cells[r][c] = 0; };
  for (let i = 0; i < 9; i++) { reserve(8, i); reserve(i, 8); }
  for (let i = 0; i < 8; i++) { reserve(8, size - 1 - i); reserve(size - 1 - i, 8); }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      reserve(size - 11 + j, i); reserve(i, size - 11 + j);
    }
  }
  const fixed = cells.map(row => Int8Array.from(row, v => (v === -1 ? 0 : 1)));

  const words = qrCodewords(bytes, version);
  const stream = [];
  for (const w of words) for (let i = 7; i >= 0; i--) stream.push((w >> i) & 1);
  let at = 0, upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right--;                        // the vertical timing column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (fixed[row][col]) continue;
        cells[row][col] = at < stream.length ? stream[at++] : 0;
      }
    }
    upward = !upward;
  }

  const penalty = grid => {
    let score = 0, dark = 0;
    const run = line => {
      let n = 1, total = 0;
      for (let i = 1; i < line.length; i++) {
        if (line[i] === line[i - 1]) n++;
        else { if (n >= 5) total += 3 + (n - 5); n = 1; }
      }
      if (n >= 5) total += 3 + (n - 5);
      return total;
    };
    for (let i = 0; i < size; i++) {
      score += run([...grid[i]]);
      score += run(grid.map(r => r[i]));
      for (let j = 0; j < size; j++) dark += grid[i][j];
    }
    for (let i = 0; i < size - 1; i++) for (let j = 0; j < size - 1; j++) {
      const a = grid[i][j];
      if (a === grid[i][j + 1] && a === grid[i + 1][j] && a === grid[i + 1][j + 1]) score += 3;
    }
    const finderish = line => {
      let total = 0;
      const want = [1, 0, 1, 1, 1, 0, 1];
      for (let i = 0; i + 7 <= line.length; i++) {
        if (want.every((v, k) => line[i + k] === v)) {
          const before = line.slice(Math.max(0, i - 4), i);
          const after = line.slice(i + 7, i + 11);
          if (before.length === 4 && before.every(v => v === 0)) total += 40;
          if (after.length === 4 && after.every(v => v === 0)) total += 40;
        }
      }
      return total;
    };
    for (let i = 0; i < size; i++) {
      score += finderish([...grid[i]]) + finderish(grid.map(r => r[i]));
    }
    const part = Math.abs((dark * 100) / (size * size) - 50);
    score += Math.floor(part / 5) * 10;
    return score;
  };

  let best = null, bestMask = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const grid = cells.map((row, i) =>
      Int8Array.from(row, (v, j) => (fixed[i][j] ? v : v ^ (QR_MASKS[mask](i, j) ? 1 : 0))));
    const format = qrFormatBits(mask);
    const setFormat = (r, c, bit) => { grid[r][c] = bit; };
    for (let i = 0; i <= 5; i++) setFormat(8, i, (format >> i) & 1);
    setFormat(8, 7, (format >> 6) & 1);
    setFormat(8, 8, (format >> 7) & 1);
    setFormat(7, 8, (format >> 8) & 1);
    for (let i = 9; i <= 14; i++) setFormat(14 - i, 8, (format >> i) & 1);
    for (let i = 0; i <= 6; i++) setFormat(size - 1 - i, 8, (format >> i) & 1);
    for (let i = 7; i <= 14; i++) setFormat(8, size - 15 + i, (format >> i) & 1);
    grid[size - 8][8] = 1;
    if (version >= 7) {
      const bits = qrVersionBits(version);
      for (let i = 0; i < 18; i++) {
        const bit = (bits >> i) & 1;
        grid[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
        grid[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
      }
    }
    const score = penalty(grid);
    if (score < bestScore) { bestScore = score; bestMask = mask; best = grid; }
  }
  return { size, version, mask: bestMask, cells: best };
}

/* Drawn as one path in an SVG: crisp at any size, no canvas, and it prints. */
function qrSVG(text, label = "") {
  const code = qrMatrix(text);
  if (!code) return "";
  const quiet = 4, span = code.size + quiet * 2;
  let path = "";
  for (let r = 0; r < code.size; r++) for (let c = 0; c < code.size; c++) {
    if (code.cells[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  return `<svg class="qr" viewBox="0 0 ${span} ${span}" role="img"
    aria-label="${esc(label || "Pairing code")}" shape-rendering="crispEdges">
    <rect width="${span}" height="${span}" fill="#fff"/>
    <path d="${path}" fill="#000"/></svg>`;
}

/* -------------------------------------------------------------- profiles */
/* A document published for somebody else to read, and never a window onto the
   group.

   A window could not be un-shared, would keep updating forever, and a link
   pasted into a chat would leak everything added afterwards. So a share is its
   own slot under its own key: revoking is deleting it, rotating is one new key,
   several links can carry different things to different people, and the content
   key that opens the group is handed to nobody, ever. */
const SHARE_SECTIONS = ["favourites", "playlists", "notes", "timeline", "counts",
                        "lately", "progress"];
const SECTION_LABEL = {
  favourites: "Favourites", playlists: "Playlists", notes: "Notes",
  timeline: "When things were played", counts: "How often",
  lately: "Recently played, without times", progress: "What is half-finished",
};
const SHARE_PRESETS = {
  choosing: { label: "Someone choosing for me",
              on: ["favourites", "playlists", "counts", "lately", "progress"] },
  plain: { label: "Just my playlists", on: ["playlists"] },
};

const Me = {
  read() { const v = load(K.me, null); return v && typeof v === "object" ? v : {}; },
  name() { return String(this.read().name || "").slice(0, 80); },
  setName(v) {
    const m = this.read();
    m.name = String(v || "").slice(0, 80);
    m.updated = nowISO();
    save(K.me, m);
    Sync.soon();
  },
  /* One name, not a merge of two. The newer stands, and where neither says when
     -- both from before the times existed -- the same one is chosen on either
     side, so two devices settle rather than swapping names for ever. */
  take(next) {
    if (!next || typeof next !== "object" || typeof next.name !== "string") return false;
    const held = this.read();
    const mine = favTime(held.updated), theirs = favTime(next.updated);
    const win = theirs > mine
      || (theirs === mine && !held.name && !held.updated)
      || (theirs === mine && next.name > (held.name || ""));
    if (!win || next.name === held.name) return false;
    save(K.me, { name: next.name.slice(0, 80), updated: next.updated || nowISO() });
    return true;
  },
};

/* Half-finished, taken at the moment of publishing rather than kept as a record.
   It answers "do not pick something they are part-way through" without positions
   ever becoming a thing that syncs. */
function progressNow() {
  const out = {};
  for (const [id, secs] of Object.entries(load(K.pos, {}) || {})) {
    const it = BY_ID.get(id);
    if (!it || !it.duration || !(secs > 60)) continue;
    const part = secs / it.duration;
    if (part > 0.02 && part < 0.95) out[id] = Math.round(part * 100) / 100;
  }
  return out;
}

function profileDoc(sections) {
  const on = new Set(sections || []);
  const out = { hypnotica: TRANSFER, published: nowISO(),
                profile: { name: Me.name() || "Someone", note: "" } };
  const seen = new Set();
  if (on.has("favourites")) {
    out.favourites = Favourites.plain();
    for (const id of Object.keys(out.favourites.items)) seen.add(id);
  }
  if (on.has("playlists")) {
    out.playlists = Playlists.all().map(p => ({
      id: p.id, name: p.name, items: [...p.items],
      created: p.created ? new Date(p.created).toISOString() : "",
      updated: p.updated ? new Date(p.updated).toISOString() : "",
    }));
    for (const p of out.playlists) for (const id of p.items) seen.add(id);
  }
  if (on.has("notes")) {
    out.notes = Notes.plain(false);            // private stays private, always
    for (const id of Object.keys(out.notes)) seen.add(id);
  }
  const wantsHistory = on.has("timeline") || on.has("counts") || on.has("lately");
  if (wantsHistory) {
    const h = History.plain();
    out.history = { recent: [], plays: {} };
    if (on.has("timeline")) out.history.recent = h.recent;
    else if (on.has("lately")) {
      // The same events with the clock taken off: what, lately, and in what
      // order, without saying that it was four in the morning.
      out.history.recent = h.recent.slice(-80).map(e => ({ i: e.i, t: "", s: 0, c: e.c, d: "" }));
    }
    if (on.has("counts")) out.history.plays = h.plays;
    for (const e of out.history.recent) seen.add(e.i);
    for (const id of Object.keys(out.history.plays)) seen.add(id);
  }
  if (on.has("progress")) {
    out.progress = progressNow();
    for (const id of Object.keys(out.progress)) seen.add(id);
  }
  // Ids alone render as nothing on a library that lacks them, which is the
  // library most readers of a share are using.
  const titles = {};
  for (const id of seen) { const n = Names.of(id); if (n) titles[id] = n; }
  out.titles = titles;
  out.names = titles;
  return out;
}

const Shares = {
  all() { const v = load(K.shares, null); return Array.isArray(v) ? v : []; },
  write(rows) { save(K.shares, rows); Sync.soon(); },
  get(id) { return this.all().find(r => r.id === id); },

  async create(label, sections) {
    const sk = randomBytes(32);
    const id = idFrom(await hkdf(sk, "hypnotica/profile-id", 16));
    const k = await Keys.ready();
    const row = { id, key: toB64u(sk), label: String(label || "Shared").slice(0, 80),
                  sections: [...sections], created: nowISO(),
                  group: k?.group || "", endpoint: Sync.base() };
    const rows = this.all(); rows.push(row); this.write(rows);
    await this.publish(row, true);
    return row;
  },

  /* Republished only when what it says has changed.

     Every sync used to write every share again, which is a write per share per
     device per sync -- and a window in which a device that has not yet heard
     about a revocation puts the slot back. */
  async publish(row, force = false) {
    const at = await this.at(row);
    const k = at.k;
    const doc = profileDoc(row.sections);
    const mark = markOf(JSON.stringify({ ...doc, published: "" }));
    if (!force && row.mark === mark) return false;
    const sk = fromB64u(row.key);
    const content = await hkdf(sk, "hypnotica/profile-content");
    const read = await hkdf(sk, "hypnotica/profile-read");
    /* Time, not a tally. A device slot is written by one device and a count of
       its own writes is enough; a share can be republished from any device in
       the group, and two tallies kept separately both start at one. A clock in
       milliseconds is monotonic where it matters and needs nothing shared. */
    const counter = Math.max(Date.now(), Sync.counter(row.id) + 1);
    const { n, ct } = await seal(content, JSON.stringify(doc));
    const env = { v: ENVELOPE, slot: k.device.fp, key: toB64(k.device.spki), counter,
                  written: nowISO(), n, ct,
                  sig: await signEnvelope(k.device, row.id, counter, fromB64(ct)) };
    await Sync.ask("PUT", `/profile/${row.id}`, { read: toB64(read), env },
      { "X-Hypnotica-Group": k.group }, at);
    Sync.bump(row.id, counter);
    row.published = nowISO();
    row.mark = mark;
    this.write(this.all().map(r => (r.id === row.id ? row : r)));
    return true;
  },

  /* A revoke that fails quietly is worse than one that fails: somebody is then
     told the link is dead and goes on believing it. The row is kept where the
     endpoint would not take it back, so it can be tried again. */
  async revoke(id) {
    if (await Keys.ready()) {
      const at = await this.at(this.get(id) || { id });
      await Sync.ask("DELETE", `/profile/${id}`, undefined,
        { "X-Hypnotica-Group": at.k.group }, at);
    }
    this.write(this.all().filter(r => r.id !== id));
    // Remembered as revoked. Without this the next device to sync still holds
    // the row, republishes it on its own next pass, and the link somebody was
    // told had stopped working starts working again.
    const gone = this.gone(); gone[id] = nowISO(); this.writeGone(gone);
  },

  gone() {
    const v = load(K.sharesGone, null);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  },
  writeGone(gone) {
    const cut = Date.now() - TOMB_DAYS * DAY;
    for (const [id, t] of Object.entries(gone)) if (favTime(t) && favTime(t) < cut) delete gone[id];
    save(K.sharesGone, gone);
  },

  /* Shares another of this person's devices published. Taken whole -- a share is
     a key and a list of sections, not something two devices edit at once -- and
     one revoked anywhere stays revoked. */
  take(rows, removed) {
    const held = this.all(), byId = new Map(held.map(r => [r.id, r]));
    const gone = this.gone();
    /* A revocation this device is hearing about for the first time. Whoever
       hears of it takes the slot down, because the device that revoked it may
       have done so while another was midway through putting it back: without
       this, a link somebody was told was dead is alive again. */
    const fresh = [];
    for (const [id, when] of Object.entries(removed || {})) {
      if (!gone[id]) fresh.push(id);
      if (!gone[id] || favTime(gone[id]) < favTime(when)) gone[id] = when;
    }
    for (const id of fresh) {
      const row = byId.get(id) || (rows || []).find(r => r?.id === id) || { id };
      Keys.ready().then(k => k && this.at(row)).then(at => at && Sync.ask("DELETE",
        `/profile/${id}`, undefined, { "X-Hypnotica-Group": at.k.group }, at)).catch(() => {});
    }
    let n = 0;
    for (const row of rows || []) {
      if (!row || typeof row.id !== "string" || typeof row.key !== "string") continue;
      if (favTime(gone[row.id]) > favTime(row.created)) continue;
      const was = byId.get(row.id);
      if (was && favTime(was.published || was.created) >= favTime(row.published || row.created)) continue;
      if (was) Object.assign(was, row); else { held.push(row); byId.set(row.id, row); }
      n++;
    }
    this.writeGone(gone);
    this.write(held.filter(r => !(favTime(gone[r.id]) > favTime(r.created))));
    return n;
  },

  /* A new key and a new address. The old link stops opening anything the moment
     the old slot goes, which is what somebody pressing this wants. */
  async rotate(id) {
    const row = this.get(id);
    if (!row) return null;
    await this.revoke(id);
    return this.create(row.label, row.sections);
  },

  /* Republished when what it exposes has changed underneath it. */
  async refresh() {
    const gone = this.gone();
    for (const row of this.all()) {
      if (favTime(gone[row.id])) continue;
      await this.publish(row).catch(() => {});
    }
  },

  /* Where a share lives and who may change it. The endpoint keeps the group
     that first published it and takes changes from that group alone; after two
     groups have become one, a share made in the other is spoken for with the
     key the ring kept for it, at the address it was published to. */
  async at(row) {
    const k = await Keys.ready();
    if (!k) throw new Error("link a device first — a share needs somewhere to live");
    if (!row.group || row.group === k.group) return { k, base: row.endpoint || Sync.base() };
    const old = await Keys.fromRing(row.group);
    if (!old) throw new Error("this share was published by a group this device holds no key for");
    return { k: old.k, base: row.endpoint || old.base };
  },

  /* A share from before shares said who made them was made by the group it is
     in now: there was only ever one. Said once, while that is still true -- the
     moment before a move, and on every pass besides. */
  stamp(group, base) {
    const rows = this.all();
    let changed = false;
    for (const r of rows) {
      if (r.group) continue;
      r.group = group;
      r.endpoint ||= base;
      changed = true;
    }
    if (changed) save(K.shares, rows);
  },

  // The address it was published to, which after a merge is not always the
  // address this library now syncs through.
  link(row) {
    const here = location.origin + location.pathname;
    return `${here}#/p?e=${encodeURIComponent(row.endpoint || Sync.base())}&k=${row.key}`;
  },
};

/* People whose shares are kept.

   A share link is read once and then usually lost. Keeping one means the library
   can say, on the recording itself, that somebody you know has liked it, has it
   in a list, or played it last March -- which is most of what the link was for.

   What is kept is what the annotations need and nothing else: the ids, the list
   names, the counts. The timeline, the notes and the titles are dropped on the
   way in, because a dozen whole profiles do not fit anywhere sensible and none
   of it is needed to answer "has Naomi heard this". */
const FOLLOW_MAX = 12;
let FOLLOW_INDEX = null;

const Followed = {
  all() { const v = load(K.follows, null); return Array.isArray(v) ? v : []; },
  write(rows) { FOLLOW_INDEX = null; save(K.follows, rows); Sync.soon(); },
  get(id) { return this.all().find(r => r.id === id); },
  has(id) { return !!this.get(id); },

  trim(got, endpoint, key) {
    const d = got.doc, plays = {};
    for (const [id, row] of Object.entries(d.history?.plays || {})) {
      let n = 0;
      for (const c of Object.values(row.c || {})) n += Number(c?.n) || 0;
      if (n) plays[id] = { n, last: row.l || "" };
    }
    return {
      id: got.id, endpoint, key,
      name: d.profile?.name || "Someone",
      fetched: nowISO(),
      favs: Object.keys(d.favourites?.items || {}),
      // A share carries both kinds of favourite and a creator is as worth
      // knowing about as a recording: "Naomi likes everything this one makes"
      // is the sort of thing somebody follows a profile to find out.
      authorFavs: Object.keys(d.favourites?.authors || {}),
      lists: (d.playlists || []).map(p => ({ name: p.name || "Playlist",
                                             items: [...(p.items || [])] })),
      plays,
    };
  },

  async add(endpoint, key) {
    const got = await fetchProfile(endpoint, key);
    const rows = this.all();
    if (!rows.some(r => r.id === got.id) && rows.length >= FOLLOW_MAX) {
      throw new Error(`That is as many profiles as this keeps (${FOLLOW_MAX}).`);
    }
    const row = this.trim(got, endpoint, key);
    const held = rows.find(r => r.id === got.id);
    row.added = held?.added || nowISO();
    this.write([...rows.filter(r => r.id !== got.id), row]);
    return row;
  },

  remove(id) { this.write(this.all().filter(r => r.id !== id)); },

  /* Asked again, quietly, whenever the library opens. A link that has been
     revoked says so and stops being believed rather than going on asserting
     what somebody liked a month ago. */
  async refresh() {
    const rows = this.all();
    if (!rows.length) return 0;
    let moved = 0;
    for (let i = 0; i < rows.length; i++) {
      try {
        const got = await fetchProfile(rows[i].endpoint, rows[i].key);
        rows[i] = { ...this.trim(got, rows[i].endpoint, rows[i].key), added: rows[i].added };
        moved++;
      } catch (e) {
        rows[i] = { ...rows[i], gone: e.message || "that link did not open" };
      }
    }
    this.write(rows);
    return moved;
  },
};

/* Sets rather than arrays, because the alternative is a linear scan per card
   per person per redraw. Rebuilt whenever the list behind it is written. */
function followIndex() {
  if (FOLLOW_INDEX) return FOLLOW_INDEX;
  FOLLOW_INDEX = Followed.all().filter(r => !r.gone).map(r => ({
    id: r.id, name: r.name,
    favs: new Set(r.favs || []),
    authorFavs: new Set(r.authorFavs || []),
    lists: (r.lists || []).map(l => ({ name: l.name, items: new Set(l.items || []) })),
    plays: r.plays || {},
  }));
  return FOLLOW_INDEX;
}

/* What the people somebody follows have to say about one recording. */
function followedFacts(id) {
  const liked = [], listed = [], played = [];
  for (const r of followIndex()) {
    if (r.favs.has(id)) liked.push(r.name);
    for (const l of r.lists) if (l.items.has(id)) listed.push({ list: l.name, who: r.name });
    const p = r.plays[id];
    if (p) played.push({ who: r.name, n: p.n, last: p.last });
  }
  played.sort((a, b) => (b.last || "").localeCompare(a.last || ""));
  return { liked, listed, played };
}

/* The same question about a creator, which has one answer rather than three. */
function followedAuthorLikes(id) {
  return followIndex().filter(r => r.authorFavs.has(id)).map(r => r.name);
}

/* Shortened rather than wrapped: a card is a fixed thing in a grid, and three
   names written out push everything under it down a line. */
const few = names => (names.length > 2 ? `${names[0]} +${names.length - 1}` : andList(names));

/* Which of somebody's own lists each recording is in.

   Built once and kept until a playlist changes: a card asks this, and a grid
   draws sixty of them at a time out of a blob that has to be parsed to answer. */
let LIST_INDEX = null;
function listIndex() {
  if (LIST_INDEX) return LIST_INDEX;
  LIST_INDEX = new Map();
  for (const p of Playlists.all()) {
    for (const id of p.items || []) {
      const at = LIST_INDEX.get(id);
      if (at) at.push(p.name); else LIST_INDEX.set(id, [p.name]);
    }
  }
  return LIST_INDEX;
}

/* "Naomi, Sam and Kit" rather than "Naomi, Sam, Kit". */
function andList(names) {
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/* Reading somebody else's. The key in the link is the whole capability: it
   derives the address, the MAC that opens it, and the key that decrypts it. */
async function fetchProfile(endpoint, keyText) {
  const sk = fromB64u(keyText);
  if (sk.length < 16) throw new Error("that link is not a share");
  const id = idFrom(await hkdf(sk, "hypnotica/profile-id", 16));
  const path = `/profile/${id}`;
  const base = String(endpoint || Sync.base() || "").replace(/\/+$/, "");
  const read = await hkdf(sk, "hypnotica/profile-read");
  const r = await fetch(base + path, {
    method: "GET", cache: "no-store",
    headers: { "X-Hypnotica-Read": await macOver(read, "GET", path, new Uint8Array(0)) },
  });
  if (!r.ok) {
    if (r.status === 404) throw new Error("that share is not there any more");
    throw new Error("that link did not open");
  }
  const env = await r.json();
  const content = await hkdf(sk, "hypnotica/profile-content");
  const text = await openEnvelope(content, id, env);
  const doc = JSON.parse(text);
  if (Number(doc.hypnotica ?? TRANSFER) > TRANSFER) {
    throw new Error("that share came from a newer Hypnotica");
  }
  return { id, doc, recv: env.recv };
}

/* --------------------------------------------------------------- pairing */
/* Linking a second device, and the only moment the group key moves.

   The code does not carry the key. It carries a pairing id and a pairing key,
   good for five minutes and one use, and the group key travels sealed to a
   public key the joining device makes on the spot. So a photograph of an old
   code, a screen share, or a shoulder is worth nothing afterwards.

   Both screens then show the same six digits, derived from both public keys. An
   endpoint that swapped one of them for its own would produce different digits
   on the two screens, and the person comparing them is the check that no amount
   of server-side good behaviour could replace. */
const toB64u = b => toB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = t => fromB64(String(t || "").replace(/-/g, "+").replace(/_/g, "/"));

async function ecdh() {
  const pair = await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
  return { priv: pair.privateKey, pub };
}
async function ecdhSecret(priv, theirPub) {
  const pub = await subtle().importKey("raw", theirPub,
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await subtle().deriveBits({ name: "ECDH", public: pub }, priv, 256);
  return hkdf(new Uint8Array(bits), "hypnotica/pair");
}
async function sasDigits(id, a, b) {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a); joined.set(b, a.length);
  const sum = await sha256(TE.encode("hypnotica/sas/1\n" + id + "\n" + toB64(joined)));
  const n = ((sum[0] << 16) | (sum[1] << 8) | sum[2]) % 1000000;
  return String(n).padStart(6, "0");
}

/* Pairing is a conversation through the endpoint that both devices confirm.

   Each side shows six digits derived from both public keys, and each side's
   person says they match before that side hands anything over. Both hand over
   the group they are in, if they are in one, sealed to the other's key -- so
   linking a device that is already linked elsewhere does not strand the devices
   it was linked to. Two groups become one: the one whose id sorts first, which
   both ends work out alike without being told, and which does not care who
   offered. The device leaving writes a note in the group it left, and every
   device still there follows it (Sync.forwarding).

   The record, as it fills:
     a: { pub }                       offered
     b: { pub }                       answered; both screens now show digits
     b: { pub, ok, n?, ct? }          the joining side's person confirmed
     a: { pub, n, ct, got? }          the offering side's person confirmed;
                                      `got` once it has read b's answer
   The joining side takes the key only once `got` is there, and then removes the
   record, so neither side can be left without what the other handed over. */
const Pair = {
  /* Device A. The first press is also the setup: it makes the group key, tells
     the endpoint the group exists, puts this device's state up, and only then
     offers a code. */
  async offer(endpoint, invite) {
    const k = await Sync.setUp(endpoint, invite);
    const key = randomBytes(32);
    const id = idFrom(await sha256(key));
    const me = await ecdh();
    const base = Sync.base();
    await Sync.ask("POST", `/sync/${k.group}/pair`, { id, key: toB64(key) });
    await this.post(base, id, key, { a: { pub: toB64(me.pub) } });
    return { id, key, me, base, link: this.link(base, id, key) };
  },

  link(base, id, key) {
    const here = location.origin + location.pathname;
    return `${here}#/link?e=${encodeURIComponent(base)}&p=${id}&k=${toB64u(key)}`;
  },

  /* The pairing key authenticates both halves of the conversation. It is not
     what keeps the group key secret -- that is the sealing -- it is what stops
     anybody who learns an id from filling the record with noise. */
  async post(base, id, key, payload, method = "POST") {
    const raw = payload === undefined ? new Uint8Array(0) : TE.encode(JSON.stringify(payload));
    const path = `/pair/${id}`;
    const headers = { "X-Hypnotica-Pair": await macOver(key, method, path, raw) };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(base + path, {
      method, headers, cache: "no-store",
      body: payload === undefined ? undefined : raw,
    });
    if (!r.ok) {
      let why = `${r.status}`;
      try { why = (await r.json()).error || why; } catch {}
      const e = new Error(why); e.status = r.status; throw e;
    }
    return r.status === 204 ? null : r.json();
  },

  async read(base, id, key) { return this.post(base, id, key, undefined, "GET"); },

  /* What this side hands over: its group, sealed to the other's key, and where
     that group lives. Nothing at all from a device in no group. */
  async sealGroup(myPriv, theirPub) {
    const k = await Keys.ready();
    if (!k) return {};
    const shared = await ecdhSecret(myPriv, theirPub);
    return seal(shared, JSON.stringify({ gk: toB64(k.gk), e: Sync.base() }));
  },

  async openGroup(myPriv, theirPub, half, base) {
    const shared = await ecdhSecret(myPriv, theirPub);
    const text = await unseal(shared, half.n, half.ct);
    let got;
    // A key on its own is what an older copy of this page hands over.
    try { got = JSON.parse(text); } catch { got = { gk: text, e: base }; }
    const gk = fromB64(String(got?.gk || ""));
    const e = String(got?.e || base).replace(/\/+$/, "");
    if (gk.length !== 32 || !/^https?:\/\//.test(e)) throw new Error("what the other device sent is not a key");
    return { gk, e };
  },

  /* Device A, once its person has said the digits match: seal the group key to
     the public key the other device offered, and post it. */
  async hand(offer, got = false) {
    const half = await this.sealGroup(offer.me.priv, offer.theirs);
    await this.post(offer.base, offer.id, offer.key,
      { a: { pub: toB64(offer.me.pub), ...half, ...(got ? { got: true } : {}) } }, "PUT");
  },

  /* Device A, after handing over: waits for the other side's person to confirm
     too, then says it has read the answer. What comes back is the other group,
     or null from a device that was in none. */
  async answer(offer, live) {
    for (let n = 0; n < 150 && live(); n++) {
      const seen = await this.read(offer.base, offer.id, offer.key).catch(() => null);
      const b = seen?.b;
      if (b?.ok) {
        if (b.pub !== toB64(offer.theirs)) throw new Error("the other device changed its key partway through");
        const other = b.ct ? await this.openGroup(offer.me.priv, offer.theirs, b, offer.base) : null;
        await this.hand(offer, true);
        return other;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error("the other device did not confirm in time");
  },

  /* Device B. Announces itself and works out the digits; hands nothing over. */
  async announce(link) {
    if (!canSync()) throw new Error(INSECURE);
    const me = await ecdh();
    const first = await this.read(link.endpoint, link.id, link.key);
    const theirPub = first?.a?.pub ? fromB64(first.a.pub) : null;
    if (!theirPub) throw new Error("that code is not offering anything");
    await this.post(link.endpoint, link.id, link.key, { b: { pub: toB64(me.pub) } });
    link.me = me;
    link.theirs = theirPub;
    return sasDigits(link.id, theirPub, me.pub);
  },

  /* Device B, once its person has said the digits match. */
  async accept(link) {
    const half = await this.sealGroup(link.me.priv, link.theirs);
    await this.post(link.endpoint, link.id, link.key,
      { b: { pub: toB64(link.me.pub), ok: true, ...half } }, "PUT");
    for (let n = 0; n < 150; n++) {
      const seen = await this.read(link.endpoint, link.id, link.key).catch(() => null);
      const a = seen?.a;
      if (a?.ct && a.got) {
        if (a.pub !== toB64(link.theirs)) throw new Error("the other device changed its key partway through");
        const other = await this.openGroup(link.me.priv, link.theirs, a, link.endpoint);
        await this.post(link.endpoint, link.id, link.key, undefined, "DELETE").catch(() => {});
        const how = await this.settle(other);
        await Sync.run();
        return how;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error("nobody confirmed it in time");
  },

  /* Both ends, once each holds what the other handed over. The same rule on
     both sides, so they agree without a further word: the group whose id sorts
     first is the one both are in afterwards. */
  async settle(other) {
    if (!other) return "linked";                      // they were in no group; they are in ours
    const mine = await Keys.ready();
    if (!mine) {
      save(K.sync, { endpoint: other.e });
      await Keys.create(other.gk);
      return "joined";
    }
    const group = await groupOf(other.gk);
    if (group === mine.group) return "same";
    if (group < mine.group) {
      await Sync.move({ gk: other.gk, e: other.e }, { note: true });
      return "merged";
    }
    // This group stays. Keeping the other's key means its shares can be spoken
    // for from here straight away rather than once its devices have arrived.
    await Keys.retire(other.gk, other.e, "done");
    return "merged";
  },
};

/* -------------------------------------------------------------- key store */
/* The group key lives in IndexedDB rather than localStorage, and the device's
   signing key never leaves it at all: generated non-extractable, so injected
   script can sign with it but cannot lift it. The group key has to be
   extractable, because pairing exists to hand it on. */
const KEYDB = "hypnotica-keys";

function keyDB() {
  return new Promise((yes, no) => {
    if (!globalThis.indexedDB) return no(new Error("no storage for keys"));
    const req = indexedDB.open(KEYDB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("k")) req.result.createObjectStore("k", { keyPath: "id" });
    };
    req.onsuccess = () => yes(req.result);
    req.onerror = () => no(req.error);
  });
}
function keyOp(mode, run) {
  return keyDB().then(db => new Promise((yes, no) => {
    const tx = db.transaction("k", mode);
    const req = run(tx.objectStore("k"));
    req.onsuccess = () => yes(req.result);
    req.onerror = () => no(req.error);
  }));
}

const Keys = {
  held: null,

  /* Derived once and kept in memory: the group id names the folder, the content
     key opens the blobs, and the enrolment key is the only one the server sees. */
  async adopt(gk) {
    this.held = await this.derive(gk);
    return this.held;
  },

  async derive(gk) {
    return {
      gk,
      group: await groupOf(gk),
      content: await hkdf(gk, "hypnotica/content"),
      enrol: await hkdf(gk, "hypnotica/enrol"),
      device: await this.device(),
    };
  },

  async ready() {
    if (this.held) return this.held;
    const row = await keyOp("readonly", st => st.get("group")).catch(() => null);
    if (!row || !row.gk) return null;
    return this.adopt(new Uint8Array(row.gk));
  },

  async create(gk = randomBytes(32)) {
    await keyOp("readwrite", st => st.put({ id: "group", gk }));
    return this.adopt(gk);
  },

  /* One keypair per browser, made once. A public key is always exportable; the
     private half is asked for non-extractable, and where the store will not hold
     a live key at all it falls back to one it can write, which is weaker and
     said so in the only place it matters -- here. */
  async device() {
    const row = await keyOp("readonly", st => st.get("device")).catch(() => null);
    if (row && row.priv) {
      return { priv: row.priv, spki: new Uint8Array(row.spki), fp: row.fp };
    }
    if (row && row.jwk) {
      const priv = await subtle().importKey("jwk", row.jwk,
        { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
      return { priv, spki: new Uint8Array(row.spki), fp: row.fp };
    }
    const pair = await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" },
      false, ["sign", "verify"]);
    const spki = new Uint8Array(await subtle().exportKey("spki", pair.publicKey));
    const fp = idFrom(await sha256(spki));
    try {
      await keyOp("readwrite", st => st.put({ id: "device", priv: pair.privateKey, spki, fp }));
      return { priv: pair.privateKey, spki, fp };
    } catch {
      const soft = await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" },
        true, ["sign", "verify"]);
      const spki2 = new Uint8Array(await subtle().exportKey("spki", soft.publicKey));
      const jwk = await subtle().exportKey("jwk", soft.privateKey);
      const fp2 = idFrom(await sha256(spki2));
      await keyOp("readwrite", st => st.put({ id: "device", jwk, spki: spki2, fp: fp2 }));
      return { priv: soft.privateKey, spki: spki2, fp: fp2 };
    }
  },

  async forget() {
    this.held = null;
    await keyOp("readwrite", st => st.delete("group")).catch(() => {});
    await keyOp("readwrite", st => st.delete("ring")).catch(() => {});
  },

  /* Groups this library used to be, kept after two of them became one.

     The endpoint remembers which group published each share and takes a change
     to it from no other, so a share made before a merge can be republished,
     rotated or revoked only by whoever still holds the key it was made under.
     The ring holds those keys, and travels between devices with everything else
     -- a share is the library's, and so is being able to take it down.

     `state` is this device's own business with that group: "note" while the
     forwarding note it owes is unwritten, "noted" once written, "leave" while
     its own old slot is still to be cleared, and "done". */
  async ring() {
    const row = await keyOp("readonly", st => st.get("ring")).catch(() => null);
    return Array.isArray(row?.rows) ? row.rows.map(r => ({ ...r, gk: new Uint8Array(r.gk) })) : [];
  },

  async keepRing(rows) {
    await keyOp("readwrite", st => st.put({ id: "ring", rows: rows.slice(-RING_MAX) }));
  },

  async retire(gk, e, state) {
    const group = await groupOf(gk);
    const rows = (await this.ring()).filter(r => r.group !== group);
    rows.push({ gk, group, e: String(e || "").replace(/\/+$/, ""), state });
    await this.keepRing(rows);
  },

  /* Keys another device had retired. Taken for their shares; nothing is owed
     to a group this device was never in, so they arrive done. */
  async takeRing(rows) {
    if (!Array.isArray(rows) || !rows.length) return;
    const held = await this.ring(), have = new Set(held.map(r => r.group));
    const current = this.held?.group;
    let added = false;
    for (const r of rows) {
      let gk;
      try { gk = fromB64(String(r?.gk || "")); } catch { continue; }
      if (gk.length !== 32 || !/^https?:\/\//.test(String(r.e || ""))) continue;
      const group = await groupOf(gk);
      if (have.has(group) || group === current) continue;
      held.push({ gk, group, e: String(r.e).replace(/\/+$/, ""), state: "done" });
      have.add(group); added = true;
    }
    if (added) await this.keepRing(held);
  },

  async ringOut(except) {
    return (await this.ring()).filter(r => r.group !== except)
      .map(r => ({ gk: toB64(r.gk), e: r.e }));
  },

  /* Somewhere to speak as a retired group: its keys, and where it lives. */
  async fromRing(group) {
    const row = (await this.ring()).find(r => r.group === group);
    return row ? { k: await this.derive(row.gk), base: row.e } : null;
  },
};

const RING_MAX = 32;
const groupOf = async gk => idFrom(await hkdf(gk, "hypnotica/group-id", 16));

/* ------------------------------------------------------------------ player */
const Player = {
  el: null, queue: [], index: -1, ready: false,
  seekTo: 0, metaFor: null, wantPlay: false, misses: 0,

  init() {
    this.el = new Audio();
    this.el.preload = "metadata";
    this.el.playbackRate = load(K.rate, 1);
    const st = load(K.queue, null);
    if (st && Array.isArray(st.queue)) { this.queue = st.queue; this.index = st.index ?? -1; }

    this.el.addEventListener("timeupdate", () => {
      this.paint(); this.remember();
      if (!this.el.paused) Listen.tick(this.current(), this.el.currentTime);
    });
    this.el.addEventListener("durationchange", () => this.onMeta());
    this.el.addEventListener("loadedmetadata", () => this.onMeta());
    this.el.addEventListener("ended", () => { Listen.finished(); this.next(true); });
    this.el.addEventListener("play", () => { this.paint(); updateMediaSession(); });
    this.el.addEventListener("pause", () => this.paint());
    this.el.addEventListener("error", () => this.onError());
    if (this.index >= 0) this.load(this.index, false);
  },

  /* The catalogue arrives after the player starts, so a queue restored from a
     previous visit can name tracks nothing knows about yet. `init` finds them
     missing and primes no source; the bar then shows the right title -- `paint`
     resolves it as soon as the page lands -- while the play button does
     nothing, which is the worst of both. Called whenever what is known changes. */
  adopt() {
    if (!this.el || this.ready || this.index < 0) return;
    this.load(this.index, false);
  },

  /* A queue entry can go stale - the id may be gone after a rebuild, or the item
     may carry no audio. Never let one of those swallow the rest of the queue. */
  at(i) { const it = BY_ID.get(this.queue[i]); return it && it.audio ? it : null; },
  pick(from, dir) {
    for (let i = from; i >= 0 && i < this.queue.length; i += dir) if (this.at(i)) return i;
    return -1;
  },
  playable() { return this.pick(0, 1) >= 0; },

  current() { return BY_ID.get(this.queue[this.index]); },
  persist() { save(K.queue, { queue: this.queue, index: this.index }); },
  remember() {
    const it = this.current();
    if (!it || !this.el.duration) return;
    if (this.metaFor !== it.id) return;      // metadata still belongs to the last track
    if (Math.floor(this.el.currentTime) % 5) return;
    const p = load(K.pos, {});
    p[it.id] = this.el.currentTime > this.el.duration - 15 ? 0 : this.el.currentTime;
    save(K.pos, p);
  },

  /* Resume is applied here, not straight after setting src: a seek before the
     metadata lands is dropped by some browsers and stalls playback in others. */
  onMeta() {
    const d = this.el.duration;
    if (!(d > 0) || !isFinite(d)) { this.paint(); return; }
    const it = this.current();
    if (it) this.metaFor = it.id;
    this.misses = 0;
    const t = this.seekTo; this.seekTo = 0;
    // Same 15s tail that remember() treats as "finished", so the two agree and an
    // auto-advanced track never opens a few seconds from its own end.
    if (t > 5 && t < d - 15) { try { this.el.currentTime = t; } catch {} }
    this.paint();
  },

  onError() {
    if (!this.el.src) return;                // element emptied on purpose
    const it = this.current();
    if (it) toast(`Cannot play "${it.title}"` +
      (navigator.onLine ? "" : " - not saved offline"));
    if (!this.wantPlay) { this.paint(); return; }
    // Step over the broken file instead of stalling, but give up once the whole
    // remainder of the queue has failed.
    if (++this.misses > this.queue.length) return this.halt("Nothing left in the queue would play");
    const j = this.pick(this.index + 1, 1);
    if (j < 0) return this.halt();
    setTimeout(() => this.load(j, true), 0);  // not from inside the error event
  },
  halt(msg) { this.wantPlay = false; this.el.pause(); this.paint(); if (msg) toast(msg); },

  start() {
    this.wantPlay = true;
    const src = this.el.src;
    const p = this.el.play();
    if (!p || !p.catch) return;
    p.catch(err => {
      if (this.el.src !== src) return;       // superseded by a later track
      if (err && err.name === "AbortError") return;
      this.wantPlay = false; this.paint();
      toast("Playback was blocked - press play to carry on");
    });
  },

  load(i, autoplay = true, dir = 1) {
    const j = this.pick(i, dir);
    if (j < 0) return false;
    // Close the sitting before the track changes: after it, `current` is the new
    // one and the seconds just heard would be filed against the wrong item.
    Listen.close();
    this.index = j; this.persist();
    const it = this.at(j);
    this.metaFor = null;
    this.seekTo = (load(K.pos, {})[it.id]) || 0;
    this.el.src = it.audio;
    if (autoplay) this.start(); else this.wantPlay = false;
    this.ready = true;
    document.body.classList.add("has-player");
    render(); updateMediaSession();
    return true;
  },

  play(ids, start = 0) {
    this.queue = (Array.isArray(ids) ? ids : [ids]).filter(x => BY_ID.get(x)?.audio);
    this.misses = 0;
    if (!this.queue.length || !this.load(start, true)) return toast("Nothing playable here");
  },
  enqueue(ids) {
    const add = (Array.isArray(ids) ? ids : [ids]).filter(x => BY_ID.get(x)?.audio);
    if (!add.length) return;
    const fresh = !this.playable();
    this.queue.push(...add); this.persist();
    if (fresh) { this.misses = 0; this.load(0, true); return; }
    if (route().name === "queue") render(); else this.paint();
    toast(`Added ${add.length} to queue`);
  },
  playNext(id) {
    if (!BY_ID.get(id)?.audio) return toast("Nothing playable here");
    if (!this.playable()) return this.play([id]);
    this.queue.splice(this.index + 1, 0, id); this.persist(); render();
    toast("Playing next");
  },
  removeAt(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    else if (i === this.index) {
      const on = !this.el.paused;
      if (!this.load(i, on, 1) && !this.load(this.queue.length - 1, on, -1)) {
        this.stop(); this.index = -1;
      }
    }
    this.persist(); render();
  },
  moveAt(i, d) {
    const j = i + d;
    if (j < 0 || j >= this.queue.length) return;
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    if (this.index === i) this.index = j; else if (this.index === j) this.index = i;
    this.persist(); render();
  },
  clear() { this.stop(); this.queue = []; this.index = -1; this.persist(); render(); },
  stop() { this.wantPlay = false; this.metaFor = null; this.el.pause();
           this.el.removeAttribute("src"); try { this.el.load(); } catch {}
           this.ready = false; document.body.classList.remove("has-player"); },

  toggle() { if (this.el.paused) this.start(); else { this.wantPlay = false; this.el.pause(); } },
  next(auto = false) {
    if (this.load(this.index + 1, true)) return;
    if (auto) { this.wantPlay = false; this.el.pause(); this.paint(); }
    else toast("End of queue");
  },
  prev() {
    if (this.el.currentTime > 4) { this.el.currentTime = 0; return; }
    this.load(this.index - 1, true, -1);
  },
  seek(frac) { if (this.el.duration) this.el.currentTime = frac * this.el.duration; },
  nudge(sec) { this.el.currentTime = Math.max(0, this.el.currentTime + sec); },
  setRate(r) { this.el.playbackRate = r; save(K.rate, r); this.paint(); },

  paint() {
    const box = $("#player"); if (!box) return;
    const it = this.current();
    box.classList.toggle("hidden", !it);
    if (!it) { document.body.classList.remove("has-player"); return; }
    document.body.classList.add("has-player");
    $("#pTitle").textContent = it.title;
    const a = DATA.authors.find(x => x.id === it.author);
    $("#pSub").textContent = [a?.name, this.queue.length > 1
      ? `${this.index + 1} of ${this.queue.length}` : ""].filter(Boolean).join(" · ");
    const art = $("#pArt");
    if (it.cover) { art.src = it.cover; art.classList.remove("hidden"); }
    else art.classList.add("hidden");
    $("#pPlay").textContent = this.el.paused ? "▶" : "❚❚";
    $("#pPlay").setAttribute("aria-label", this.el.paused ? "Play" : "Pause");
    const d = this.el.duration || it.duration || 0;
    $("#pNow").textContent = clock(this.el.currentTime);
    $("#pEnd").textContent = clock(d);
    const sk = $("#pSeek");
    if (sk && document.activeElement !== sk) sk.value = d ? (this.el.currentTime / d) * 1000 : 0;
    $("#pRate").textContent = this.el.playbackRate.toFixed(2).replace(/0$/, "") + "×";
    highlightSegments(this.el.currentTime, it.id);
  },
};

function updateMediaSession() {
  if (!("mediaSession" in navigator)) return;
  const it = Player.current(); if (!it) return;
  const a = DATA.authors.find(x => x.id === it.author);
  const art = it.cover ? [{ src: new URL(it.cover, location.href).href, sizes: "512x512" }] : [];
  navigator.mediaSession.metadata = new MediaMetadata({
    title: it.title, artist: a?.name || it.author,
    album: it.series || DATA.site.title || "Hypnotica", artwork: art });
  const set = (k, fn) => { try { navigator.mediaSession.setActionHandler(k, fn); } catch {} };
  set("play", () => Player.el.play()); set("pause", () => Player.el.pause());
  set("previoustrack", () => Player.prev()); set("nexttrack", () => Player.next());
  set("seekbackward", () => Player.nudge(-15)); set("seekforward", () => Player.nudge(30));
}

/* --------------------------------------------------------------- filtering */
/* Tags and categories are each a three-way facet:
     any - keep an item if it carries at least one of these
     all - every one of these is required
     not - carrying any one of these disqualifies the item
   The three combine, and "not" always wins. */
const MODES = ["any", "all", "not"];
const MODE_LABEL = { any: "any", all: "all", not: "not" };
const emptyFacet = () => ({ any: [], all: [], not: [] });

/* What a tag is *about*, read off its "Kind: Value" prefix. The same eight live
   in build.go here and in Inductor's TagKinds, which is where a tag is given its
   prefix in the first place; the build ingests the YAML as written, so the
   prefix in the data is all we go on. A prefix that is not listed here is an
   ordinary content tag, which is what keeps a stray "Hypno: Full" out of the
   sections -- and is also why adding a namespace to a registry without adding
   it here is quiet rather than loud. */
const TAG_KINDS = [
  { key: "voice", prefix: "Voice", label: "Voice",
    note: "how the speaker presents" },
  { key: "audience", prefix: "Audience", label: "Audience",
    note: "who it speaks to" },
  { key: "induction", prefix: "Induction", label: "Induction",
    note: "how trance is brought on" },
  { key: "production", prefix: "Production", label: "Production",
    note: "how the audio was made" },
  { key: "trigger", prefix: "Trigger", label: "Triggers", spoiler: true,
    note: "cues it installs" },
  { key: "compulsion", prefix: "Compulsion", label: "Compulsions", spoiler: true,
    note: "drives it leaves behind" },
  { key: "cw", prefix: "CW", label: "Content warnings",
    note: "touched on, not the subject" },
  { key: "content", prefix: "", label: "Content", note: "what happens in it" },
];
/* The eight above are the fallback, not the law: a registry may declare its own
   namespaces and the build ships them in the index head as `tagKinds`. They stay
   compiled in because the first paint happens before any data arrives, and
   because a page cached from an older build has no `tagKinds` to read. */
let KINDS = TAG_KINDS;
let KIND_BY_PREFIX = new Map();
let KIND_BY_KEY = new Map();
let SPOILER_KINDS = new Set();
let CONTENT_KIND = "content";
function useKinds(kinds) {
  KINDS = Array.isArray(kinds) && kinds.length ? kinds : TAG_KINDS;
  KIND_BY_PREFIX = new Map(KINDS.filter(k => k.prefix).map(k => [k.prefix, k]));
  KIND_BY_KEY = new Map(KINDS.map(k => [k.key, k]));
  SPOILER_KINDS = new Set(KINDS.filter(k => k.spoiler).map(k => k.key));
  CONTENT_KIND = (KINDS.find(k => !k.prefix) || { key: "content" }).key;
}
useKinds(TAG_KINDS);
/* The head and the namespaces it was built with arrive together and must be
   installed together: sections built from the fallback while tags are named by
   the data is the one state where a namespace silently loses its section. */
function setData(d) {
  DATA = d || { site: {}, authors: [], items: [] };
  useKinds(DATA.tagKinds);
}
/* Recomputed from the file itself, so it is filtered on below and never offered
   as a tag - a "Duration: 10-20" on a 60-second preview is exactly the kind of
   claim that used to get through. Items written before the retag still carry
   these, so they are dropped on the way in rather than waited out. */
const DERIVED_PREFIXES = new Set(["Duration"]);
const isDerivedTag = t => DERIVED_PREFIXES.has(String(t).split(": ")[0]);

function tagKind(tag) {
  const i = String(tag).indexOf(": ");
  if (i < 0) return CONTENT_KIND;
  return KIND_BY_PREFIX.get(String(tag).slice(0, i))?.key || CONTENT_KIND;
}
/* What a tag means, from tags.yaml by way of the build. A chip shows the value
   only - "Sink", not "Trigger: Sink" - so the definition is the one place a
   reader can find out what the library means by a word before clicking it. */
function tagNote(tag) {
  return (DATA?.tagInfo || {})[String(tag)] || "";
}
/* title= for a chip: the full prefixed tag, then its definition where there is
   one, so the kind is legible on a chip that only shows the bare value. */
function tagTitle(tag, extra) {
  const note = tagNote(tag);
  return [String(tag), note, extra].filter(Boolean).join(" — ");
}
function tagValue(tag) {
  const i = String(tag).indexOf(": ");
  return i < 0 || !KIND_BY_PREFIX.has(String(tag).slice(0, i))
    ? String(tag) : String(tag).slice(i + 2);
}

const F = Object.assign(
  { q: "", author: "", tags: emptyFacet(), cats: emptyFacet(), meta: emptyFacet(),
    dur: { min: "", max: "" }, spoil: false,
    // Creators sort by how much they made, not alphabetically: the list is a
    // place to find somebody worth hours of listening, and a creator with four
    // hundred recordings is a different proposition from one with two.
    sort: "date", asort: "files", tr: false, off: false },
  load(K.filters, {}));
if (!F.dur || typeof F.dur !== "object") F.dur = { min: "", max: "" };

function saveFilters() { save(K.filters, F); }

/* Earlier builds stored one chosen tag and one chosen category. Write the
   migrated shape straight back, so the superseded keys do not linger. */
(() => {
  let moved = false;
  for (const [key, was] of [["tags", "tag"], ["cats", "cat"], ["meta", ""]]) {
    const f = F[key] && typeof F[key] === "object" ? F[key] : {};
    F[key] = { any: [...(f.any || [])], all: [...(f.all || [])], not: [...(f.not || [])] };
    if (!was) continue;                    // nothing earlier to migrate from
    if (typeof F[was] === "string" && F[was] && !F[key].any.includes(F[was])) F[key].any.push(F[was]);
    if (was in F) { delete F[was]; moved = true; }
  }
  if (moved) saveFilters();
})();

/* A filter that outlives the search it was set in.

   Some exclusions are not about this search, they are about what somebody wants
   to be shown at all -- an audience they are not, a content warning they would
   rather not meet. Setting those again on every search, and on every creator's
   page, is the kind of thing people stop doing and then stop using the library.

   So the same chips write to one of two places: the search being made now, or
   the standing filter, which is applied on top of every search and every
   creator's page and is not touched by Clear. It can be suspended without being
   taken apart, because "let me see everything for a minute" is a different act
   from "I did not mean any of this".

   Made of the same chips the panels offer, and nothing else: duration and the
   search box stay with the search they were typed into. */
const ALWAYS = Object.assign(
  { tags: emptyFacet(), cats: emptyFacet(), meta: emptyFacet(), off: false },
  load(K.always, {}));
for (const key of ["tags", "cats", "meta"]) {
  const f = ALWAYS[key] && typeof ALWAYS[key] === "object" ? ALWAYS[key] : {};
  ALWAYS[key] = { any: [...(f.any || [])], all: [...(f.all || [])], not: [...(f.not || [])] };
}
/* Stamped, because two devices can disagree about this and the answer wants to
   be the one somebody set last rather than the one that happened to sync last. */
function saveAlways() { ALWAYS.updated = nowISO(); save(K.always, ALWAYS); Sync.soon(); }

const alwaysCount = () =>
  ["tags", "cats", "meta"].reduce((n, k) => n + MODES.reduce((m, mode) => m + ALWAYS[k][mode].length, 0), 0);

/* A name, or a set of pins, from before either carried a time.

   Both resolve by asking which is newer, and two values with no time at all
   compare equal -- so a device that set one before this existed would refuse
   every other device's for ever, and quietly go on showing its own. Stamped
   once, on the first load that knows to, which gives the comparison something
   to compare. */
(() => {
  const me = load(K.me, null);
  if (me && typeof me === "object" && me.name && !me.updated) {
    save(K.me, { ...me, updated: nowISO() });
  }
  if (!ALWAYS.updated && alwaysCount()) {
    ALWAYS.updated = nowISO();
    save(K.always, ALWAYS);
  }
})();
const alwaysOn = () => !ALWAYS.off && alwaysCount() > 0;

/* A chosen value lives in one of the two and never in both: the search being
   made now, or the pinned set that outlives it. Which one it is in is the whole
   difference, and the pin on its chip is how it is moved. */
const isPinned = (key, v) => MODES.some(m => ALWAYS[key][m].includes(v));
const facetWhere = (key, v) => (isPinned(key, v) ? ALWAYS : F);

function facetOf(key, v) {
  const home = facetWhere(key, v);
  return MODES.find(m => home[key][m].includes(v)) || "";
}
function pull(home, key, v) {
  for (const m of MODES) {
    const i = home[key][m].indexOf(v);
    if (i >= 0) home[key][m].splice(i, 1);
  }
}
function setFacet(key, v, mode) {
  const home = facetWhere(key, v);
  pull(home, key, v);
  if (mode) { home[key][mode].push(v); home[key][mode].sort((a, b) => a.localeCompare(b)); }
  if (home === ALWAYS) saveAlways(); else saveFilters();
}

/* The pin, and the only way across. The mode comes with it: something excluded
   for this search and then pinned is excluded from now on, which is what
   pressing a pin on a chip that says "not" plainly means. */
function togglePin(key, v) {
  const mode = facetOf(key, v);
  if (!mode) return;
  const from = facetWhere(key, v), to = from === ALWAYS ? F : ALWAYS;
  pull(from, key, v);
  to[key][mode].push(v);
  to[key][mode].sort((a, b) => a.localeCompare(b));
  saveAlways(); saveFilters();
}
function cycleFacet(key, v, back = false) {
  const ring = ["", "any", "all", "not"];
  const i = ring.indexOf(facetOf(key, v));
  setFacet(key, v, ring[(i + (back ? ring.length - 1 : 1)) % ring.length]);
}
/* Everything chosen in a section, from both stores, each saying which it is in.
   Pinned last: they are the standing part, and reading them after the search's
   own is the order somebody thinks in. */
function facetChosen(key, kind) {
  const from = (home, pinned) =>
    MODES.flatMap(m => home[key][m].map(v => ({ m, v, pinned })));
  const all = [...from(F, false), ...from(ALWAYS, true)];
  return kind ? all.filter(c => tagKind(c.v) === kind) : all;
}
/* Clearing is per section, so wiping the content tags cannot silently drop a
   standing audience exclusion the reader set months ago. */
/* Clearing is per section, and never reaches a pinned choice: those are the ones
   somebody set once so they would not have to think about them again, and a
   button that tidies up this search has no business taking them away. */
function clearFacet(key, kind) {
  if (!kind) { F[key] = emptyFacet(); saveFilters(); return; }
  for (const m of MODES) F[key][m] = F[key][m].filter(v => tagKind(v) !== kind);
  saveFilters();
}

/* Duration is read off the file, never off a tag - a "Duration: 10-20" tag on a
   60-second preview is exactly the kind of thing that used to get through. */
function inDuration(it) {
  const mins = (it.duration || 0) / 60;
  const lo = parseFloat(F.dur.min), hi = parseFloat(F.dur.max);
  if (!isNaN(lo) && mins < lo) return false;
  if (!isNaN(hi) && mins > hi) return false;
  return true;
}

/* What the reader has done with a recording, offered as a facet.

   None of this is in the build: it is the four things this browser remembers,
   and the point of putting them through the same cycle as tags is that "liked
   but never played", or "in a list and not yet noted", becomes two clicks
   rather than a page of its own. */
const META_KEYS = ["played", "note", "favourite", "playlist"];
const META_LABEL = { played: "Played", note: "Has a note",
                     favourite: "Favourited", playlist: "In a playlist" };
const META_WHY = {
  played: "Listened to for at least one sitting on this device.",
  note: "Something is written against it.",
  favourite: "Liked.",
  playlist: "In at least one playlist here.",
};
/* The four this library knows about itself, then one for each person whose
   share is kept: "liked by Naomi" is the same kind of question as "liked", and
   wants the same any/all/not. */
const metaKeys = () => [...META_KEYS, ...followIndex().map(r => "by:" + r.id)];
const metaWho = v => (v.startsWith("by:") ? followIndex().find(r => "by:" + r.id === v) : null);
const metaLabel = v => {
  const who = metaWho(v);
  return who ? `Liked by ${who.name}` : META_LABEL[v] || v;
};
const metaWhy = v => {
  const who = metaWho(v);
  return who ? `In the favourites of ${who.name}, as their share last had it.`
             : META_WHY[v] || "";
};

function metaSets() {
  const theirs = VIEWING && VIEWING.sets;
  const out = theirs || { played: History.playedIds(), note: new Set(Notes.ids()),
                          favourite: new Set(Favourites.ids("item")),
                          playlist: Playlists.itemIds() };
  for (const r of followIndex()) out["by:" + r.id] = r.favs;
  return out;
}
function metaOf(it, sets) {
  return metaKeys().filter(k => sets[k] && sets[k].has(it.id));
}
const facetActive = f => !!(f && (f.any.length || f.all.length || f.not.length));

function matchFacet(have, f) {
  if (f.not.length && f.not.some(v => have.includes(v))) return false;
  if (f.all.length && !f.all.every(v => have.includes(v))) return false;
  if (f.any.length && !f.any.some(v => have.includes(v))) return false;
  return true;
}

/* Transcript search asks the word index, not the transcripts.

   A term's postings live in the shard named by its first two letters, so a
   query downloads a few hundred kilobytes instead of every transcript in the
   library. Matching is by whole word, with the term still being typed treated
   as a prefix -- "bim" finds "bimbo" before you finish the word. */
let WORD_IDS = null, wordIdsLoading = null;
const WORD_SHARDS = new Map(), wordShardLoading = new Map();
let TR_HITS = null;          // Set of item ids the current query matched, or null

function shardName(word) {
  const head = word.slice(0, 2);
  return /^[a-z0-9]{2}$/.test(head) ? head : "_other";
}
function loadWordIds() {
  if (WORD_IDS) return Promise.resolve(WORD_IDS);
  if (!wordIdsLoading) {
    wordIdsLoading = fetch("data/words/_ids.json")
      .then(r => r.ok ? r.json() : [])
      .then(j => (WORD_IDS = j))
      .catch(() => (WORD_IDS = []));
  }
  return wordIdsLoading;
}
function loadShard(name) {
  if (WORD_SHARDS.has(name)) return Promise.resolve(WORD_SHARDS.get(name));
  if (wordShardLoading.has(name)) return wordShardLoading.get(name);
  const p = fetch(`data/words/${name}.json`)
    .then(r => r.ok ? r.json() : {})
    .catch(() => ({}))
    .then(d => { WORD_SHARDS.set(name, d); wordShardLoading.delete(name); return d; });
  wordShardLoading.set(name, p);
  return p;
}

/* The ids whose transcript matches every term. The last term is a prefix, the
   rest are whole words: that is what a half-typed query means. */
async function transcriptHits(terms) {
  const usable = terms.filter(t => t.length > 2);
  if (!usable.length) return null;
  const [ids] = await Promise.all([
    loadWordIds(),
    Promise.all([...new Set(usable.map(shardName))].map(loadShard)),
  ]);
  let keep = null;
  usable.forEach((term, n) => {
    const shard = WORD_SHARDS.get(shardName(term)) || {};
    const last = n === usable.length - 1;
    let posting = new Set(shard[term] || []);
    if (last && !shard[term]) {
      for (const w in shard) {
        if (w.startsWith(term)) for (const i of shard[w]) posting.add(i);
      }
    }
    keep = keep === null ? posting : new Set([...keep].filter(i => posting.has(i)));
  });
  return new Set([...(keep || [])].map(i => ids[i]).filter(Boolean));
}

/* Run the query, then redraw: results widen as the shards land. */
let trQuery = "";
function refreshTranscriptHits() {
  const q = F.tr ? F.q.trim().toLowerCase() : "";
  if (q === trQuery) return;
  trQuery = q;
  if (!q) { TR_HITS = null; return; }
  transcriptHits(q.split(/\s+/)).then(hits => {
    if (trQuery !== q) return;            // a newer query overtook this one
    TR_HITS = hits;
    // Lands while somebody is still typing, so it takes the same narrow path a
    // keystroke does rather than rebuilding the box under them.
    refilter();
  });
}

async function ensureSpoilers() {
  if (SPOILERS) return SPOILERS;
  if (!spoilersLoading) {
    spoilersLoading = fetch("data/spoilers.json")
      .then(r => r.ok ? r.json() : {})
      .then(j => (SPOILERS = j))
      .catch(() => (SPOILERS = {}));
  }
  return spoilersLoading;
}

/* Search text is built at build time and fetched on the first query, so typing
   does not make the browser strip HTML out of 4,800 descriptions. Until it
   arrives, match on what the grid already has: the results are narrower for a
   moment rather than absent. */
let SEARCH = null, searchLoading = null;
function loadSearch() {
  if (SEARCH || searchLoading) return searchLoading;
  searchLoading = fetch("data/search.json")
    .then(r => r.ok ? r.json() : {})
    .then(d => { SEARCH = d; render(); return d; })
    .catch(() => { SEARCH = {}; });
  return searchLoading;
}
function haystack(it) {
  if (SEARCH && SEARCH[it.id] !== undefined) return SEARCH[it.id];
  return (it._hay ||= [it.title, it.summary, (it.tags || []).join(" "),
    it.series || "", authorName(it.author)].join(" ").toLowerCase());
}

/* Write-ups live in a per-author shard, fetched when an item is opened. They
   were 43% of the index and nothing shows them until then. */
const DETAIL = new Map();
const detailLoading = new Map();
function loadDetail(author) {
  if (DETAIL.has(author)) return Promise.resolve(DETAIL.get(author));
  if (detailLoading.has(author)) return detailLoading.get(author);
  const safe = String(author).replace(/[^A-Za-z0-9._-]+/g, "-");
  const p = fetch(`data/detail/${encodeURIComponent(safe)}.json`)
    .then(r => r.ok ? r.json() : {})
    .catch(() => ({}))
    .then(d => { DETAIL.set(author, d); detailLoading.delete(author); return d; });
  detailLoading.set(author, p);
  return p;
}
function detailOf(it) { return (DETAIL.get(it.author) || {})[it.id] || {}; }
/* The creator's own record rides in their shard under a reserved key: their
   picture brief is two paragraphs, and putting 135 of those in the index head
   would have doubled the first thing every visitor downloads. */
function authorDetail(id) { return (DETAIL.get(id) || {})._author || {}; }

/* What a library says it wrote rather than found, field by field. The answer
   differs between fields of the same entry -- a creator's own title above a
   summary written from the transcript -- so the mark goes on the line, not on
   the page. Nothing is inferred here: a field is marked when the library says
   so and not otherwise, because telling somebody their own writing was
   machine-made is the one error worth ruling out. */
const GEN_WHY = {
  title: "Written from the recording. The file arrived without a title of its own.",
  summary: "Written from the transcript by an automated pass, not supplied by the creator.",
  description: "Written from the transcript by an automated pass, not the creator's own words.",
  synopsis: "Written from the recordings listed below, not by the creator.",
  cover: "Drawn from a written brief. Not a photograph, and not a likeness of anyone.",
  image: "Drawn from a written brief. Not a photograph, and not a likeness of anyone.",
  tags: "Some of these tags were proposed by an automated pass and ruled on afterwards.",
  spoilers: "An automated review of an automatic transcript. A lead, not a verdict.",
};
function genOf(it) {
  const said = detailOf(it).generated;
  if (said) return said;
  // Before the shard lands, the index still knows about the rare one.
  return it.titleGenerated ? ["title"] : [];
}
/* A star, not a word. The mark sits beside a title, a picture and a paragraph,
   and the word "generated" spelled out three times on one page reads as an
   argument about the page rather than a note on it. The tooltip carries the
   meaning; the glyph only has to be noticeable enough to be asked about. */
const GEN_GLYPH = "\u2726";      // ✦ BLACK FOUR POINTED STAR -- text, never emoji
function genMark(fields, which) {
  if (!fields || fields.indexOf(which) < 0) return "";
  return ` <span class="gen" role="img" aria-label="generated"
    title="${esc(GEN_WHY[which] || "Generated, not supplied.")}">${GEN_GLYPH}</span>`;
}

/* What was measured off the audio, said in words.

   A number on its own is trivia: "hnr_db: 12.4" tells a reader nothing. The
   same number with a name and a reading -- breath against tone, clear -- is the
   thing they came for, and it is the difference between an ASMR whisper and a
   chest-voice command at the same pitch. Every band here is a measurement the
   library took, never a tag somebody applied, and where the two disagree the
   page says so rather than picking a side. */
const BANDS = {
  f0_median_hz: {
    label: "Pitch", unit: " Hz",
    read: v => v < 140 ? "low" : v < 180 ? "low-mid" : v < 220 ? "mid" : "high",
    why: "Median fundamental frequency, measured from the waveform.",
  },
  hnr_db: {
    label: "Breath", unit: " dB",
    read: v => v < 5 ? "breathy, close to a whisper"
             : v < 12 ? "soft, some breath" : v < 20 ? "clear" : "very clear",
    why: "Harmonics against noise. A whisper has almost no harmonics; a chest voice is nearly all harmonics.",
  },
  brightness_hz: {
    label: "Tone", unit: " Hz",
    read: v => v < 900 ? "dark" : v < 1600 ? "warm" : "bright",
    why: "Where the weight of the sound sits.",
  },
  words_per_minute: {
    label: "Pace", unit: " wpm",
    read: v => v < 90 ? "slow" : v < 120 ? "unhurried" : v < 150 ? "conversational" : "quick",
    why: "Counted against speaking time, not against the length of the file.",
  },
  speaking_share: {
    label: "Speaking", unit: "", format: v => `${Math.round(v * 100)}%`,
    read: v => v > 0.95 ? "almost continuous" : v > 0.8 ? "few pauses" : "spacious",
    why: "How much of the recording is speech rather than silence.",
  },
  longest_pause_s: {
    label: "Longest pause", unit: "s",
    read: v => v < 3 ? "" : v < 10 ? "a real gap" : "a long silence",
    why: "The biggest gap between one phrase and the next.",
  },
  crest_db: {
    label: "Dynamics", unit: " dB",
    read: v => v < 10 ? "heavily compressed" : v < 16 ? "compressed" : "natural",
    why: "Peak against average. A low figure means everything has been squashed to one level.",
  },
  level_variation: {
    label: "Delivery", unit: "",
    read: v => v < 0.3 ? "very even" : v < 0.6 ? "even" : "swells and drops",
    why: "How much the loudness moves between one moment and the next.",
  },
};
const BAND_ORDER = ["f0_median_hz", "hnr_db", "brightness_hz", "words_per_minute",
                    "speaking_share", "longest_pause_s", "crest_db", "level_variation"];

function voiceFigs(a) {
  if (!a || typeof a !== "object") return [];
  return BAND_ORDER.filter(k => typeof a[k] === "number").map(k => {
    const band = BANDS[k], v = a[k];
    const shown = band.format ? band.format(v) : `${v}${band.unit}`;
    const reading = band.read(v);
    return `<div class="band"><b>${esc(band.label)}</b>
      <span class="fig" title="${esc(band.why)}">${esc(shown)}</span>
      ${reading ? `<i>${esc(reading)}</i>` : ""}</div>`;
  });
}

/* The measured voice, and whether it agrees with the tag. Kept apart from the
   bands because it is the one place the library contradicts itself out loud. */
function voiceNote(a) {
  if (!a || typeof a !== "object" || !a.voice) return "";
  return a.voice_disputed
    ? `<p class="note disputed">Measured as <b>${esc(a.voice)}</b>, but tagged
       <b>${esc(a.voice_disputed)}</b>. Both are kept — a measurement reports and
       a tag asserts, and this is where they disagree.</p>`
    : `<p class="note">Measured voice: <b>${esc(a.voice)}</b>${
        a.f0_reliable === false ? " — the pitch reading is not trustworthy here"
                                : ", agreeing with its tag"}.</p>`;
}

const BEAT_BANDS = { delta: "deep sleep range", theta: "drowsy, hypnagogic range",
                     alpha: "relaxed, eyes-closed range", beta: "alert range",
                     gamma: "above the usual entrainment range" };

/* What a recording sounds like: everything measured off the audio and everything
   heard in it, in one panel.

   The voice bands -- pitch, breath, pace, how much of the file is speech -- used
   to hang in the provenance fold, which filed a description of the sound under a
   heading about how the entry was assembled. They are not provenance. They are
   what the reader came here to know, and they belong beside the tones and the
   labels a listening model returned; the fold keeps only the paper trail.

   Open by default where there is nothing to transcribe: for a wordless recording
   this is not a footnote but the only description there is, and the reason the
   transcript is missing. */
function soundPanel(sn, a) {
  sn = sn && typeof sn === "object" ? sn : {};
  const t = sn.tones && typeof sn.tones === "object" ? sn.tones : null;
  // The voice first, then what the listening pass found: a reader of a spoken
  // recording wants the pitch and the pace, and on a wordless one there is no
  // voice to measure, so the tones lead on their own.
  const figs = voiceFigs(a);
  const fig = (label, shown, why, reading) => figs.push(`<div class="band">
    <b>${esc(label)}</b><span class="fig" title="${esc(why)}">${esc(shown)}</span>
    ${reading ? `<i>${esc(reading)}</i>` : ""}</div>`);
  if (typeof sn.voice_confidence === "number") {
    const v = sn.voice_confidence;
    fig("Speech", v.toFixed(2),
        "How sure the sound tagger is that somebody is speaking, judged from the audio alone and never from the transcript. Its classes are scored one by one, so this does not compete with anything else heard here.",
        v < 0.25 ? "no voice detected" : v < 0.5 ? "sparse or quiet" : "present throughout");
  }
  if (t) {
    if (t.carrier_steady && typeof t.carrier_hz === "number")
      fig("Carrier", `${Math.round(t.carrier_hz)} Hz`,
          "The tone itself, as measured in the left channel.",
          t.carrier_drift && t.carrier_drift !== "steady" ? t.carrier_drift : "");
    if (typeof t.beat_hz === "number" && t.beat_hz >= 0.5)
      fig("Binaural beat", `${t.beat_hz.toFixed(1)} Hz`,
          "The difference between the ears. It is not in the file — it happens in the listener, and only over headphones.",
          BEAT_BANDS[t.beat_band] || "");
    else if (typeof t.beat_hz === "number")
      fig("Binaural beat", "none",
          "Both channels carry the same tone, so there is no difference for the listener to hear as a beat.", "");
    if (typeof t.pulse_hz === "number" && t.pulse_strength > 0.15)
      fig("Pulse", `${t.pulse_hz.toFixed(1)} Hz`,
          "A real rise and fall in level, measured in one channel — unlike the beat, this one is in the audio.", "");
  }
  /* The two label sets answer different questions and must not be run together.
     The ranked ones are the closest match from a list the model was given and
     could not refuse; the classes are scored independently, so several can be
     true at once and none of them is competing. */
  const RANKED_WHY = "The closest match from the vocabulary this library offers the audio-text model. It ranks what it is given and cannot answer \u2018none of these\u2019, so these are shown only when the match was close enough to mean something.";
  const CLASS_WHY = "From a fixed 527-class sound ontology, each class scored on its own. Several can be true at once, which is why speech and mouth sounds can both appear.";
  const row = (label, items, why) => items && items.length
    ? `<p class="sndrow"><b title="${esc(why)}">${esc(label)}</b>${items.map(c =>
        `<span class="chip" title="${esc(why)}">${esc(c)}</span>`).join("")}</p>`
    : "";
  const ranked = sn.fits === false ? [] : (sn.sounds || []);
  const classes = sn.classes || [];
  const wordless = sn.wordless || sn.speech === "none";
  const voice = voiceNote(a);
  if (!figs.length && !ranked.length && !classes.length && !wordless && !sn.reads_as && !voice)
    return "";
  const hoverable = figs.length || ranked.length || classes.length;
  return `<details class="snd"${wordless ? " open" : ""}>
    <summary>What this sounds like${wordless ? ` <span class="cnt">no speech</span>` : ""}</summary>
    ${wordless ? `<p class="note">There is no transcript because there is nothing to
      transcribe: a pass that identifies sound rather than speech found no voice in this
      recording. What follows was measured and heard, not read.</p>`
    : `<p class="note">Measured off the audio itself and identified by models that listen
      for sound rather than words — never taken from the tags.${
      hoverable ? " Hover any figure or label for what it means." : ""}</p>`}
    ${sn.reads_as ? `<p class="reads">${esc(sn.reads_as)}</p>` : ""}
    ${figs.length || voice ? `<div class="measured">${
      figs.length ? `<div class="bands">${figs.join("")}</div>` : ""}${voice}</div>` : ""}
    ${row("Sounds most like", ranked, RANKED_WHY)}
    ${row("Also heard", classes, CLASS_WHY)}
    ${sn.fits === false ? `<p class="note">Nothing in the vocabulary matched this closely
      enough to name, so only the independently scored classes are shown.</p>` : ""}
  </details>`;
}

/* The brief a picture was drawn from, and the list of what else on the page was
   made rather than found. Closed by default: it answers a question somebody has
   only once they have started wondering. */
function provPanel(fields, prompts, what) {
  const rows = (fields || []).filter(f => GEN_WHY[f]);
  const styles = [["natural", "As prose"], ["tagged", "As keywords"],
                  ["negative", "Asked to avoid"]]
    .filter(([k]) => prompts && prompts[k]);
  if (!rows.length && !styles.length) return "";
  return `<details class="prov"><summary>How this ${esc(what)} was made</summary>
    ${rows.length ? `<ul class="genlist">${rows.map(f =>
      `<li><b>${esc(f)}</b> — ${esc(GEN_WHY[f])}</li>`).join("")}</ul>` : ""}
    ${styles.length ? `<div class="brief">
      <p class="note">The brief the picture was drawn from. Kept in both styles, because
        tag-weighted renderers and instruction-following ones want different things.</p>
      ${styles.map(([k, label]) =>
        `<p class="kv">${esc(label)}</p><pre class="prompt">${esc(prompts[k])}</pre>`).join("")}
    </div>` : ""}
  </details>`;
}
/* The creator's write-up and the machine's, in that order and told apart.

   They used to share one field, so a page could show either and a reader had no
   way to know which. Where both exist the creator's comes first and unlabelled
   -- it is the recording speaking for itself -- and the synopsis follows under a
   heading that says what it is. Where only the synopsis exists there is nothing
   to distinguish it from, so it is shown exactly as a description always was. */
function writeUp(d, it, gen) {
  const own = d.description || "";
  const ours = d.synopsis || "";
  if (own && ours) {
    // The mark goes on the heading, not after the paragraph. It qualifies the
    // whole section -- "this part was written by a model" -- and a reader meets
    // the heading before the prose, which is when they want to know. Trailing
    // it left the qualifier several hundred words downstream of the thing it
    // qualifies, and on a long synopsis off the bottom of the screen entirely.
    return `<div class="prose">${own}</div>
      <h2 class="writeup">Synopsis${genMark(gen, "synopsis")}</h2>
      <div class="prose synopsis">${ours}</div>`;
  }
  if (own) return `<div class="prose">${own}${genMark(gen, "description")}</div>`;
  if (ours) return `<div class="prose">${ours}${genMark(gen, "synopsis")}</div>`;
  return it.summary ? `<div class="prose"><p>${esc(it.summary)}</p>
    ${genMark(gen, "summary")}</div>` : "";
}

/* What the people whose shares are kept have to say about this one.

   Three different facts, and worth keeping apart: liking something, putting it
   in a list, and having actually played it are not the same claim. */
function followedPanel(id) {
  // Somebody's own lists first, and unqualified: "In playlists: Sleep, Deep
  // (Naomi)" reads as one answer to one question, which is what it is. Nothing
  // else on the page says a recording is in a list of yours at all.
  const mine = listIndex().get(id) || [];
  const { liked, listed, played } = followedFacts(id);
  if (!mine.length && !liked.length && !listed.length && !played.length) return "";
  const lists = [...mine, ...listed.map(l => `${l.list} (${l.who})`)];
  const theirs = liked.length || listed.length || played.length;
  return `<div class="among">
    ${lists.length ? `<p><b>In playlists</b> ${esc(andList(lists))}</p>` : ""}
    ${liked.length ? `<p><b>Favourited by</b> ${esc(andList(liked))}</p>` : ""}
    ${played.map(p => `<p><b>${esc(p.who)}</b> played it ${
      p.n === 1 ? "once" : `${p.n} times`}${
      p.last ? `, last ${esc(dayLabel(p.last).toLowerCase())}` : ""}</p>`).join("")}
    ${theirs ? `<p class="note">The people whose shares you keep, as those last
      stood.</p>` : ""}
  </div>`;
}

/* The same, small enough for a card: which lists it is in, who liked it, and
   whether anybody has actually played it. */
function followedMark(id) {
  const mine = listIndex().get(id) || [];
  const { liked, listed, played } = followedFacts(id);
  if (!mine.length && !liked.length && !listed.length && !played.length) return "";
  const lists = [...mine, ...listed.map(l => `${l.list} (${l.who})`)];
  const bits = [];
  if (liked.length) bits.push(`♥ ${few(liked)}`);
  if (lists.length) bits.push(`in ${few(lists)}`);
  if (played.length) bits.push(`played by ${few(played.map(p => p.who))}`);
  return `<p class="among1">${esc(bits.join(" · "))}</p>`;
}

/* And the same on a creator, where the only question is who likes them. */
function followedAuthorMark(id) {
  const liked = followedAuthorLikes(id);
  return liked.length ? `<p class="among1">♥ ${esc(few(liked))}</p>` : "";
}

/* What this device has heard of it. Shown only once there is something to say,
   because "played 0 times" is a sentence about nothing. */
function playedLine(id) {
  const p = History.plays(id);
  if (!p) return "";
  const when = dayLabel(p.last);
  return `<p class="played">Played ${p.n === 1 ? "once" : `${p.n} times`}${
    when ? ` · last ${esc(when.toLowerCase())}` : ""}
    <button class="link" data-act="histForget" data-id="${esc(id)}">forget</button></p>`;
}

/* The note box. Text in, text out, and the displaced copy of a note a merge
   overwrote offered once beside it rather than thrown away. */
function notePanel(id) {
  const text = Notes.text(id), was = Notes.displaced(id);
  const priv = Notes.isPrivate(id);
  return `<details class="note-box"${text ? " open" : ""}>
    <summary>Note${text ? "" : ` <span class="cnt">none yet</span>`}</summary>
    <p class="note">Yours, kept on this device. Plain text, and never part of what the
      library publishes.</p>
    <textarea id="noteText" rows="4" maxlength="${NOTE_MAX}" aria-label="Note"
      data-id="${esc(id)}"
      placeholder="What it is for, what it did, whatever is worth remembering."
      >${esc(text)}</textarea>
    <p class="noterow">
      <label><input type="checkbox" id="notePriv"${priv ? " checked" : ""}> Private —
        leave out of every share and export</label>
      <button class="btn sm" data-act="noteSave" data-id="${esc(id)}">Save</button>
      ${text ? `<button class="btn sm" data-act="noteDel" data-id="${esc(id)}">Delete</button>` : ""}
    </p>
    ${was ? `<p class="note disputed">A version of this note written
      ${esc(dayLabel(was.updated).toLowerCase())} was replaced by one that arrived in an
      import. It is kept here until you say otherwise.</p>
      <pre class="prompt">${esc(was.text)}</pre>
      <p class="noterow">
        <button class="btn sm" data-act="noteRestore" data-id="${esc(id)}">Restore it</button>
        <button class="btn sm" data-act="noteDrop" data-id="${esc(id)}">Discard it</button>
      </p>` : ""}
  </details>`;
}

/* Cut at a word, and say it was cut. Only ever a fallback: a sentence written
   for a card beats the first n characters of one written for a page. */
function clip(text, n) {
  const t = String(text || "").trim().replace(/\s+/g, " ");
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), n - 20)).trimEnd() + "\u2026";
}
function stripTags(h) { return String(h || "").replace(/<[^>]+>/g, " "); }
function authorName(id) { return DATA.authors.find(a => a.id === id)?.name || id; }

/* `skip` leaves one facet out, which is what the per-tag match counts need:
   a count is "how many results would this tag give me", not "how many now". */
/* The standing filter, as a test over one item. Not applied while it is the
   thing being edited: a chip cannot be chosen out of a list it has already
   removed from the page. */
function alwaysKeeps(it, sets) {
  if (!matchFacet(it.tags, ALWAYS.tags)) return false;
  if (!matchFacet(it.categories, ALWAYS.cats)) return false;
  if (sets && !matchFacet(metaOf(it, sets), ALWAYS.meta)) return false;
  return true;
}
const standingApplies = () => alwaysOn();

/* What a list of items looks like once the standing filter has had it. Used by
   every surface that browses rather than collects: the library and a creator's
   page. A playlist, the favourites and the queue are things somebody put
   something into on purpose, and quietly taking it out again would be worse
   than showing it. */
function alwaysKeep(rows) {
  if (!standingApplies()) return rows;
  const sets = facetActive(ALWAYS.meta) ? metaSets() : null;
  return rows.filter(it => alwaysKeeps(it, sets));
}

/* One pass per distinct question, not one per panel.

   Nine facet panels ask `filtered(key)` for their counts, and eight of them ask
   the same question -- every tag kind skips "tags". On a library of ten thousand
   that was ten walks of the whole catalogue for one keystroke, which is what
   made typing feel like wading. Nothing mutates a filter in the middle of a
   render, so the answers hold for the length of one. */
let PASS = null;
const startPass = () => { PASS = new Map(); };
const endPass = () => { PASS = null; };

function filtered(skip = "") {
  if (PASS && PASS.has(skip)) return PASS.get(skip);
  const rows = computeFiltered(skip);
  if (PASS) PASS.set(skip, rows);
  return rows;
}

function computeFiltered(skip = "") {
  const q = F.q.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  // Built once per pass and only when something asks for it: the sets behind it
  // are read out of storage, which is not work to do per card.
  const wantsMeta = facetActive(F.meta) || (standingApplies() && facetActive(ALWAYS.meta));
  const meta = skip !== "meta" && wantsMeta ? metaSets() : null;
  const standing = standingApplies();
  let rows = DATA.items.filter(it => {
    if (F.author && it.author !== F.author) return false;
    if (standing && !alwaysKeeps(it, meta)) return false;
    if (skip !== "tags" && !matchFacet(it.tags, F.tags)) return false;
    if (skip !== "cats" && !matchFacet(it.categories, F.cats)) return false;
    if (meta && !matchFacet(metaOf(it, meta), F.meta)) return false;
    if (F.off && !Offline.has(it)) return false;
    if (!inDuration(it)) return false;
    if (!terms.length) return true;
    const hay = haystack(it);
    if (terms.every(t => hay.includes(t))) return true;
    return !!(TR_HITS && TR_HITS.has(it.id));
  });
  if (skip) return rows;
  const dir = { date: (a, b) => (b.date || "").localeCompare(a.date || ""),
                dateA: (a, b) => (a.date || "").localeCompare(b.date || ""),
                title: (a, b) => a.title.localeCompare(b.title),
                dur: (a, b) => b.duration - a.duration,
                author: (a, b) => authorName(a.author).localeCompare(authorName(b.author))
                                  || (b.date || "").localeCompare(a.date || "") };
  return rows.sort(dir[F.sort] || dir.date);
}

/* ------------------------------------------------------------------ router */
/* A share and a pairing both carry their secret in the fragment, which is also
   where the router lives -- so the query is split off the route rather than
   being allowed to look like one, and consumed the moment it is read. */
function route() {
  const raw = location.hash.replace(/^#\/?/, "");
  const cut = raw.indexOf("?");
  const h = cut < 0 ? raw : raw.slice(0, cut);
  const params = new URLSearchParams(cut < 0 ? "" : raw.slice(cut + 1));
  const [head, ...rest] = h.split("/");
  return { name: head || "library", arg: decodeURIComponent(rest.join("/") || ""), params };
}

function openShare(where, key) {
  VIEWING = { key, endpoint: where, doc: null, sets: null };
  fetchProfile(where, key).then(got => {
    VIEWING = { key, endpoint: where, id: got.id, doc: got.doc, sets: null };
    VIEWING.sets = sharedSets();
    render();
  }).catch(e => { VIEWING = { key, endpoint: where, error: e.message }; render(); });
}

/* A link that arrived somewhere else.

   On iOS an app added to the home screen is not offered links to its own site --
   there is no manifest member or association file that changes this -- so a
   pairing code or a share link tapped in Messages opens Safari, which holds a
   different library with different storage. Nothing the page can do makes the
   link land in the app; what it can do is take one that is pasted in, which
   turns "this cannot be used here" into one extra step.

   It also never touches the address bar, so the key is not in the history even
   briefly. */
function takeLink(text) {
  const raw = String(text || "").trim();
  if (!raw) return "Nothing pasted.";
  let hash = "";
  if (raw.startsWith("#")) hash = raw;
  else {
    try { hash = new URL(raw).hash; }
    catch { hash = raw.includes("#") ? raw.slice(raw.indexOf("#")) : ""; }
  }
  const inner = hash.replace(/^#\/?/, "");
  const cut = inner.indexOf("?");
  const name = cut < 0 ? inner : inner.slice(0, cut);
  const params = new URLSearchParams(cut < 0 ? "" : inner.slice(cut + 1));
  if (name === "link" && params.get("p") && params.get("k")) {
    LINKING = { endpoint: params.get("e") || Sync.base(), id: params.get("p"),
                key: fromB64u(params.get("k")) };
    go("/link"); render();
    return "";
  }
  if (name === "p" && params.get("k")) {
    openShare(params.get("e") || Sync.base(), params.get("k"));
    go("/p"); render();
    return "";
  }
  return "That is not a pairing code or a share link.";
}

function pasteLink() {
  transferDialog("Paste a link",
    `<p class="note">A pairing code or a share link somebody has given you. Useful where
      a link opens in the browser rather than here — on iOS an app added to the home
      screen is never offered links to its own site, and the two keep separate
      libraries.</p>
     <textarea id="pasteBox" rows="3" aria-label="Link"
       placeholder="https://…#/p?e=…&amp;k=…"></textarea>
     <p class="note" id="pasteWhy">&nbsp;</p>`,
    `<button class="btn" data-act="ioClose">Cancel</button>
     <button class="btn primary" data-act="pasteGo">Open it</button>`);
}

/* An app on the home screen on iOS says so, and only there. Safari says false;
   everything else says nothing at all. */
const iosBrowser = () => navigator.standalone === false;

/* Taken out of the address bar as soon as it is in hand. A key left in the hash
   is a key in the history, in the next screenshot, and in whatever the browser
   syncs between machines. */
function consume(name) {
  try { history.replaceState(null, "", location.pathname + location.search + "#/" + name); }
  catch {}
}
function go(path) { location.hash = path; }

/* ------------------------------------------------------------------ render */
function render() {
  const r = route();
  // Who was typing, and where their caret was. `render` replaces the whole
  // view, so without this every redraw steals the caret -- and redraws happen
  // for reasons that have nothing to do with the reader: a catalogue page
  // landing, transcript hits arriving, a filter being applied.
  const active = document.activeElement;
  const activeId = active && active.id ? active.id : "";
  const caret = active && typeof active.selectionStart === "number"
    ? [active.selectionStart, active.selectionEnd] : null;
  // And *what* they had typed. The view rebuilds the search box from the filter
  // as it stands, which is the filter as of the last debounce -- so a redraw
  // landing mid-word puts the box back to the word before it. Redraws arrive
  // for reasons that have nothing to do with typing (a catalogue page, a
  // transcript hit), so the faster somebody types the more letters go missing.
  // What is in the box they are typing into is newer than anything this render
  // knows, and it wins.
  const typed = active && typeof active.value === "string"
    && /^(INPUT|TEXTAREA)$/.test(active.tagName) ? active.value : null;
  // Panels scroll inside themselves. The window's position says nothing about
  // where somebody is in a list of six hundred tags, and the box is a different
  // element after every redraw -- so it starts at the top unless it is told
  // otherwise, which is what "it jumps back" means to whoever is choosing tags.
  const boxes = new Map();
  for (const box of $$("[data-panel] .fbody")) {
    const key = box.closest("[data-panel]")?.dataset.panel;
    if (key && box.scrollTop) boxes.set(key, box.scrollTop);
  }
  const key = `${r.name}/${r.arg}`;
  const moved = key !== CURRENT_ROUTE;
  // Leaving a view: remember the place before the view that holds it is gone.
  // Staying on one -- a filter changed, a page of the catalogue landed -- means
  // holding the place across a redraw that would otherwise collapse the grid
  // back to its first few chunks.
  // A secret in the fragment is taken in hand and struck out of the address bar
  // before the first paint that could show it.
  if (r.name === "link" && r.params.get("p")) {
    LINKING = { endpoint: r.params.get("e") || Sync.base(), id: r.params.get("p"),
                key: fromB64u(r.params.get("k") || "") };
    consume("link");
  }
  if (r.name === "p" && r.params.get("k")) {
    openShare(r.params.get("e") || Sync.base(), r.params.get("k"));
    consume("p");
  }
  const mark = CURRENT_ROUTE === null ? null : scrollMark();
  if (moved && CURRENT_ROUTE) SCROLL.set(CURRENT_ROUTE, mark);
  const main = $("#main");
  const views = { library: viewLibrary, item: viewItem, author: viewAuthor,
                  authors: viewAuthors, favourites: viewFavourites,
                  playlists: viewPlaylists, playlist: viewPlaylist,
                  queue: viewQueue, offline: viewOffline,
                  history: viewHistory, notes: viewNotes,
                  profile: viewProfile, link: viewLink, p: viewShared };
  // Fetch what this view needs, then draw again when it lands. Rendering first
  // means the page appears immediately and fills in, rather than waiting.
  if (r.name === "item") {
    const it = BY_ID.get(r.arg);
    if (it && !DETAIL.has(it.author)) loadDetail(it.author).then(render);
  }
  // The creator's page wants the same shard: their picture brief travels in it.
  if (r.name === "author" && r.arg && !DETAIL.has(r.arg)) loadDetail(r.arg).then(render);
  if (r.name === "library" && F.q) { loadSearch(); refreshTranscriptHits(); }
  Grid.stop();
  startPass();
  try {
    main.innerHTML = (views[r.name] || viewLibrary)(r.arg);
  } finally {
    endPass();
  }
  if (r.name === "library" || r.name === "author" || r.name === "favourites") {
    Grid.start(LAST_ROWS);
  } else if (r.name === "authors") {
    Grid.start(AUTHOR_ROWS, authorCard);
  }
  $$(".navlinks a").forEach(a =>
    a.classList.toggle("active", a.getAttribute("href") === "#/" + (r.name === "library" ? "" : r.name)));
  paintMe();
  // `toggle` does not bubble, so the facet panels are wired on every render.
  $$("details.facet").forEach(d =>
    d.addEventListener("toggle", () => { FOPEN[d.dataset.panel] = d.open; }));
  Player.paint();
  paintProgress();
  if (r.name === "item") wireItem(r.arg);
  if (r.name === "offline") paintStorage();

  if (boxes.size) {
    for (const panel of $$("[data-panel]")) {
      const top = boxes.get(panel.dataset.panel);
      const box = top && panel.querySelector(".fbody");
      if (box) box.scrollTop = top;
    }
  }

  if (activeId) {
    const back = document.getElementById(activeId);
    if (back) {
      if (back !== document.activeElement) back.focus({ preventScroll: true });
      // Value before caret: assigning to `value` moves the caret to the end,
      // so restoring the selection first would undo itself.
      const drawn = back.value;
      if (typed !== null && drawn !== typed) {
        back.value = typed;
        // The filter was applied to what this render knew, which is now behind
        // what is on screen. Normally the keystroke that arrived during the
        // render has its own debounce pending and will settle it -- but if the
        // last letter landed *inside* the render, nothing is pending and the
        // box would sit there showing a word nothing had searched for.
        back.dispatchEvent(new Event("input", { bubbles: true }));
      }
      if (caret && typeof back.setSelectionRange === "function") {
        try { back.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ }
      }
    }
  }

  if (!moved) {
    // Same view, redrawn. Put the reader back where they were.
    if (mark && (mark.y || mark.chunks > 1)) scrollBack(mark);
  } else if (KEEPS_PLACE.has(r.name)) {
    scrollBack(SCROLL.get(key));
  } else {
    window.scrollTo(0, 0);      // opening something is a move forward
  }
  CURRENT_ROUTE = key;
}

/* What the browser has actually granted, and how much room is left. Both are
   questions only it can answer, so the line is filled in after the page draws
   rather than guessed at while rendering. */
async function paintStorage() {
  const note = $("#storageNote");
  if (!note || !navigator.storage) return;
  const parts = [];
  try {
    if (await navigator.storage.persisted?.()) parts.push("storage is persistent");
    else parts.push("storage may be evicted when space runs short");
  } catch {}
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (quota) parts.push(`${(usage / 1073741824).toFixed(2)} of `
      + `${(quota / 1073741824).toFixed(1)} GB used`);
  } catch {}
  if (parts.length) note.textContent = ` · ${parts.join(" · ")}`;
}

/* Kept as a name: every redraw now holds the reader's place and their caret,
   so a filter click is an ordinary render. */
function rerender() { render(); }

/* Typing does not rebuild the page.

   Redrawing everything on a keystroke meant the search box itself was destroyed
   and made again between letters: the caret had to be put back, and anything
   typed while the browser was busy landed on an element that was no longer in
   the document. What a search actually changes is the results, the count and the
   facet counts -- so those are what it redraws, and the box somebody is typing
   into is left alone. */
function refilter() {
  if (route().name !== "library") { rerender(); return; }
  const main = $("#main");
  if (!main || !main.querySelector(".controls")) { rerender(); return; }
  // The facet column is replaced, and a panel's own find-box may be in it.
  const active = document.activeElement;
  const held = active && active.id && main.contains(active)
    ? { id: active.id, value: active.value,
        caret: typeof active.selectionStart === "number"
          ? [active.selectionStart, active.selectionEnd] : null }
    : null;
  startPass();
  try {
    const rows = collapseVariants(filtered());
    LAST_ROWS = rows;
    const count = main.querySelector(".count");
    if (count) {
      const folded = rows.reduce((n, r) => n + (r._cuts ? r._cuts - 1 : 0), 0);
      const head = count.firstChild;
      const text = `${rows.length} of ${DATA.items.length}${
        folded ? ` · ${folded} alternate cut(s) folded in` : ""} `;
      if (head && head.nodeType === 3) head.nodeValue = text;
    }
    const facets = main.querySelector(".facets");
    if (facets) {
      facets.innerHTML = facetBar() + facetPanels();
      for (const d of facets.querySelectorAll("details.facet")) {
        d.addEventListener("toggle", () => { FOPEN[d.dataset.panel] = d.open; });
      }
    }
    const saved = main.querySelector(".saved");
    if (saved) saved.outerHTML = savedRow();
    Grid.stop();
    const grid = main.querySelector("#grid");
    if (rows.length && grid) Grid.start(rows);
    else rerenderGridArea(main, rows);
  } finally {
    endPass();
  }
  if (held && !document.getElementById(held.id)?.isSameNode(active)) {
    const back = document.getElementById(held.id);
    if (back) {
      back.focus({ preventScroll: true });
      if (typeof back.value === "string" && back.value !== held.value) back.value = held.value;
      if (held.caret && typeof back.setSelectionRange === "function") {
        try { back.setSelectionRange(held.caret[0], held.caret[1]); } catch { /* not text */ }
      }
    }
  }
}

/* The one case the in-place update cannot do: a result set that has just become
   empty, or just stopped being empty, changes which element is there at all. */
function rerenderGridArea(main, rows) {
  const grid = main.querySelector("#grid"), empty = main.querySelector(".empty");
  if (rows.length && !grid) { rerender(); return; }
  if (!rows.length && !empty) { rerender(); return; }
}

/* Triggers and compulsions say what a recording will do to you, which is the one
   thing a browser of a hypnosis library may not want spoiled in a grid. */
/* Chips in namespace order, each kind kept together.

   Read as one run, "(fem) (man) (Fixation) (Subliminals) (Bondage)" is five
   unrelated facts wearing the same coat: who is speaking, who is spoken to, how
   it was made, and what happens in it. Grouped and tinted by kind, the shape of
   an entry is legible before a word of it is read -- and the tint does the work
   the "Voice: " prefix used to do on a chip that no longer shows one. */
function tagGroups(tags) {
  const by = new Map();
  for (const t of tags) {
    const kind = tagKind(t);
    if (!by.has(kind)) by.set(kind, []);
    by.get(kind).push(t);
  }
  return KINDS.map(k => [k, by.get(k.key) || []]).filter(([, v]) => v.length);
}

/* `label` puts the kind's name before its group -- worth the room on an item
   page, never on a card. */
function chips(tags, { label = false, extra = "", counts = null } = {}) {
  const tally = t => {
    const n = counts?.get(t);
    return n ? `<i>${n}</i>` : "";
  };
  const note = t => {
    const n = counts?.get(t);
    return n ? `${n} recording${n === 1 ? "" : "s"}` : "";
  };
  return tagGroups(tags).map(([kind, list]) =>
    `<span class="tgrp">${label ? `<b class="tgl">${esc(kind.label)}</b>` : ""}${
      list.map(t => `<span class="tag k-${esc(kind.key)}" data-act="tag"
         data-tag="${esc(t)}" title="${esc(tagTitle(t, note(t)))}"
         >${esc(tagValue(t))}${tally(t)}</span>`)
        .join("")}</span>`).join("") + extra;
}

/* What a creator makes, counted over everything of theirs.

   Memoised because the creators page asks for all of them at once and the
   answer only moves when the catalogue does -- `rebuildItems` clears it. The
   spoiler gate applies here as everywhere: a creator's commonest triggers are
   still triggers, and a summary of their work is not a place to give them away.
*/
const AUTHOR_TAGS = new Map();
let authorTagsSpoil = null;
function authorTagCounts(id) {
  // The gate is a setting the reader can change, so it is part of the key.
  if (authorTagsSpoil !== F.spoil) { AUTHOR_TAGS.clear(); authorTagsSpoil = F.spoil; }
  const held = AUTHOR_TAGS.get(id);
  if (held) return held;
  const rows = BY_AUTHOR.get(id) || [];
  const counts = new Map();
  for (const it of rows) {
    for (const tag of visibleTags(it)) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  const answer = { counts, files: rows.length };
  AUTHOR_TAGS.set(id, answer);
  return answer;
}

const byCount = (a, b) => b[1] - a[1] || tagValue(a[0]).localeCompare(tagValue(b[0]));

/* A card's worth: enough of each kind to say who this is, not enough to become
   a list. One voice, who they speak to, how it is made, and what it is about. */
const CARD_TOP = { voice: 1, audience: 2, production: 1, content: 5 };
function authorCardTags(id) {
  const { counts } = authorTagCounts(id);
  const out = [];
  for (const [kind, many] of Object.entries(CARD_TOP)) {
    out.push(...[...counts].filter(([t]) => tagKind(t) === kind)
      .sort(byCount).slice(0, many).map(([t]) => t));
  }
  return out;
}

/* On their own page there is room for what actually recurs: carried by more
   than one recording, and by more than a tenth of them. Both tests matter --
   a tenth alone lets a single file speak for a creator with five, and "more
   than one" alone lets a one-off ride along on a creator with four hundred. */
function authorCommonTags(id) {
  const { counts, files } = authorTagCounts(id);
  return [...counts].filter(([, n]) => n > 1 && n > files * 0.1)
    .sort(byCount);
}

/* Which of several recordings sharing a title this one is.

   295 cards in this library share a title with another by the same creator --
   a release beside its no-binaural mix, seven parts of a series all called
   "Irresistible Urge". They are different recordings, and a card showing only
   the title makes them read as the same one listed twice. `variant` is the
   field that says which; it was being carried all the way to the browser and
   then not drawn.

   The creator usually repeats the title inside it -- "Obeying your fembot [No
   binaural]" -- so the part that differs is what gets shown. */
function variantOf(it) {
  const v = String(it.variant || "").trim();
  if (!v) return "";
  const title = String(it.title || "").trim();
  if (v.toLowerCase() === title.toLowerCase()) return "";
  const tail = v.toLowerCase().startsWith(title.toLowerCase())
    ? v.slice(title.length).trim() : v;
  return tail.replace(/^[\s\-–—:,]+/, "").trim() || v;
}

function realTags(it) { return it.tags.filter(t => !isDerivedTag(t)); }
/* Two cuts of one recording -- a bare-voice mix beside a scored one, a
   no-binaural edition beside the full one -- are one thing to choose and two
   things to play. The grid should offer it once; the item page is where you
   pick which cut.

   Grouped on creator plus the title with its punctuation and case removed,
   which is what "the same recording" means here: `variant` exists precisely
   because the titles are identical. An item with no variant groups only with
   itself, so nothing that is merely similarly named gets folded. */
function variantKey(it) {
  return it.author + "\u0000" +
    String(it.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function variantsOf(it) {
  const key = variantKey(it);
  return DATA.items.filter(x => variantKey(x) === key)
    .sort((a, b) => (a.variant || "").localeCompare(b.variant || "")
                    || String(a.id).localeCompare(String(b.id)));
}

/* One row per recording, keeping the rest reachable from it. The cut with no
   variant named is the plain edition and leads; failing that the longest, on
   the grounds that the fuller mix is the one somebody means. */
function collapseVariants(rows) {
  const groups = new Map();
  for (const it of rows) {
    const key = variantKey(it);
    const seen = groups.get(key);
    if (!seen) { groups.set(key, [it]); continue; }
    seen.push(it);
  }
  const out = [];
  for (const group of groups.values()) {
    if (group.length === 1) { out.push(group[0]); continue; }
    const lead = group.find(x => !variantOf(x))
      || group.slice().sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
    out.push(Object.assign(Object.create(Object.getPrototypeOf(lead)), lead,
                           { _cuts: group.length }));
  }
  return out;
}

function seriesOf(it) {
  if (!it.series) return [];
  return DATA.items.filter(x => x.series === it.series && x.author === it.author)
    .sort((a, b) => (a.seriesIndex || 1e9) - (b.seriesIndex || 1e9)
                    || String(a.title).localeCompare(String(b.title)));
}

function visibleTags(it) {
  const tags = realTags(it);
  return F.spoil ? tags : tags.filter(t => !SPOILER_KINDS.has(tagKind(t)));
}
function cardTags(it) { return visibleTags(it).slice(0, 6); }
function hiddenTagCount(it) { return realTags(it).length - visibleTags(it).length; }

/* The heart. Two glyphs rather than one glyph in two colours, because a filled
   heart and an outlined one are told apart by anybody, including whoever is
   reading this in monochrome or with the page's colours overridden.

   Text presentation is asked for explicitly: left alone, a browser is entitled
   to swap a black heart for a red emoji picture, which is somebody else's
   design sitting in the middle of this one. */
const HEART_ON = "♥︎", HEART_OFF = "♡";

function heartState(what, id) {
  const on = Favourites.has(what, id);
  const noun = what === "author" ? "creator" : "recording";
  return { on, glyph: on ? HEART_ON : HEART_OFF, word: on ? "Favourited" : "Favourite",
           say: on ? `Remove this ${noun} from favourites` : `Add this ${noun} to favourites` };
}

/* `label` puts the word beside the heart: room enough on an item or creator
   page, never on a card. Without it the button's name comes from `aria-label`;
   with it, from the word itself, which is what somebody saying "favourite"
   to a voice control expects to hit. */
function heart(what, id, { label = false } = {}) {
  const s = heartState(what, id);
  return `<button class="${label ? "btn " : ""}heart${s.on ? " on" : ""}" data-act="fav"
    data-what="${esc(what)}" data-fid="${esc(id)}" aria-pressed="${s.on}"
    title="${esc(s.say)}"${label ? "" : ` aria-label="${esc(s.say)}"`}><span class="gl"
    aria-hidden="true">${s.glyph}</span>${label ? `<span class="wd">${s.word}</span>` : ""}</button>`;
}

/* Liking something changes that button and nothing else on the page, so the
   button is what gets repainted. A full redraw would rebuild the grid and the
   reader's place in it to move one glyph. */
function paintHearts(what, id) {
  const s = heartState(what, id);
  for (const b of $$("button.heart")) {
    if (b.dataset.what !== what || b.dataset.fid !== id) continue;
    b.classList.toggle("on", s.on);
    b.setAttribute("aria-pressed", String(s.on));
    b.title = s.say;
    if (b.hasAttribute("aria-label")) b.setAttribute("aria-label", s.say);
    const gl = b.querySelector(".gl"); if (gl) gl.textContent = s.glyph;
    const wd = b.querySelector(".wd"); if (wd) wd.textContent = s.word;
  }
}

/* One line for a card. `summary` is written to be exactly this -- one sentence,
   read beside a picture in a grid -- so it is used whole and unclamped. Only
   where a recording has none does anything get cut, and then it is cut here
   rather than by the stylesheet, so what the reader sees ends at a word and
   says that it ended early. */
function itemBlurb(it) {
  if (it.summary) return it.summary;
  // Detail is fetched per creator and may not be loaded on a library grid.
  // That is fine: this is the fallback for the few recordings with no summary,
  // and an absent line is better than a wrong one.
  const d = detailOf(it);
  return clip(stripTags(d.description || d.synopsis || ""), 150);
}

function card(it) {
  const a = DATA.authors.find(x => x.id === it.author);
  const off = Offline.has(it), q = Offline.isQueued(it.id);
  return `<div class="card" data-id="${esc(it.id)}">
    <a class="thumb" href="#/item/${encodeURIComponent(it.id)}">
      ${it.cover ? `<img loading="lazy" src="${esc(it.cover)}" alt="">` : ""}
      ${it.audio ? `<button class="play" data-act="play" title="Play">▶</button>` : ""}
    </a>
    <div class="body">
      <h3><a href="#/item/${encodeURIComponent(it.id)}">${esc(it.title)}</a>${
        it.titleGenerated ? genMark(["title"], "title") : ""}</h3>
      ${it._cuts ? `<div class="variant">${it._cuts} cuts</div>`
        : variantOf(it) ? `<div class="variant">${esc(variantOf(it))}</div>` : ""}
      <div class="meta">
        <a class="who" href="#/author/${encodeURIComponent(it.author)}">${esc(a?.name || it.author)}</a>
        ${it.date ? `<span>${esc(it.date)}</span>` : ""}
        ${it.duration ? `<span>${fmtDur(it.duration)}</span>` : ""}
        ${it.hasVideo ? `<span class="pill">video</span>` : ""}
        ${it.hasTranscript ? `<span class="pill">transcript</span>` : ""}
        ${off ? `<span class="pill ok">offline</span>` : q ? `<span class="pill">queued</span>` : ""}
      </div>
      ${VIEWING ? sharedMark(it.id) : followedMark(it.id)}
      ${itemBlurb(it) ? `<p class="note blurb">${esc(itemBlurb(it))}</p>` : ""}
      <div class="tags">${chips(cardTags(it))}
        ${hiddenTagCount(it) ? `<span class="tag f-none"
          title="Triggers and compulsions — tick “show triggers” to see them"
          >+${hiddenTagCount(it)} hidden</span>` : ""}</div>
      <div class="cardacts">
        ${it.audio ? `<button class="btn sm" data-act="enqueue">+ Queue</button>
        <button class="btn sm" data-act="addto">+ List</button>
        ${off ? `<button class="btn sm" data-act="unsave">Remove</button>`
              : `<button class="btn sm" data-act="save"${q ? " disabled" : ""}>${q ? "Queued" : "Save"}</button>`}` : ""}
        ${heart("item", it.id)}
      </div>
    </div></div>`;
}

/* Searches somebody meant to come back to.

   A filter that took six clicks to build is a filter nobody rebuilds; they
   either keep the tab open or stop using it. A saved search is the whole search
   -- the words, the chips, the sort, the duration -- under a name, and applying
   one replaces the search being made without touching the standing filter. */
const Searches = {
  all() { const v = load(K.searches, null); return Array.isArray(v) ? v : []; },
  write(rows) { save(K.searches, rows); Sync.soon(); },
  get(id) { return this.all().find(r => r.id === id); },
  snapshot() {
    const copy = f => ({ any: [...f.any], all: [...f.all], not: [...f.not] });
    return { q: F.q, author: F.author, sort: F.sort, spoil: !!F.spoil, tr: !!F.tr,
             off: !!F.off, dur: { min: F.dur.min, max: F.dur.max },
             tags: copy(F.tags), cats: copy(F.cats), meta: copy(F.meta) };
  },
  add(name) {
    const rows = this.all();
    const row = { id: newListId(), name: String(name || "Search").slice(0, 60),
                  created: nowISO(), find: this.snapshot() };
    rows.push(row); this.write(rows);
    return row;
  },
  apply(id) {
    const row = this.get(id);
    if (!row || !row.find) return false;
    const f = row.find;
    // Written into the object every view already holds rather than replacing it.
    F.q = String(f.q || ""); F.author = String(f.author || "");
    F.sort = String(f.sort || "date");
    F.spoil = !!f.spoil; F.tr = !!f.tr; F.off = !!f.off;
    F.dur = { min: f.dur?.min ?? "", max: f.dur?.max ?? "" };
    for (const key of ["tags", "cats", "meta"]) {
      const held = f[key] && typeof f[key] === "object" ? f[key] : {};
      F[key] = { any: [...(held.any || [])], all: [...(held.all || [])], not: [...(held.not || [])] };
    }
    saveFilters();
    return true;
  },
  /* Remembered as forgotten, so another device does not hand it back. The same
     shape a deleted playlist uses, for the same reason. */
  remove(id) {
    this.write(this.all().filter(r => r.id !== id));
    const gone = this.gone(); gone[id] = nowISO(); this.writeGone(gone);
  },
  gone() {
    const v = load(K.searchesGone, null);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  },
  writeGone(gone) {
    const cut = Date.now() - TOMB_DAYS * DAY;
    for (const [id, t] of Object.entries(gone)) if (favTime(t) && favTime(t) < cut) delete gone[id];
    save(K.searchesGone, gone);
  },
  take(rows, removed) {
    const held = this.all(), byId = new Map(held.map(r => [r.id, r]));
    const gone = this.gone();
    let n = 0;
    for (const [id, when] of Object.entries(removed || {})) {
      if (!gone[id] || favTime(gone[id]) < favTime(when)) gone[id] = when;
    }
    for (const row of rows || []) {
      if (!row || typeof row !== "object" || typeof row.id !== "string") continue;
      if (favTime(gone[row.id]) > favTime(row.created)) continue;   // forgotten since
      const was = byId.get(row.id);
      if (was && favTime(was.created) >= favTime(row.created)) continue;
      if (was) Object.assign(was, row); else { held.push(row); byId.set(row.id, row); }
      n++;
    }
    this.writeGone(gone);
    this.write(held.filter(r => !(favTime(gone[r.id]) > favTime(r.created))));
    return n;
  },
};

/* Enough of a fingerprint to tell "this is what is already published" from
   "this is not". Not a secure hash and not asked to be one: it compares a
   string with itself, and runs where crypto.subtle may not exist. */
function markOf(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/* What a saved search holds, in words, for the thing somebody hovers before
   pressing it. */
function searchWords(row) {
  const f = row.find || {};
  const bits = [];
  if (f.q) bits.push(`“${f.q}”`);
  for (const key of ["tags", "cats", "meta"]) {
    for (const m of MODES) {
      for (const v of (f[key] || {})[m] || []) {
        bits.push(`${MODE_LABEL[m]} ${key === "meta" ? metaLabel(v) : tagValue(v)}`);
      }
    }
  }
  if (f.author) bits.push(authorName(f.author));
  if (f.dur?.min || f.dur?.max) bits.push(`${f.dur.min || "0"}–${f.dur.max || "∞"} min`);
  if (f.off) bits.push("offline only");
  return bits.length ? bits.join(" · ") : "everything";
}

function savedRow() {
  const rows = Searches.all();
  return `<div class="saved">
    <button class="btn sm" data-act="searchSave">Save this search</button>
    ${rows.map(r => `<span class="tag k-meta saved1" data-act="searchApply"
      data-id="${esc(r.id)}" role="button" tabindex="0"
      title="${esc(searchWords(r))}">${esc(r.name)}<i data-act="searchDrop"
      data-id="${esc(r.id)}" title="Forget this search">✕</i></span>`).join("")}
  </div>`;
}

/* Panel state that must survive the re-render every chip click triggers.
   Keyed by section: "tags:audience", "tags:content", "cats". */
const FQ = {};
const FOPEN = {};

function facetPanel(key, kind, label, field, note) {
  const id = kind ? `${key}:${kind}` : key;
  const chosen = facetChosen(key, kind);
  const belongs = kind ? (v => tagKind(v) === kind) : (() => true);

  /* Counted against the search being made -- "how many would this give me" --
     except while the standing filter is what is being set, where the answer is
     about the whole library. Counting those against the current search would
     hide the very chip somebody is reaching for: you cannot exclude an audience
     for ever from a page that is not showing it at the moment. */
  const counts = new Map();
  for (const it of filtered(key)) for (const v of it[field]) counts.set(v, (counts.get(v) || 0) + 1);

  const all = [...new Set(DATA.items.flatMap(i => i[field]))]
    .filter(v => belongs(v) && !isDerivedTag(v))
    .sort((a, b) => tagValue(a).localeCompare(tagValue(b)));
  if (!all.length) return "";

  const loose = chosen.filter(c => !c.pinned).length;
  const q = (FQ[id] || "").trim().toLowerCase();
  const matching = q ? all.filter(v => v.toLowerCase().includes(q)) : all;

  const chip = v => {
    const st = facetOf(key, v), n = counts.get(v) || 0;
    // Same tint here as on a card, so the panel and the cards agree about what
    // kind of thing a chip is.
    return `<button class="tag k-${esc(tagKind(v))}${st ? " f-" + st : ""}${
      n ? "" : " f-none"}" data-act="facet"
      data-key="${esc(key)}" data-v="${esc(v)}"
      title="${esc(tagTitle(v, `${n} match${n === 1 ? "" : "es"}`))}"
      >${esc(tagValue(v))}<i>${n}</i></button>`;
  };

  /* Banded by how many recordings carry the tag, because an alphabetical list
     of six hundred puts "Amnesia" (1,204 of them) next to "Aquarium" (one), and
     the two are not the same kind of choice. Alphabetical inside a band, since
     within one that is how you find a particular tag.

     A tag matching nothing right now is dropped -- it leads nowhere -- unless
     it is one of the chosen, which must stay reachable to be un-chosen. */
  const bands = [
    ["More than 100", n => n > 100],
    ["51 to 100", n => n > 50],
    ["3 to 50", n => n > 2],
    ["1 or 2", n => n > 0],
  ];
  /* A tag matching nothing is dropped, unless it is already chosen -- it has to
     stay reachable to be un-chosen -- or unless somebody has typed its name,
     which is an explicit request for that one. Without that last case a value
     absent from the current results cannot be selected, and therefore cannot be
     pinned, which is exactly when somebody wants to pin it. */
  const left = matching.filter(v => (counts.get(v) || 0) > 0 || facetOf(key, v) || q);
  const groups = [];
  let rest = left;
  for (const [name, holds] of bands) {
    const mine = rest.filter(v => holds(counts.get(v) || 0));
    rest = rest.filter(v => !holds(counts.get(v) || 0));
    if (mine.length) groups.push([name, mine]);
  }
  if (rest.length) groups.push([q ? "Matching nothing right now" : "Chosen, matching nothing", rest]);

  const body = groups.map(([name, values]) =>
    `<div class="band"><h4>${esc(name)}<i>${values.length}</i></h4>
       <div class="tags">${values.map(chip).join("")}</div></div>`).join("");

  return `<details class="facet" data-panel="${esc(id)}"${FOPEN[id] ? " open" : ""}>
    <summary>${esc(label)}${chosen.length ? `<span class="cnt">${chosen.length}</span>` : ""}
      <span class="note">${note ? esc(note) + " · " : ""}${all.length}</span></summary>
    <div class="fbody">
      <div class="frow">
        ${all.length > 24 ? `<input class="fq" id="fq-${esc(id)}" type="search"
          placeholder="Find ${esc(label.toLowerCase())}…" value="${esc(FQ[id] || "")}">` : ""}
        <button class="btn sm" data-act="facetClear" data-key="${esc(key)}"
          data-kind="${esc(kind || "")}"${loose ? "" : " disabled"}
          >Clear${loose ? ` (${loose})` : ""}</button>
      </div>
      <p class="note">Click to cycle: <b class="f-any">any</b> (at least one) →
        <b class="f-all">all</b> (required) → <b class="f-not">not</b> (excluded) → off.
        Alt-click steps backwards.</p>
      ${body || `<p class="note">Nothing matches “${esc(FQ[id] || "")}”.</p>`}
    </div></details>`;
}

/* The panel for what the reader has done with a recording. Four values, so none
   of the banding a tag list needs -- and its own tint, because these are not
   tags and should not read as a namespace somebody forgot to colour. */
function metaPanel() {
  const sets = metaSets();
  const counts = {};
  for (const it of filtered("meta")) {
    for (const k of metaOf(it, sets)) counts[k] = (counts[k] || 0) + 1;
  }
  const chosen = facetChosen("meta", null);
  const chip = v => {
    const st = facetOf("meta", v), n = counts[v] || 0;
    return `<button class="tag k-meta${st ? " f-" + st : ""}${n ? "" : " f-none"}"
      data-act="facet" data-key="meta" data-v="${esc(v)}"
      title="${esc(`${metaWhy(v)} — ${n} match${n === 1 ? "" : "es"}`)}"
      >${esc(metaLabel(v))}<i>${n}</i></button>`;
  };
  const whose = VIEWING ? `what ${esc(VIEWING.doc?.profile?.name || "they")} has done with it`
                        : "what you have done with it";
  return `<details class="facet" data-panel="meta"${FOPEN.meta ? " open" : ""}>
    <summary>Library${chosen.length ? `<span class="cnt">${chosen.length}</span>` : ""}
      <span class="note">${whose} · ${metaKeys().length}</span></summary>
    <div class="fbody">
      <div class="frow">
        <button class="btn sm" data-act="facetClear" data-key="meta" data-kind=""${
          chosen.filter(c => !c.pinned).length ? "" : " disabled"}>Clear${
          chosen.filter(c => !c.pinned).length ? ` (${chosen.filter(c => !c.pinned).length})` : ""
        }</button>
      </div>
      <p class="note">Click to cycle: <b class="f-any">any</b> (at least one) →
        <b class="f-all">all</b> (required) → <b class="f-not">not</b> (excluded) → off.
        Alt-click steps backwards. Nothing here leaves the device.</p>
      <div class="band"><div class="tags">${metaKeys().map(chip).join("")}</div></div>
    </div></details>`;
}

/* A pushpin, drawn rather than borrowed from a font: the glyphs that look like
   one are emoji, and this sits inside a chip at eight pixels. */
const PIN = `<svg viewBox="0 0 12 12" aria-hidden="true" focusable="false"
  ><path d="M6 .8a2.9 2.9 0 0 1 1.2 5.5l.5 4.9H4.3l.5-4.9A2.9 2.9 0 0 1 6 .8z"/></svg>`;

/* What is chosen, in the sections it was chosen from, each chip carrying the pin
   that decides whether it belongs to this search or to every search.
   
   A pinned chip has no ✕ and Clear does not reach it. Taking one off is
   unpinning it first, which is one more press than an ordinary chip needs and
   exactly the point: these are the ones somebody meant to stop thinking about. */
function facetBar() {
  const sections = [
    ...KINDS.map(k => ["tags", k.key, k.label, !!k.spoiler]),
    ["cats", null, "Categories", false],
    ["meta", null, "Library", false],
  ];
  const rows = sections.map(([key, kind, label, spoiler]) => {
    const chosen = facetChosen(key, kind);
    if (!chosen.length) return "";
    if (spoiler && !F.spoil) {
      return `<div class="fsel"><span class="note">${esc(label)}:</span>
        <span class="note">${chosen.length} hidden — tick “show triggers”</span></div>`;
    }
    const mine = key === "meta";
    const loose = chosen.filter(c => !c.pinned).length;
    return `<div class="fsel"><span class="note">${esc(label)}:</span>
      ${chosen.map(c => `<span class="tag ${
        mine ? "k-meta" : `k-${esc(tagKind(c.v))}`} f-${c.m} chip${c.pinned ? " pinned" : ""}">
        <button class="pin" data-act="facetPin" data-key="${esc(key)}" data-v="${esc(c.v)}"
          aria-pressed="${c.pinned}" title="${c.pinned
            ? "Pinned to every search — press to unpin"
            : "Pin to every search"}">${PIN}</button>
        <span class="lab">${MODE_LABEL[c.m]} · ${esc(mine ? metaLabel(c.v) : tagValue(c.v))}</span>
        ${c.pinned ? "" : `<button class="off" data-act="facetOff" data-key="${esc(key)}"
          data-v="${esc(c.v)}" title="Remove">✕</button>`}
      </span>`).join("")}
      <button class="btn sm" data-act="facetClear" data-key="${esc(key)}"
        data-kind="${esc(kind || "")}"${loose ? "" : " disabled"}>Clear</button></div>`;
  }).join("");
  return rows ? pinLine() + rows : "";
}

/* Said once, above the chips, and no larger than it needs to be: the pins on
   the chips are already saying which ones. */
function pinLine(hidden) {
  const n = alwaysCount();
  if (!n) return "";
  const asleep = ALWAYS.off;
  return `<p class="pinline${asleep ? " asleep" : ""}">${PIN}
    <span>${asleep ? "Pinned filters are suspended" : `${n} pinned, on every search`}${
      hidden ? ` · ${hidden} hidden here` : ""}</span>
    <button class="btn sm" data-act="alwaysSuspend">${asleep ? "Resume" : "Suspend"}</button></p>`;
}

function facetPanels() {
  const out = [];
  for (const k of KINDS) {
    if (k.spoiler && !F.spoil) continue;
    out.push(facetPanel("tags", k.key, k.label, "tags", k.note));
  }
  out.push(facetPanel("cats", null, "Categories", "categories"));
  // Last, and after the sections that describe the recording: this one
  // describes the reader's relationship to it.
  out.push(metaPanel());
  return out.join("");
}

/* The grid, in chunks, with the off-screen ones taken back out of the DOM.

   A library outgrows the browser before it outgrows the disk: 4,828 cards, each
   with an image and a dozen elements, is a page that takes seconds to lay out
   and megabytes of memory to hold. So only a window of the results is ever
   real. Chunks are appended as the reader approaches the end, and a chunk that
   has scrolled well out of view is replaced by a spacer of exactly the height
   it occupied -- measured before it is removed, because cards are not all the
   same height and guessing would make the page jump under the reader.

   Everything on a card is reached by event delegation, so a card that is added
   or removed needs no wiring either way. */
const CHUNK = 60;          // cards appended at a time
const KEEP = 3;            // chunks kept around the viewport, each side

/* The catalogue: held in the browser, checked against the build, page by page.

   A library's item list is the one thing every view needs and the one thing
   large enough to be felt. Fetching it on every visit means waiting on every
   visit, so it is kept in IndexedDB and drawn from there immediately -- before
   anything touches the network.

   What arrives from the network afterwards is `data/manifest.json`, a hash of
   every data file. Only the files whose hash has moved are fetched again, and
   because each page is stored under its own name, a changed page replaces its
   own entries and nothing else. A rebuild that touched one recording costs one
   page rather than the whole catalogue.

   Every part is optional. A private window, cleared site data, or a browser
   that refuses the database all behave like a first visit: fetch, draw as it
   arrives, store nothing. The service worker keeps its own copy of each file,
   which is what makes this work with no network at all. */
/* The version of the store itself. Bump it when the *shape* of what is kept
   here changes, and every client drops what it holds and rebuilds from the
   network -- IndexedDB hands the upgrade the old database, and the handler
   below empties it. The build has its own version of the same idea in the
   manifest, for when the files change shape while this reader does not. */
const CATALOG_SCHEMA = 2;

const Catalog = {
  DB: "hypnotica", STORE: "files", _db: undefined,

  open() {
    if (this._db !== undefined) return this._db;
    this._db = new Promise(resolve => {
      let request;
      try { request = indexedDB.open(this.DB, CATALOG_SCHEMA); }
      catch { return resolve(null); }
      request.onupgradeneeded = () => {
        const db = request.result;
        // Whatever was here was written by a reader that no longer exists.
        // v1 kept one blob per build; v2 keeps one record per file.
        for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
        db.createObjectStore(this.STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    }).catch(() => null);
    return this._db;
  },

  async _tx(mode, run) {
    const db = await this.open();
    if (!db) return null;
    try {
      return await new Promise(resolve => {
        const store = db.transaction(this.STORE, mode).objectStore(this.STORE);
        run(store, resolve);
      });
    } catch { return null; }
  },

  /* Every stored file: name -> {hash, data}. One read, not one per page. */
  async all() {
    const out = new Map();
    await this._tx("readonly", (store, done) => {
      const keys = store.getAllKeys(), values = store.getAll();
      values.onsuccess = () => {
        (keys.result || []).forEach((key, n) => {
          const row = (values.result || [])[n];
          if (row && row.hash) out.set(String(key), row);
        });
        done(true);
      };
      values.onerror = () => done(false);
    });
    return out;
  },

  put(name, hash, data) {
    return this._tx("readwrite", (store, done) => {
      store.put({ hash, data }, name);
      done(true);
    });
  },

  /* Everything, for when the build says what is held is the wrong shape. */
  clear() {
    return this._tx("readwrite", (store, done) => {
      const keys = store.getAllKeys();
      keys.onsuccess = () => {
        for (const key of keys.result || []) store.delete(key);
        done(true);
      };
      keys.onerror = () => done(false);
    });
  },

  drop(names) {
    if (!names.length) return null;
    return this._tx("readwrite", (store, done) => {
      for (const name of names) store.delete(name);
      done(true);
    });
  },
};

/* Items, by the file they came from, so one file can be replaced on its own. */
const PAGES = new Map();

function pageNames() {
  return [...PAGES.keys()].sort((a, b) =>
    (Number(a.match(/(\d+)/)?.[1] ?? 0)) - (Number(b.match(/(\d+)/)?.[1] ?? 0)));
}

function rebuildItems() {
  DATA.items = [];
  for (const name of pageNames()) DATA.items.push(...(PAGES.get(name) || []));
  BY_ID = new Map(DATA.items.map(i => [i.id, i]));
  BY_AUTHOR = new Map();
  AUTHOR_TAGS.clear();
  for (const i of DATA.items) {
    if (!BY_AUTHOR.has(i.author)) BY_AUTHOR.set(i.author, []);
    BY_AUTHOR.get(i.author).push(i);
  }
  Player.adopt();
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/* Bring what is held into line with what the build says, and redraw if it moved. */
async function syncCatalog(stored) {
  // eslint-disable-next-line no-param-reassign
  let manifest;
  try {
    manifest = await fetchJSON("data/manifest.json");
  } catch {
    return;                 // offline, or an older build with no manifest
  }
  const files = manifest.files || {};
  let changed = false;

  // The build's own version of "what is stored no longer means what it did".
  // Hashes cannot say this: a client holding the old shape sees hashes it
  // recognises and goes on reading records it misunderstands. So this is
  // checked first, and it empties the store rather than comparing anything.
  const schema = Number(manifest.schema ?? 0);
  const headHash = files["index.json"]?.hash;
  const wrongShape = Number(stored.get("schema")?.data ?? -1) !== schema;
  const staleHead = headHash && stored.get("index.json")?.hash !== headHash;

  if (wrongShape || staleHead) {
    let head;
    try {
      head = await fetchJSON("data/index.json");
    } catch {
      return;     // no network: what is held is old, and old beats nothing
    }
    if (wrongShape) {
      // Emptied only once the replacement is in hand. Clearing first would
      // leave a reader that went offline mid-upgrade with no library at all.
      await Catalog.clear();
      PAGES.clear();
      stored = new Map();
      await Catalog.put("schema", String(schema), schema);
    }
    setData(head);
    if (headHash) await Catalog.put("index.json", headHash, DATA);
    changed = true;
  }

  const wanted = Object.keys(files).filter(name => name.startsWith("index/"));
  for (const name of wanted) {
    if (stored.get(name)?.hash === files[name].hash && PAGES.has(name)) continue;
    try {
      const page = await fetchJSON(`data/${name}`);
      expandLabels(page);
      PAGES.set(name, page);
      await Catalog.put(name, files[name].hash, page);
      changed = true;
      rebuildItems();
      render();             // each page shows up as it lands
    } catch { /* a page that will not load is a smaller library, not a crash */ }
  }

  // Pages the build no longer has: the library shrank, or was re-paged.
  const gone = [...stored.keys()].filter(
    name => name.startsWith("index/") && !files[name]);
  for (const name of gone) PAGES.delete(name);
  if (gone.length) {
    await Catalog.drop(gone);
    changed = true;
  }
  if (changed) { rebuildItems(); render(); }
}


let LAST_ROWS = [];
// The creators on screen, kept apart from LAST_ROWS: that one means "the
// recordings this view is showing" to the player and the queue.
let AUTHOR_ROWS = [];

/* Where the reader was, per view.

   Opening something is a move forward and starts at the top. Coming back to a
   list is a return, and should land where they left -- which for the windowed
   grid means putting back the chunks that were there, because the position
   they are returning to does not exist until the page is that tall again.

   The browser's own restoration cannot do this: it fires before the view is
   rebuilt, on a page whose height it has no way to predict. */
const SCROLL = new Map();
let CURRENT_ROUTE = null;
const KEEPS_PLACE = new Set(["library", "author", "authors", "favourites",
                             "playlist", "playlists", "queue", "offline"]);

function scrollMark() {
  return { y: window.scrollY, chunks: Grid.chunks.length };
}

let scrollGeneration = 0;

function scrollBack(saved) {
  // Each restore is scheduled a frame ahead, so a second one can be asked for
  // before the first has run -- tapping two tags quickly, or a catalogue page
  // landing mid-scroll. The later request wins and the earlier one is dropped;
  // without this an older position is restored over a newer view.
  const mine = ++scrollGeneration;
  if (!saved) { window.scrollTo(0, 0); return; }
  Grid.ensure(saved.chunks);
  window.scrollTo(0, saved.y);
  // Lazy images and a chunk's own layout settle a frame later, so land on it
  // again once they have; otherwise the view drifts by a row or two.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (mine !== scrollGeneration) return;
    Grid.ensure(saved.chunks);
    window.scrollTo(0, saved.y);
    Grid.sweep();
  }));
}

/* Tags and categories travel as indices into a table shared by every page. */
function expandLabels(items) {
  const tags = DATA.tagTable || [], cats = DATA.catTable || [];
  if (!tags.length && !cats.length) return;
  for (const i of items) {
    i.tags = (i.tags || []).map(n => tags[n]).filter(Boolean);
    i.categories = (i.categories || []).map(n => cats[n]).filter(Boolean);
  }
}

const Grid = {
  rows: [], chunks: [], el: null, sentinel: null, io: null, draw: null,

  /* `draw` is how a row becomes a card. It is a parameter because the creators
     page has the same problem the library has -- three hundred cards, each with
     a picture -- and no reason to solve it a second way. */
  start(rows, draw) {
    this.stop();
    this.rows = rows;
    this.draw = draw || card;
    this.el = document.getElementById("grid");
    if (!this.el) return;
    // The container is start's to own. It used to be handed a fresh one every
    // time because the whole view was rebuilt first; a redraw that replaces only
    // the results hands back the one that still holds the last set.
    this.el.innerHTML = "";
    this.chunks = [];
    this.append();
    this.sentinel = document.getElementById("gridEnd");
    if (this.sentinel && "IntersectionObserver" in window) {
      this.io = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) this.append();
      }, { rootMargin: "800px" });
      this.io.observe(this.sentinel);
    }
    this.onScroll = () => this.sweep();
    window.addEventListener("scroll", this.onScroll, { passive: true });
  },

  stop() {
    if (this.io) { this.io.disconnect(); this.io = null; }
    if (this.onScroll) window.removeEventListener("scroll", this.onScroll);
    this.onScroll = null;
    this.chunks = [];
    this.draw = null;
  },

  shown() { return this.chunks.length * CHUNK; },

  /* Enough chunks that a remembered position exists to scroll back to. */
  ensure(count) {
    while (this.chunks.length < count && this.shown() < this.rows.length) {
      this.append();
    }
  },

  append() {
    const from = this.shown();
    if (!this.el || from >= this.rows.length) return;
    const slice = this.rows.slice(from, from + CHUNK);
    const holder = document.createElement("div");
    holder.className = "chunk";
    holder.dataset.n = String(this.chunks.length);
    holder.innerHTML = slice.map(this.draw).join("");
    this.el.appendChild(holder);
    this.chunks.push({ el: holder, from, height: 0, loaded: true });
    // Fill the screen on first paint: one chunk may not reach the sentinel.
    if (this.chunks.length < 3 &&
        document.body.scrollHeight <= window.innerHeight + 400) this.append();
  },

  /* Where a chunk sits on the page.

     A loaded chunk is `display: contents`, so it generates no box of its own --
     its own rect is empty and the answer has to come from its first and last
     card. An unloaded one is a real block with a set height. */
  box(chunk) {
    const top = window.scrollY;
    if (!chunk.loaded) {
      const rect = chunk.el.getBoundingClientRect();
      return [rect.top + top, rect.bottom + top];
    }
    const kids = chunk.el.children;
    if (!kids.length) return [0, 0];
    const first = kids[0].getBoundingClientRect();
    const last = kids[kids.length - 1].getBoundingClientRect();
    return [first.top + top, last.bottom + top];
  },

  /* Unload what is far above or below, restore what is coming back. */
  sweep() {
    if (!this.el || !this.chunks.length) return;
    const top = window.scrollY, bottom = top + window.innerHeight;
    const margin = window.innerHeight * KEEP;
    for (const chunk of this.chunks) {
      const [start, end] = this.box(chunk);
      const near = end > top - margin && start < bottom + margin;
      if (!near && chunk.loaded) {
        // Measured before removal: cards are not all the same height, and a
        // guessed spacer makes the page jump under the reader.
        chunk.height = Math.max(1, end - start);
        chunk.el.style.height = `${chunk.height}px`;
        chunk.el.dataset.spacer = "1";
        chunk.el.innerHTML = "";
        chunk.loaded = false;
      } else if (near && !chunk.loaded) {
        chunk.el.innerHTML = this.rows
          .slice(chunk.from, chunk.from + CHUNK).map(this.draw).join("");
        chunk.el.style.height = "";
        delete chunk.el.dataset.spacer;
        chunk.loaded = true;
      }
    }
  },
};

function viewLibrary() {
  const rows = collapseVariants(filtered());
  LAST_ROWS = rows;
  return `
  ${VIEWING ? `<div class="theirbar">Reading
    <b>${esc(VIEWING.doc?.profile?.name || "a share")}</b> — every card says what they have
    heard, and the Library filter reads from it.
    <button class="btn sm" data-act="sharedOpen">Their page</button>
    <button class="btn sm" data-act="sharedClose">Stop</button></div>` : ""}
  <div class="controls">
    <input id="q" type="search" placeholder="Search titles, write-ups, tags…" value="${esc(F.q)}">
    <select id="fAuthor"><option value="">All authors</option>
      ${DATA.authors.map(a => `<option value="${esc(a.id)}"${a.id === F.author ? " selected" : ""}>${esc(a.name)}</option>`).join("")}</select>
    <select id="fSort">
      <option value="date"${F.sort === "date" ? " selected" : ""}>Newest first</option>
      <option value="dateA"${F.sort === "dateA" ? " selected" : ""}>Oldest first</option>
      <option value="title"${F.sort === "title" ? " selected" : ""}>Title A–Z</option>
      <option value="author"${F.sort === "author" ? " selected" : ""}>By author</option>
      <option value="dur"${F.sort === "dur" ? " selected" : ""}>Longest first</option>
    </select>
    <label class="chk"><input type="checkbox" id="fTr"${F.tr ? " checked" : ""}> search transcripts</label>
    <label class="chk"><input type="checkbox" id="fOff"${F.off ? " checked" : ""}> offline only</label>
    <label class="chk" title="Triggers and compulsions are spoilers for what a
      recording does to you, so they are out of the way until you ask."><input
      type="checkbox" id="fSpoil"${F.spoil ? " checked" : ""}> show triggers</label>
    <span class="durfilter">minutes
      <input id="fDurMin" type="number" min="0" step="5" placeholder="min"
        value="${esc(F.dur.min)}" aria-label="Shortest, in minutes">–<input
        id="fDurMax" type="number" min="0" step="5" placeholder="max"
        value="${esc(F.dur.max)}" aria-label="Longest, in minutes"></span>
  </div>
  ${savedRow()}
  <div class="facets">
    ${facetBar()}
    ${facetPanels()}
  </div>
  <p class="count">${rows.length} of ${DATA.items.length}${
    rows.some(r => r._cuts) ? ` · ${rows.reduce((n, r) => n + (r._cuts ? r._cuts - 1 : 0), 0)} alternate cut(s) folded in` : ""}
    ${rows.length ? `· <button class="btn sm" id="playAll">Play all</button>
    <button class="btn sm" id="queueAll">Queue all</button>
    <button class="btn sm" id="saveAll">Save all offline</button>
    <button class="btn sm" id="listAll">Save as playlist</button>` : ""}</p>
  ${rows.length ? `<div class="grid" id="grid"></div><div id="gridEnd"></div>`
    : `<div class="empty">Nothing matches those filters.</div>`}`;
}

/* Creators whose recorded voice measures close to this one. Two bands, and the
   difference matters: a high enough score is not "these sound alike", it is
   "this is probably the same performer under another name" -- which is a thing
   to say plainly and leave alone, not to act on. Somebody publishing under two
   names chose to. */
function similarPanel(id) {
  const rows = (authorDetail(id).similar || []).filter(r => DATA.authors.some(a => a.id === r.id));
  if (!rows.length) return "";
  const same = rows.filter(r => r.same_person);
  const near = rows.filter(r => !r.same_person);
  const line = r => `<li><a href="#/author/${encodeURIComponent(r.id)}">${esc(authorName(r.id))}</a>
    <span class="meta">${(r.score * 100).toFixed(0)}%</span></li>`;
  return `<section class="similar">
    ${same.length ? `<h2>Possibly the same voice</h2>
      <p class="note">Measured close enough to be one performer under two names.
        Recorded as a likeness, not merged.</p>
      <ul class="simlist">${same.map(line).join("")}</ul>` : ""}
    ${near.length ? `<h2>Voices like this one</h2>
      <ul class="simlist">${near.map(line).join("")}</ul>` : ""}
  </section>`;
}

/* The creator's own words about themselves, then the library's about them.

   Same rule as an item, different labels: what a creator writes about
   themselves is a bio, and what a model writes from their catalogue is a
   synopsis. Where only one exists it stands on its own, because there is
   nothing for a heading to distinguish it from. */
function authorWriteUp(a) {
  const bio = a.description || "";
  const ours = a.synopsis || "";
  if (bio && ours) {
    return `<h2 class="writeup">Bio</h2><div class="prose">${bio}</div>
      <h2 class="writeup">Synopsis${genMark(a.generated, "synopsis")}</h2>
      <p class="synopsis">${esc(ours)}</p>`;
  }
  if (bio) return `<div class="prose">${bio}${genMark(a.generated, "description")}</div>`;
  if (ours) return `<p class="synopsis">${esc(ours)}${genMark(a.generated, "synopsis")}</p>`;
  return "";
}

function authorCard(a) {
  const n = (BY_AUTHOR.get(a.id) || []).length;
  // One sentence written for this spot, where there is one. The synopsis is a
  // paragraph written for the top of a page, and showing its first six lines in
  // a grid is how a card ends up saying half a sentence.
  const blurb = a.summary || clip(a.synopsis || stripTags(a.description), 180);
  return `<div class="card"><a class="thumb" href="#/author/${encodeURIComponent(a.id)}"
    >${a.image ? `<img loading="lazy" src="${esc(a.image)}" alt="">` : ""}</a>
    <div class="body"><h3><a href="#/author/${encodeURIComponent(a.id)}">${esc(a.name)}</a></h3>
    <div class="meta"><span>${n} file${n === 1 ? "" : "s"}</span></div>
    ${followedAuthorMark(a.id)}
    ${blurb ? `<p class="note blurb">${esc(blurb)}</p>` : ""}
    <div class="tags">${chips(authorCardTags(a.id))}</div>
    <div class="cardacts">${heart("author", a.id)}</div></div></div>`;
}

function viewAuthors() {
  const rows = DATA.authors.slice();
  // Windowed like the library: three hundred creator cards is three hundred
  // pictures, and drawing them all at once is the cost the window exists to
  // avoid. `AUTHOR_ROWS` rather than `LAST_ROWS` because that one is what the
  // player and the queue read to mean "the recordings on screen", and creators
  // are not recordings.
  if (F.asort === "name") {
    rows.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    rows.sort((a, b) => (BY_AUTHOR.get(b.id) || []).length
                      - (BY_AUTHOR.get(a.id) || []).length
                      || a.name.localeCompare(b.name));
  }
  AUTHOR_ROWS = rows;
  return `<h1 style="margin-top:18px">Authors</h1>
  <div class="controls">
    <select id="aSort" aria-label="Order the creators">
      <option value="files"${F.asort !== "name" ? " selected" : ""}>Most files first</option>
      <option value="name"${F.asort === "name" ? " selected" : ""}>Name A–Z</option>
    </select>
    <span class="count">${rows.length} creators</span>
  </div>
  ${rows.length ? `<div class="grid" id="grid"></div><div id="gridEnd"></div>`
    : `<div class="empty">No creators yet.</div>`}`;
}

function viewAuthor(id) {
  const a = DATA.authors.find(x => x.id === id);
  if (!a) return `<div class="empty">Unknown author.</div>`;
  const held = BY_AUTHOR.get(id) || [];
  const rows = alwaysKeep(held).slice()
    .sort((x, y) => (y.date || "").localeCompare(x.date || ""));
  const hidden = held.length - rows.length;
  // The same windowed grid the library uses. A prolific creator has hundreds of
  // recordings, and drawing all of them at once costs what drawing the whole
  // library at once cost -- the reason the window exists.
  LAST_ROWS = rows;
  const hrs = Math.round(rows.reduce((s, i) => s + i.duration, 0) / 3600);
  return `<a class="back" href="#/">← Library</a>
  <div class="authorhead">
    ${a.image ? `<div class="herowrap"><img src="${esc(a.image)}" alt="">
      ${genMark(a.generated, "image")}</div>` : `<div class="ph"></div>`}
    <div><h1 style="margin:0">${esc(a.name)}</h1>
      <p class="kv">${rows.length} files · ${hrs} hours
      ${a.url ? ` · <a href="${esc(a.url)}" rel="noreferrer">website</a>` : ""}</p>
      <p class="kv"><a href="feed/${encodeURIComponent(a.id)}.xml">RSS feed for ${esc(a.name)}</a></p>
      <div class="actions">
        <button class="btn primary" data-act="playAuthor" data-author="${esc(a.id)}">Play all</button>
        <button class="btn" data-act="queueAuthor" data-author="${esc(a.id)}">Queue all</button>
        <button class="btn" data-act="saveAuthor" data-author="${esc(a.id)}">Save offline</button>
        ${heart("author", a.id, { label: true })}
      </div>
    </div>
  </div>
  ${pinLine(hidden)}
  ${(() => {
    const liked = followedAuthorLikes(id);
    return liked.length ? `<div class="among"><p><b>Favourited by</b>
      ${esc(andList(liked))}</p>
      <p class="note">The people whose shares you keep, as those last stood.</p></div>` : "";
  })()}
  ${authorWriteUp(a)}
  ${(() => {
    const common = authorCommonTags(id);
    if (!common.length) return "";
    // With the count, because "Femdom on 380 of 383" and "Femdom on 44 of 436"
    // are different claims about a creator and the chip alone cannot tell them
    // apart.
    return `<p class="tags labelled authortags">${
      chips(common.map(([t]) => t), { label: true, counts: new Map(common) })}</p>`;
  })()}
  ${provPanel(a.generated, authorDetail(id).coverPrompts, "page")}
  ${similarPanel(id)}
  ${rows.length ? `<div class="grid" id="grid"></div><div id="gridEnd"></div>`
    : `<div class="empty">Nothing here yet.</div>`}`;
}

/* The other cuts of this same recording. The library shows one card for the
   group, so this is where the rest of them are -- and where the difference
   between them is stated, since by definition their titles do not state it. */
function cutsPanel(it) {
  const cuts = variantsOf(it);
  if (cuts.length < 2) return "";
  return `<section class="cuts">
    <h2>Other cuts of this recording</h2>
    <ul class="cutlist">${cuts.map(c => `<li${c.id === it.id ? ' class="here"' : ""}>
      ${c.id === it.id ? "<span>" : `<a href="#/item/${encodeURIComponent(c.id)}">`}
      ${esc(variantOf(c) || "The plain edition")}
      ${c.id === it.id ? "</span>" : "</a>"}
      ${c.duration ? `<span class="meta">${clock(c.duration)}</span>` : ""}
      ${c.id === it.id ? `<span class="meta">playing this one</span>` : ""}
    </li>`).join("")}</ul>
  </section>`;
}

/* Everything else in the series, in its own order. A series entry is usually
   named for the series and not for itself, so the number matters more than the
   title and is shown first where there is one. */
const SERIES_SHOWN = 24;

function seriesPanel(it) {
  const all = seriesOf(it);
  if (all.length < 2) return "";
  /* Some "series" here are really categories -- 121 recordings filed under
     Feminization, none of them numbered -- and listing all of one on every
     item page is a wall, not a navigation aid. Long ones show a window around
     where you are, which is the part you would actually click. */
  let rows = all, elided = 0;
  if (all.length > SERIES_SHOWN) {
    const at = Math.max(0, all.findIndex(s => s.id === it.id));
    const from = Math.max(0, Math.min(at - Math.floor(SERIES_SHOWN / 2),
                                      all.length - SERIES_SHOWN));
    rows = all.slice(from, from + SERIES_SHOWN);
    elided = all.length - rows.length;
  }
  return `<section class="series">
    <h2>${esc(it.series)}${all.length > 1 ? ` <span class="cnt">${all.length}</span>` : ""}</h2>
    ${elided ? `<p class="note">Showing ${rows.length} around this one; ${elided} more in the series.</p>` : ""}
    <ol class="serieslist">${rows.map(s => `<li${s.id === it.id ? ' class="here"' : ""}>
      ${s.seriesIndex ? `<span class="num">${s.seriesIndex}</span>` : ""}
      ${s.id === it.id ? `<span>${esc(s.title)}</span>`
        : `<a href="#/item/${encodeURIComponent(s.id)}">${esc(s.title)}</a>`}
      ${variantOf(s) ? `<span class="meta">${esc(variantOf(s))}</span>` : ""}
      ${s.duration ? `<span class="meta">${clock(s.duration)}</span>` : ""}
    </li>`).join("")}</ol>
  </section>`;
}

function viewItem(id) {
  const it = BY_ID.get(id);
  if (!it) return `<div class="empty">Unknown item.</div>`;
  const a = DATA.authors.find(x => x.id === it.author);
  const off = Offline.has(it), q = Offline.isQueued(it.id);
  const gen = genOf(it), d = detailOf(it);
  /* Not <article>.
  
     An item page is a player, a pile of metadata and a transcript, and Safari's
     Reader takes an <article> as an invitation: it offers itself, throws away
     the player and the panels, and leaves something unusable. There is no
     supported way to say "not this page" -- the heuristic is Apple's and has no
     opt-out -- so the honest thing is not to claim to be an article. A section
     with a name says the same thing to a screen reader. */
  return `<section class="item" aria-labelledby="itemTitle">
    <a class="back" href="#/">← Library</a>
    <h1 id="itemTitle">${esc(it.title)}${genMark(gen, "title")}</h1>
    ${d.originalTitle ? `<p class="wasnamed">Filed under
      <span>${esc(d.originalTitle)}</span> when it arrived</p>` : ""}
    ${variantOf(it) ? `<p class="variant big">${esc(variantOf(it))}</p>` : ""}
    <p class="kv">
      <a href="#/author/${encodeURIComponent(it.author)}">${esc(a?.name || it.author)}</a>
      ${it.date ? ` · ${esc(it.date)}` : ""}
      ${it.duration ? ` · ${clock(it.duration)}` : ""}
      ${it.series ? ` · ${esc(it.series)}${it.seriesIndex ? " #" + it.seriesIndex : ""}` : ""}
      ${it.categories.length ? ` · ${esc(it.categories.join(", "))}` : ""}
    </p>
    ${d.video
      ? `<video class="hero" controls preload="none" playsinline
           ${it.cover ? `poster="${esc(it.cover)}"` : ""}
           src="${esc(d.video)}"></video>
         <p class="note">Watching plays the video here. The player, the queue and
           anything saved offline use the audio track — this file is a recording
           first, and a picture second.</p>`
      : it.cover ? `<div class="herowrap"><img class="hero" src="${esc(it.cover)}" alt="">
      ${genMark(gen, "cover")}</div>` : ""}
    <div class="actions">
      ${it.audio ? `<button class="btn primary" data-act="playOne" data-id="${esc(it.id)}">▶ Play</button>
      <button class="btn" data-act="next1" data-id="${esc(it.id)}">Play next</button>
      <button class="btn" data-act="enqueue1" data-id="${esc(it.id)}">Add to queue</button>
      <button class="btn" data-act="addto1" data-id="${esc(it.id)}">Add to playlist</button>
      ${off ? `<button class="btn" data-act="unsave1" data-id="${esc(it.id)}">Remove download</button>`
            : `<button class="btn" data-act="save1" data-id="${esc(it.id)}"${q ? " disabled" : ""}>${q ? "Queued" : "Save offline"}</button>`}` : ""}
      ${heart("item", it.id, { label: true })}
    </div>
    ${playedLine(it.id)}
    ${followedPanel(it.id)}
    ${writeUp(d, it, gen)}
    ${notePanel(it.id)}
    ${cutsPanel(it)}
    ${seriesPanel(it)}
    <p class="tags labelled">${chips(visibleTags(it), { label: true })}
      ${hiddenTagCount(it) ? `<span class="note">· ${hiddenTagCount(it)} trigger tag${
        hiddenTagCount(it) === 1 ? "" : "s"} withheld; they are listed under
        “Triggers and compulsions” below, or tick “show triggers” in the library.</span>` : ""}</p>
    ${detailOf(it).sourceUrl ? `<p class="kv"><a href="${esc(detailOf(it).sourceUrl)}" rel="noreferrer">Original page</a></p>` : ""}
    ${it.spoilerCount ? `<details class="sp" id="spBox">
      <summary>Triggers and compulsions
        <span class="cnt">${it.spoilerCount}</span>
        ${it.spoilerUnlisted ? `<span class="cnt warn">${it.spoilerUnlisted} not in tags</span>` : ""}</summary>
      <p class="note">Spoilers. Every trigger this item declares in its own tags, plus any
        post-hypnotic suggestion an audit found in the transcript that the tags and write-up
        do not name. The audited ones are an automated review of an automatic transcript —
        treat them as a lead, not a verdict.</p>
      <div id="spBody"><p class="note">Loading…</p></div></details>` : ""}
    ${d.script ? `<details class="tr"><summary>Author's script</summary>
      <p class="note">What the creator wrote and read out, as they wrote it. The
        transcript below is what a model heard; where the two differ, this one is
        the recording's own words.</p>
      <div class="plain">${d.script.split(/\n{2,}/).map(p =>
        `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("")}</div></details>` : ""}
    ${it.hasTranscript ? `<details class="tr" id="trBox"><summary>Transcript</summary>
      <p class="note">${transcriptNote(detailOf(it).transcriptSource)}</p>
      <div id="trBody"><p class="note">Loading…</p></div></details>` : ""}
    ${soundPanel(d.sound, d.acoustic)}
    ${provPanel(gen, d.coverPrompts, "entry")}
  </section>`;
}

/* Everything liked, in the order it was liked, creators before recordings --
   a shorter list of bigger things reads better at the top, and the recordings
   below it are the windowed grid the library and creator pages use, because a
   favourites list is as long as somebody wants it to be. */
function viewFavourites() {
  const itemIds = Favourites.ids("item"), authorIds = Favourites.ids("author");
  const rows = itemIds.map(id => BY_ID.get(id)).filter(Boolean);
  const authors = authorIds.map(id => DATA.authors.find(a => a.id === id)).filter(Boolean);
  LAST_ROWS = rows;
  const away = (itemIds.length - rows.length) + (authorIds.length - authors.length);
  const secs = rows.reduce((s, i) => s + i.duration, 0);
  const any = itemIds.length || authorIds.length;
  return `<h1 style="margin-top:18px">Favourites</h1>
  <div class="actions">
    ${rows.length ? `<button class="btn primary" id="favPlay">Play all</button>
    <button class="btn" id="favQueue">Queue all</button>
    <button class="btn" id="favSave">Save offline</button>
    <button class="btn" id="favList">Save as playlist</button>` : ""}
    <button class="btn" id="favExport"${any ? "" : " disabled"}>Export</button>
    <button class="btn" id="favImport">Import</button>
  </div>
  ${any ? `<p class="kv">${rows.length} recording${rows.length === 1 ? "" : "s"}${
    secs ? ` · ${fmtDur(secs)}` : ""}${authors.length
      ? ` · ${authors.length} creator${authors.length === 1 ? "" : "s"}` : ""}</p>` : ""}
  ${away ? `<p class="note">${away} favourite${away === 1 ? " is" : "s are"} not in this
    library. They are kept as they are, and appear here if the library gains them.</p>` : ""}
  ${authors.length ? `<h3>Creators</h3>
    <div class="grid">${authors.map(authorCard).join("")}</div>` : ""}
  ${rows.length ? `${authors.length ? "<h3>Recordings</h3>" : ""}
    <div class="grid" id="grid"></div><div id="gridEnd"></div>`
    : !authors.length ? `<div class="empty">Nothing favourited yet. The heart on any
      recording or creator puts it here — or bring the ones from another device in
      with “Import”.</div>` : ""}`;
}

/* An id that this build no longer has is still worth showing. `Names` kept what
   it was called when something here first pointed at it, which is exactly the
   case a retitled item creates: a new id, and an old one with a name. */
function titleOf(id) {
  const it = BY_ID.get(id);
  if (it) return { title: it.title, who: authorName(it.author), item: it };
  const n = Names.of(id);
  return { title: n ? n.t : id, who: n ? n.a : "", item: null };
}

const DAY_FMT = { weekday: "long", day: "numeric", month: "long", year: "numeric" };
function dayLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  const today = new Date(), yday = new Date(Date.now() - DAY);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, yday)) return "Yesterday";
  try { return d.toLocaleDateString(undefined, DAY_FMT); } catch { return d.toDateString(); }
}
const timeLabel = iso => {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  try { return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); }
  catch { return d.toISOString().slice(11, 16); }
};

/* What was played, newest first and grouped by the day it happened, because a
   timeline read by a person is read in days. The controls sit next to what they
   act on rather than in a settings page somewhere else. */
function viewHistory() {
  const events = History.events();
  const paused = History.paused();
  const ranked = History.ranked().slice(0, 12);
  const days = [];
  for (const e of events) {
    const label = dayLabel(e.at);
    if (!days.length || days[days.length - 1].label !== label) days.push({ label, rows: [] });
    days[days.length - 1].rows.push(e);
  }
  const row = e => {
    const { title, who, item } = titleOf(e.id);
    const plays = History.plays(e.id);
    return `<li><span class="n">${esc(timeLabel(e.at))}</span>
      <div class="t"><b>${item ? `<a href="#/item/${encodeURIComponent(e.id)}"
        style="text-decoration:none;color:inherit">${esc(title)}</a>` : esc(title)}</b>
        <span>${who ? esc(who) + " · " : ""}${fmtDur(e.secs) || "under a minute"}${
          e.done ? " · finished" : ""}${item ? "" : " · not in this library"}</span></div>
      <div class="g">
        ${item ? `<button data-act="histPlay" data-id="${esc(e.id)}" title="Play">▶</button>` : ""}
        <button data-act="histForget" data-id="${esc(e.id)}"
          title="Forget this recording">✕</button>
      </div></li>`;
  };
  return `<h1 style="margin-top:18px">History</h1>
  <div class="actions">
    <button class="btn${paused ? " primary" : ""}" id="histPause">${
      paused ? "Resume recording" : "Pause recording"}</button>
    <button class="btn" id="histExport"${events.length ? "" : " disabled"}>Export…</button>
    <button class="btn" id="histClear"${events.length ? "" : " disabled"}>Clear</button>
  </div>
  <p class="note">What this device played, kept here and nowhere else. Thirty seconds of a
    recording makes a sitting; one sitting is one line, however often it was paused.
    ${paused ? "Recording is paused, and nothing new is being kept." : ""}</p>
  ${events.length ? days.map(d => `<h3>${esc(d.label)}</h3>
    <ol class="list times">${d.rows.map(row).join("")}</ol>`).join("")
    : `<div class="empty">Nothing played yet${paused ? ", and recording is paused" : ""}.</div>`}
  ${ranked.length > 1 ? `<h3>Most played</h3><ol class="list">${ranked.map(r => {
    const { title, who, item } = titleOf(r.id);
    return `<li><span class="n">${r.n}×</span>
      <div class="t"><b>${item ? `<a href="#/item/${encodeURIComponent(r.id)}"
        style="text-decoration:none;color:inherit">${esc(title)}</a>` : esc(title)}</b>
        <span>${who ? esc(who) + " · " : ""}last ${esc(dayLabel(r.last).toLowerCase())}</span></div>
      </li>`;
  }).join("")}</ol>` : ""}`;
}

/* Everything annotated. The editor itself is on the item, where the reason for
   a note is on the screen beside it. */
function viewNotes() {
  const ids = Notes.ids();
  return `<h1 style="margin-top:18px">Notes</h1>
  <div class="actions">
    <button class="btn" id="noteExport"${ids.length ? "" : " disabled"}>Export…</button>
    <button class="btn" id="noteImport">Import</button>
  </div>
  ${ids.length ? `<p class="kv">${ids.length} note${ids.length === 1 ? "" : "s"}</p>
  <ol class="list notes">${ids.map(id => {
    const { title, who, item } = titleOf(id);
    const n = Notes.row(id);
    return `<li>
      <div class="t"><b>${item ? `<a href="#/item/${encodeURIComponent(id)}"
        style="text-decoration:none;color:inherit">${esc(title)}</a>` : esc(title)}</b>
        <span>${who ? esc(who) + " · " : ""}${esc(dayLabel(n.updated))}${
          n.private ? " · private" : ""}${item ? "" : " · not in this library"}</span>
        <p class="notetext">${esc(n.text).replace(/\n/g, "<br>")}</p></div>
      </li>`;
  }).join("")}</ol>`
    : `<div class="empty">No notes yet. Every recording has a note box under its
      write-up — what it is for, what it did, whatever is worth remembering.</div>`}`;
}

/* ------------------------------------------------------- profile and sync */
let LINKING = null;        // a pairing offered to this device, from a link
let VIEWING = null;        // somebody else's profile, being read

function syncLine() {
  if (!Sync.on()) return "Not linked. Everything here stays on this device.";
  const st = Sync.state;
  if (st.busy) return "Syncing…";
  if (st.error) return `Last sync: ${esc(st.error)}`;
  if (!st.at) return "Linked, not yet synced.";
  return `Synced ${esc(timeLabel(new Date(st.at).toISOString()))} · ${
    st.devices} device${st.devices === 1 ? "" : "s"}`;
}
/* Every one of them. The line appears twice -- in the menu and on the profile
   page -- and while both carried the same id only the first was ever found, so
   the one somebody was actually looking at sat there saying "not yet synced"
   however many times they pressed the button. */
function paintSync() {
  const words = syncLine();
  for (const el of $$(".syncline")) el.textContent = words;
}

/* The menu in the corner: everything that is about the person rather than the
   library.

   The bar used to carry nine links, of which five were somebody's own -- what
   they had liked, listed, played, written and saved -- and on a phone they wrapped
   into a second row that pushed the library down the screen. They are all here
   now, which leaves the bar as the three things a visitor would want.

   With no endpoint there is no sync status -- not a disabled one, none -- because
   until somebody links a device or publishes a share there is nothing there. */
const MY_PAGES = ["profile", "favourites", "playlists", "history", "notes", "offline"];

function paintMe() {
  const box = $("#meBody");
  if (!box) return;
  const linked = Sync.on(), at = route().name;
  const here = name => (name === at ? ` class="active"` : "");
  $("#meName").textContent = Me.name() || "You";
  // The summary carries the mark when the page being read is one of these, so
  // the bar still says where the reader is now that the link is folded away.
  $("#meMenu")?.classList.toggle("here", MY_PAGES.includes(at));
  box.innerHTML = `
    ${navigator.onLine ? "" : `<p class="note nonet">No network. What was saved still
      plays, and everything here is kept on this device either way.</p>`}
    <a href="#/profile"${here("profile")}>Profile</a>
    <div class="mesep"></div>
    <a href="#/favourites"${here("favourites")}>Favourites</a>
    <a href="#/playlists"${here("playlists")}>Playlists</a>
    <a href="#/history"${here("history")}>History</a>
    <a href="#/notes"${here("notes")}>Notes</a>
    <a href="#/offline"${here("offline")}>Offline</a>
    <div class="mesep"></div>
    <button class="melink" data-act="exportAny">Export…</button>
    <button class="melink" data-act="importAny">Import…</button>
    <button class="melink" data-act="pasteLink">Paste a link…</button>
    <div class="mesep"></div>
    ${linked
      ? `<p class="note syncline">${esc(syncLine())}</p>
         <button class="melink" data-act="syncNow">Sync now</button>`
      : `<button class="melink" data-act="linkStart">Link a device…</button>`}`;
}

/* Long-pressing a chip is the pin, for a finger: a target eight pixels across is
   not one, and holding something down to change what it means is the gesture a
   phone already teaches.

   The press that follows is swallowed, because the element under it has been
   redrawn by then and whatever is now in its place did not ask to be pressed. */
const HOLD_MS = 500;
let HOLD = null, HELD_AT = 0;

function dropHold() {
  if (!HOLD) return;
  clearTimeout(HOLD.timer);
  HOLD = null;
}
document.addEventListener("pointerdown", e => {
  const chip = e.target.closest?.(".fsel .chip");
  if (!chip || e.target.closest(".off")) return;
  const owner = chip.querySelector("[data-key][data-v]");
  if (!owner) return;
  const { key, v } = owner.dataset;
  dropHold();
  HOLD = {
    x: e.clientX || 0, y: e.clientY || 0,
    timer: setTimeout(() => {
      HOLD = null; HELD_AT = Date.now();
      togglePin(key, v);
      rerender();
    }, HOLD_MS),
  };
});
document.addEventListener("pointerup", dropHold);
document.addEventListener("pointercancel", dropHold);
document.addEventListener("pointermove", e => {
  if (!HOLD) return;
  if (Math.abs((e.clientX || 0) - HOLD.x) + Math.abs((e.clientY || 0) - HOLD.y) > 8) dropHold();
});

/* A menu that stays open behind the page it opened is a menu somebody has to
   close twice. Anything chosen inside one closes it, and so does anywhere else.

   The bar's own menu is a class rather than a <details>, so its open state is
   set here; it is only ever open on a screen too narrow to lay the links out,
   where the button that toggles it is the only thing visible. */
function showNav(open) {
  const nav = $("#navMenu");
  if (!nav) return;
  nav.classList.toggle("open", open);
  $("#navToggle")?.setAttribute("aria-expanded", String(open));
}
document.addEventListener("click", e => {
  const nav = $("#navMenu");
  if (nav) {
    if (e.target.closest("#navToggle")) showNav(!nav.classList.contains("open"));
    else if (nav.classList.contains("open")) showNav(false);
  }
  const me = $("#meMenu");
  if (me?.open && !e.target.closest("#meMenu > summary")) me.open = false;
});

function shareRow(row) {
  const bits = row.sections.map(s => SECTION_LABEL[s]).filter(Boolean).join(", ");
  return `<li>
    <div class="t"><b>${esc(row.label)}</b>
      <span>${esc(bits || "nothing")} · live · made ${esc(dayLabel(row.created))}</span>
      <input class="sharelink" readonly value="${esc(Shares.link(row))}"
        aria-label="Link for ${esc(row.label)}"></div>
    <div class="g">
      <button data-act="shareCopy" data-id="${esc(row.id)}" title="Copy the link">⧉</button>
      <button data-act="shareRotate" data-id="${esc(row.id)}"
        title="New link; the old one stops working">↻</button>
      <button data-act="shareRevoke" data-id="${esc(row.id)}" title="Revoke">✕</button>
    </div></li>`;
}

function viewProfile() {
  const linked = Sync.on();
  const shares = Shares.all();
  const devices = load(K.devices, {}) || {};
  return `<h1 style="margin-top:18px">Profile</h1>
  <p class="kv">A name, what you share, and the devices this library is on.</p>
  <div class="prow">
    <input id="meNameBox" placeholder="What people see" maxlength="80"
      value="${esc(Me.name())}" aria-label="Your name">
    <button class="btn" data-act="meSave">Save</button>
  </div>
  <p class="note">The name travels in a share and in an export, so an import can say
    who it came from. It never reaches the endpoint in the clear.</p>

  <h3>Sharing</h3>
  <div class="actions">
    <button class="btn primary" data-act="shareNew" data-preset="choosing">Share for
      someone choosing for me</button>
    <button class="btn" data-act="shareNew" data-preset="plain">Share my playlists</button>
  </div>
  <p class="note">A share is a page of its own, published under its own key, and it
    updates as this library does. Revoking one takes it down for good. A note marked
    private is never in any of them.${linked ? "" : ` Publishing needs somewhere to keep
    it, so the first one asks where — one device is enough, and no second device has to
    be linked for it.`}</p>
  ${linked && !shares.length ? `<div class="empty">No shares yet.</div>` : ""}
  ${shares.length ? `<ol class="list shares">${shares.map(shareRow).join("")}</ol>` : ""}

  <h3>People you keep</h3>
  ${Followed.all().length ? `<p class="note">Shares you have been given and kept. Their
    favourites, playlists and play counts annotate recordings here, and each one adds a
    “Liked by” to the Library filter. They are asked again when the library opens.</p>
    <div class="actions"><button class="btn" data-act="followRefresh">Ask again now</button></div>
    <ol class="list">${Followed.all().map(r => `<li>
      <div class="t"><b>${esc(r.name)}</b>
        <span>${r.gone ? `<span class="warn">${esc(r.gone)}</span>`
          : `${(r.favs || []).length} favourite${(r.favs || []).length === 1 ? "" : "s"} · ${
             (r.lists || []).length} playlist${(r.lists || []).length === 1 ? "" : "s"} · asked ${
             esc(dayLabel(r.fetched).toLowerCase())}`}</span></div>
      <div class="g"><button data-act="unfollow" data-id="${esc(r.id)}"
        title="Stop keeping this">✕</button></div></li>`).join("")}</ol>`
    : `<div class="empty">None yet. Open a share link somebody has given you and press
      “Keep this profile”.</div>`}

  <h3>Devices</h3>
  ${linked ? `<p class="note syncline">${esc(syncLine())}</p>
    <div class="actions">
      <button class="btn" data-act="linkStart">Link another device…</button>
      <button class="btn" data-act="syncNow">Sync now</button>
      <button class="btn" data-act="unlinkAll">Unlink this device…</button>
    </div>
    ${Object.keys(devices).length ? `<ol class="list">${Object.entries(devices)
      .map(([fp, d]) => `<li><span class="n">${esc((d.name || "device").slice(0, 2))}</span>
        <div class="t"><b>${esc(d.name || fp.slice(0, 8))}</b>
          <span>last seen ${esc(dayLabel(d.seen))}</span></div>
        <div class="g"><button data-act="deviceDrop" data-id="${esc(fp)}"
          title="Retire this device">✕</button></div></li>`).join("")}</ol>` : ""}`
    : `<div class="actions">
        <button class="btn primary" data-act="linkStart">Link a device…</button>
      </div>
      <p class="note">Linking makes the key that ties this library's devices together, tells
        an endpoint the group exists, and shows a code for the second device. Nothing is
        published before that press.</p>
      ${canSync() ? "" : `<p class="note disputed">Not from this page, though: the
        cryptography it needs is offered only over HTTPS or from localhost, and this is
        <code>${esc(location.origin)}</code>.</p>`}`}`;
}

/* The joining side of a pairing. Reached by opening the code, which is why the
   key is taken out of the address bar before anything is drawn. */
function viewLink() {
  if (!LINKING) {
    return `<div class="empty">That pairing link has nothing in it. Ask the other device
      to show its code again.</div>`;
  }
  if (LINKING.done) {
    return `<h1 style="margin-top:18px">Linked</h1>
      <p class="kv">${LINKING.done === "joined"
        ? "This device is now part of the group, and has taken what the others hold."
        : esc(linkedSays(LINKING.done))}</p>
      <div class="actions"><a class="btn primary" href="#/">Back to the library</a></div>`;
  }
  /* Said before anything is pressed, because a device already in a group takes
     every device it is linked to along with it -- and anybody it has shared with
     starts seeing the other side's library too. */
  // Asked of the endpoint rather than taken from the last sync, which may have
  // been before the newest of them arrived.
  if (Sync.on() && LINKING.others === undefined) {
    const link = LINKING;
    link.others = null;
    Sync.list().then(rows => { link.others = rows.length - 1; if (LINKING === link) render(); })
      .catch(() => {});
  }
  const others = LINKING.others;
  const already = Sync.on()
    ? `<p class="note">This device is already linked${others > 0
        ? ` to ${others} other${others === 1 ? "" : "s"}` : ""}.
        Linking it here brings the two groups together: every device in either ends up
        in one, holding everything both had.${Shares.all().length ? ` Links you have
        shared go on working, and show the whole combined library from then on.` : ""}
        Only do this with your own devices — somebody else's is what a share link is for.</p>`
    : "";
  return `<h1 style="margin-top:18px">Link this device</h1>
    <p class="kv">Another device is offering to link this one.</p>
    ${already}
    ${LINKING.accepted
      ? `<p class="note">Confirmed here. If the other device has not been confirmed yet,
          do that now.</p>
         <p class="sas">${esc(LINKING.digits)}</p>
         <p class="note" id="linkState">Waiting for the other device…</p>`
      : LINKING.digits
      ? `<p class="note">Check that the other device is showing the same six digits. If
          it is, confirm here and there.</p>
         <p class="sas">${esc(LINKING.digits)}</p>
         <div class="actions">
           <button class="btn primary" data-act="linkAccept"${/\d{6}/.test(LINKING.digits)
             ? "" : " disabled"}>They match — link it</button>
           <a class="btn" href="#/">Cancel</a>
         </div>`
      : `<p class="note">This will link the two devices, so that both hold the same
          library. Both screens will show six digits to compare first.</p>
         <div class="actions">
           <button class="btn primary" data-act="linkJoin">Join</button>
           <a class="btn" href="#/">Not now</a>
         </div>`}
    ${LINKING.error ? `<p class="note disputed">${esc(LINKING.error)}</p>` : ""}`;
}

/* Somebody else's profile.

   Read-only by construction: there is no key here that could write anything, and
   the one way it touches this library is the button that says it will. The
   annotated catalogue is the point -- a person picking something browses the
   grid, not a timeline -- so the Library facet reads from the share while this
   is open, and the cards say what the share knows. */
function sharedSets() {
  const d = VIEWING?.doc;
  if (!d) return null;
  const played = new Set(Object.keys(d.history?.plays || {}));
  for (const e of d.history?.recent || []) played.add(e.i);
  return {
    played,
    note: new Set(Object.keys(d.notes || {})),
    favourite: new Set(Object.keys(d.favourites?.items || {})),
    playlist: new Set((d.playlists || []).flatMap(p => p.items || [])),
    progress: new Set(Object.keys(d.progress || {})),
  };
}
function sharedPlays(id) {
  const row = VIEWING?.doc?.history?.plays?.[id];
  if (!row) return null;
  let n = 0;
  for (const c of Object.values(row.c || {})) n += Number(c?.n) || 0;
  return n ? { n, last: row.l || "" } : null;
}
/* What a chooser wants on the card itself: heard it, when, and whether they are
   part-way through. */
function sharedMark(id) {
  const sets = VIEWING && VIEWING.sets;
  if (!sets) return "";
  const bits = [];
  const plays = sharedPlays(id);
  if (plays) {
    bits.push(plays.n === 1 ? "played once" : `played ${plays.n}×`);
    if (plays.last) bits.push(dayLabel(plays.last).toLowerCase());
  } else if (sets.played.has(id)) bits.push("played");
  else bits.push("never played");
  const part = VIEWING.doc.progress?.[id];
  if (part) bits.push(`${Math.round(part * 100)}% in`);
  if (sets.favourite.has(id)) bits.push("liked");
  return `<p class="theirs">${esc(bits.join(" · "))}</p>`;
}

function sharedList(ids, empty) {
  if (!ids.length) return `<div class="empty">${esc(empty)}</div>`;
  return `<ol class="list">${ids.map(id => {
    const { title, who, item } = sharedTitle(id);
    const plays = sharedPlays(id);
    return `<li><span class="n">${item ? "" : "—"}</span>
      <div class="t"><b>${item ? `<a href="#/item/${encodeURIComponent(id)}"
        style="text-decoration:none;color:inherit">${esc(title)}</a>` : esc(title)}</b>
        <span>${who ? esc(who) : ""}${plays ? ` · played ${plays.n}×` : ""}${
          item ? "" : " · not in this library"}</span></div>
      ${item ? `<div class="g"><button data-act="play" data-id="${esc(id)}"
        title="Play">▶</button></div>` : ""}</li>`;
  }).join("")}</ol>`;
}
/* Their names for things, then ours: a share is read on somebody else's library
   as often as on a copy of the same one. */
function sharedTitle(id) {
  const it = BY_ID.get(id);
  if (it) return { title: it.title, who: authorName(it.author), item: it };
  const n = VIEWING?.doc?.titles?.[id] || Names.of(id);
  return { title: n ? n.t : id, who: n ? n.a : "", item: null };
}

/* One of their playlists, opened. The entries this library does not have are
   still listed by name: a playlist is a thing somebody put together, and showing
   it four short without saying so would misrepresent it. */
function viewSharedPlaylist(id) {
  const d = VIEWING.doc;
  const pl = (d.playlists || []).find(p => p.id === id);
  if (!pl) return `<a class="back" href="#/p">← Back</a>
    <div class="empty">That playlist is not in this share any more.</div>`;
  const items = (pl.items || []).map(iid => ({ iid, ...sharedTitle(iid) }));
  const here = items.filter(x => x.item);
  const secs = here.reduce((n, x) => n + (x.item.duration || 0), 0);
  return `<a class="back" href="#/p">← ${esc(d.profile?.name || "Back")}</a>
  <h1>${esc(pl.name || "Playlist")}</h1>
  <p class="kv">${items.length} entr${items.length === 1 ? "y" : "ies"}${
    secs ? ` · ${fmtDur(secs)}` : ""}${
    items.length - here.length ? ` · ${items.length - here.length} not in this library` : ""}</p>
  <div class="actions">
    ${here.length ? `<button class="btn primary" data-act="sharedPlay"
      data-id="${esc(pl.id)}">▶ Play what we have</button>
    <button class="btn" data-act="sharedQueue" data-id="${esc(pl.id)}">Add to queue</button>
    <button class="btn" data-act="sharedCopy" data-id="${esc(pl.id)}">Copy to my playlists</button>` : ""}
  </div>
  ${items.length ? `<ol class="list">${items.map((x, n) => `<li>
    <span class="n">${n + 1}</span>
    <div class="t"><b>${x.item ? `<a href="#/item/${encodeURIComponent(x.iid)}"
      style="text-decoration:none;color:inherit">${esc(x.title)}</a>` : esc(x.title)}</b>
      <span>${x.who ? esc(x.who) : ""}${x.item && x.item.duration
        ? ` · ${fmtDur(x.item.duration)}` : ""}${x.item ? "" : " · not in this library"}</span></div>
    ${x.item ? `<div class="g"><button data-act="play" data-id="${esc(x.iid)}"
      title="Play">▶</button></div>` : ""}</li>`).join("")}</ol>`
    : `<div class="empty">This playlist is empty.</div>`}`;
}

function viewShared(arg) {
  if (!VIEWING) {
    return `<div class="empty">That link has nothing in it. Ask for it again.</div>`;
  }
  if (VIEWING.error) return `<div class="empty">${esc(VIEWING.error)}</div>`;
  if (!VIEWING.doc) return `<div class="empty">Opening…</div>`;
  if (arg) return viewSharedPlaylist(arg);
  const d = VIEWING.doc;
  const who = d.profile?.name || "Someone";
  const favs = Object.keys(d.favourites?.items || {});
  const lately = [...(d.history?.recent || [])].reverse().map(e => e.i);
  const seen = new Set();
  const recent = lately.filter(id => (seen.has(id) ? false : seen.add(id)));
  const ranked = Object.entries(d.history?.plays || {})
    .map(([id]) => ({ id, ...(sharedPlays(id) || {}) })).filter(r => r.n)
    .sort((a, b) => b.n - a.n).slice(0, 15).map(r => r.id);
  const progress = Object.keys(d.progress || {});
  const notes = Object.entries(d.notes || {}).filter(([, n]) => n && n.text);
  return `<h1 style="margin-top:18px">${esc(who)}</h1>
  <p class="kv">Published ${esc(dayLabel(d.published))}. This is a copy of what they chose
    to share, read here and changed nowhere.</p>
  <div class="actions">
    <a class="btn primary" href="#/">Browse the library with this</a>
    ${VIEWING.id && Followed.has(VIEWING.id)
      ? `<button class="btn" data-act="unfollow" data-id="${esc(VIEWING.id)}">Stop keeping this</button>`
      : `<button class="btn" data-act="follow">Keep this profile</button>`}
    <button class="btn" data-act="sharedImport">Import to mine</button>
    <button class="btn" data-act="sharedClose">Close</button>
  </div>
  ${VIEWING.id && Followed.has(VIEWING.id) ? `<p class="note">Kept. Recordings will say
    where ${esc(who)} has liked, listed or played them, and the Library filter gains
    “Liked by ${esc(who)}”. Nothing of yours goes back to them.</p>` : ""}
  <p class="note">Browsing shows what they have heard on every card, and the Library
    filter reads from this rather than from your own. Importing copies what is here into
    your library; nothing you do goes back to them.</p>
  ${iosBrowser() ? `<p class="note">Reading this in the browser. An app added to your
    home screen keeps its own library and is never handed links to this site, so to use
    this there: <button class="link" data-act="shareCopyHere">copy the link</button>,
    open the app, and paste it under “Paste a link”.</p>` : ""}
  ${progress.length ? `<h3>Part-way through</h3>${sharedList(progress, "")}` : ""}
  ${recent.length ? `<h3>Lately</h3>${sharedList(recent.slice(0, 20), "")}` : ""}
  ${ranked.length ? `<h3>Most played</h3>${sharedList(ranked, "")}` : ""}
  ${favs.length ? `<h3>Favourites</h3>${sharedList(favs.slice(0, 40), "")}` : ""}
  ${(d.playlists || []).length ? `<h3>Playlists</h3>
    <ol class="list">${d.playlists.map(p => `<li>
      <div class="t"><b><a href="#/p/${encodeURIComponent(p.id)}"
        style="text-decoration:none;color:inherit">${esc(p.name || "Playlist")}</a></b>
        <span>${(p.items || []).length} entr${
          (p.items || []).length === 1 ? "y" : "ies"}</span></div>
      <div class="g">
        <button data-act="sharedPlay" data-id="${esc(p.id)}"
          title="Play what this library has">▶</button>
        <a class="open" href="#/p/${encodeURIComponent(p.id)}" title="Open it">›</a>
      </div></li>`).join("")}</ol>` : ""}
  ${notes.length ? `<h3>Notes</h3><ol class="list notes">${notes.map(([id, n]) => {
    const { title } = sharedTitle(id);
    return `<li><div class="t"><b>${esc(title)}</b>
      <p class="notetext">${esc(n.text).replace(/\n/g, "<br>")}</p></div></li>`;
  }).join("")}</ol>` : ""}`;
}

function viewQueue() {
  const q = Player.queue;
  return `<h1 style="margin-top:18px">Play queue</h1>
  ${q.length ? `<div class="actions">
      <button class="btn" id="qClear">Clear queue</button>
      <button class="btn" id="qSave">Save as playlist</button></div>
    <ol class="list">${q.map((id, i) => {
      const it = BY_ID.get(id); if (!it) return "";
      return `<li class="${i === Player.index ? "on" : ""}">
        <span class="n">${i + 1}</span>
        <div class="t"><b>${esc(it.title)}</b><span>${esc(authorName(it.author))} · ${fmtDur(it.duration)}</span></div>
        <div class="g">
          <button data-act="qplay" data-i="${i}" title="Play">▶</button>
          <button data-act="qup" data-i="${i}" title="Up">↑</button>
          <button data-act="qdown" data-i="${i}" title="Down">↓</button>
          <button data-act="qdel" data-i="${i}" title="Remove">✕</button>
        </div></li>`;
    }).join("")}</ol>`
  : `<div class="empty">The queue is empty. Play something, or add items from the library.</div>`}`;
}

function viewPlaylists() {
  const all = Playlists.all();
  return `<h1 style="margin-top:18px">Playlists</h1>
  <div class="actions"><button class="btn primary" id="plNew">New playlist</button>
    <button class="btn" id="plExportAll"${all.length ? "" : " disabled"}>Export all</button>
    <button class="btn" id="plImport">Import</button></div>
  ${all.length ? `<ol class="list">${all.map(p => {
    const items = p.items.map(i => BY_ID.get(i)).filter(Boolean);
    const secs = items.reduce((s, i) => s + i.duration, 0);
    return `<li>
      <div class="t"><b><a href="#/playlist/${encodeURIComponent(p.id)}"
        style="text-decoration:none;color:inherit">${esc(p.name)}</a></b>
        <span>${items.length} item${items.length === 1 ? "" : "s"} · ${fmtDur(secs)}</span></div>
      <div class="g">
        <button data-act="plPlay" data-id="${esc(p.id)}" title="Play">▶</button>
        <button data-act="plQueue" data-id="${esc(p.id)}" title="Queue">+</button>
        <button data-act="plSave" data-id="${esc(p.id)}" title="Save offline">⤓</button>
        <button data-act="plExport" data-id="${esc(p.id)}" title="Export as a file">⤒</button>
        <button data-act="plRename" data-id="${esc(p.id)}" title="Rename">✎</button>
        <button data-act="plDel" data-id="${esc(p.id)}" title="Delete">✕</button>
      </div></li>`;
  }).join("")}</ol>` : `<div class="empty">No playlists yet. Build one from the library,
    the queue, or the “+ List” button on any item.</div>`}`;
}

function viewPlaylist(id) {
  const pl = Playlists.get(id);
  if (!pl) return `<div class="empty">Unknown playlist.</div>`;
  const items = pl.items.map(i => BY_ID.get(i)).filter(Boolean);
  return `<a class="back" href="#/playlists">← Playlists</a>
  <h1>${esc(pl.name)}</h1>
  <p class="kv">${items.length} items · ${fmtDur(items.reduce((s, i) => s + i.duration, 0))}</p>
  <div class="actions">
    <button class="btn primary" data-act="plPlay" data-id="${esc(pl.id)}">▶ Play all</button>
    <button class="btn" data-act="plQueue" data-id="${esc(pl.id)}">Add to queue</button>
    <button class="btn" data-act="plSave" data-id="${esc(pl.id)}">Save offline</button>
    <button class="btn" data-act="plExport" data-id="${esc(pl.id)}">Export</button>
    <button class="btn" data-act="plRename" data-id="${esc(pl.id)}">Rename</button>
    <button class="btn" data-act="plDel" data-id="${esc(pl.id)}">Delete</button>
  </div>
  ${items.length ? `<ol class="list">${pl.items.map((iid, i) => {
    const it = BY_ID.get(iid); if (!it) return "";
    return `<li><span class="n">${i + 1}</span>
      <div class="t"><b><a href="#/item/${encodeURIComponent(it.id)}"
        style="text-decoration:none;color:inherit">${esc(it.title)}</a></b>
        <span>${esc(authorName(it.author))} · ${fmtDur(it.duration)}
        ${Offline.has(it) ? " · offline" : ""}</span></div>
      <div class="g">
        <button data-act="plItemPlay" data-pl="${esc(pl.id)}" data-i="${i}" title="Play">▶</button>
        <button data-act="plItemUp" data-pl="${esc(pl.id)}" data-i="${i}" title="Up">↑</button>
        <button data-act="plItemDown" data-pl="${esc(pl.id)}" data-i="${i}" title="Down">↓</button>
        <button data-act="plItemDel" data-pl="${esc(pl.id)}" data-i="${i}" title="Remove">✕</button>
      </div></li>`;
  }).join("")}</ol>` : `<div class="empty">This playlist is empty.</div>`}`;
}

function viewOffline() {
  const saved = DATA.items.filter(i => Offline.has(i));
  const bytes = saved.reduce((s, i) => s + (i.bytes || 0), 0);
  const qd = Offline.queue.map(i => BY_ID.get(i)).filter(Boolean);
  const act = Offline.active ? BY_ID.get(Offline.active) : null;
  return `<h1 style="margin-top:18px">Offline</h1>
  <p class="kv">${saved.length} file${saved.length === 1 ? "" : "s"} saved
    · ${(bytes / 1073741824).toFixed(2)} GB<span id="storageNote"></span></p>
  ${act ? `<div style="margin:14px 0"><b>Downloading:</b> ${esc(act.title)}
    <span id="dlpct" class="note">0%</span>
    <div class="progress" id="dlbar"><i style="width:0"></i></div></div>` : ""}
  ${qd.length ? `<h3>Queued (${qd.length})</h3>
    <div class="actions"><button class="btn" id="dlClear">Clear queue</button></div>
    <ol class="list">${qd.map(it => `<li><div class="t"><b>${esc(it.title)}</b>
      <span>${esc(authorName(it.author))}</span></div>
      <div class="g"><button data-act="dlCancel" data-id="${esc(it.id)}" title="Remove">✕</button></div>
      </li>`).join("")}</ol>` : ""}
  <h3>Saved</h3>
  ${saved.length ? `<div class="actions"><button class="btn" id="dlWipe">Remove all</button></div>
    <ol class="list">${saved.map(it => `<li>
      <div class="t"><b><a href="#/item/${encodeURIComponent(it.id)}"
        style="text-decoration:none;color:inherit">${esc(it.title)}</a></b>
        <span>${esc(authorName(it.author))} · ${fmtDur(it.duration)}
        ${it.bytes ? " · " + (it.bytes / 1048576).toFixed(0) + " MB" : ""}</span></div>
      <div class="g"><button data-act="qplay1" data-id="${esc(it.id)}" title="Play">▶</button>
      <button data-act="unsave1" data-id="${esc(it.id)}" title="Remove">✕</button></div></li>`).join("")}</ol>`
    : `<div class="empty">Nothing saved yet. Use “Save offline” on any item —
      downloads keep going while you browse, and saved files play with no network.</div>`}`;
}

/* -------------------------------------------------------- transcript panel */
let SEG_CACHE = new Map();
function hms(t) {
  const parts = String(t || "").trim().split(":").map(Number);
  if (!parts.length || parts.some(isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function spoilerMeta(s) {
  if (s.disclosure === "declared") return "";
  const state = s.disclosure === "generic_only"
    ? "only a generic tag covers this" : "not named in the tags";
  const bits = [state];
  if (s.tagged) bits.push(`now tagged <b>${esc(s.tagged)}</b>`);
  if (s.confidence) bits.push(`${esc(s.confidence)} confidence`);
  return bits.join(" · ");
}

function spoilerRow(s) {
  const declared = s.disclosure === "declared";
  const secs = hms(s.timestamp);
  const chip = declared ? "declared" : (s.severity || "medium");
  const meta = spoilerMeta(s);
  const stamp = s.timestamp && secs != null
    ? (s.source
        ? `<span class="t off">${esc(s.timestamp)}</span>`
        : `<span class="t" data-act="seek" data-t="${secs}">${esc(s.timestamp)}</span>`)
    : "";
  return `<div class="sprow${declared ? " dec" : ""}">
    <p class="sphead">
      <span class="sev ${esc(chip)}">${esc(chip)}</span>
      ${stamp}
      <b>${esc(s.trigger || "unnamed cue")}</b>
    </p>
    ${s.effect ? `<p>${esc(s.effect)}</p>` : ""}
    ${s.quote ? `<blockquote>${esc(s.quote)}${s.source ? `<cite>installed in
      <a href="#/item/${encodeURIComponent(s.source)}">${esc(s.source_title || s.source)}</a></cite>` : ""}</blockquote>` : ""}
    ${s.note ? `<p class="note">${esc(s.note)}</p>` : ""}
    ${meta ? `<p class="note">${meta}</p>` : ""}
  </div>`;
}

async function wireSpoilers(it) {
  if (!it.spoilerCount) return;
  const box = $("#spBox"); if (!box) return;
  const fill = async () => {
    if (box.dataset.loaded) return;
    box.dataset.loaded = "1";
    await ensureSpoilers();
    const body = $("#spBody"); if (!body) return;
    const rows = (SPOILERS && SPOILERS[it.id]) || [];
    body.innerHTML = rows.length
      ? rows.map(spoilerRow).join("")
      : `<p class="note">Notes could not be loaded.</p>`;
  };
  box.addEventListener("toggle", () => box.open && fill());
  if (box.open) fill();
}

async function wireItem(id) {
  const it = BY_ID.get(id);
  if (!it) return;
  wireSpoilers(it);
  // Two things playing at once is nobody's intention. The page's video wins
  // while it is running; the player keeps its place and is still there after.
  const screen = $("video.hero");
  if (screen) {
    screen.addEventListener("play", () => {
      if (Player.el && !Player.el.paused) Player.toggle();
    });
  }
  if (!it.hasTranscript) return;
  const box = $("#trBox"); if (!box) return;
  const fill = async () => {
    if (box.dataset.loaded) return;
    box.dataset.loaded = "1";
    let payload = SEG_CACHE.get(id);
    if (!payload) {
      try {
        const r = await fetch(`transcripts/${encodeURIComponent(id)}.json`);
        payload = r.ok ? await r.json() : null;
      } catch { payload = null; }
      if (!payload) payload = { text: "", segments: null };
      SEG_CACHE.set(id, payload);
    }
    const body = $("#trBody"); if (!body) return;
    const q = F.q.trim();
    if (payload.segments && payload.segments.length) {
      body.innerHTML = `<table class="seg">${payload.segments.map((s, i) =>
        `<tr data-s="${s.start}" data-i="${i}"><td class="t" data-act="seek" data-t="${s.start}">${clock(s.start)}</td>
         <td>${mark(esc(s.text), q)}</td></tr>`).join("")}</table>`;
    } else {
      /* No timestamps, which is what a transcript supplied by the creator looks
         like. It used to render as <pre>, and a supplied transcript is one
         paragraph per line with lines running to five hundred characters, so
         the panel became a wall of monospace that scrolled sideways. It is
         prose; set it as prose. */
      const paras = String(payload.text || "").split(/\n+/).map(p => p.trim()).filter(Boolean);
      body.innerHTML = paras.length
        ? `<div class="plain">${paras.map(p => `<p>${mark(esc(p), q)}</p>`).join("")}</div>`
        : `<p class="note">No transcript text.</p>`;
    }
  };
  box.addEventListener("toggle", () => box.open && fill());
  if (box.open) fill();
  if (F.q.trim() && F.tr) { box.open = true; fill(); }
}
/* Where a transcript came from, and no more than is actually known.

   The field holds six different things across this library -- a model name, a
   model name with a flag after it, the word "transcript", the word "None", the
   word "whisper", and "source" -- because it has been written by several
   passes over several years. Three of those say nothing about provenance, and
   claiming "automatic" for them was asserting something nobody recorded. */
function transcriptNote(src) {
  const s = String(src ?? "").trim();
  if (s === "source") return "Transcript as supplied with the recording.";
  if (!s || s === "None" || s === "null" || s === "transcript")
    return "Transcript — how it was made was not recorded.";
  if (s === "whisper") return "Automatic transcript — expect occasional errors.";
  return `Automatic transcript (${s}) — expect occasional errors.`;
}

function mark(html, q) {
  if (!q) return html;
  const terms = q.split(/\s+/).filter(t => t.length > 1)
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return html;
  return html.replace(new RegExp(`(${terms.join("|")})`, "gi"), "<mark>$1</mark>");
}
function highlightSegments(t, id) {
  if (route().name !== "item" || route().arg !== id) return;
  const rows = $$("#trBody tr"); if (!rows.length) return;
  let hit = null;
  for (const r of rows) if (+r.dataset.s <= t) hit = r; else break;
  for (const r of rows) r.classList.toggle("on", r === hit);
}

/* ------------------------------------------------------- import and export */
const slugOf = s => String(s || "").toLowerCase().normalize("NFKD")
  .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function transferName(what, extra = "") {
  const base = slugOf(DATA.site?.title) || "hypnotica";
  const mid = slugOf(extra);
  return `${base}-${what}${mid ? "-" + mid : ""}-${new Date().toISOString().slice(0, 10)}.json`;
}

/* A file the browser saves, when it will. Downloads started by a page are not
   available everywhere one of these runs -- an installed web app on a phone may
   have nowhere to put a file -- and somebody halfway through moving to a new
   device needs the text more than they need a file, so a refusal falls back to
   the text itself rather than to an apology. */
function downloadText(text, name) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.rel = "noopener";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 20000);
    return true;
  } catch { return false; }
}

function exportBundle(what, bundle, extra = "") {
  const text = JSON.stringify(bundle, null, 2) + "\n";
  const name = transferName(what, extra);
  if (downloadText(text, name)) toast(`Saved ${name}`);
  else showTransfer(text);
}

function transferDialog(title, body, foot) {
  const dlg = $("#ioDlg");
  if (!dlg) return null;
  $("#ioTitle").textContent = title;
  $("#ioBody").innerHTML = body;
  $("#ioFoot").innerHTML = foot;
  dlg.showModal();
  return dlg;
}

function showTransfer(text) {
  transferDialog("Export",
    `<p class="note">This browser would not save a file. Copy the text instead and
      keep it wherever the other device can reach it.</p>
     <textarea id="ioOut" rows="8" readonly aria-label="Exported JSON"></textarea>`,
    `<button class="btn" data-act="ioClose">Close</button>
     <button class="btn primary" id="ioCopy">Copy</button>`);
  const box = $("#ioOut");
  if (box) { box.value = text; box.focus(); box.select(); }
}

/* Export, with the file named before it is written. Favourites and playlists are
   ticked because they are what an export has always been; notes and history are
   not, because they were written for oneself and a file is the thing that gets
   sent to somebody else. */
function openExport(pre = {}) {
  const held = {
    favourites: Favourites.ids("item").length + Favourites.ids("author").length > 0,
    playlists: Playlists.all().length > 0,
    notes: Notes.ids().length > 0,
    history: History.events().length > 0,
    searches: Searches.all().length > 0,
  };
  const row = (k, label, hint) => `<label class="exprow">
    <input type="checkbox" data-sec="${k}"${(pre[k] ?? (k === "favourites" || k === "playlists")) && held[k] ? " checked" : ""}${held[k] ? "" : " disabled"}>
    <span><b>${esc(label)}</b> ${esc(hint)}${held[k] ? "" : " — nothing to send"}</span></label>`;
  transferDialog("Export",
    `<p class="note">One file, carrying whichever of these you tick. It can be read back
      here or on another device, and an import merges rather than replaces.</p>
     ${row("favourites", "Favourites", "recordings and creators, with when each was liked")}
     ${row("playlists", "Playlists", "every list, and what has been taken out of them")}
     ${row("notes", "Notes", "what you have written against recordings")}
     ${row("history", "History", "what was played, when, and how often")}
     ${row("searches", "Saved searches", "the searches you have given names to")}
     <p class="note">A note marked private is left out whatever is ticked here, and the
       standing filter is in none of this: it goes to your own devices and nowhere
       else.</p>`,
    `<button class="btn" data-act="ioClose">Cancel</button>
     <button class="btn primary" id="ioExportGo">Export</button>`);
}

function openImport() {
  transferDialog("Import",
    `<p class="note">A file exported from Hypnotica, here or on another device.
      Playlists already here gain whatever the file adds to them and keep what
      they have; the rest arrive as new ones, and favourites join yours. Nothing
      is removed, and an entry this library does not have is kept rather than
      dropped.</p>
     <input type="file" id="ioFile" accept="application/json,.json">
     <p class="note">Or paste the text of the file:</p>
     <textarea id="ioText" rows="6" aria-label="Exported JSON"
       placeholder='{"hypnotica": 1, "playlists": […]}'></textarea>`,
    `<button class="btn" data-act="ioClose">Cancel</button>
     <button class="btn primary" id="ioGo">Import</button>`);
}

/* What arrived, said plainly: a merge that adds nothing looks exactly like one
   that failed unless it says so. */
function runImport(text) {
  if (!String(text || "").trim()) { toast("Choose a file, or paste one in."); return; }
  let payload;
  try { payload = Share.parse(text); }
  catch (e) { toast(e.message || "Could not read that."); return; }
  const r = Share.merge(payload);
  $("#ioDlg")?.close();
  const bits = [];
  if (r.added) bits.push(`${r.added} playlist${r.added === 1 ? "" : "s"}`);
  if (r.updated) bits.push(`${r.updated} playlist${r.updated === 1 ? "" : "s"} updated`);
  const favs = r.items + r.authors;
  if (favs) bits.push(`${favs} favourite${favs === 1 ? "" : "s"}`);
  if (r.notes) bits.push(`${r.notes} note${r.notes === 1 ? "" : "s"}`);
  if (r.events) bits.push(`${r.events} sitting${r.events === 1 ? "" : "s"}`);
  if (r.searches) bits.push(`${r.searches} saved search${r.searches === 1 ? "" : "es"}`);
  // Removals are counted separately and said out loud. A merge that takes
  // something away has to be as visible as one that adds.
  const away = [];
  if (r.dropped) away.push(`${r.dropped} favourite${r.dropped === 1 ? "" : "s"}`);
  if (r.lists) away.push(`${r.lists} playlist${r.lists === 1 ? "" : "s"}`);
  toast((bits.length ? `Imported ${bits.join(", ")}` : "Nothing new in that file")
        + (away.length ? ` · removed ${away.join(", ")}` : "")
        + (r.missing ? ` · ${r.missing} not in this library` : ""));
  render();
}

/* ------------------------------------------------------- linking a device */
let OFFER = null;             // the pairing this device is currently offering
let SETUP = null;             // what the address being asked for is being asked for

function stopOffer() {
  if (OFFER?.poll) clearInterval(OFFER.poll);
  OFFER = null;
}

function finishSetup(where, invite) {
  if (SETUP?.after === "share") { makeShare(SETUP.preset, where, invite); return; }
  offerNow(where, invite);
}

async function makeShare(presetName, where, invite) {
  const preset = SHARE_PRESETS[presetName] || SHARE_PRESETS.plain;
  try {
    if (where) {
      transferDialog("Publish a share", `<p class="note">Setting up…</p>`,
        `<button class="btn" data-act="linkCancel">Cancel</button>`);
      await Sync.setUp(where, invite);
    }
    await Shares.create(preset.label, preset.on);
    $("#ioDlg")?.close();
    toast("Share published");
    if (route().name !== "profile") go("/profile"); else render();
  } catch (e) {
    transferDialog("Publish a share",
      `<p class="note disputed">${esc(e.message || "that did not work")}</p>`,
      `<button class="btn primary" data-act="linkCancel">Close</button>`);
  }
}

/* Nothing here works without the browser's cryptography, and the reason it is
   missing is fixable, so it is worth saying which one it is rather than failing
   at the first call. */
function showInsecure() {
  transferDialog("Link a device",
    `<p class="note disputed">Sync is not available on this page.</p>
     <p class="note">Browsers hand out the cryptography it needs only on a secure page:
       HTTPS, or a site opened from localhost. This one is
       <code>${esc(location.origin)}</code>. Serve it over HTTPS and this will work;
       everything else — history, notes, playlists, the transfer file — is local and
       works as it is.</p>`,
    `<button class="btn primary" data-act="linkCancel">Close</button>`);
}

function linkStart() {
  if (Sync.on()) { offerNow(Sync.base(), ""); return; }
  setupDialog({ after: "link" });
}

/* Sharing needs somewhere to publish to just as linking does, so it asks the
   same question and makes the same group -- with one device in it, which is a
   perfectly ordinary library. Nobody should have to link a second device they
   do not own in order to show somebody a playlist. */
function shareStart(preset) {
  if (Sync.on()) { makeShare(preset); return; }
  setupDialog({ after: "share", preset });
}

function setupDialog(what) {
  SETUP = what;
  if (!canSync()) { showInsecure(); return; }
  const forShare = what.after === "share";
  transferDialog(forShare ? "Publish a share" : "Link a device",
    `<p class="note">${forShare
      ? `A share is a page published for somebody else to read, so it needs somewhere to
         live — a Hypnotica running <code>serve --sync</code>, on your own machine or
         anywhere the person you are sharing with can reach.`
      : `Sync needs somewhere to keep the encrypted blobs — a Hypnotica running
         <code>serve --sync</code>, on your own machine or anywhere both devices can
         reach.`} This is the only time you type it in: every device after this one gets
      it from the code.</p>
     <input id="lnkWhere" type="url" placeholder="https://sync.example.com"
       aria-label="Sync endpoint" style="width:100%">
     <p class="note" id="lnkHint">&nbsp;</p>`,
    `<button class="btn" data-act="linkCancel">Cancel</button>
     <button class="btn primary" data-act="linkGo">Continue</button>`);
  /* A site served by a Hypnotica with --sync has its endpoint at the same
     origin, which is the ordinary case and not worth making anybody type. It is
     filled in rather than assumed: the address is still there to be read, and
     still there to be changed. */
  Sync.policy(location.origin).then(how => {
    const box = $("#lnkWhere"), hint = $("#lnkHint");
    if (!box || box.value.trim() || how === "closed") return;
    box.value = location.origin;
    if (hint) hint.textContent = "This site is served with one, filled in above.";
  }).catch(() => {});
}

/* Whether a token is wanted is the endpoint's business, not something to make a
   person guess at. Most will want none; the ones that do are asked for it here
   and nowhere else. */
async function linkWhere(where) {
  transferDialog("Link a device", `<p class="note">Asking ${esc(where)}…</p>`,
    `<button class="btn" data-act="linkCancel">Cancel</button>`);
  let how = "invite";
  try {
    how = await Sync.policy(where);
  } catch (e) {
    // An address that will not answer at all is worth saying so about, rather
    // than asking for a token it may not even want.
    transferDialog("Link a device",
      `<p class="note disputed">${esc(e.message || "that address did not answer")}</p>
       <p class="note">Check the address, and that the endpoint is running with
         <code>--sync</code>.</p>`,
      `<button class="btn" data-act="linkCancel">Close</button>
       <button class="btn primary" data-act="linkStart">Back</button>`);
    return;
  }
  if (how === "open") { finishSetup(where, ""); return; }
  if (how === "closed") {
    transferDialog("Link a device",
      `<p class="note disputed">That endpoint is not taking new libraries.</p>
       <p class="note">Whoever runs it can open it with <code>--sync-open</code>, or hand
         out an invite with <code>--sync-invite</code>. A library already on it goes on
         working either way.</p>`,
      `<button class="btn" data-act="linkCancel">Close</button>
       <button class="btn primary" data-act="linkStart">Back</button>`);
    return;
  }
  transferDialog("Link a device",
    `<p class="note">That endpoint asks for an invite before it takes a new library.
      Whoever runs it has one.</p>
     <input id="lnkInvite" placeholder="invite" aria-label="Invite"
       style="width:100%" data-where="${esc(where)}">`,
    `<button class="btn" data-act="linkCancel">Cancel</button>
     <button class="btn primary" data-act="linkGoInvite">Set up</button>`);
}

async function offerNow(endpoint, invite) {
  stopOffer();
  transferDialog("Link a device", `<p class="note">Setting up…</p>`,
    `<button class="btn" data-act="linkCancel">Cancel</button>`);
  let offer;
  try {
    offer = await Pair.offer(endpoint, invite);
  } catch (e) {
    transferDialog("Link a device",
      `<p class="note disputed">${esc(e.message || "that endpoint would not have it")}</p>`,
      `<button class="btn" data-act="linkCancel">Close</button>
       <button class="btn primary" data-act="linkStart">Try again</button>`);
    return;
  }
  OFFER = offer;
  showOffer();
  OFFER.poll = setInterval(async () => {
    const seen = await Pair.read(offer.base, offer.id, offer.key).catch(() => null);
    if (!seen?.b?.pub || OFFER?.digits) return;
    OFFER.theirs = fromB64(seen.b.pub);
    OFFER.digits = await sasDigits(offer.id, offer.me.pub, OFFER.theirs);
    showOffer();
  }, 2000);
}

/* The code first and the text behind a fold: a code is hard to paste into a chat
   by accident, and this link is the whole library, not a share. */
function showOffer() {
  if (!OFFER) return;
  const body = OFFER.digits
    ? `<p class="note">The other device is showing six digits. If they are these, confirm
        it here.</p>
       <p class="sas">${esc(OFFER.digits)}</p>
       <p class="note">If they differ, something is between the two devices. Cancel, and
        start again. If that device is already linked to others of yours, the two groups
        become one.</p>`
    : `<p class="note">Open this on the other device — its camera will do. The code is
        good for five minutes and one device, and it does not carry the key: that is
        handed over afterwards, sealed, once you have compared six digits.</p>
       ${qrSVG(OFFER.link, "Pairing code")}
       <details class="astext"><summary>Show it as text</summary>
         <textarea id="lnkText" rows="3" readonly aria-label="Pairing link"
           >${esc(OFFER.link)}</textarea>
         <p class="note">Only ever to your own device. Anything holding this becomes part
           of the group.</p></details>
       <p class="note">Waiting for the other device…</p>`;
  transferDialog("Link a device", body,
    OFFER.digits
      ? `<button class="btn" data-act="linkCancel">Cancel</button>
         <button class="btn primary" data-act="linkConfirm">They match — link it</button>`
      : `<button class="btn" data-act="linkCancel">Cancel</button>`);
}

async function confirmOffer() {
  const offer = OFFER;
  if (!offer?.theirs || offer.handed) return;
  offer.handed = true;
  try {
    await Pair.hand(offer);
    transferDialog("Link a device",
      `<p class="note">Confirmed here. Now confirm on the other device — it is showing
        the same six digits.</p>
       <p class="sas">${esc(offer.digits)}</p>
       <p class="note" id="linkState">Waiting for the other device…</p>`,
      `<button class="btn" data-act="linkCancel">Cancel</button>`);
    const other = await Pair.answer(offer, () => OFFER === offer);
    const how = await Pair.settle(other);
    stopOffer();
    transferDialog("Link a device", `<p class="note">${esc(linkedSays(how))}</p>`,
      `<button class="btn primary" data-act="linkCancel">Done</button>`);
    Sync.run();
    render();
  } catch (e) {
    offer.handed = false;
    if (OFFER === offer) toast(e.message || "could not hand the key over");
  }
}

/* What linking did, said the same way on both screens. */
function linkedSays(how) {
  return how === "merged"
    ? `Linked. Both devices were already in groups of their own, and the two are now
       one: every device in either is joining it and bringing what it holds, and links
       shared from either go on working and show the whole of it.`
    : how === "same" ? "These two were already linked to each other."
    : "Linked. The other device is taking a copy now.";
}

/* Importing somebody else's share takes what they chose to publish and leaves
   their listening out of it: their play counts are theirs, and merging them
   would make this library claim things it never played. */
async function importShared() {
  const d = VIEWING?.doc;
  if (!d) return;
  const bits = [];
  if ((d.playlists || []).length) bits.push(`${d.playlists.length} playlist(s)`);
  const favs = Object.keys(d.favourites?.items || {}).length;
  if (favs) bits.push(`${favs} favourite(s)`);
  const notes = Object.keys(d.notes || {}).length;
  if (notes) bits.push(`${notes} note(s)`);
  if (!bits.length) { toast("Nothing in that share to import."); return; }
  if (!confirm(`Take ${bits.join(", ")} into your library? Their history is not included.`)) return;
  try {
    const payload = Share.parse(JSON.stringify({
      hypnotica: d.hypnotica, playlists: d.playlists, favourites: d.favourites,
      notes: d.notes, names: d.titles,
    }));
    const r = Share.merge(payload);
    toast(`Imported ${r.added + r.updated} playlist(s), ${r.items} favourite(s), ${r.notes} note(s)`);
    render();
  } catch (e) {
    toast(e.message || "could not read that share");
  }
}

/* ------------------------------------------------------------ add-to-modal */
function askPlaylist(ids) {
  const dlg = $("#plDlg");
  const all = Playlists.all();
  $("#plDlgBody").innerHTML = `
    ${all.length ? `<ol class="list">${all.map(p =>
      `<li><div class="t"><b>${esc(p.name)}</b><span>${p.items.length} items</span></div>
       <div class="g"><button data-pick="${esc(p.id)}" title="Add">+</button></div></li>`).join("")}</ol>`
      : `<p class="note">No playlists yet.</p>`}
    <div style="display:flex;gap:8px;margin-top:12px">
      <input id="plNewName" placeholder="New playlist name" style="flex:1">
      <button class="btn primary" id="plNewGo">Create</button></div>`;
  dlg.dataset.ids = JSON.stringify(ids);
  dlg.showModal();
}

/* ------------------------------------------------------------------- wiring */
function idsOf(nodeIds) { return nodeIds.filter(x => BY_ID.get(x)?.audio); }

document.addEventListener("click", e => {
  if (Date.now() - HELD_AT < 400) return;      // the press that ended a long one
  const t = e.target.closest("[data-act],[data-pick],button,select");
  if (!t) return;
  const act = t.dataset?.act;
  const card = e.target.closest(".card");
  const cardId = card?.dataset.id;

  if (t.dataset?.pick) {
    const ids = JSON.parse($("#plDlg").dataset.ids || "[]");
    Playlists.addItems(t.dataset.pick, ids);
    $("#plDlg").close(); toast(`Added ${ids.length} to playlist`); render(); return;
  }

  switch (act) {
    case "tag": {
      const v = t.dataset.tag, want = e.altKey ? "not" : "any";
      setFacet("tags", v, facetOf("tags", v) === want ? "" : want);
      if (route().name !== "library") go("/"); else rerender();
      return; }
    case "facet": cycleFacet(t.dataset.key, t.dataset.v, e.altKey); rerender(); return;
    case "facetPin": togglePin(t.dataset.key, t.dataset.v); rerender(); return;
    case "alwaysSuspend": ALWAYS.off = !ALWAYS.off; saveAlways(); rerender(); return;
    case "searchSave": {
      const n = prompt("Call this search", F.q.trim() || "Saved search");
      if (!n) return;
      Searches.add(n); toast("Search saved"); rerender(); return; }
    case "searchApply":
      if (Searches.apply(t.dataset.id)) rerender();
      return;
    case "searchDrop": {
      const row = Searches.get(t.dataset.id);
      if (!row || !confirm(`Forget “${row.name}”?`)) return;
      Searches.remove(t.dataset.id); rerender(); return; }
    case "facetOff": setFacet(t.dataset.key, t.dataset.v, ""); rerender(); return;
    case "facetClear": clearFacet(t.dataset.key, t.dataset.kind || null); rerender(); return;
    case "play": Player.play([cardId]); return;
    case "enqueue": Player.enqueue([cardId]); return;
    case "addto": askPlaylist([cardId]); return;
    case "save": Offline.add(cardId); return;
    case "unsave": Offline.remove(cardId); return;
    case "playOne": Player.play([t.dataset.id]); return;
    case "next1": Player.playNext(t.dataset.id); return;
    case "enqueue1": Player.enqueue([t.dataset.id]); return;
    case "addto1": askPlaylist([t.dataset.id]); return;
    case "save1": Offline.add(t.dataset.id); return;
    case "unsave1": Offline.remove(t.dataset.id); return;
    case "qplay1": Player.play([t.dataset.id]); return;
    case "seek": Player.el.currentTime = +t.dataset.t;
                 if (Player.el.paused) Player.el.play().catch(() => {}); return;
    /* Play all means all of what is on the page. Queueing something the
       standing filter took off it would be the filter failing at the one moment
       it matters most. */
    case "playAuthor": Player.play(idsOf(alwaysKeep(BY_AUTHOR.get(t.dataset.author) || []).map(i => i.id))); return;
    case "queueAuthor": Player.enqueue(idsOf(alwaysKeep(BY_AUTHOR.get(t.dataset.author) || []).map(i => i.id))); return;
    case "saveAuthor": Offline.addMany(alwaysKeep(BY_AUTHOR.get(t.dataset.author) || []).map(i => i.id)); return;
    case "qplay": Player.load(+t.dataset.i, true); return;
    case "qup": Player.moveAt(+t.dataset.i, -1); return;
    case "qdown": Player.moveAt(+t.dataset.i, 1); return;
    case "qdel": Player.removeAt(+t.dataset.i); return;
    case "dlCancel": Offline.cancel(t.dataset.id); return;
    case "plPlay": { const p = Playlists.get(t.dataset.id);
      if (p) Player.play(idsOf(p.items)); return; }
    case "plQueue": { const p = Playlists.get(t.dataset.id);
      if (p) Player.enqueue(idsOf(p.items)); return; }
    case "plSave": { const p = Playlists.get(t.dataset.id);
      if (p) Offline.addMany(p.items); return; }
    case "plRename": { const p = Playlists.get(t.dataset.id); if (!p) return;
      const n = prompt("Playlist name", p.name);
      if (n) { Playlists.update(p.id, x => (x.name = n)); render(); } return; }
    case "plDel": { const p = Playlists.get(t.dataset.id); if (!p) return;
      if (confirm(`Delete "${p.name}"?`)) { Playlists.remove(p.id);
        route().name === "playlist" ? go("/playlists") : render(); } return; }
    case "plItemPlay": { const p = Playlists.get(t.dataset.pl);
      if (p) Player.play(idsOf(p.items), Math.min(+t.dataset.i, p.items.length - 1)); return; }
    case "plItemUp": case "plItemDown": {
      const d = act === "plItemUp" ? -1 : 1, i = +t.dataset.i;
      Playlists.update(t.dataset.pl, p => {
        const j = i + d; if (j < 0 || j >= p.items.length) return;
        [p.items[i], p.items[j]] = [p.items[j], p.items[i]];
      }); render(); return; }
    case "plItemDel": Playlists.dropItem(t.dataset.pl, +t.dataset.i); render(); return;
    case "plExport": { const p = Playlists.get(t.dataset.id); if (!p) return;
      exportBundle("playlist", Share.bundle({ playlists: [p] }), p.name); return; }
    /* Liking something is one button changing, everywhere but the page that is
       a list of what has been liked -- there, it is the page changing. */
    case "fav": {
      Favourites.toggle(t.dataset.what, t.dataset.fid);
      if (route().name === "favourites") render(); else paintHearts(t.dataset.what, t.dataset.fid);
      return; }
    case "ioClose": $("#ioDlg")?.close(); return;
    case "histPlay": Player.play(idsOf([t.dataset.id])); return;
    case "histForget": {
      const id = t.dataset.id;
      if (!confirm(`Forget every time "${titleOf(id).title}" was played?`)) return;
      History.forgetItem(id); render(); return; }
    case "noteSave": {
      const box = $("#noteText");
      if (!box) return;
      Notes.set(t.dataset.id, box.value, !!$("#notePriv")?.checked);
      toast(box.value.trim() ? "Note saved" : "Note cleared");
      render(); return; }
    case "noteDel":
      if (!confirm("Delete this note?")) return;
      Notes.set(t.dataset.id, "", false); render(); return;
    case "noteRestore": Notes.restore(t.dataset.id); toast("Note restored"); render(); return;
    case "noteDrop": Notes.clearDisplaced(t.dataset.id); render(); return;

    case "linkStart": linkStart(); return;
    case "linkGo": {
      const where = $("#lnkWhere")?.value.trim() || "";
      if (!/^https?:\/\//.test(where)) { toast("That needs to be a web address."); return; }
      linkWhere(where.replace(/\/+$/, "")); return; }
    case "linkGoInvite": {
      const box = $("#lnkInvite");
      finishSetup(box?.dataset.where || "", box?.value.trim() || ""); return; }
    case "linkConfirm": confirmOffer(); return;
    case "linkCancel": stopOffer(); $("#ioDlg")?.close(); return;
    case "linkJoin": {
      if (!LINKING) return;
      LINKING.error = "";
      const link = LINKING;
      Pair.announce(link)
        .then(digits => { link.digits = digits; render(); })
        .catch(e => { link.digits = ""; link.error = e.message || String(e); render(); });
      link.digits = link.digits || "……";
      render(); return; }
    case "linkAccept": {
      const link = LINKING;
      if (!link?.me || link.accepted) return;
      link.error = "";
      link.accepted = true;
      Pair.accept(link)
        .then(how => { link.done = how; render(); })
        .catch(e => { link.accepted = false; link.error = e.message || String(e); render(); });
      render(); return; }
    case "syncNow": Sync.run(); return;
    case "unlinkAll":
      if (!confirm("Unlink this device? Its own copy stays; it stops sending and receiving.")) return;
      Sync.forget().then(() => { toast("Unlinked"); render(); });
      return;
    case "meSave":
      Me.setName($("#meNameBox")?.value || "");
      Shares.refresh().catch(() => {});
      toast("Saved"); render(); return;

    case "shareNew": shareStart(t.dataset.preset); return;
    case "shareCopy": {
      const row = Shares.get(t.dataset.id); if (!row) return;
      navigator.clipboard?.writeText(Shares.link(row)).then(() => toast("Link copied"), () => {});
      return; }
    case "shareRotate":
      if (!confirm("Issue a new link? The one you have given out stops working.")) return;
      Shares.rotate(t.dataset.id).then(() => { toast("New link"); render(); })
        .catch(e => toast(e.message || "could not rotate it"));
      return;
    case "shareRevoke":
      if (!confirm("Revoke this share? The link stops opening anything.")) return;
      Shares.revoke(t.dataset.id)
        .then(() => { toast("Revoked"); render(); })
        .catch(e => toast(`Not revoked: ${e.message || e}`));
      return;
    case "deviceDrop": {
      const held = load(K.devices, {}) || {};
      delete held[t.dataset.id];
      save(K.devices, held);
      Keys.ready().then(k => k && Sync.ask("DELETE", `/sync/${k.group}/${t.dataset.id}`))
        .catch(() => {}).then(() => render());
      return; }

    case "follow":
      if (!VIEWING) return;
      Followed.add(VIEWING.endpoint, VIEWING.key)
        .then(row => { VIEWING.id = row.id; toast(`Keeping ${row.name}`); render(); })
        .catch(e => toast(e.message || "could not keep that one"));
      return;
    case "unfollow":
      Followed.remove(t.dataset.id);
      toast("Stopped keeping it"); render(); return;
    case "followRefresh":
      toast("Asking again…");
      Followed.refresh().then(() => { toast("Up to date"); render(); });
      return;
    case "sharedImport": importShared(); return;
    case "sharedOpen": go("/p"); return;
    case "sharedClose": VIEWING = null; toast("Closed"); render(); return;
    case "sharedPlay": {
      const pl = (VIEWING?.doc?.playlists || []).find(p => p.id === t.dataset.id);
      if (pl) Player.play(idsOf(pl.items || []));
      return; }
    case "sharedQueue": {
      const pl = (VIEWING?.doc?.playlists || []).find(p => p.id === t.dataset.id);
      if (pl) Player.enqueue(idsOf(pl.items || []));
      return; }
    /* Copied whole, ids this library does not know included: it may gain them,
       and a playlist that arrives four entries short is not the one they made. */
    case "sharedCopy": {
      const pl = (VIEWING?.doc?.playlists || []).find(p => p.id === t.dataset.id);
      if (!pl) return;
      const who = VIEWING?.doc?.profile?.name;
      Playlists.create(who ? `${pl.name} (${who})` : pl.name, pl.items || []);
      toast("Copied to your playlists");
      return; }
    case "exportAny": openExport({}); return;
    case "importAny": openImport(); return;
    case "pasteLink": pasteLink(); return;
    case "pasteGo": {
      const why = takeLink($("#pasteBox")?.value || "");
      if (!why) { $("#ioDlg")?.close(); return; }
      const line = $("#pasteWhy");
      if (line) line.textContent = why;
      return; }
    case "shareCopyHere": {
      if (!VIEWING) return;
      const here = `${location.origin}${location.pathname}#/p?e=${
        encodeURIComponent(VIEWING.endpoint)}&k=${VIEWING.key}`;
      navigator.clipboard?.writeText(here).then(() => toast("Link copied"), () => {});
      return; }
  }

  switch (t.id) {
    case "playAll": Player.play(idsOf(filtered().map(i => i.id))); break;
    case "queueAll": Player.enqueue(idsOf(filtered().map(i => i.id))); break;
    case "saveAll": Offline.addMany(filtered().map(i => i.id)); break;
    case "listAll": { const n = prompt("Playlist name", "Filtered selection");
      if (n) { Playlists.create(n, filtered().map(i => i.id)); toast("Playlist saved"); } break; }
    case "qClear": Player.clear(); break;
    case "qSave": { const n = prompt("Playlist name", "Queue");
      if (n) { Playlists.create(n, Player.queue); toast("Playlist saved"); } break; }
    case "plNew": { const n = prompt("Playlist name", "New playlist");
      if (n) { Playlists.create(n); render(); } break; }
    case "plNewGo": { const n = $("#plNewName").value.trim() || "New playlist";
      const ids = JSON.parse($("#plDlg").dataset.ids || "[]");
      Playlists.create(n, ids); $("#plDlg").close(); toast("Playlist created"); render(); break; }
    case "plExportAll": exportBundle("playlists", Share.bundle({ playlists: Playlists.all() })); break;
    case "plImport": case "favImport": openImport(); break;
    case "ioGo": runImport($("#ioText")?.value || ""); break;
    case "ioCopy": { const box = $("#ioOut"); if (!box) break;
      box.focus(); box.select();
      navigator.clipboard?.writeText(box.value).then(() => toast("Copied"), () => {});
      break; }
    case "favExport": exportBundle("favourites", Share.bundle({ favourites: true })); break;
    case "histExport": openExport({ history: true }); break;
    case "noteExport": openExport({ notes: true }); break;
    case "noteImport": openImport(); break;
    case "ioExportGo": {
      const want = {};
      for (const box of $$("#ioBody input[data-sec]")) want[box.dataset.sec] = box.checked;
      if (!Object.values(want).some(Boolean)) { toast("Tick something to export."); break; }
      $("#ioDlg")?.close();
      exportBundle("library", Share.bundle({
        playlists: want.playlists ? Playlists.all() : null,
        favourites: !!want.favourites, notes: !!want.notes, history: !!want.history,
        searches: !!want.searches,
      }));
      break; }
    case "histPause": History.setPaused(!History.paused()); render(); break;
    case "histClear":
      if (confirm("Clear everything this device remembers about what was played?")) {
        History.clear(); toast("History cleared"); render();
      }
      break;
    case "favPlay": Player.play(idsOf(Favourites.ids("item"))); break;
    case "favQueue": Player.enqueue(idsOf(Favourites.ids("item"))); break;
    case "favSave": Offline.addMany(Favourites.ids("item")); break;
    case "favList": { const n = prompt("Playlist name", "Favourites");
      if (n) { Playlists.create(n, Favourites.ids("item")); toast("Playlist saved"); } break; }
    case "dlClear": Offline.clearQueue(); break;
    case "dlWipe": if (confirm("Remove every offline file?")) Offline.removeAll(); break;
    case "pPlay": Player.toggle(); break;
    case "pNext": Player.next(); break;
    case "pPrev": Player.prev(); break;
    case "pBack": Player.nudge(-15); break;
    case "pFwd": Player.nudge(30); break;
    case "pRate": { const steps = [0.75, 0.9, 1, 1.1, 1.25, 1.5];
      const i = steps.indexOf(+Player.el.playbackRate.toFixed(2));
      Player.setRate(steps[(i + 1) % steps.length]); break; }
    case "pOpen": { const it = Player.current(); if (it) go(`/item/${encodeURIComponent(it.id)}`); break; }
  }
});

let searchTimer, facetTimer;
document.addEventListener("input", async e => {
  const t = e.target;
  if (t.id === "q") {
    clearTimeout(searchTimer);
    const v = t.value;
    searchTimer = setTimeout(async () => {
      F.q = v; saveFilters();
      refreshTranscriptHits();
      refilter();
    }, 180);
    return;
  }
  if (t.id.startsWith("fq-")) {
    clearTimeout(facetTimer);
    const id = t.id.slice(3), v = t.value;
    facetTimer = setTimeout(() => { FQ[id] = v; refilter(); }, 140);
    return;
  }
  if (t.id === "fDurMin" || t.id === "fDurMax") {
    clearTimeout(facetTimer);
    const which = t.id === "fDurMin" ? "min" : "max", v = t.value;
    facetTimer = setTimeout(() => { F.dur[which] = v; saveFilters(); refilter(); }, 220);
    return;
  }
  if (t.id === "pSeek") { Player.seek(t.value / 1000); return; }
});

document.addEventListener("change", async e => {
  const t = e.target;
  if (t.id === "ioFile") {
    const file = t.files && t.files[0];
    if (!file) return;
    try { $("#ioText").value = await file.text(); }
    catch { toast("Could not read that file."); }
    return;
  }
  const map = { fAuthor: "author", fSort: "sort", aSort: "asort" };
  if (map[t.id]) { F[map[t.id]] = t.value; saveFilters(); render(); return; }
  if (t.id === "fTr") { F.tr = t.checked; saveFilters();
    refreshTranscriptHits(); render(); return; }
  if (t.id === "fOff") { F.off = t.checked; saveFilters(); render(); return; }
  if (t.id === "fSpoil") { F.spoil = t.checked; saveFilters(); rerender(); return; }
});

document.addEventListener("keydown", e => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.metaKey || e.ctrlKey) return;
  if (e.key === " " && Player.ready) { e.preventDefault(); Player.toggle(); }
  else if (e.key === "ArrowRight" && e.shiftKey) Player.next();
  else if (e.key === "ArrowLeft" && e.shiftKey) Player.prev();
  else if (e.key === "/") { e.preventDefault(); $("#q")?.focus(); }
});

if ("scrollRestoration" in history) history.scrollRestoration = "manual";
window.addEventListener("hashchange", render);
/* Whether there is a network, said on the button that is already in the corner
   rather than on a badge of its own.

   A dot is a colour, and a colour on its own tells a reader with no colour
   nothing, so the state is also in the button's label and written out in the
   menu -- where somebody wondering why a recording will not play is going to
   look anyway. */
const netBadge = () => {
  const menu = $("#meMenu");
  if (!menu) return;
  const on = navigator.onLine;
  menu.classList.toggle("off", !on);
  menu.querySelector("summary")?.setAttribute("aria-label", on ? "You, online" : "You, offline");
  paintMe();
};
window.addEventListener("online", () => { netBadge(); Offline.pump(); });
window.addEventListener("offline", netBadge);

/* The last chance to file a sitting. `pagehide` fires where `unload` is not
   allowed to, and a tab going into the background on a phone may never come
   back. */
window.addEventListener("pagehide", () => Listen.close());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && Player.el && Player.el.paused) Listen.close();
});

/* --------------------------------------------------------------------- boot */
async function boot() {
  // What is already held, first: a visit that has been here before draws from
  // the browser's own copy and touches the network only afterwards, to ask
  // whether anything moved.
  const stored = await Catalog.all();
  const head = stored.get("index.json");
  if (head?.data?.site) {
    setData(head.data);
    for (const [name, row] of stored) {
      if (name.startsWith("index/") && Array.isArray(row.data)) PAGES.set(name, row.data);
    }
    rebuildItems();
  } else {
    try {
      setData(await fetchJSON("data/index.json"));
      const hash = String(DATA.site?.built || "");
      if (hash) await Catalog.put("index.json", hash, DATA);
    } catch {
      $("#main").innerHTML = `<div class="empty">Could not load the library index.</div>`;
      return;
    }
    DATA.items = [];
    rebuildItems();
  }
  DATA.authors.sort((a, b) => a.name.localeCompare(b.name));
  if (DATA.site.title) {
    document.title = DATA.site.title;
    $("#brandName").textContent = DATA.site.title;
  }
  $("#feedAll")?.setAttribute("href", "feed/all.xml");
  await Offline.init();
  Player.init();
  netBadge();
  render();
  // A linked library catches up once the catalogue is in hand, so what arrives
  // has something to be merged against.
  if (Sync.on()) Sync.run();
  // And the shares somebody keeps are asked again, quietly: a revoked one should
  // stop asserting what its owner liked a month ago.
  if (Followed.all().length) Followed.refresh().then(n => n && render()).catch(() => {});
  // Now ask the build what it has. Anything whose hash has not moved is left
  // alone; a page that changed replaces its own entries and nothing else.
  syncCatalog(stored);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
boot();
})();
