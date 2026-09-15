// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"bytes"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	id3 "github.com/bogem/id3v2/v2"
)

func makeFile(t *testing.T, root, rel string, b []byte) string {
	t.Helper()
	path := filepath.Join(root, rel)
	if e := writeFile(path, b); e != nil {
		t.Fatal(e)
	}
	return path
}
func TestClaims(t *testing.T) {
	for _, tc := range []struct {
		ref, found string
		want       []string
	}{{"../y.m4a", "/a/uuid", []string{"media/y.m4a"}}, {"y", "/a/y.MP3", []string{"media/y.mp3", "media/y", "media/y.mp3"}}, {"", "", nil}} {
		if got := claims("media/y", tc.ref, tc.found); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("claims(%q,%q)=%v", tc.ref, tc.found, got)
		}
	}
}
func TestPrune(t *testing.T) {
	root := t.TempDir()
	kept := makeFile(t, root, "media/audio/kept.mp3", []byte("last copy"))
	makeFile(t, root, "media/gone/stale.mp3", []byte("stale"))
	outside := makeFile(t, root, "data/index.json", []byte("{}"))
	dangling := filepath.Join(root, "media/dangling")
	if e := os.Symlink(filepath.Join(root, "missing"), dangling); e != nil {
		t.Skip(e)
	}
	external := t.TempDir()
	externalFile := makeFile(t, external, "source", []byte("keep"))
	if e := os.Symlink(external, filepath.Join(root, "media/external")); e != nil {
		t.Fatal(e)
	}
	claimed := map[string]bool{"media/audio/kept.mp3": true, "media/dangling": true}
	gone, freed, e := prune(root, "media", claimed)
	if e != nil {
		t.Fatal(e)
	}
	if gone != 3 || freed != 5 {
		t.Fatalf("gone=%d freed=%d", gone, freed)
	}
	for _, p := range []string{kept, outside, externalFile} {
		if !isFile(p) {
			t.Errorf("removed %s", p)
		}
	}
	if _, e = os.Lstat(dangling); !os.IsNotExist(e) {
		t.Fatal("dangling symlink survived")
	}
	if _, e = os.Stat(filepath.Join(root, "media/gone")); !os.IsNotExist(e) {
		t.Fatal("empty directory survived")
	}
	gone, freed, e = prune(root, "media", claimed)
	if e != nil || gone != 0 || freed != 0 {
		t.Fatal(gone, freed, e)
	}
}
func TestPlaceModesNeverChangeSource(t *testing.T) {
	root := t.TempDir()
	src := makeFile(t, root, "source.mp3", []byte("source"))
	dst := filepath.Join(root, "out/file.mp3")
	if fresh, e := place(src, dst, "none", false); e != nil || fresh {
		t.Fatal(fresh, e)
	}
	if _, e := os.Lstat(dst); !os.IsNotExist(e) {
		t.Fatal("none wrote output")
	}
	if _, e := place(src, dst, "link", false); e != nil {
		t.Skip(e)
	}
	if fresh, e := place(src, dst, "link", false); e != nil || fresh {
		t.Fatal(fresh, e)
	}
	if _, e := place(src, dst, "copy", false); e != nil {
		t.Fatal(e)
	}
	info, e := os.Lstat(dst)
	if e != nil || !info.Mode().IsRegular() {
		t.Fatal("copy retained symlink", e)
	}
	if e = os.WriteFile(dst, []byte("retagged"), 0644); e != nil {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(src)
	if string(b) != "source" {
		t.Fatal("source modified")
	}
	if fresh, e := place(src, dst, "copy", false); e != nil || fresh {
		t.Fatal("unchanged copy rewritten", fresh, e)
	}
}

func TestFingerprintIgnoresTags(t *testing.T) {
	root := t.TempDir()
	payload := []byte("the audio payload")
	plain := makeFile(t, root, "plain", payload)
	tagged := append([]byte{'I', 'D', '3', 3, 0, 0, 0, 0, 0, 4}, []byte("tags")...)
	tagged = append(tagged, payload...)
	tagged = append(tagged, append([]byte("TAG"), make([]byte, 125)...)...)
	path := makeFile(t, root, "tagged", tagged)
	a, e := AudioFingerprint(plain)
	if e != nil {
		t.Fatal(e)
	}
	b, e := AudioFingerprint(path)
	if e != nil || a != b {
		t.Fatal(a, b, e)
	}
	if a != digest(payload, 16) {
		t.Fatal("wrong BLAKE2b parameters")
	}
}
func TestTaggingAndProbe(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join("..", "..", "tests", "fixture", "media", "voxa-1.mp3")
	b, e := os.ReadFile(source)
	if e != nil {
		t.Fatal(e)
	}
	path := makeFile(t, root, "audio.mp3", append(append([]byte(nil), b...), append([]byte("TAG"), make([]byte, 125)...)...))
	before, e := AudioFingerprint(path)
	if e != nil {
		t.Fatal(e)
	}
	i, e := newItem(object{
		"title":      "Café 音声",
		"author":     "author",
		"date":       "2026-03-05",
		"series":     object{"name": "Album", "index": 2},
		"categories": []any{"Audio", "Free"},
		"tags":       []any{"Nature", "Quiet"},
		"summary":    "A summary",
		"transcript": "A transcript",
		"source_url": "https://example.com",
	}, "x.yaml")
	if e != nil {
		t.Fatal(e)
	}
	a, _ := newAuthor(object{"name": "Author"}, "a.yaml")
	coverBytes, e := spiralIcon(16, "#123456")
	if e != nil {
		t.Fatal(e)
	}
	cover := makeFile(t, root, "cover.png", coverBytes)
	if e = tagMP3(path, i, a, cover); e != nil {
		t.Fatal(e)
	}
	after, e := AudioFingerprint(path)
	if e != nil || before != after {
		t.Fatal("tagging changed audio payload", e)
	}
	taggedBytes, _ := os.ReadFile(path)
	if len(taggedBytes) >= 128 && string(taggedBytes[len(taggedBytes)-128:len(taggedBytes)-125]) == "TAG" {
		t.Fatal("stale ID3v1 survived")
	}
	tag, e := id3.Open(path, id3.Options{Parse: true})
	if e != nil {
		t.Fatal(e)
	}
	defer tag.Close()
	if tag.Title() != i.Title || tag.Artist() != a.Name || tag.Album() != "Album" || tag.Version() != 3 {
		t.Fatal("core ID3 fields wrong")
	}
	for _, frame := range []string{"COMM", "TXXX", "APIC", "USLT", "TRCK", "TYER", "TDAT", "WOAR"} {
		if len(tag.GetFrames(frame)) == 0 {
			t.Errorf("missing %s", frame)
		}
	}
	if duration := probe(path); duration < .8 || duration > 1.2 {
		t.Errorf("duration %f", duration)
	}
	unchanged, _ := os.ReadFile(source)
	if !bytes.Equal(b, unchanged) {
		t.Fatal("source changed")
	}
}
func TestCopyRefreshesOlderOutput(t *testing.T) {
	root := t.TempDir()
	src := makeFile(t, root, "src", []byte("new"))
	dst := makeFile(t, root, "dst", []byte("old"))
	old := time.Now().Add(-time.Hour)
	if e := os.Chtimes(dst, old, old); e != nil {
		t.Fatal(e)
	}
	if fresh, e := place(src, dst, "copy", false); e != nil || !fresh {
		t.Fatal(fresh, e)
	}
	b, _ := os.ReadFile(dst)
	if string(b) != "new" {
		t.Fatal(string(b))
	}
}

// Expected durations were measured with Mutagen from synthetic half-second tones.
func TestProbeFormats(t *testing.T) {
	root := filepath.Join("..", "..", "testdata", "audio")
	expected := jsonValue(t, filepath.Join(root, "durations.json")).(map[string]any)
	for name, want := range expected {
		t.Run(name, func(t *testing.T) {
			got := probe(filepath.Join(root, name))
			if math.Abs(got-want.(float64)) > .11 {
				t.Errorf("duration %v, Mutagen %v", got, want)
			}
		})
	}
}

// Regression for the upstream writer's extra byte at UTF-16 field boundaries.
// These expected values are read through its parser, independently of our writer.
func TestUnicodeMultiFieldFrames(t *testing.T) {
	root := t.TempDir()
	b, e := os.ReadFile(filepath.Join("..", "..", "tests", "fixture", "media", "voxa-1.mp3"))
	if e != nil {
		t.Fatal(e)
	}
	path := makeFile(t, root, "audio.mp3", b)
	i, _ := newItem(object{"title": "Unicode", "author": "a", "summary": "Résumé 音声", "transcript": "Words 🎵", "tags": []any{"Nature", "静か"}}, "")
	coverBytes, e := spiralIcon(8, "#abc")
	if e != nil {
		t.Fatal(e)
	}
	cover := makeFile(t, root, "cover.png", coverBytes)
	if e = tagMP3(path, i, nil, cover); e != nil {
		t.Fatal(e)
	}
	tag, e := id3.Open(path, id3.Options{Parse: true})
	if e != nil {
		t.Fatal(e)
	}
	defer tag.Close()
	if got := tag.GetFrames("COMM")[0].(id3.CommentFrame).Text; got != i.Summary {
		t.Errorf("comment %q", got)
	}
	if got := tag.GetFrames("USLT")[0].(id3.UnsynchronisedLyricsFrame).Lyrics; got != i.Transcript {
		t.Errorf("lyrics %q", got)
	}
	for _, frame := range tag.GetFrames("TXXX") {
		f := frame.(id3.UserDefinedTextFrame)
		want := "Nature; 静か"
		if f.Description == "AUTHOR_ID" {
			want = "a"
		}
		if f.Value != want {
			t.Errorf("%s: %q", f.Description, f.Value)
		}
	}
	if got := tag.GetFrames("APIC")[0].(id3.PictureFrame).Picture; !bytes.Equal(got, coverBytes) {
		t.Fatal("artwork bytes corrupted")
	}
}

func TestPruneCoversEveryManagedTree(t *testing.T) {
	// The bug this is here for: prune ran over media only, so a creator who was
	// renamed, merged away or deleted left a detail shard and a feed behind --
	// still written, still served, still linkable. One here was four days stale
	// and answering for an id that had been folded into another item.
	root := t.TempDir()
	for _, rel := range []string{
		"media/audio/a/a-one.mp3", "media/audio/a/a-gone.mp3",
		"data/detail/a.json", "data/detail/departed.json",
		"feed/a.xml", "feed/departed.xml",
		"transcripts/a-one.json", "transcripts/a-gone.json",
		"data/index/0.json", "index.html",
	} {
		path := filepath.Join(root, filepath.FromSlash(rel))
		if e := os.MkdirAll(filepath.Dir(path), 0755); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(path, []byte("x"), 0644); e != nil {
			t.Fatal(e)
		}
	}
	claimed := map[string]bool{
		"media/audio/a/a-one.mp3": true, "data/detail/a.json": true,
		"feed/a.xml": true, "transcripts/a-one.json": true,
	}
	total := 0
	for _, sub := range []string{"media", "data/detail", "feed", "transcripts"} {
		gone, _, e := prune(root, sub, claimed)
		if e != nil {
			t.Fatal(e)
		}
		total += gone
	}
	if total != 4 {
		t.Errorf("pruned %d, want 4", total)
	}
	for _, rel := range []string{"media/audio/a/a-one.mp3", "data/detail/a.json",
		"feed/a.xml", "transcripts/a-one.json"} {
		if _, e := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); e != nil {
			t.Errorf("%s was removed and should not have been", rel)
		}
	}
	// Nothing outside a managed tree is touched, however unclaimed it looks.
	for _, rel := range []string{"data/index/0.json", "index.html"} {
		if _, e := os.Stat(filepath.Join(root, filepath.FromSlash(rel))); e != nil {
			t.Errorf("%s is not ours to remove", rel)
		}
	}
}
