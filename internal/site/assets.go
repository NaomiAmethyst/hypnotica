// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sync"

	"golang.org/x/crypto/blake2b"
)

// A stamp on every picture, so a redrawn one is actually fetched again.
//
// Covers are served from a path built out of the author and the id, and that
// path does not change when the picture behind it does. A browser that has the
// old one keeps showing the old one; so does the service worker, for longer.
// Redrawing a cover and seeing no difference is not a rendering problem, it is
// a caching one, and the fix is for the URL to say which version it means.
//
// The stamp is a digest of the file's contents rather than its timestamp.
// Content survives being copied, cloned or restored from a backup, so the same
// picture keeps the same URL across machines; an mtime would change on every
// one of those and throw away a cache that was perfectly good. The cost is
// reading the file, which is why the answers are kept.

type stampRow struct {
	Size   int64  `json:"size"`
	Mtime  int64  `json:"mtime"`
	Digest string `json:"digest"`
}

type stamps struct {
	path  string
	mu    sync.Mutex
	rows  map[string]stampRow
	used  map[string]bool
	dirty bool
}

func loadStamps(cache string) *stamps {
	s := &stamps{path: filepath.Join(cache, "asset-versions.json"),
		rows: map[string]stampRow{}, used: map[string]bool{}}
	b, err := os.ReadFile(s.path)
	if err != nil {
		return s
	}
	var on struct {
		Rows map[string]stampRow `json:"rows"`
	}
	if json.Unmarshal(b, &on) == nil && on.Rows != nil {
		s.rows = on.Rows
	}
	return s
}

// of returns the short digest of a file, reading it only when the size or the
// modification time says the cached answer is about a different file.
func (s *stamps) of(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	s.mu.Lock()
	row, ok := s.rows[path]
	s.used[path] = true
	s.mu.Unlock()
	if ok && row.Size == info.Size() && row.Mtime == info.ModTime().UnixNano() {
		return row.Digest
	}
	digest := digestFile(path)
	if digest == "" {
		return ""
	}
	s.mu.Lock()
	s.rows[path] = stampRow{info.Size(), info.ModTime().UnixNano(), digest}
	s.dirty = true
	s.mu.Unlock()
	return digest
}

func digestFile(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	h, err := blake2b.New(6, nil)
	if err != nil {
		return ""
	}
	if _, err = io.Copy(h, f); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}

// save writes the cache back, dropping rows for files this build never asked
// about so a library that loses pictures does not carry their digests for ever.
func (s *stamps) save() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.dirty && len(s.used) == len(s.rows) {
		return nil
	}
	keep := map[string]stampRow{}
	for p, row := range s.rows {
		if s.used[p] {
			keep[p] = row
		}
	}
	if e := os.MkdirAll(filepath.Dir(s.path), 0755); e != nil {
		return e
	}
	return writeJSON(s.path, object{"apiVersion": "hypnotica/v1",
		"kind": "AssetVersions", "rows": keep})
}

// warm hashes the files a build is about to ask for, in parallel. Doing it up
// front is what makes the first build over a large library bearable: the work
// is a read per picture and nothing about it is sequential.
func (s *stamps) warm(paths []string, p *phase) {
	workers := min(runtime.NumCPU(), 8)
	if workers < 1 {
		workers = 1
	}
	queue := make(chan string)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for path := range queue {
				s.of(path)
				if p != nil {
					p.step()
				}
			}
		}()
	}
	for _, path := range paths {
		if path != "" {
			queue <- path
		}
	}
	close(queue)
	wg.Wait()
}

// versioned is the URL a page should ask for: the path it is served from, plus
// the stamp of what is there now.
func versioned(rel, digest string) string {
	if rel == "" || digest == "" {
		return rel
	}
	return rel + "?v=" + digest
}
