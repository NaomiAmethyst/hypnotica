# Sync and sharing

Built, all of it. This is the design it was built from and the record of why each
decision went the way it did; `docs/contracts.md` is the reference for what the
endpoint and the key schedule actually are.

Where the two differ, the contract is right and this is the reasoning. Two things
moved during the build and are noted where they appear: the group no longer
derives a separate read key, because shares turned out to want independent keys
of their own, and a device's listening events are tagged with a local device id
rather than its key fingerprint, because history predates sync and has to work
without it.

The one thing deliberately left out is a serverless whole-profile share: a
playlist travels in a link, and everything else goes in a file.

## Principles

1. The library works fully with no sync server. Sync is additive, never a
   dependency, and a build has no knowledge of one.
2. `localStorage` remains the source of truth. Sync mirrors it; the interface
   never waits on the network to draw or to record a change.
3. The endpoint is configured at runtime — typed once on the first device, and
   carried by a pairing link to every device after. Nothing about it is baked
   into a build, so two builds of the same library are identical and the output
   still runs on any static host.
4. A group is one person's devices. Another person never joins a group; they
   receive a share link. Linking is for things you own, sharing is for people.
5. Nothing is published until somebody asks for it to be. A library with one
   device has no group, no key and no slot, and the server does not know it
   exists.
6. Every sharing feature has a serverless form. A server upgrades a snapshot to
   something live and revocable; it never unlocks the feature itself.
7. The server stores ciphertext it cannot read, and validates only the envelope.
   Payload validation stays in `Share.parse`, which already does it.

## Lifecycle

A library is in one of two states, and starts in the first.

**Local.** The default, and where most installations stay. Favourites,
playlists, history and notes are recorded in `localStorage` and read from there.
No endpoint is configured, no key exists, nothing is encrypted because nothing
is sent. The export file is the only way anything leaves, and a playlist link is
the only way anything is shared. The sync sections of the interface are absent
rather than disabled.

**Linked.** Entered deliberately, by either of the two things that need somewhere
to publish to: **Link a device**, or **Share**. Whichever comes first creates the
group — it asks for the endpoint, generates `gk`, registers `group-id` with the
server, and writes this device's first slot — and then goes on to do what was
asked. A group with one device in it is perfectly ordinary: somebody who wants to
show a partner what they have been listening to should not have to link a second
device they do not own to do it.

Three consequences worth stating plainly. A first device cannot receive a pairing
link — there is nothing to pair with yet — so the endpoint is typed or pasted
once; the browser fills it in where the site is itself served by a Hypnotica with
`--sync`, and still shows it. An abandoned setup keeps nothing: the endpoint is
saved only for the length of the attempt, because a configured endpoint with no
key looks linked and is not. And an abandoned pairing leaves a registered group
with one slot, which idle collection removes on the ordinary schedule.

Whether an endpoint takes a new group at all is the operator's choice —
`--sync-open` for no token, `--sync-invite` for one, neither for none — and the
browser asks which before it asks a person for anything, so the open case has no
token in it anywhere.

A playlist link needs none of this, and never will.

**Neither, on an insecure page.** Browsers offer `crypto.subtle` only over HTTPS
or from localhost, so a build served over plain http to a machine on the network
can do none of this. Everything local still works. The interface says which and
why rather than failing at the first call, because it is fixable and the fix is
worth naming.

History and notes are recorded locally in both states. Linking changes where a
record can go, never whether it is kept.

## What already exists

`Share.bundle`, `Share.parse` and `Share.merge` are a convergent merge, not a
copy: playlists match by id, entries union, favourites keep the earliest time,
and ids the build does not know are kept rather than dropped (invariant 11).
Per-playlist export exists, and `parse` already accepts a bare playlist object
so one can be sent on its own. Sync adds a transport and a trigger, not a merge.

## Prerequisite: recorded deletions

The merge is add-only, which is correct for a hand-carried file and wrong for an
automatic one. Unfavourite something on a phone, sync, and it returns; remove a
track from a playlist and it comes back forever. Before any transport:

- Favourites keep removed ids with a removal time. Additions still resolve
  earliest-wins; an add against a remove resolves latest-event-wins.
- Playlists keep a `removed` map of entry ids, and the group keeps a tombstone
  list of deleted playlist ids.
