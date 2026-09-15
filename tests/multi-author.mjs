import { JSDOM, VirtualConsole } from "jsdom";
import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
import { readIndex } from "./readindex.mjs";
const ROOT = process.argv[2] || fileURLToPath(new URL("../www", import.meta.url));
let pass=0,fail=0;
const ok=(n,c,e="")=>{c?(pass++,console.log("  ok   "+n)):(fail++,console.log("  FAIL "+n+" "+e));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const vc=new VirtualConsole();
const dom=new JSDOM(fs.readFileSync(path.join(ROOT,"index.html"),"utf8"),
  {url:"http://localhost:9/",runScripts:"outside-only",pretendToBeVisual:true,virtualConsole:vc});
const {window}=dom, doc=window.document;
window.fetch=async u=>{const p=path.join(ROOT,String(u).replace(/^https?:\/\/[^/]+\//,"").split("?")[0]);
  if(!fs.existsSync(p))return{ok:false,status:404,json:async()=>({})};
  const b=fs.readFileSync(p);return{ok:true,status:200,headers:{get:()=>String(b.length)},
    json:async()=>JSON.parse(b.toString()),text:async()=>b.toString(),clone(){return this;}};};
window.caches={async open(){return{async keys(){return[];},async put(){},async delete(){},async match(){}};},
  async match(){},async delete(){},async keys(){return[];}};
window.Audio=class{constructor(){this.paused=true;this.currentTime=0;this.duration=0;this.playbackRate=1;this._l={};}
  addEventListener(k,f){(this._l[k]||=[]).push(f);}play(){this.paused=false;return Promise.resolve();}
  pause(){this.paused=true;}removeAttribute(){}};
window.MediaMetadata=class{};window.Response=class{};window.Request=class{};
window.navigator.mediaSession={setActionHandler(){},set metadata(v){}};
window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
window.HTMLDialogElement.prototype.close=function(){this.open=false;};
window.eval(fs.readFileSync(path.join(ROOT,"app.js"),"utf8"));
await sleep(300);
const $=s=>doc.querySelector(s), $$=s=>[...doc.querySelectorAll(s)];
const idx=readIndex(ROOT);
const setVal=(el,v)=>{el.value=v;el.dispatchEvent(new window.Event("change",{bubbles:true}));};

console.log("\n== multi-author frontend ==");
ok("all 4 items listed", $$(".card").length===4, `${$$(".card").length}`);
const authorSel=()=>$("#fAuthor");
ok("author dropdown has both authors", authorSel().options.length===3, `${authorSel().options.length} options`);
ok("dropdown shows display names",
   [...authorSel().options].slice(1).map(o=>o.textContent).sort().join(",")==="Nyx,Voxa");
setVal(authorSel(),"voxa"); await sleep(80);
ok("filter to Voxa -> 3 items", $$(".card").length===3, `${$$(".card").length}`);
ok("selection survives re-render", authorSel().value==="voxa", authorSel().value);
ok("only Voxa cards shown", $$(".card .who").every(a=>a.textContent==="Voxa"));
setVal(authorSel(),"nyx"); await sleep(80);
ok("filter to Nyx -> 1 item", $$(".card").length===1, `${$$(".card").length}`);
setVal(authorSel(),""); await sleep(80);
ok("clearing filter restores 4", $$(".card").length===4);

console.log("\n== author pages ==");
for (const a of idx.authors) {
  window.location.hash=`#/author/${a.id}`; await sleep(150);
  const want=idx.items.filter(i=>i.author===a.id).length;
  ok(`${a.name}: heading`, $(".authorhead h1")?.textContent===a.name);
  ok(`${a.name}: ${want} item(s)`, $$(".card").length===want, `${$$(".card").length}`);
  ok(`${a.name}: links own feed`, !!$(`a[href="feed/${a.id}.xml"]`));
}
window.location.hash="#/authors"; await sleep(150);
ok("authors index lists both", $$(".card").length===2, `${$$(".card").length}`);
ok("author cards show counts", /1 file/.test(doc.body.textContent) && /3 files/.test(doc.body.textContent));

console.log("\n== cross-author playback ==");
window.location.hash="#/"; await sleep(150);
$("#playAll").dispatchEvent(new window.MouseEvent("click",{bubbles:true}));
await sleep(150);
ok("play-all queues every author's items",
   JSON.parse(window.localStorage.getItem("hyp.queue")).queue.length===4);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
