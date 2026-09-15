# Tests

```sh
go test ./...          # backend, contracts, HTTP, and audio
npm ci                # Node.js 22.13+ or 24+
npm test              # backend plus all seven browser suites
```

`tests/run.sh` builds the real Go executable and two sites in a temporary directory:

- `tests/fixture`: four synthetic items across two authors, with precise tag
  combinations for author and facet assertions.
- `tests/make-library.mjs`: 520 synthetic items to exercise catalogue paging,
  windowed grids, transcripts, measurements, provenance, and video paths.

The fixtures need no private content or runtime downloads. The small MP3s are
silent test audio. `testdata/audio` contains synthetic tones in all supported
audio formats, including an extensionless MP3; expected durations were measured
with Mutagen. FFmpeg created these fixtures but is not needed to run tests.

`testdata/contracts` exercises richer documents. `testdata/golden` contains
snapshots produced by the original Python builder. Tests compare JSON structures,
normalized XML (excluding build time), and transcript text. Changing a snapshot
requires reviewing the compatibility contract.

## Browser suites

| File | Checks |
| --- | --- |
| `frontend.mjs` | Search, rendering, player, playlists, offline, provenance, video, measurements |
| `catalog.mjs` | IndexedDB reuse, page hashes, schema changes, offline upgrade failure |
| `scroll.mjs` | Navigation restoration, filtering, facet panel scrolling |
| `queue.mjs` | Auto-advance, resume, stale queue items, failed playback |
| `sw-range.mjs` | Offline byte-range responses |
| `facets.mjs` | Any/all/not tags, categories, spoilers, duration, persistence |
| `multi-author.mjs` | Author filters, pages, feeds, cross-author playback |

Each script accepts a build directory. `sh tests/run.sh /path/to/www` optionally
uses another large build for the first five suites; it still builds the small
fixture. The broad frontend test expects the documented synthetic-library
properties, including a search match for `woodland`.

jsdom does not implement real layout, codecs, installation, or browser storage
quotas. Tests verify application state and requests, not visual layout or actual
media decoding. A browser smoke test is still useful before releases.