- Tombstones older than 90 days are pruned on write.

This is transport-independent and lands first. Invariant 11 needs rewording to
say that a merge removes nothing *except* where a recorded deletion is newer
than the addition it answers.

The records added below deal with removal in their own ways — a note is deleted
by emptying it, a listening event by a forget watermark — but under the same
rule: a deletion is a thing that is recorded and merged, never an absence that
is inferred.

## Names beside ids

Every record here keys on an item id, and an id defaults to a slug of the title.
Retitling an item in the source therefore changes its id and detaches whatever
pointed at it. Unknown ids are kept rather than dropped, so nothing is lost, but
a hand-written note silently stops appearing — and a note is the one record in
the library that cannot be regenerated from anything.

So `hyp.names` is maintained alongside: `{id: {t, a}}`, the title and author name
as they stood when a favourite, playlist entry, note or listening event first
referenced that id. One entry per distinct item, not per event, merged latest
wins.

It pays for itself three times. An orphaned record can be shown by name instead
of vanishing. A rename can be offered for re-matching, since a renamed item is
exactly an id that is gone and a title and author that are still there. And a
profile's `titles` map stops being something assembled at publish time: it is a
projection of this one.

Explicit `id:` in the source remains the real fix for anything worth annotating,
and belongs in the content documentation. Detecting renames in the builder, from
the cache, is possible and is a different feature.

## The sync model

A group is one person and the devices they own. It has one identity, one name and
one history, and every device in it is assumed to be the same listener — which is
why `plays` can sum its per-device counters, and why a group never acquires a
member. Two people who use one library run two groups and hand each other share
links; a group with two listeners in it would be a group whose history means
nothing.

One slot per device, named by that device's key fingerprint. A device writes
only its own slot and reads everyone's, merging locally with the code above.

Write conflicts are therefore structurally impossible: no ETags, no retry loop,
no server-side merge. A device that has been offline for a week PUTs its whole
current state when it returns, with no op log to replay. Each blob is that
device's full merged view, so state propagates transitively between devices that
are never online at the same time.

Writes are debounced and flushed on `pagehide`. Full state every time; at these
sizes deltas would be complexity with no payer.

## Listen history

Today the library remembers resume points and nothing else: `hyp.positions` is
`{id: seconds}`, with no timestamp and no count. A history is a new record, in
two layers.

`recent` is a stream of listening events, and powers the timeline a history view
actually wants — what was played, in order, and when. An event opens when
playback of an item passes thirty seconds, and closes when the item changes or
after thirty minutes without playback, so one sitting is one entry rather than
forty. It carries when it started, how many seconds were really played, and
whether it finished, reusing the rule already in the player: within fifteen
seconds of the end counts as the end.

```json
{ "i": "a-walk-in-the-woods", "t": "2026-09-20T11:04:22Z", "s": 1180, "c": true }
```

About seventy bytes an event, a handful of events a day.

`plays` is the durable summary that survives trimming: per item, the first and
last time it was played and how many times. Counts are held **per device** and
summed only for display. They cannot be summed on merge, because every blob is a
full merged view and adding two views of the same history compounds it. Each
device increments only its own entry, a merge takes the higher value per device,
and the total is the sum — a grow-only counter, which is the shape this needs.
Each entry carries an epoch so that clearing can reset a counter that otherwise
only ever rises.

Events are the one record a device does **not** republish. A device publishes its
own stream and keeps everyone else's for display, because a trimmed foreign event
would otherwise arrive again from the device that still holds it. The cost is
that events propagate through the server rather than between devices, which is
free when every device reaches the server, and the export file still carries the
merged view because it is a snapshot for a person rather than a sync blob.

Forgetting is explicit and merges like any other deletion: a `before` watermark
for clearing a span, and per-item times for forgetting one thing. Both take the
later of the two on merge, and both are applied when publishing as well as when
reading, so a cleared event is not handed back out. Clearing also bumps the
`plays` epoch.

Retention is two years or two thousand events per device, whichever comes first.

