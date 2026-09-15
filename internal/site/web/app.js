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
};

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

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
const Playlists = {
  all() { return load(K.playlists, []); },
  get(id) { return this.all().find(p => p.id === id); },
  write(list) { save(K.playlists, list); },
  create(name, items = []) {
    const list = this.all();
    const pl = { id: "pl" + Date.now().toString(36), name: name || "Untitled playlist",
                 items: [...items], created: Date.now(), updated: Date.now() };
    list.push(pl); this.write(list); return pl;
  },
  update(id, fn) {
    const list = this.all(); const pl = list.find(p => p.id === id);
    if (!pl) return; fn(pl); pl.updated = Date.now(); this.write(list);
  },
  remove(id) { this.write(this.all().filter(p => p.id !== id)); },
  addItems(id, ids) {
    this.update(id, pl => { for (const i of ids) if (!pl.items.includes(i)) pl.items.push(i); });
  },
};

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

    this.el.addEventListener("timeupdate", () => { this.paint(); this.remember(); });
    this.el.addEventListener("durationchange", () => this.onMeta());
    this.el.addEventListener("loadedmetadata", () => this.onMeta());
    this.el.addEventListener("ended", () => this.next(true));
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

/* What a tag is *about*, read off its "Kind: Value" prefix. This mirrors KINDS
   in enrich/vocab.py, which is where tags are given their prefix; the build
   ingests the YAML as written, so the prefix in the data is all we go on. A
   prefix that is not listed here is an ordinary content tag, which is what
   keeps a stray "Hypno: Full" out of the sections. */
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
const KIND_BY_PREFIX = new Map(TAG_KINDS.filter(k => k.prefix).map(k => [k.prefix, k]));
/* Recomputed from the file itself, so it is filtered on below and never offered
   as a tag - a "Duration: 10-20" on a 60-second preview is exactly the kind of
   claim that used to get through. Items written before the retag still carry
   these, so they are dropped on the way in rather than waited out. */
const DERIVED_PREFIXES = new Set(["Duration"]);
const isDerivedTag = t => DERIVED_PREFIXES.has(String(t).split(": ")[0]);
const KIND_BY_KEY = new Map(TAG_KINDS.map(k => [k.key, k]));
const SPOILER_KINDS = new Set(TAG_KINDS.filter(k => k.spoiler).map(k => k.key));

function tagKind(tag) {
  const i = String(tag).indexOf(": ");
  if (i < 0) return "content";
  return KIND_BY_PREFIX.get(String(tag).slice(0, i))?.key || "content";
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
  { q: "", author: "", tags: emptyFacet(), cats: emptyFacet(),
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
  for (const [key, was] of [["tags", "tag"], ["cats", "cat"]]) {
    const f = F[key] && typeof F[key] === "object" ? F[key] : {};
    F[key] = { any: [...(f.any || [])], all: [...(f.all || [])], not: [...(f.not || [])] };
    if (typeof F[was] === "string" && F[was] && !F[key].any.includes(F[was])) F[key].any.push(F[was]);
    if (was in F) { delete F[was]; moved = true; }
  }
  if (moved) saveFilters();
})();

function facetOf(key, v) { return MODES.find(m => F[key][m].includes(v)) || ""; }
function setFacet(key, v, mode) {
  for (const m of MODES) {
    const i = F[key][m].indexOf(v);
    if (i >= 0) F[key][m].splice(i, 1);
  }
  if (mode) { F[key][mode].push(v); F[key][mode].sort((a, b) => a.localeCompare(b)); }
  saveFilters();
}
function cycleFacet(key, v, back = false) {
  const ring = ["", "any", "all", "not"];
  const i = ring.indexOf(facetOf(key, v));
  setFacet(key, v, ring[(i + (back ? ring.length - 1 : 1)) % ring.length]);
}
function facetChosen(key, kind) {
  const all = MODES.flatMap(m => F[key][m].map(v => [m, v]));
  return kind ? all.filter(([, v]) => tagKind(v) === kind) : all;
}
/* Clearing is per section, so wiping the content tags cannot silently drop a
   standing audience exclusion the reader set months ago. */
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
    render();
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

