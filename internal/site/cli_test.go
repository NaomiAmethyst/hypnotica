// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCLI(t *testing.T) {
	source := t.TempDir()
	out := t.TempDir()
	var stdout, stderr bytes.Buffer
	run := func(args ...string) int { stdout.Reset(); stderr.Reset(); return Run(args, &stdout, &stderr) }
	if code := run("init", "-s", source); code != 0 {
		t.Fatal(code, stderr.String())
	}
	original, e := os.ReadFile(filepath.Join(source, "items/an-example-file.yaml"))
	if e != nil {
		t.Fatal(e)
	}
	if code := run("-s", source, "init"); code != 0 {
		t.Fatal(code, stderr.String())
	}
	after, _ := os.ReadFile(filepath.Join(source, "items/an-example-file.yaml"))
	if !bytes.Equal(original, after) {
		t.Fatal("init overwrote an existing item")
	}
	if code := run("check", "--source="+source); code != 0 {
		t.Fatal(code, stderr.String())
	}
	if code := run("build", "-s", source, "-o", out, "--no-media", "--no-prune", "--base-url", "https://example.com/audio"); code != 0 {
		t.Fatal(code, stderr.String())
	}
	if !isFile(filepath.Join(out, "index.html")) {
		t.Fatal("CLI did not build")
	}
	for _, args := range [][]string{{"build", "--media", "invalid"}, {"check", "--unknown"}, {"check", "unexpected"}, {"unknown"}, {"-s"}} {
		if code := run(args...); code == 0 {
			t.Errorf("accepted invalid args %v", args)
		}
	}
	for _, args := range [][]string{{}, {"--help"}, {"build", "--help"}, {"serve", "--help"}, {"init", "--help"}} {
		if code := run(args...); code != 0 {
			t.Errorf("help failed %v: %s", args, stderr.String())
		}
	}
	makeFile(t, source, "bad.yaml", []byte("title: Bad\nauthor: missing\n"))
	if code := run("-s", source, "check"); code != 1 || !strings.Contains(stderr.String(), "unknown author") {
		t.Fatal(code, stderr.String())
	}
}
func TestPreviewRanges(t *testing.T) {
	root := t.TempDir()
	makeFile(t, root, "audio.mp3", []byte("0123456789"))
	makeFile(t, root, "sw.js", []byte("worker"))
	makeFile(t, root, "manifest.webmanifest", []byte("{}"))
	server := httptest.NewServer(PreviewHandler(root, nil))
	defer server.Close()
	for _, tc := range []struct {
		method, rng        string
		status             int
		body, contentRange string
	}{{"GET", "bytes=2-5", 206, "2345", "bytes 2-5/10"}, {"GET", "bytes=-3", 206, "789", "bytes 7-9/10"}, {"GET", "bytes=7-", 206, "789", "bytes 7-9/10"}, {"GET", "bytes=20-", 416, "", "bytes */10"}, {"HEAD", "bytes=0-2", 206, "", "bytes 0-2/10"}, {"GET", "", 200, "0123456789", ""}} {
		req, _ := http.NewRequest(tc.method, server.URL+"/audio.mp3", nil)
		if tc.rng != "" {
			req.Header.Set("Range", tc.rng)
		}
		res, e := http.DefaultClient.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		b, e := io.ReadAll(res.Body)
		res.Body.Close()
		if e != nil {
			t.Fatal(e)
		}
		if res.StatusCode != tc.status || res.Header.Get("Content-Range") != tc.contentRange {
			t.Errorf("%s: %d %s", tc.rng, res.StatusCode, res.Header.Get("Content-Range"))
		}
		if tc.status != 416 && string(b) != tc.body {
			t.Errorf("%s body %q", tc.rng, b)
		}
	}
	res, e := http.Get(server.URL + "/sw.js")
	if e != nil {
		t.Fatal(e)
	}
	res.Body.Close()
	if !strings.Contains(res.Header.Get("Cache-Control"), "no-store") {
		t.Fatal("worker may be cached")
	}
	res, e = http.Get(server.URL + "/manifest.webmanifest")
	if e != nil {
		t.Fatal(e)
	}
	res.Body.Close()
	if res.Header.Get("Content-Type") != "application/manifest+json" {
		t.Fatal(res.Header)
	}
}
