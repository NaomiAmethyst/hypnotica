# Hypnotica

Hypnotica builds a static, offline-capable website and podcast feeds from a
library of YAML documents and audio files. The builder is written in Go; the
website is plain HTML, CSS, and JavaScript, with no frontend build step.

The output runs on any static web server. Python, FFmpeg, and a database are not
required. Audio probing and web assets are embedded in the executable.

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
- Persistent audio player, reorderable queue, playback speed, resume positions,
  playlists, keyboard shortcuts, and Media Session controls.
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