function measuredPanel(a) {
  if (!a || typeof a !== "object") return "";
  const rows = BAND_ORDER.filter(k => typeof a[k] === "number").map(k => {
    const band = BANDS[k], v = a[k];
    const shown = band.format ? band.format(v) : `${v}${band.unit}`;
    const reading = band.read(v);
    return `<div class="band"><b>${esc(band.label)}</b>
      <span class="fig" title="${esc(band.why)}">${esc(shown)}</span>
      ${reading ? `<i>${esc(reading)}</i>` : ""}</div>`;
  });
  if (!rows.length) return "";
  // The measured voice, and whether it agrees with the tag. Kept apart from the
  // bands because it is the one place the library contradicts itself out loud.
  let voice = "";
  if (a.voice) {
    voice = a.voice_disputed
      ? `<p class="note disputed">Measured as <b>${esc(a.voice)}</b>, but tagged
         <b>${esc(a.voice_disputed)}</b>. Both are kept — a measurement reports and
         a tag asserts, and this is where they disagree.</p>`
      : `<p class="note">Measured voice: <b>${esc(a.voice)}</b>${
          a.f0_reliable === false ? " — the pitch reading is not trustworthy here"
                                  : ", agreeing with its tag"}.</p>`;
  }
  return `<div class="measured"><div class="bands">${rows.join("")}</div>${voice}</div>`;
}

/* The brief a picture was drawn from, and the list of what else on the page was
   made rather than found. Closed by default: it answers a question somebody has
   only once they have started wondering. */
function provPanel(fields, prompts, what, measured) {
  const rows = (fields || []).filter(f => GEN_WHY[f]);
  const styles = [["natural", "As prose"], ["tagged", "As keywords"],
                  ["negative", "Asked to avoid"]]
    .filter(([k]) => prompts && prompts[k]);
  const bands = measuredPanel(measured);
  if (!rows.length && !styles.length && !bands) return "";
  return `<details class="prov"><summary>How this ${esc(what)} was made</summary>
    ${bands ? `<p class="note">Measured off the audio itself, not taken from the
      tags. Hover a figure for what it means.</p>${bands}` : ""}
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
function stripTags(h) { return String(h || "").replace(/<[^>]+>/g, " "); }
function authorName(id) { return DATA.authors.find(a => a.id === id)?.name || id; }

/* `skip` leaves one facet out, which is what the per-tag match counts need:
   a count is "how many results would this tag give me", not "how many now". */
function filtered(skip = "") {
  const q = F.q.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  let rows = DATA.items.filter(it => {
    if (F.author && it.author !== F.author) return false;
    if (skip !== "tags" && !matchFacet(it.tags, F.tags)) return false;
    if (skip !== "cats" && !matchFacet(it.categories, F.cats)) return false;
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
function route() {
  const h = location.hash.replace(/^#\/?/, "");
  const [head, ...rest] = h.split("/");
  return { name: head || "library", arg: decodeURIComponent(rest.join("/") || "") };
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
  const mark = CURRENT_ROUTE === null ? null : scrollMark();
  if (moved && CURRENT_ROUTE) SCROLL.set(CURRENT_ROUTE, mark);
  const main = $("#main");
  const views = { library: viewLibrary, item: viewItem, author: viewAuthor,
                  authors: viewAuthors, playlists: viewPlaylists, playlist: viewPlaylist,
                  queue: viewQueue, offline: viewOffline };
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
  main.innerHTML = (views[r.name] || viewLibrary)(r.arg);
  if (r.name === "library" || r.name === "author") Grid.start(LAST_ROWS);
  $$(".navlinks a").forEach(a =>
    a.classList.toggle("active", a.getAttribute("href") === "#/" + (r.name === "library" ? "" : r.name)));
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
  return TAG_KINDS.map(k => [k, by.get(k.key) || []]).filter(([, v]) => v.length);
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
      <div class="tags">${chips(cardTags(it))}
        ${hiddenTagCount(it) ? `<span class="tag f-none"
          title="Triggers and compulsions — tick “show triggers” to see them"
          >+${hiddenTagCount(it)} hidden</span>` : ""}</div>
      <div class="cardacts">
        ${it.audio ? `<button class="btn sm" data-act="enqueue">+ Queue</button>
        <button class="btn sm" data-act="addto">+ List</button>
        ${off ? `<button class="btn sm" data-act="unsave">Remove</button>`
              : `<button class="btn sm" data-act="save"${q ? " disabled" : ""}>${q ? "Queued" : "Save"}</button>`}` : ""}
      </div>
    </div></div>`;
}

/* Panel state that must survive the re-render every chip click triggers.
   Keyed by section: "tags:audience", "tags:content", "cats". */
const FQ = {};
const FOPEN = {};

