# Hypnotica

Hypnotica builds a static, offline-capable website and podcast feeds from a
library of YAML documents and audio files. The builder is written in Go; the
website is plain HTML, CSS, and JavaScript, with no frontend build step.

The output runs on any static web server. Python, FFmpeg, and a database are not
required. Audio probing and web assets are embedded in the executable.

## Where this sits

Hypnotica reads a library; it does not make one. Writing the YAML by hand is
perfectly reasonable for a few dozen recordings, and the format is documented
below.

[**Inductor**](https://github.com/NaomiAmethyst/inductor) is what fills one at
scale, from audio: it transcodes and fingerprints the files, transcribes them,
measures the sound, puts the transcript to a model for a synopsis, tags and a
list of what a recording suggests to the listener, rules those tags against a
controlled vocabulary, and writes the `hypnotica/v1` documents this builder
reads. The two never meet — Inductor knows nothing about websites, Hypnotica
never transcribes anything — so a library outlives either of them.

[**Driftspace**](https://github.com/NaomiAmethyst/driftspace-template) is a
ready-made library directory to start from: the layout, a tag vocabulary, a
worked example carried all the way through, and the notes an agent needs to
fill it.

```sh
git clone https://github.com/NaomiAmethyst/driftspace-template my-library
```

## Build and run

Prebuilt binaries for Linux, Windows, and macOS (amd64 and arm64) are available
from [GitHub Releases](https://github.com/NaomiAmethyst/hypnotica/releases).
Use the `darwin` archive for macOS. Each archive includes license notices and a
source link; a matching `.sha256` file contains its checksum. Development
builds are available as artifacts in [GitHub Actions](https://github.com/NaomiAmethyst/hypnotica/actions).

Install Go 1.26 or newer, then build from this checkout:

```sh
go build -o bin/hypnotica ./cmd/hypnotica
bin/hypnotica init -s content
bin/hypnotica check -s content
bin/hypnotica build -s content -o www --base-url https://audio.example.com
bin/hypnotica serve -o www -p 8788
```

`serve` also takes `--sync DIR` and `--sync-invite TOKEN` to run the optional
sync endpoint beside the site; see [Sync](#sync).

Open `http://localhost:8788`. Use HTTPS when hosting publicly; service workers
and offline storage require a secure context (localhost also works).

Source options work before or after the subcommand. `build`, `check`, `serve`,
and `init` each support `--help`. `init` leaves existing files alone.

### Container

The image supports Linux amd64 and arm64. `latest` tracks the default branch;
use a version tag such as `v1.0.0` for a tagged release.

```sh
docker run --rm -v "$PWD:/work" -w /work \
  ghcr.io/naomiamethyst/hypnotica:latest \
  build -s content -o www --base-url https://audio.example.com
```

## Sync

Sync is off until you link a device, and the site works fully without it. When
it is on, the server stores blobs it cannot read: everything is encrypted in the
browser under a key the endpoint is never given.

Run an endpoint alongside the site, with a directory outside the build:

```sh
bin/hypnotica serve -o www -p 8788 --sync ~/.hypnotica-sync --sync-open
```

Then, on the first device, open the menu in the top right, choose **Link a
device**, and give it the address — which is filled in already when the site is
served by the same Hypnotica. That press is what creates the group key. It shows
a code; open it on the second device with its camera, compare the six digits on
the two screens, and confirm on both. The code is good for five minutes and one
device, and it does not carry the key — that is handed over sealed, afterwards.

It does not matter which device offers. If both are already linked to others —
a phone and a laptop that were each set up on their own — the two groups become
one, and the devices that took no part follow the next time they sync. Links you
have shared from either side go on working and show the combined library.

Publishing a share does the same setup if it has not happened yet, so a library
with one device can share a view of itself without linking a second one.

The browser asks the endpoint what it wants before asking you for anything, so
with `--sync-open` there is no token to type at any point. Three choices:

- `--sync-open` — anybody may put a library on it. Right for an endpoint only you
  and the people you live with can reach.
- `--sync-invite TOKEN` — a library needs that token to get on. Only the first
  device of a library ever presents it; every device after gets in with the code.
- neither, the default — no new libraries, and the ones already there go on
  working. Useful once your own is set up.

**The site itself must be served over HTTPS, or opened from localhost.** Browsers
offer the cryptography this needs nowhere else, so a build served over plain http
to a machine on the network can use everything except sync, and says so when you
try. `--sync-disk GB` caps the store
at 5 GiB by default. `hypnotica sync --dir DIR` lists what is stored and `--rm ID`
deletes a group or a share.

Opening a share link shows their view and lets you open any of their playlists
on its own entries, play what your library has of one, or copy it whole. Pressing
**Keep this profile** remembers the link: from then on, a recording says
"Favourited by Naomi", which of their playlists it is in and when they last
played it, and the Library filter gains "Liked by Naomi" to search on. Only the
ids, list names and counts are kept — not their timeline or their notes — and
the links travel between your own devices while what was fetched with them does
not. A revoked link says so and stops being believed.

A **share** is a separate published document with its own key, made from the
Profile page and read-only for whoever you give the link to. It belongs to the
library rather than to the device that made it, so any of your devices can copy
its link, rotate it or revoke it. It can carry
favourites, playlists, notes, what you have played and how often, and what you
are part-way through — each a separate tick. Reading one annotates the library
with what its author has heard, which is what somebody choosing a recording for
you actually wants. Revoking it takes it down; rotating it issues a new link and
kills the old. A note marked private is in none of them.

Losing every device loses the group key and the blobs become unreadable. The
export file stays the way out, as it is for anyone who never turns sync on.

### On iOS

Two platform limits, neither of which a web app can do anything about:

- **An app added to the home screen keeps its own storage.** Safari and the
  installed app are separate libraries with separate favourites, history and
  keys. There is no API to share them. Treat them as two devices and link them:
  they will then sync like any other pair.
- **The installed app is never offered links to its own site.** A pairing code
  or share link tapped in Messages opens Safari. iOS has no equivalent of the
  link capturing Android does from the manifest's `scope`, which is why this
  works there and not here.

So the menu has **Paste a link**: copy the link in Safari, open the app, paste it
in. That covers both a share somebody sends you and the code for pairing the app
with Safari on the same phone. A share opened in Safari on iOS offers the copy
itself.

## Content

Arrange documents however you like. Hypnotica recursively reads `.yaml` and
`.yml` files, including multi-document files and lists of records. Declare a
record's `kind` explicitly for portable, predictable inputs.

```yaml
apiVersion: hypnotica/v1
kind: Item
title: A Walk in the Woods
author: example
date: 2026-03-05
audio: audio/walk.mp3
cover: images/walk.jpg
tags: [Nature, 'Voice: Soft']
categories: [Audio, Free]
series: {name: Walks, index: 2}
summary: An afternoon walk.
description: |
  <p>A longer description with <em>text formatting</em>.</p>
transcript: |
  Welcome to the woods.
---
apiVersion: hypnotica/v1
kind: Author
id: example
name: Example Author
url: https://example.com
```

Only an item's title and author are required. IDs default to a slug of the title
and must be unique across the library; set explicit IDs when titles recur.
Assets resolve relative to the YAML file, then the configured assets directory,
then the source root. Absolute asset paths also work.

Descriptions retain text formatting and safe links. Scripts, embedded players,
remote images, styling, and other resource-loading markup are removed from the
rendered output. Source documents are never rewritten.

See [the input and output contracts](docs/contracts.md) for configuration,
transcripts, additional fields, generated data, and migration details.

## Media

```sh
bin/hypnotica -s content build -o www --media copy  # default: portable output
bin/hypnotica -s content build -o www --media link  # no second audio copy
bin/hypnotica -s content build -o www --media none  # data and app shell only
```

Copy mode writes MP3 metadata: title, author, series, track, date, categories,
keywords, source URL, artwork, and transcript. Other audio formats are copied
without retagging. Supported audio probing includes MP3, M4A/M4B, WAV, FLAC,
Ogg Vorbis, and Opus. Optional video files are shown on item pages; the main
player, queue, and offline downloads continue to use audio.

Link mode serves the original bytes without changing their tags. The output
then depends on the original files remaining accessible. `--no-media` is an
alias for `--media none`.

Builds remove unclaimed files under the output's `media/` directory. Claims are
based on declarations, so a temporarily unavailable source does not erase an
existing copy. Dangling output links are removed. Use `--no-prune` when another
tool also manages that directory. `--force` recopies and retags media.

## Website and feeds

- Search titles, descriptions, tags, authors, and transcripts.
- Combine tag/category inclusion, requirements, and exclusions; filter by
  author, duration, and offline availability.
- A Library facet over what you have done with a recording — played, noted,
  favourited, in a playlist — with the same any/all/not cycle as tags, so
  "liked but never played" is two clicks.
- Save a search under a name and press it to get the whole thing back: the
  words, the chips, the sort, the duration.
- Pin any chosen filter, from the pin on its chip or by holding the chip
  down, and it applies to every search and every creator's page instead of
  just this one. Set once that you would rather not be shown an audience you
  are not, or a content warning you would rather not meet, and stop setting
  it. A pinned chip has no ✕ and Clear does not reach it; a small line above
  the chips says how many are pinned and offers to suspend them. Pinned
  filters travel between your own devices and appear in no export and no
  share.
- Persistent audio player, reorderable queue, playback speed, resume positions,
  playlists, keyboard shortcuts, and Media Session controls.
- A heart on every recording and creator, and a favourites page of what it
  collects.
- A listening history kept on the device that made it, with play counts, a
  pause, and a control to forget one recording or clear the lot. A private note
  against any recording, in plain text, never published.
- Playlists, favourites, notes and history export to a JSON file and import back
  on another device; the dialog picks what goes in, and notes and history stay
  out unless asked for. An import merges into what is already there: it adds and
  updates, and removes only where the file carries a dated record of a removal
  newer than what is held.
- Optional end-to-end encrypted sync between your own devices, and read-only
  share links for other people. See [Sync](#sync); nothing is published until
  you link a device.
- Keep a share somebody gives you, and recordings say where they have liked,
  listed or played them — with a "Liked by" added to the Library filter for
  each person kept.
- Installable PWA with offline downloads and seeking in saved audio.
- Progressive catalogue loading, IndexedDB caching, and virtualized grids for
  large libraries.
- Author pages, provenance and artwork prompts, optional acoustic measurements,
  and spoiler notes with a visibility control.
- Combined and per-author RSS feeds with artwork, durations, keywords, and
  transcript links. Set `--base-url` to the public site URL before publishing.

Transcription belongs to ingest tools such as Inductor. Hypnotica reads inline
transcripts, `kind: Transcript` records, referenced text files, and compatible
cached transcripts; it does not run speech recognition.

## Development

```sh
go test ./...
go test -race ./...
go vet ./...
npm ci
npm test
```

Node.js 22.13+ or 24+ is only needed for browser tests. `npm test` runs the Go
checks and seven headless browser suites against synthetic fixtures, including
a generated 520-item library. No private content or external service is needed.

See [CONTRIBUTING.md](CONTRIBUTING.md), [architecture](docs/architecture.md), and
[test documentation](tests/README.md).

## License and maintainer

Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>.

Hypnotica is licensed under the **GNU General Public License, version 3 only**
(`GPL-3.0-only`). See [LICENSE](LICENSE). Dependency licenses and source locations
are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