History is always recorded, for local viewing, in both lifecycle states. A player
that cannot remember what it played is a worse player, and in a Local library the
record has nowhere to go: no key exists and no server knows the library is there.
The controls are therefore a pause toggle, for a sitting somebody would rather
not keep, and a clear control — not a global off switch, which would only trade
a useful record for nothing. Nothing leaves the device unless sync is on and
history is included in it, and nothing appears on a profile unless that share
names it.

This is also why history syncs when positions do not. Positions are written
every five seconds during playback; a history event is written once per sitting.
The cadence, not the size, was the objection.

## Notes

A short note against an item: why it is kept, what it is for, what it did.
`hyp.notes` is `{id: {text, updated, private}}`, capped at two thousand
characters. A private note never appears on any share, whatever that share's
toggles say; see the chooser case below for why the granularity matters.

Notes are **text, never HTML**. Descriptions arrive as sanitised HTML through
`sanitise.go`; a note does not, and should be escaped and rendered with line
breaks and nothing else. It removes a whole class of problem for the sake of a
formatting feature nobody asked for.

The merge is last write wins per item, by `updated`. Empty text with a newer
`updated` is the deletion, so notes need no tombstone of their own. Where a write
displaces different text, the displaced version is kept locally and offered once
— losing something typed is the one kind of loss people actually notice, and the
alternative to a conflict copy is a silent one.

Notes are searchable locally. `haystack` caches a per-item string on `it._hay`,
so a note either invalidates that cache on write or is matched separately in
`filtered()`; the former is simpler and wrong less often.

On a profile, notes are per-share. When viewing somebody else's, they are
stranger-authored text and take the same escaping, length cap and bidi stripping
as a profile name.

## Key schedule

One 256-bit group key `gk`, generated at the moment sync is first set up, is the
whole secret. Before that press it does not exist.
Everything else derives from it with HKDF-SHA256 under distinct info strings, so
possessing one derivative yields neither `gk` nor any sibling.

| Value | Derivation | Held by | Purpose |
| --- | --- | --- | --- |
| `group-id` | `HKDF(gk, "hypnotica/group-id")`, 128 bits, base32 | server, devices | path component |
| `content-key` | `HKDF(gk, "hypnotica/content")` | devices only | AES-256-GCM for sync blobs |
| `enrol-key` | `HKDF(gk, "hypnotica/enrol")` | server, devices | HMAC gating every group operation |

The server holds `enrol-key` and `group-id` and can therefore tell a member from
a stranger while remaining unable to decrypt anything.

An earlier sketch split a separate `read-key` so a read-only link could be cut
from the group. That is no longer needed: profiles are separate documents with
independent keys (below), so device slots are only ever read by devices and one
group MAC suffices.

Each device holds an ECDSA P-256 keypair, generated locally, private half
non-extractable in IndexedDB so injected script cannot lift it. `gk` must stay
extractable, since pairing has to hand it on.

`device-fp` is base32 of the first 128 bits of SHA-256 over the public key's
SPKI encoding. It names the slot, which makes writes self-authenticating: no
registration step, no account, no server-side user record.

## Envelope

What the server parses. The payload is gzipped and then encrypted, so nothing
below reveals content. Compression before encryption is safe here: there is no
adaptive chosen-plaintext channel into a person's own favourites.

```json
{
  "v": 1,
  "slot": "<device-fp>",
  "key": "<base64 SPKI>",
  "counter": 41,
  "written": "2026-09-20T11:04:22Z",
  "n": "<base64 96-bit nonce>",
  "ct": "<base64 ciphertext and tag>",
  "sig": "<base64 ECDSA over v | group-id | slot | counter | SHA-256(ct)>"
}
```

Requests carry `X-Hypnotica-Auth: <base64 HMAC(enrol-key, method | path |
counter | SHA-256(body))>`.

The server accepts a write when the envelope parses within its size bounds, the
fingerprint of `key` equals `slot`, `sig` verifies under `key` over the stated
tuple, `counter` exceeds the stored counter, and the auth MAC verifies. Nothing
else. It cannot check the shape of the plaintext, and should not pretend to.

The counter is not bookkeeping. Without it a server can replay an old blob and
silently roll back a deletion; clients also remember the highest counter seen per
slot and refuse to go backwards.