function facetPanel(key, kind, label, field, note) {
  const id = kind ? `${key}:${kind}` : key;
  const chosen = facetChosen(key, kind);
  const belongs = kind ? (v => tagKind(v) === kind) : (() => true);

  const counts = new Map();
  for (const it of filtered(key)) for (const v of it[field]) counts.set(v, (counts.get(v) || 0) + 1);

  const all = [...new Set(DATA.items.flatMap(i => i[field]))]
    .filter(v => belongs(v) && !isDerivedTag(v))
    .sort((a, b) => tagValue(a).localeCompare(tagValue(b)));
  if (!all.length) return "";

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
  const left = matching.filter(v => (counts.get(v) || 0) > 0 || facetOf(key, v));
  const groups = [];
  let rest = left;
  for (const [name, holds] of bands) {
    const mine = rest.filter(v => holds(counts.get(v) || 0));
    rest = rest.filter(v => !holds(counts.get(v) || 0));
    if (mine.length) groups.push([name, mine]);
  }
  if (rest.length) groups.push(["Chosen, matching nothing", rest]);

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
          data-kind="${esc(kind || "")}"${chosen.length ? "" : " disabled"}
          >Clear${chosen.length ? ` (${chosen.length})` : ""}</button>
      </div>
      <p class="note">Click to cycle: <b class="f-any">any</b> (at least one) →
        <b class="f-all">all</b> (required) → <b class="f-not">not</b> (excluded) → off.
        Alt-click steps backwards.</p>
      ${body || `<p class="note">Nothing matches “${esc(FQ[id] || "")}”.</p>`}
    </div></details>`;
}

function facetBar() {
  const sections = [
    ...TAG_KINDS.map(k => ["tags", k.key, k.label, !!k.spoiler]),
    ["cats", null, "Categories", false],
  ];
  return sections.map(([key, kind, label, spoiler]) => {
    const chosen = facetChosen(key, kind);
    if (!chosen.length) return "";
    if (spoiler && !F.spoil) {
      return `<div class="fsel"><span class="note">${esc(label)}:</span>
        <span class="note">${chosen.length} hidden — tick “show triggers”</span></div>`;
    }
    return `<div class="fsel"><span class="note">${esc(label)}:</span>
      ${chosen.map(([m, v]) => `<button class="tag k-${esc(tagKind(v))} f-${m}" data-act="facetOff"
        data-key="${esc(key)}" data-v="${esc(v)}" title="Remove"
        >${MODE_LABEL[m]} · ${esc(tagValue(v))} ✕</button>`).join("")}
      <button class="btn sm" data-act="facetClear" data-key="${esc(key)}"
        data-kind="${esc(kind || "")}">Clear</button></div>`;
  }).join("");
}

function facetPanels() {
  const out = [];
  for (const k of TAG_KINDS) {
    if (k.spoiler && !F.spoil) continue;
    out.push(facetPanel("tags", k.key, k.label, "tags", k.note));
  }
  out.push(facetPanel("cats", null, "Categories", "categories"));
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
    DATA = head;
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

/* Where the reader was, per view.

   Opening something is a move forward and starts at the top. Coming back to a
   list is a return, and should land where they left -- which for the windowed
   grid means putting back the chunks that were there, because the position
   they are returning to does not exist until the page is that tall again.

   The browser's own restoration cannot do this: it fires before the view is
   rebuilt, on a page whose height it has no way to predict. */
const SCROLL = new Map();
let CURRENT_ROUTE = null;
const KEEPS_PLACE = new Set(["library", "author", "authors", "playlist",
                             "playlists", "queue", "offline"]);

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
  rows: [], chunks: [], el: null, sentinel: null, io: null,

  start(rows) {
    this.stop();
    this.rows = rows;
    this.el = document.getElementById("grid");
    if (!this.el) return;
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
    holder.innerHTML = slice.map(card).join("");
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
          .slice(chunk.from, chunk.from + CHUNK).map(card).join("");
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

function viewAuthors() {
  const rows = DATA.authors.slice();
  if (F.asort === "name") {
    rows.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    rows.sort((a, b) => (BY_AUTHOR.get(b.id) || []).length
                      - (BY_AUTHOR.get(a.id) || []).length
                      || a.name.localeCompare(b.name));
  }
  return `<h1 style="margin-top:18px">Authors</h1>
  <div class="controls">
    <select id="aSort" aria-label="Order the creators">
      <option value="files"${F.asort !== "name" ? " selected" : ""}>Most files first</option>
      <option value="name"${F.asort === "name" ? " selected" : ""}>Name A–Z</option>
    </select>
    <span class="count">${rows.length} creators</span>
  </div>
  <div class="grid">${rows.map(a => {
    const n = (BY_AUTHOR.get(a.id) || []).length;
    // The synopsis is what the library knows about them; their own summary is
    // marketing, and is the fallback rather than the first choice.
    const blurb = a.synopsis || a.summary || "";
    return `<div class="card"><a class="thumb" href="#/author/${encodeURIComponent(a.id)}"
      >${a.image ? `<img loading="lazy" src="${esc(a.image)}" alt="">` : ""}</a>
      <div class="body"><h3><a href="#/author/${encodeURIComponent(a.id)}">${esc(a.name)}</a></h3>
      <div class="meta"><span>${n} file${n === 1 ? "" : "s"}</span></div>
      ${blurb ? `<p class="note blurb">${esc(blurb)}</p>` : ""}
      <div class="tags">${chips(authorCardTags(a.id))}</div></div></div>`;
  }).join("")}</div>`;
}

function viewAuthor(id) {
  const a = DATA.authors.find(x => x.id === id);
  if (!a) return `<div class="empty">Unknown author.</div>`;
  const rows = (BY_AUTHOR.get(id) || []).slice()
    .sort((x, y) => (y.date || "").localeCompare(x.date || ""));
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
      </div>
    </div>
  </div>
  ${a.synopsis ? `<p class="synopsis">${esc(a.synopsis)}${genMark(a.generated, "synopsis")}</p>` : ""}
  ${(() => {
    const common = authorCommonTags(id);
    if (!common.length) return "";
    // With the count, because "Femdom on 380 of 383" and "Femdom on 44 of 436"
    // are different claims about a creator and the chip alone cannot tell them
    // apart.
    return `<p class="tags labelled authortags">${
      chips(common.map(([t]) => t), { label: true, counts: new Map(common) })}</p>`;
  })()}
  ${a.description ? `<div class="prose">${a.description}${genMark(a.generated, "description")}</div>` : ""}
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
  return `<article>
    <a class="back" href="#/">← Library</a>
    <h1>${esc(it.title)}${genMark(gen, "title")}</h1>
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
    </div>
    <div class="prose">${d.description || `<p>${esc(it.summary)}</p>`}
      ${genMark(gen, d.description ? "description" : "summary")}</div>
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
    ${it.hasTranscript ? `<details class="tr" id="trBox"><summary>Transcript</summary>
      <p class="note">${detailOf(it).transcriptSource === "source"
        ? "Transcript as supplied with the source."
        : "Automatic transcript — expect occasional errors."}</p>
      <div id="trBody"><p class="note">Loading…</p></div></details>` : ""}
    ${provPanel(gen, d.coverPrompts, "entry", d.acoustic)}
  </article>`;
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
  <div class="actions"><button class="btn primary" id="plNew">New playlist</button></div>
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
      body.innerHTML = `<pre>${mark(esc(payload.text || "(empty)"), q)}</pre>`;
    }
  };
  box.addEventListener("toggle", () => box.open && fill());
  if (box.open) fill();
  if (F.q.trim() && F.tr) { box.open = true; fill(); }
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
    case "playAuthor": Player.play(idsOf((BY_AUTHOR.get(t.dataset.author) || []).map(i => i.id))); return;
    case "queueAuthor": Player.enqueue(idsOf((BY_AUTHOR.get(t.dataset.author) || []).map(i => i.id))); return;
    case "saveAuthor": Offline.addMany((BY_AUTHOR.get(t.dataset.author) || []).map(i => i.id)); return;
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
    case "plItemDel": Playlists.update(t.dataset.pl, p => p.items.splice(+t.dataset.i, 1));
      render(); return;
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
      rerender();
    }, 180);
    return;
  }
  if (t.id.startsWith("fq-")) {
    clearTimeout(facetTimer);
    const id = t.id.slice(3), v = t.value;
    facetTimer = setTimeout(() => { FQ[id] = v; rerender(); }, 140);
    return;
  }
  if (t.id === "fDurMin" || t.id === "fDurMax") {
    clearTimeout(facetTimer);
    const which = t.id === "fDurMin" ? "min" : "max", v = t.value;
    facetTimer = setTimeout(() => { F.dur[which] = v; saveFilters(); rerender(); }, 220);
    return;
  }
  if (t.id === "pSeek") { Player.seek(t.value / 1000); return; }
});

document.addEventListener("change", async e => {
  const t = e.target;
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
const netBadge = () => {
  const b = $("#net"); if (!b) return;
  b.textContent = navigator.onLine ? "online" : "offline";
  b.classList.toggle("off", !navigator.onLine);
};
window.addEventListener("online", () => { netBadge(); Offline.pump(); });
window.addEventListener("offline", netBadge);

/* --------------------------------------------------------------------- boot */
async function boot() {
  // What is already held, first: a visit that has been here before draws from
  // the browser's own copy and touches the network only afterwards, to ask
  // whether anything moved.
  const stored = await Catalog.all();
  const head = stored.get("index.json");
  if (head?.data?.site) {
    DATA = head.data;
    for (const [name, row] of stored) {
      if (name.startsWith("index/") && Array.isArray(row.data)) PAGES.set(name, row.data);
    }
    rebuildItems();
  } else {
    try {
      DATA = await fetchJSON("data/index.json");
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
  // Now ask the build what it has. Anything whose hash has not moved is left
  // alone; a page that changed replaces its own entries and nothing else.
  syncCatalog(stored);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
boot();
})();
