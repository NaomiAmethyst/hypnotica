# Input and output contracts

## Command line

| Command | Options |
| --- | --- |
| `build` | `-o`/`--output`, `--base-url`, `--force`, `--media copy/link/none`, `--no-media`, `--no-prune` |
| `check` | Validates documents, author references, and globally unique item IDs |
| `serve` | `-o`/`--output`, `-p`/`--port`, `--bind`, `--quiet` |
| `init` | Creates a starter tree without replacing existing files |

All commands accept `-s`/`--source` (default `content`). Output defaults to `www`;
preview binds to `0.0.0.0:8080`. Exit status is 0 on success, 1 for content or
operational failures, and 2 for CLI usage errors. Build warnings do not change
the exit status. `check` reports missing authors as errors; a build creates a
minimal author record and warns instead. Duplicate items produce an error and
only the first record is built, matching the original builder.

The preview server supports GET/HEAD, byte ranges, and MIME types for audio,
feeds, JSON, and the web manifest. The service worker is served with no-cache
headers. It is a local preview server; the published site needs only static hosting.

## Configuration

`hypnotica.yaml` (or `hypnotica.yml`) at the source root:

```yaml
kind: Config
site:
  title: Hypnotica
  tagline: A library of spoken-audio files.
  description: ''
  base_url: https://audio.example.com
  theme_color: '#be3a52'
  icon: images/site.png
  media: copy
  tag_media: true
  prune_media: true
paths:
  assets: assets
  cache: .hypnotica
  transcripts: .hypnotica/transcripts
```

Paths may be absolute or source-relative. Transcripts default to
`<cache>/transcripts`. CLI media, base URL, and pruning options override config.
YAML 1.1 unquoted `yes/no/on/off` values retain their original boolean meaning.
Quoted values remain strings; aliases, merges, and multi-document files work.

## Discovery

`.git`, `.hypnotica`, `node_modules`, `__pycache__`, and `.venv` directories are
excluded. Root config and tag-registry filenames are reserved. Explicit kinds
are case-insensitive, including these historical aliases:

| Record | Kinds |
| --- | --- |
| Author | `author`, `authors`, `person` |
| Item | `item`, `file`, `episode`, `track` |
| Transcript | `transcript`, `transcription` |
| Config | `config`, `site`, `settings`, `hypnotica` |
| Tags | `tags`, `tag`, `vocabulary`, `registry` |

For old hand-written libraries, an author can also be recognized by a filename
`author.yaml`/`author.yml` or `*.author.yaml`/`*.author.yml`, or by a `name` with
no `title` or `author`. Explicit item kinds override the filename fallback.

## Item fields

- Required: `title`, `author`.
- Identity: `id`, `variant`, `also_titled`. Default IDs are Unicode-normalized
  slugs; a variant adds `--<variant-slug>` unless an ID was supplied.
- Media: `audio`, `video`, `cover` (alias `image`), `duration` (seconds or
  `H:MM:SS`). Missing duration is probed. Declared filename extensions take
  precedence over resolved symlink target extensions.
- Organization: `date` (alias `published`), `tags`, `categories`, `series`,
  `series_index`. Tags/categories can be lists or comma-separated text. Series
  can be text or `{name, index}`; `part` aliases `index`.
- Writing: `summary`, sanitized `description`, `source_url` (alias `url`),
  `explicit` (defaults to true).
- Transcripts: `transcript`, `transcript_file` relative to the document,
  `transcript_source`, `transcript_segments`.
- Detail: `acoustic` mapping; `cover_prompts` with `tagged`, `natural`, and
  `negative` styles; `provenance.generated` identifying generated fields.
- `spoilers`: strings or mappings with `severity`, `disclosure`, `confidence`,
  `timestamp`, `tagged`, `source`, `source_title`, `trigger`, `effect`, `quote`,
  and `note`.