The server also stamps each stored blob with its own received time, in `recv`,
which it can do without learning anything. Clients clamp every timestamp in an
incoming blob to that stamp and order across devices by counter and `recv`
rather than by the writing device's clock. Otherwise a device a year fast wins
every last-write-wins comparison until its clock is corrected, and its notes go
on winning afterwards. A device's own clock still orders its own records, and a
Local library is unaffected: it has no cross-device merge except through a file,
where a person is present to see what arrived.

Envelope version and payload version are independent. The Go side never learns
the transfer schema, so the endpoint does not change when the format does, and a
phone running a three-week-old cached build cannot be broken by a server upgrade.

## Endpoint

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/sync/<group-id>/` | enrol MAC | list slots, counters, sizes |
| `GET` | `/sync/<group-id>/<fp>` | enrol MAC | fetch a slot |
| `PUT` | `/sync/<group-id>/<fp>` | enrol MAC + envelope | replace own slot |
| `DELETE` | `/sync/<group-id>/<fp>` | enrol MAC | retire a device |
| `POST` | `/pair/<pairing-id>` | pairing MAC | pairing exchange |
| `GET` | `/profile/<profile-id>` | profile read MAC | view a published profile |
| `PUT` | `/profile/<profile-id>` | enrol MAC + envelope | publish or replace |
| `DELETE` | `/profile/<profile-id>` | enrol MAC | revoke a share |

Blobs are served `application/octet-stream` with `Content-Disposition:
attachment` and `nosniff`, so the endpoint can never emit anything a browser
will render or execute.

`serve --sync DIR` is off by default, and when on accepts writes only to group
ids the operator has added, or presents `--sync-invite` for creating new ones.
Closed by default reduces the entire abuse surface to people already linked.

## Pairing

The QR must not encode `gk`. A screenshot, a screen share or a photograph of a
laptop would otherwise be permanent full access. Pairing exists only when a
server does, so it can use one.

1. Device A asks the server for a pairing id, generates a 256-bit pairing key,
   and displays a QR for `https://host/#/link?p=<id>&k=<key>`. Five minutes,
   single use.
2. Device B opens it, generates its keypair, and posts its public key MAC'd
   under the pairing key.
3. Both screens show the same six digits, derived from SHA-256 over both public
   keys and the pairing id.
4. The person confirms on each device, in either order. Each side then seals
   what it holds -- its group key and its endpoint, or nothing from a device in
   no group -- to the other's public key by ECDH and posts it: B as `b.ok`,
   A as `a.ct`.
5. A reads B's half and marks its own `got`. B takes A's half only once `got`
   is there, so neither is left without what the other handed over, and then
   deletes the record.
6. Each side now holds both groups, if there were two, and applies the same
   rule to them (below).

A confirmation on each side, because each side may be handing over a key: a
device that took the other's key on the strength of the other screen alone
would join whatever group a party in the middle sealed to it, and one that
handed over its own would give that party the whole library. An old
screenshot is inert, and the six digits are what makes "another device clicking
joins the group" safe rather than merely convenient.

## Two groups become one

Linking a device that is already linked elsewhere does not strand the devices it
was linked to. Both groups become one: the group whose id sorts first. Both ends
of the pairing work that out alike without a further message, it does not
depend on who offered, and since every move is to a lower id, no sequence of
merges can form a loop -- two pairings made at once in opposite directions end
in the same place.

- **The device that moves** retires its old group key to a *ring*, switches its
  endpoint and group key, and on its next pass writes a forwarding note into its
  own slot in the old group: the new group key and endpoint, sealed under the
  old group's content key like any other blob, and nothing else. Its state goes
  to the new group and is merged there like any device's.
- **Devices still in the old group** find the note on their next pull, merge
  what they have already taken, and follow it (only ever to a lower id). Having
  followed, each deletes its own old slot, since the note already says where to
  go; the note stays, so a device that was switched off for months still finds
  its way. A device that moves again rewrites the notes it left, so a straggler
  two merges back goes straight to the end.
- **The ring** travels in the sync blob to every device in the merged group.
  The endpoint records which group published each share and takes changes to it
  from no other, so a share made before a merge is republished, rotated and
  revoked with the key the ring kept, at the endpoint it was published to. Each
  share records both, and its link is built from its own endpoint rather than
  the one the library now syncs through.

