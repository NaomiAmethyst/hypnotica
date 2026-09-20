/* Hypnotica service worker: app shell offline, audio served from the saved cache. */
const VERSION = "__BUILD_ID__";
const SHELL = `hypnotica-shell-${VERSION}`;
const RUNTIME = `hypnotica-runtime-${VERSION}`;
const AUDIO = "hypnotica-audio-v1";   // unversioned: user downloads survive rebuilds

const SHELL_FILES = [
  "./", "./index.html", "./app.js", "./style.css",
  // Generated from the registry's namespaces, so it is part of the shell rather
  // than an extra: without it the tag chips lose their colours offline, which
  // looks like a broken page rather than a missing stylesheet.
  "./namespaces.css",
  "./manifest.webmanifest", "./data/index.json",
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.allSettled(SHELL_FILES.map(f => cache.add(new Request(f, { cache: "reload" }))));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== SHELL && key !== RUNTIME && key !== AUDIO) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

const isAudio = url => /\.(mp3|m4a|m4b|ogg|opus|wav|flac|mp4)$/i.test(url.pathname);
const isImage = url => /\.(jpe?g|png|webp|gif|svg|avif)$/i.test(url.pathname);
const isData = url => /\/data\/|\/transcripts\//.test(url.pathname);
/* The sync endpoint is not a file and must never be answered from a cache: a
   stale blob would be an old view of the library handed back as a current one,
   and offline it should simply not happen rather than fail strangely. */
const isSync = url => /^\/(sync|pair|profile)\//.test(url.pathname);

/* Serve a byte range out of a full cached response, as a real server would. */
async function slice(request, cached) {
  const header = request.headers.get("range");
  if (!header) return cached;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return cached;
  const buf = await cached.arrayBuffer();
  const size = buf.byteLength;
  let start, end;
  if (m[1] === "") {                                   // "bytes=-N": the final N bytes
    start = Math.max(0, size - Number(m[2])); end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new Response(null, { status: 416, statusText: "Range Not Satisfiable",
      headers: { "content-range": `bytes */${size}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206, statusText: "Partial Content",
    headers: {
      "content-type": cached.headers.get("content-type") || "audio/mpeg",
      "content-length": String(end - start + 1),
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
    },
  });
}

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  if (isSync(url)) return;                 // straight to the network, or not at all

  // Audio: whatever the user saved wins, always. Once we answer with respondWith
  // the browser does no range handling of its own, so a Range request has to be
  // sliced here - hand a media element a 200 for one and seeking breaks in
  // Chrome and playback fails outright in Safari.
  if (isAudio(url)) {
    event.respondWith((async () => {
      const hit = await caches.match(new Request(url.href), { cacheName: AUDIO, ignoreVary: true });
      if (hit) return slice(request, hit);
      try {
        return await fetch(request);
      } catch {
        return new Response("Offline and not saved", { status: 504, statusText: "Offline" });
      }
    })());
    return;
  }

  // Navigation: serve the shell so hash routes work with no network.
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(SHELL);
        cache.put("./index.html", fresh.clone());
        return fresh;
      } catch {
        return (await caches.match("./index.html", { cacheName: SHELL }))
            || (await caches.match("./")) 
            || new Response("Offline", { status: 504 });
      }
    })());
    return;
  }

  // Index and transcripts: fresh when possible, cached copy when not.
  if (isData(url)) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        if (fresh.ok) (await caches.open(RUNTIME)).put(request, fresh.clone());
        return fresh;
      } catch {
        const hit = await caches.match(request, { cacheName: RUNTIME })
                 || await caches.match(request, { cacheName: SHELL });
        return hit || new Response("{}", { headers: { "content-type": "application/json" } });
      }
    })());
    return;
  }

  // Images and static assets: cache-first, filled in as they are seen.
  event.respondWith((async () => {
    const hit = await caches.match(request, { cacheName: RUNTIME })
             || await caches.match(request, { cacheName: SHELL });
    if (hit) return hit;
    try {
      const fresh = await fetch(request);
      if (fresh.ok && (isImage(url) || /\.(js|css|webmanifest)$/i.test(url.pathname))) {
        (await caches.open(RUNTIME)).put(request, fresh.clone());
      }
      return fresh;
    } catch {
      return new Response("", { status: 504 });
    }
  })());
});

// Let the page ask us to pre-warm covers for a set of items.
self.addEventListener("message", event => {
  const data = event.data || {};
  if (data.type === "prefetch" && Array.isArray(data.urls)) {
    event.waitUntil((async () => {
      const cache = await caches.open(RUNTIME);
      await Promise.allSettled(data.urls.map(u => cache.add(u)));
    })());
  }
});