Generated field names are `title`, `summary`, `description`, `synopsis`, `cover`,
`image`, `tags`, and `spoilers`. They are shown only when declared, never inferred.
Unknown document fields do not appear in the generated catalogue.

Dates accept ISO dates/timestamps, day/month/year (before month/day/year when
ambiguous), year/month/day, `5 March 2026`, and `March 5, 2026`. Missing or invalid
dates produce null catalogue dates; feeds use build time for undated episodes.

## Authors and vocabulary

Authors need `name` (legacy alias `title`) and can declare `id`, `url`, `image`,
`summary`, `description`, `synopsis`, `links`, `language`, `explicit`,
`cover_prompts`, `provenance.generated`, and `similar`. Similarity entries carry
`id`, `score`, and `same_person`. Links must be a mapping.

A `tags.yaml`/`tags.yml` registry maps namespaces to tag definitions:

```yaml
kind: Tags
voice:
  Soft: Softly spoken.
content:
  Nature: Outdoor scenes.
```

Known prefixes default to Voice, Audience, Induction, Production, Trigger, CW
and Compulsion; content tags have no prefix. Only used definitions are emitted.
A single-document registry elsewhere may be discovered by its kind.

A registry may declare its own namespaces instead, as an ordered list. The order
is the order sections appear:

```yaml
kind: Tags
namespaces:
  - key: voice
    prefix: Voice
    label: Voice
    note: how the speaker presents
    colour: '#8a3f86'
    dark: '#dda3d6'
  - key: warning
    prefix: Warning
    label: Warnings
    spoiler: true
  - key: subject          # no prefix: the namespace bare tags fall into
    label: Subject
voice:
  Soft: Softly spoken.
```

`key` names the registry block and must be present; `label` defaults to the
capitalised key; `prefix` absent or empty marks the namespace unprefixed tags
belong to; `spoiler` gates the section behind the spoiler control; `note` is
shown beside the heading; `colour` and `dark` become that namespace's chip
colour, defaulting to the muted text colour. A registry declaring no
`namespaces` keeps the seven prefixes above plus content, unchanged.

A prefix that no namespace claims is not an error: the tag is filed under the
unprefixed namespace and rendered as an ordinary tag.

## Transcripts and Inductor

```yaml
kind: Transcript
item: recording-id
text: Words spoken in the recording.
model: supplied
segments:
  - {start: 0, end: 2.5, text: Words spoken}
```

Inline or referenced text takes precedence, followed by a Transcript document,
then the cache. Cache JSON contains `text`, optional `segments`, and `model`.
The cache key is `provenance.fingerprint` when supplied. Otherwise it is the
BLAKE2b-128 hex digest of the audio bytes after excluding leading ID3v2 and
trailing ID3v1 containers. No audio decoding or transcription runs during a build.
A malformed or missing cache entry is ignored. Inductor can continue producing
the same YAML and transcript cache without importing the Go implementation.

## Generated files

| Path | Contents |
| --- | --- |
| `index.html`, `app.js`, `style.css`, `sw.js`, `manifest.webmanifest` | Web app |
| `namespaces.css` | One generated custom property per namespace, light and dark |
| `icons/` | Procedural PWA icons and optional supplied icon |
| `data/index.json` | Site, authors, interned tag/category tables, namespaces, page count |
| `data/index/<n>.json` | Catalogue pages of 250 items |
| `data/detail/<author-slug>.json` | Item descriptions and detail fields; optional `_author` entry |
| `data/search.json` | Flattened search text by item ID |
| `data/spoilers.json` | Spoiler records by item ID |
| `data/words/_ids.json` | Transcript item IDs |
| `data/words/<prefix>.json` | Word-to-item postings; two-letter prefix or `_other` |
| `data/manifest.json` | Schema 1, build time, BLAKE2b-64 hash and byte count per data file |
| `transcripts/<id>.json`, `.txt` | Timestamped segments and plain text |
| `media/audio/<author-slug>/<id>.<ext>` | Audio |
| `media/cover/<author-slug>/<id>.<ext>` | Artwork |
| `media/video/<author-slug>/<id>.<ext>` | Optional video |
| `media/author/<author-slug>.<ext>` | Author artwork |
| `feed/all.xml`, `feed/<author-id>.xml` | Combined and per-author podcast feeds |