What merging means for people holding share links: the links go on working,
unchanged, because a share's key is its own and not derived from the group's.
What they show becomes the merged library from the next publish. The joining
screen says so before anything is pressed, when there are shares. Two links to
one person from what were two groups are now two links to the same library; the
reader's side cannot tell and shows the name twice, and revoking one is the
remedy. The profile name is one setting and the newer one wins, so one side's
links change name.

Nothing about this needs the endpoint's help: a note is an ordinary blob in an
ordinary slot, and the endpoint already lets a member delete a slot.

## Profiles

A profile is a document the owner publishes, not a window onto the live sync
group. A window could never be un-shared, would keep updating forever, and a
link pasted into a chat would leak everything added afterwards.

Each share is its own slot under its own 256-bit share key `sk`, with
`profile-id`, an AES key and a read MAC key derived from it exactly as the group
schedule derives from `gk`. Consequences: revoking is deleting a slot or rotating
one share key, with no re-encryption and no re-pairing; several links can carry
different contents to different audiences; and `content-key` is never handed to
anybody, ever.

The link is `https://host/#/p?k=<sk>` — origin plus one key, the same size as
the pairing QR.

```json
{
  "hypnotica": 1,
  "published": "2026-09-20T11:04:22Z",
  "profile": { "name": "Naomi", "note": "" },
  "favourites": { "items": {}, "authors": {} },
  "playlists": [],
  "history": { "recent": [], "plays": {}, "progress": {} },
  "notes": {},
  "titles": { "<item-id>": { "t": "A Walk in the Woods", "a": "Example Author" } }
}
```

Every section is a per-share toggle, and the share page names exactly what a
given link exposes. Favourites and playlists default on, notes and history
default off: a note is written for oneself, and a history is the most exposing
record in the library. History is four toggles rather than one, because the
timeline, the play counts, what was played lately without times, and what is
in progress are four different degrees of candour. Presets carry the common
combinations so nobody has to reason about six checkboxes; see below.

`titles` is a projection of `hyp.names`, and is why a name field matters beyond
the profile's own. Ids alone render
as nothing on a library that lacks those items; the merge still keys on ids and
the text is only for showing, which is the same posture `strangers()` already
takes toward ids a build does not know.

Viewing is not importing. A profile link renders their view inside yours behind
a persistent banner, items you lack shown by name and unavailable, and an
explicit **Import to mine** running the existing merge. A silent merge is the
one way UI could undo the read-only property.

This is also the first time the app renders text written by somebody else.
Profile names, playlist names and shared titles are all stranger-authored:
`esc()` covers the HTML, and they additionally want length caps and stripping of
control and bidi-override characters, or a name can spoof interface chrome.

## Choosing for somebody else

The use case that shapes profiles most is not showing off a library. It is one
person reading another's in order to pick something for them — a partner, and in
D/s dynamics routinely so. What that reader wants is specific: has this been
heard, when was it last heard, how often, what has been heard lately, and what is
half-finished.

The design consequence is that a viewer does not want a timeline. The owner's
**History** view is chronological because the question there is "what did I do".
A chooser is browsing to select, so their question is per item, and the answer
belongs **on the catalogue**: a last-played line on the card, and filters for
never played, not played in six months, and in progress. Same data, projected
onto the grid instead of listed by day. Selection then happens where selection
naturally happens.

The two layers already answer both questions without anything new: `recent` gives
what lately, `plays` gives heard-it, when-last and how-often.

In-progress is worth carrying too, and can be had cheaply. A profile is written
at a session boundary anyway, so it can include a short in-progress list — item
and fraction — derived from `hyp.positions` at publish time. That answers "do not
pick something they are halfway through", or precisely the opposite, without
positions ever becoming a synced record.

**Handing something back stays a playlist link.** The obvious temptation is an
inbox, a queue, an assignment — some way for the chooser to put something into
the other person's library directly. That would need a write capability handed to
a viewer, and it would undo the single property that makes a profile safe to give
away. The answer instead is one click each side: the viewer selects across the
annotated grid, gets a playlist link, and the owner imports it with the machinery
that already exists. A little less magic, and nobody holds a key they should not.

This configuration has a name, so it should be a preset rather than six
checkboxes: **Someone choosing for me** turns on favourites, `plays`, `recent`
and in-progress, against a plainer preset that shares playlists and nothing else.

