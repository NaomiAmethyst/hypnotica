// SPDX-License-Identifier: GPL-3.0-only
// A deterministic public library for paging, windowing, and browser tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = process.argv[2];
if (!root) throw new Error('usage: node tests/make-library.mjs OUTPUT');
const here = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.copyFileSync(path.join(here, 'fixture/media/voxa-1.mp3'), path.join(root, 'assets/tone.mp3'));
fs.writeFileSync(path.join(root, 'assets/cover.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#be3a52"/></svg>');
fs.writeFileSync(path.join(root, 'assets/video.mp4'), 'Synthetic video path fixture; playback is stubbed.');
const docs = [];
for (let n = 0; n < 3; n++) docs.push({kind:'Author', id:`author-${n}`, name:`Author ${n}`, description:'<p>A fictional author for automated testing.</p>', image:'cover.svg', cover_prompts:{natural:'A colored square'}, provenance:{generated:['image']}});
for (let n = 0; n < 520; n++) {
 const special = n % 7 === 0;
 docs.push({kind:'Item', id:`recording-${String(n).padStart(4,'0')}`, title:`Recording ${String(n).padStart(4,'0')}${special ? ' woodland' : ''}`, author:`author-${n < 400 ? 0 : n % 2 + 1}`, date:'2026-01-01', duration:60, audio:'tone.mp3', cover:'cover.svg', categories:['Audio','Free'], tags:['Nature','Voice: Soft','Audience: F4A','Production: Spoken', special ? 'Forest' : 'River','Trigger: Bell'], summary:'Synthetic library fixture.', description:'<p>A fictional recording with a long enough description to test the item view and its formatting.</p>', transcript:`A woodland walk, number ${n}. Quiet trees and a flowing stream.`, transcript_segments:Array.from({length:8},(_,j)=>({start:j*5,end:(j+1)*5,text:`Segment ${j}: quiet trees.`})), ...(n===1 ? {video:'video.mp4'} : {}), ...(n===0 ? {acoustic:{f0_median_hz:196,hnr_db:12.4},cover_prompts:{natural:'A quiet river'},provenance:{generated:['description','cover']}} : {})});
}
// JSON is a YAML subset; a sequence exercises list-document scanning.
fs.writeFileSync(path.join(root,'library.yaml'),JSON.stringify(docs,null,2));
