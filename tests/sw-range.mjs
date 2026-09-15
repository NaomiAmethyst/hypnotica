/* The service worker answers audio requests itself, so it has to do the byte-range
   slicing a server would normally do. Runs sw.js in a vm with the bits it touches. */
import fs from "node:fs"; import path from "node:path"; import vm from "node:vm";

import { fileURLToPath } from "node:url";
const ROOT = process.argv[2] || fileURLToPath(new URL("../www", import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { c ? (pass++, console.log("  ok   " + n))
                                 : (fail++, console.log("  FAIL " + n + " " + e)); };

class Res {
  constructor(body, init = {}) {
    // Buffer.from(buf).buffer would hand back Node's whole 8KB pool, not these bytes.
    this._b = body == null ? new ArrayBuffer(0)
            : body instanceof ArrayBuffer ? body : Uint8Array.from(body).buffer;
    this.status = init.status ?? 200;
    this.statusText = init.statusText || "";
    const h = new Map(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    this.headers = { get: k => h.get(String(k).toLowerCase()) ?? null };
  }
  async arrayBuffer() { return this._b; }
}
const req = (url, range) => ({ url, method: "GET",
  headers: { get: k => (k.toLowerCase() === "range" ? (range ?? null) : null) } });

const ctx = vm.createContext({
  self: { addEventListener() {}, skipWaiting() {}, clients: { claim() {} } },
  caches: { async open() { return { async add() {}, async put() {}, async match() {} }; },
            async keys() { return []; }, async delete() {}, async match() {} },
  location: { origin: "http://localhost:8788" },
  Response: Res, Request: class { constructor(u) { this.url = String(u); } },
  URL, console,
});
vm.runInContext(fs.readFileSync(path.join(ROOT, "sw.js"), "utf8"), ctx);
const slice = ctx.slice;

const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
const cached = () => new Res(BODY, { headers: { "content-type": "audio/mpeg", "content-length": "1000" } });
const bytes = async r => Buffer.from(await r.arrayBuffer());

console.log("\n== range slicing ==");
ok("slice() exists", typeof slice === "function");
if (typeof slice !== "function") {
  console.log("\n  the worker answers audio requests without slicing ranges\n");
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(1);
}
{
  const r = await slice(req("/a.mp3"), cached());
  ok("no Range header -> the whole cached response", r.status === 200, `${r.status}`);
}
{
  const r = await slice(req("/a.mp3", "bytes=0-"), cached());
  ok("bytes=0- answers 206, not 200", r.status === 206, `${r.status}`);
  ok("...spanning the whole file", r.headers.get("content-range") === "bytes 0-999/1000",
     r.headers.get("content-range"));
  ok("...with the full body", (await bytes(r)).length === 1000);
  ok("...and advertises range support", r.headers.get("accept-ranges") === "bytes");
}
{
  const r = await slice(req("/a.mp3", "bytes=500-"), cached());
  ok("an open-ended seek starts at the right byte",
     r.headers.get("content-range") === "bytes 500-999/1000", r.headers.get("content-range"));
  const b = await bytes(r);
  ok("...and returns those bytes, not the start of the file",
     b.length === 500 && b.equals(BODY.subarray(500)), `${b.length} bytes, first=${b[0]} want=${BODY[500]}`);
}
{
  const r = await slice(req("/a.mp3", "bytes=100-199"), cached());
  ok("a closed range is exact", r.headers.get("content-range") === "bytes 100-199/1000"
     && (await bytes(r)).equals(BODY.subarray(100, 200)), r.headers.get("content-range"));
  ok("...and reports its own length", r.headers.get("content-length") === "100",
     r.headers.get("content-length"));
}
{
  const r = await slice(req("/a.mp3", "bytes=-64"), cached());
  ok("a suffix range takes the tail", (await bytes(r)).equals(BODY.subarray(936))
     && r.headers.get("content-range") === "bytes 936-999/1000", r.headers.get("content-range"));
}
{
  const r = await slice(req("/a.mp3", "bytes=900-9999"), cached());
  ok("an over-long end is clamped to the file", r.headers.get("content-range") === "bytes 900-999/1000",
     r.headers.get("content-range"));
}
{
  const r = await slice(req("/a.mp3", "bytes=5000-"), cached());
  ok("a start past the end is 416", r.status === 416, `${r.status}`);
  ok("...and says how long the file really is", r.headers.get("content-range") === "bytes */1000",
     r.headers.get("content-range"));
}
{
  const r = await slice(req("/a.mp3", "bytes=abc"), cached());
  ok("an unparseable Range falls back to the whole response", r.status === 200, `${r.status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