The head's `tagKinds` is the namespace list the build resolved, in order, each
with `key`, `prefix`, `label` and optionally `spoiler` and `note`. The app reads
it and falls back to the built-in seven-plus-content when it is absent, so a
cached page from an older build keeps working.

Catalogue tags/categories are integer offsets into the head's tables. Detail
shards carry descriptions, source URLs, transcript sources, measurements, video
paths, prompts, and provenance. RSS GUIDs remain `hypnotica:<author>:<item-id>`.

## Browser storage and transfer files

The site keeps what a reader does in their own browser. Nothing is sent anywhere.

| Key | Contents |
| --- | --- |
| `hyp.playlists` | Playlists: `id`, `name`, `items`, `created`, `updated` |
| `hyp.favourites` | `{items, authors}`, each an id-to-time mapping |
| `hyp.queue`, `hyp.positions`, `hyp.rate` | Play queue, resume positions, speed |
| `hyp.filters`, `hyp.dlqueue` | Library filters and the download queue |
| `hypnotica-audio-v1` | Cache Storage for saved audio; unversioned |
| `hypnotica` | IndexedDB catalogue pages, versioned by CATALOG_SCHEMA |

Playlists and favourites export to a JSON file and import back on the same
device or another one. Times are ISO 8601; a number of milliseconds is also
accepted when reading.

```json
{
  "hypnotica": 1,
  "exported": "2026-03-05T12:00:00.000Z",
  "site": "Hypnotica",
  "playlists": [
    {"id": "plabc123", "name": "Sleep", "created": "2026-03-01T00:00:00.000Z",
     "updated": "2026-03-05T00:00:00.000Z", "items": ["a-walk-in-the-woods"]}
  ],
  "favourites": {
    "items": {"a-walk-in-the-woods": "2026-03-04T22:10:00.000Z"},
    "authors": {"example": "2026-03-04T22:11:00.000Z"}
  }
}
```

Either top-level section may be absent. A bare list of playlists, or a single
playlist object, reads the same way, so one entry copied out of a file works.
Favourites also accept a plain list of ids. A file declaring a `hypnotica`
version newer than this build is refused rather than half-read.

An import merges and never removes:

- A playlist whose `id` is already here gains the entries it is missing, keeps
  the ones it has, and takes the file's name only when the file's `updated` is
  newer. Otherwise it arrives as a new playlist under its own id.
- Favourites join the ones already held, keeping the earlier of the two times.
- Item and author ids the build does not know are kept, not dropped, and the
  import reports how many there were. A library that later gains them shows
  them without another import.

## Migration from Python

The executable replaces the Python CLI. YAML, asset naming, RSS GUIDs,
transcript fingerprints, generated data schema, and browser storage conventions
are preserved. Python imports are not an API exposed by the Go executable.
The old README's automatic transcription instructions no longer described the
Python implementation and have been removed.

JSON whitespace/key order, RSS formatting, PNG compression, and ID3 encoding or
padding may differ. Data hashes can therefore change on the first Go build;
subsequent unchanged builds have stable catalogue-page hashes. Audio Cache
Storage (`hypnotica-audio-v1`), localStorage playlists/positions, and IndexedDB
schema are unchanged. Keep the same site origin and media URLs to retain saved
browser state.

Intentional corrections: declared transcript fingerprints are honored even
without accessible audio; changing from link to copy mode replaces the output
link before retagging; stale ID3v1 tags are removed; site text and CDATA
terminators are safely escaped in their output formats.
