/* The index as the app sees it: a head that describes the library, plus pages
   that hold the catalogue.

   The head carries no items -- that split is what lets a client replace one
   page without re-fetching everything -- so a test that reads `index.json` and
   expects `items` finds nothing and fails somewhere confusing. This reassembles
   it the way the app does. */
import fs from "node:fs";
import path from "node:path";

export function readIndex(root) {
  const head = JSON.parse(
    fs.readFileSync(path.join(root, "data/index.json"), "utf8"));
  head.items = [];
  for (let n = 0; n < Number(head.pages || 0); n++) {
    const page = path.join(root, `data/index/${n}.json`);
    if (fs.existsSync(page)) {
      head.items.push(...JSON.parse(fs.readFileSync(page, "utf8")));
    }
  }
  // Tags and categories travel as indices into a shared table.
  const tags = head.tagTable || [], cats = head.catTable || [];
  if (tags.length || cats.length) {
    for (const item of head.items) {
      item.tags = (item.tags || []).map(n => tags[n]).filter(Boolean);
      item.categories = (item.categories || []).map(n => cats[n]).filter(Boolean);
    }
  }
  return head;
}