It also changes what a note is for. Notes in this dynamic are the useful kind —
too intense, good for sleep, made me cry — and a chooser wants them, which makes
all-or-nothing the wrong granularity. A note therefore carries a `private` flag,
and a private note is excluded from every share regardless of what its toggles
say.

The owner stays in control and the exposure stays legible. The shares list says
what each link exposes, that it is live rather than a snapshot, and when it was
last fetched — the server can record a fetch time without recording content.
Revoking is one tap and no confirmation gauntlet, because a revocation that is
awkward to perform is one somebody puts off.

A viewer who does not have the library at all still works: `titles` renders the
names, they can select and send a playlist back, and they cannot listen. That is
the correct set of abilities for somebody choosing on another person's behalf.

A chooser never joins the group. They hold a share link, their own library is
their own group, and two people who choose for each other hold one link each.
Every capability described here follows from that: a viewer can read what the
link exposes and produce a playlist from it, and there is no arrangement of the
interface in which they acquire more.

## Sharing a playlist alone

The payload goes in the fragment. Fragments are never transmitted, so this
works with no server, tells no one what was shared, and needs no crypto: the
recipient sees the import dialog and confirms, which is where authenticity
belongs.

Fifty tracks with ids, titles and author names is roughly 4.5 KB of JSON, 1.5 KB
gzipped, 2 KB base64url — inside URL limits everywhere, and at the edge of QR
capacity, which tops out at 2,953 bytes. Links always work; codes work for short
lists. Past a few hundred tracks it becomes unwieldy in a chat message and falls
back to the file export that already exists.

## The export file

The export predates history and notes, and it is the artifact people actually
email. It therefore takes the same section toggles as a share, with the same
defaults — favourites and playlists on, notes and history off — so a file sent
to a friend does not quietly carry a timeline. Private notes are excluded
whatever the toggles say, exactly as in a share.

It keeps the properties it already had. It is the only way anything leaves a
Local library; it carries the merged view of history rather than one device's
stream, because it is a snapshot for a person and not a sync blob; it carries
the profile name as `from`, so an import can say who sent it; and it remains the
recovery path for a library whose devices are all gone, which is the one path
that survives losing `gk`.

## The two tiers

| | No server | With a server |
| --- | --- | --- |
| Share | data in the fragment: a snapshot, like the export file | a key in the fragment: live, updating |
| Revoke | impossible, it is a copy | delete the slot or rotate the key |
| Devices | manual import | paired, continuous |

Both keep the payload or key in the fragment, so even the hosted form never
shows the server what was shared or who read it.

## Interface

The bar carried nine links, five of which were somebody's own — Favourites,
Playlists, History, Notes and Offline — and on a phone they wrapped into a second
row that pushed the library down the screen. They live in the menu now, which
leaves the bar as Library, Authors, Queue and RSS: the things a visitor would
want. The menu's summary carries the active mark while one of its pages is open,
because a link folded away still has to say where the reader is.

In the Local state the menu holds the name, **History**, **Notes**, export and
import, and one entry reading **Link a device** — which on its first press is
also the setup: endpoint, invite token, group created, QR shown. There is no
sync status line, no greyed-out share controls and no "not configured" panel,
because until that press there is genuinely nothing there.

Once linked the menu gains **Profile** and a sync status line, and the device
entry becomes a list of devices. History and notes sit in the menu in both
states; they are local records that a server happens to be able to carry.

A profile being viewed annotates the library rather than opening a view of its
own: last-played on the cards, and filters for never played, not in six months,
and in progress, behind the banner that says whose view this is.

**History** is a reverse-chronological list, grouped by day, each row an item
with when and how long, and a played count where there is more than one. It
carries the controls that matter next to what they act on: pause recording,
forget this item, clear a span. A "most played" ordering falls out of `plays` for
free, as does a "never played" filter in the library.

**Notes** is the list of everything annotated, and the editor itself lives on the
item page under the write-up, where the reason for a note is on screen. A "has
note" facet belongs beside the existing filters.

The two links must never be confusable. A pairing link is total read and write
access forever; a profile link is one published document. They will otherwise
look identical — same origin, same shape, a key in the fragment.

