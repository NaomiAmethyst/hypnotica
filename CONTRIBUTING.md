# Contributing

Maintainer: Naomi Persephone Amethyst <naomi@amethyst.name>.

Contributions are licensed under GPL-3.0-only, like the project. Keep changes
focused and describe their behavior and validation in the pull request.

## Development checks

```sh
gofmt -w cmd internal
go test ./...
go test -race ./...
go vet ./...
npm ci
npm test
```

Use Go 1.26+ and Node.js 22.13+ or 24+. There is no frontend compilation step. Edit browser
assets in `internal/site/web/`; the executable embeds them during `go build`.

Preserve the contracts in `docs/contracts.md`. A change to generated data may
need matching frontend changes and a schema bump. For regressions, add a test
that fails on the old behavior. Do not regenerate golden files simply to make
a failing test pass: establish whether the contract should change first.

Fixtures must be synthetic or redistributable. Do not add personal libraries,
absolute machine paths, credentials, scraped creator content, or real recordings.

## Building distributable binaries

```sh
CGO_ENABLED=0 go build -trimpath -o bin/hypnotica ./cmd/hypnotica
```

The executable includes the browser assets and audio-probing engine. Include
LICENSE, THIRD_PARTY.md, dependency notices, and corresponding source information
with distributions. The repository has a CI workflow but does not publish releases
automatically.
