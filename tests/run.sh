#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# All tests use synthetic fixtures; no private library is required.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(dirname "$here")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
cd "$root"
go test ./...
go build -o "$work/hypnotica" ./cmd/hypnotica
"$work/hypnotica" -s "$here/fixture" build -o "$work/fixture" --media copy
node "$here/make-library.mjs" "$work/content"
"$work/hypnotica" -s "$work/content" build -o "$work/www" --media link
www=${1:-$work/www}
for suite in frontend catalog scroll queue sw-range; do
 node "$here/$suite.mjs" "$www"
done
for suite in facets multi-author; do
 node "$here/$suite.mjs" "$work/fixture"
done