- Different verbs, and the word "link" for only one of them: **Link a device**
  for something you own, **Share profile** for someone you do not. The division
  is exact rather than advisory: a pairing link is never given to another person,
  under any circumstance, because a group is one person's devices. The interface
  can say so in those words, which is easier to follow than a warning about keys.
- Pairing is QR-first, with the link text behind a disclosure. A QR is harder to
  paste into a chat by accident, and the disclosure is a speed bump where one
  belongs.
- The profile link is the opposite: a plain copyable field, because pasting it
  is the entire point.

Rotation is two different buttons in two different places. Rotating a share key
kills one URL and leaves devices alone; it sits beside the share. Rotating `gk`
re-pairs every device; it sits in the device list beside **Remove**, with the
consequence written out.

Even where the first version issues exactly one profile link, the model is a
list of shares — label, what it exposes, whether it is live, when it was last
fetched, and its own rotate and revoke. One row now, several audiences later, no
rework.

The name also belongs in `Share.bundle` as an optional `from`, so an import can
report "3 playlists from Naomi" whether or not a server was ever involved.

## Abuse resistance

The structure does the work, and the numbers should be generous. A library is
not public and is not meant to be; everyone who can reach the endpoint was
linked on purpose. So the limits below are sanity bounds against a looping bug
or a runaway device, not a fence against an adversary who, by construction, is
not there.

What earns its keep is the shape rather than the size. A slot is replace-only
and fixed in name and count, so a group's footprint is `slots x max blob`
whatever the write volume; unbounded storage would need unbounded groups, which
is why group creation stays closed by default and is the only control that
really matters. That costs nothing to keep, and it means the caps can be loose.

| Limit | Value | Response |
| --- | --- | --- |
| Blob size | 2 MiB | 413 |
| Slots per group | 64 | 409 |
| Shares per group | 256 | 409 |
| Writes per slot | 1 per 5s sustained, bursts of 20 | 429 |
| Idle slot collection | 2 years | deleted |
| Total disk | configured ceiling, 5 GiB by default | 507 |

Two megabytes is roughly four times the largest library modelled below, which is
the right margin for a bound meant to catch a bug. Profile slots are the one
surface handed out on purpose and keep a read rate limit, generous but present.
Logs record group id, slot, size and time, never content. `hypnotica sync ls`
and `rm` exist so a group can be seen and dropped, because at this scale the
answer to anything going wrong is eviction, not detection.

## Threat model

Protects against: a compromised or curious host reading what somebody likes,
stolen backups, and forged state (signatures and counters).

Does not protect against: traffic analysis, which still reveals group size, blob
sizes and sync timing; and a host serving malicious JavaScript, since the same
origin that stores the ciphertext can ship code that posts `gk` back. End-to-end
encryption in a re-fetched web app is weaker than in a native one. Hosting the
sync endpoint on a different origin from the site hardens this, and the runtime
configuration already allows it.

What it buys is that the plaintext never sits readable on a server or in its
backups. With history and notes that plaintext is no longer only what somebody
likes: it is what they played, when, for how long, and what they wrote about it
afterwards. That raises the value of encrypting at rest without raising the
difficulty, which is the best kind of change to a threat model.

Losing every device loses `gk`, and the ciphertext is inert. The plaintext export
file remains the recovery path, as it is the path for people who never turn sync
on at all.

## Dependencies

None on either side. WebCrypto supplies AES-256-GCM, ECDSA P-256, ECDH,
HKDF-SHA256 and `getRandomValues`; `CompressionStream` supplies gzip. The server
needs `crypto/ecdsa`, `crypto/hmac`, `crypto/sha256` and `encoding/base64` from
the standard library. Nothing enters go.sum, THIRD_PARTY.md or the frontend,
which has no build step.

A QR encoder rendering an SVG grid is a few hundred lines and needs no camera.
A decoder is not written: the QR encodes a URL, phone cameras open those, and
the typed link code covers devices without one.

## Sizes

| Library | Raw JSON | Gzipped |
| --- | --- | --- |
| 100 favourites, 6 playlists, 200 events, 20 notes | ~45 KB | ~9 KB |
| 500 favourites, 20 playlists, 800 events, 60 notes | ~190 KB | ~40 KB |
| 2000 favourites, 40 playlists, 2000 events, 300 notes | ~600 KB | ~125 KB |

A favourite costs about 65 bytes: a slug id around 30 characters, a 24-character
ISO timestamp, and punctuation. A playlist entry costs about 33, a history event
about 70, a `plays` entry about 50, a `names` entry about 60, and a note whatever
it says plus 70. Tombstones price as favourites. Ids compress hard because they
share a vocabulary; notes are prose and compress like prose.

`names` holds one entry per distinct item referenced, not one per record, so it
grows with the breadth of a library rather than with use, and it displaces the
per-share `titles` map that would have been built anyway.

History roughly triples a blob and notes add whatever somebody writes, which is
why the size cap moved. Neither changes the write cadence: an event is one write
per sitting, a note one per edit.

This still assumes positions stay out. `hyp.positions` is written every five
seconds during playback, and its cadence, not its size, is the objection.

## Implementation notes

- `--sync DIR` must live outside the output root, and `/sync/`, `/profile/` and
  `/pair/` must route before the file server in `PreviewHandler`. A sync
  directory under `-o www` is served directly and every rule above is bypassed.
- Endpoints must not sit under `/data/` or `/transcripts/`: the service worker
  treats those as network-first with a cached fallback, which would hand back
  stale sync state. They also want an explicit bypass, or the cache-first
  catch-all answers an offline GET with an empty 504 instead of a network error.
  Sync should no-op offline, not fail strangely.
- The hash router owns the fragment, which is also where secrets have to live.
  Share routes carry them deliberately (`#/link?p=`, `#/p?k=`) and consume them
  immediately, with `history.replaceState` to keep the key out of history and
  out of the next screenshot of the address bar.
- Device private keys are non-extractable; `gk` is not, and lives in IndexedDB.
- History writes at session boundaries, not during playback. The player's
  `remember()` runs every five seconds and must not become a sync trigger; an
  event closes on item change, on pause past the idle window, and on `pagehide`.
- A note is plain text on the way in and on the way out. Nothing about it should
  touch the HTML policy in `sanitise.go`, which exists for a different problem.
- jsdom suites run against real WebCrypto in Node, so envelope and key-schedule
  tests need no stubs. Golden vectors for the envelope are worth pinning.

## Invariants to add

12. The library is fully functional with no sync server. Sync is runtime
    configured and additive; no build depends on one, and every sharing feature
    has a serverless form.
13. The server validates envelopes only. Payload shape is `Share.parse`'s job,
    and envelope and payload versions move independently.
14. A device writes only the slot its own key fingerprint names. Reads require
    group membership; a published profile is a separate document under its own
    key and never exposes the group.
15. Nothing recorded locally leaves the device unless sync is enabled and that
    record is included in it, and a share names exactly what its link exposes.
    History and notes default to staying put, in an export file as much as in a
    share, and a private note leaves in neither.
16. Listening events are owned by the device that recorded them. A device
    publishes its own and republishes nobody else's, so a trimmed event does not
    return.
17. A group is one person's devices, and never gains a member. Access for another
    person is a share link, which is read-only by construction; there is no
    mechanism by which a second listener joins a group.

## Open questions

Nothing here shapes a record's format any more; the four that did have been
decided and moved into the body — what a group is, into the principles; names
beside ids, clock clamping and the export file's toggles, into sections of their
own. What is left can be decided while building.

- Whether positions should now sync after all. The objection was cadence, and a
  history event already flushes at a session boundary; carrying the resume point
  for anything played recently and not finished would cost a few kilobytes and
  buy starting on a laptop and finishing on a phone. Left out of this version on
  purpose, but the argument against it has weakened.
- Whether the history view says anything on first use. Recording is settled, but
  a machine shared with somebody else holds a timeline they can open, and one
  line in the view pointing at pause and clear costs nothing.
- What a note conflict looks like when it happens. Keeping the displaced text is
  decided; whether it surfaces as a banner on the item, a queue in the notes
  list, or a one-time toast is not.
- One profile link in the first version, or several shares from the start.
- Whether the profile menu absorbs the four personal navigation links.
- Whether a serverless whole-profile share is worth having. Five hundred
  favourites with titles is around 18 KB of base64 in a URL: legal, unpleasant.
  Playlists in a link and everything else in a file may be the honest split.
