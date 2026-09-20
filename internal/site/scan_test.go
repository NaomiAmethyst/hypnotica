// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestScannerContracts(t *testing.T) {
	root := t.TempDir()
	makeFile(t, root, "arbitrary/deep/records.yaml", []byte(`- kind: Author
  id: writer
  name: Writer
- kind: Item
  title: One
  author: writer
- kind: Transcript
  item: one
  text: Attached text
- kind: Tags
  content: {Nature: A definition}
- kind: Config
  site: {title: Ignored here}
`))
	makeFile(t, root, "other.yml", []byte("kind: Item\ntitle: Two\nauthor: writer\ntranscript: Inline wins\n---\nkind: Transcript\nitem: two\ntext: Must not replace inline\n"))
	makeFile(t, root, ".hypnotica/ignored.yaml", []byte("not a mapping"))
	makeFile(t, root, "node_modules/ignored.yaml", []byte("not a mapping"))
	makeFile(t, root, "tags.yaml", []byte("ignored: true"))
	l := LoadDocuments(root)
	if len(l.Errors) > 0 || len(l.Authors) != 1 || len(l.Items) != 2 {
		t.Fatalf("%+v", l)
	}
	if l.Items[0].Transcript != "Attached text" || l.Items[1].Transcript != "Inline wins" {
		t.Fatal("transcript precedence wrong")
	}
	makeFile(t, root, "broken.yaml", []byte("title: [broken\n"))
	makeFile(t, root, "bad.yml", []byte("42\n---\nkind: Transcript\nitem: absent\ntext: Orphan\n---\nkind: Transcript\ntext: No target\n---\ntitle: No author\n"))
	l = LoadDocuments(root)
	if len(l.Errors) != 5 {
		t.Fatalf("want five errors: %v", l.Errors)
	}
}
func TestLegacyYAMLScalarsAndMerges(t *testing.T) {
	path := makeFile(t, t.TempDir(), "input.yaml", []byte(`defaults: &defaults
  summary: old
  explicit: no
item:
  <<: *defaults
  title: Original
  title: Last wins
  summary: on
  duration: 1:30
  tags: [yes, "yes", off]
`))
	docs, e := readDocs(path)
	if e != nil {
		t.Fatal(e)
	}
	m := mapping(mapping(docs[0])["item"])
	if m["title"] != "Last wins" || m["summary"] != true || m["explicit"] != false || m["duration"] != float64(90) {
		t.Fatal(m)
	}
	tags := list(m["tags"])
	if strings.Join(tags, ",") != "True,yes,False" {
		t.Fatal(tags)
	}
}
func TestModelNormalization(t *testing.T) {
	i, e := newItem(object{
		"title":       "Café — A walk",
		"author":      "a",
		"variant":     "Long Cut",
		"duration":    "1:02:03.5",
		"series":      object{"name": "Walks", "part": "2"},
		"date":        "5 March 2026",
		"tags":        "one, two, ",
		"explicit":    "no",
		"description": "<p>Words</p><img src='x'>",
		"acoustic":    []any{1},
	}, "item.yaml")
	if e != nil {
		t.Fatal(e)
	}
	if i.ID != "cafe-a-walk--long-cut" || i.Duration != 3723.5 || i.SeriesIndex != 2 || i.Explicit || i.Date == nil || i.Date.Format("2006-01-02") != "2026-03-05" || i.Description != "<p>Words</p>" || len(i.Acoustic) != 0 {
		t.Fatalf("%+v", i)
	}
	i.OutAudio = "media/audio/a/item.mp3"
	i.OutVideo = "media/video/a/item.mp4"
	if i.index()["hasVideo"] != true || i.index()["video"] != nil || i.detail()["video"] != i.OutVideo {
		t.Fatal("video not confined to detail shard")
	}
	for _, d := range []object{{}, {"title": "No author"}} {
		if _, e := newItem(d, ""); e == nil {
			t.Fatal("accepted incomplete item")
		}
	}
	if _, e := newAuthor(object{"name": "A", "links": "not a mapping"}, ""); e == nil {
		t.Fatal("accepted invalid author links")
	}
}
func TestConfigAndAssetPrecedence(t *testing.T) {
	root := t.TempDir()
	makeFile(t, root, "hypnotica.yaml", []byte("site:\n  title: Test\n  media: link\n  tag_media: off\n  prune_media: no\npaths:\n  assets: media\n  transcripts: custom\n"))
	c, e := LoadConfig(root, t.TempDir(), Overrides{Media: "none", BaseURL: "https://example.com/"})
	if e != nil {
		t.Fatal(e)
	}
	if c.Media != "none" || c.Prune || c.TagMedia || c.BaseURL != "https://example.com" || c.Transcripts != filepath.Join(root, "custom") {
		t.Fatalf("%+v", c)
	}
	yamlPath := makeFile(t, root, "nested/item.yaml", nil)
	local := makeFile(t, root, "nested/audio.mp3", []byte("local"))
	makeFile(t, root, "media/audio.mp3", []byte("assets"))
	if got := resolveAsset("audio.mp3", yamlPath, c); got != local {
		t.Fatal(got)
	}
	if e = os.Remove(local); e != nil {
		t.Fatal(e)
	}
	if got := resolveAsset("audio.mp3", yamlPath, c); got != filepath.Join(root, "media/audio.mp3") {
		t.Fatal(got)
	}
}

func TestGeneratedRequiresListAndSeriesRequiresInteger(t *testing.T) {
	i, e := newItem(object{"title": "T", "author": "a", "series_index": "2.5", "provenance": object{"generated": "title"}, "cover_prompts": object{"natural": false}}, "")
	if e != nil {
		t.Fatal(e)
	}
	if len(i.Generated) != 0 || i.SeriesIndex != nil || len(i.CoverPrompts) != 0 {
		t.Fatalf("unexpected normalization: %+v", i)
	}
}

// The name a recording arrived under is shown only where the library replaced
// it with one of its own. Trimming a suffix also records an `original_title`,
// and on a real library that is five times as many entries as were actually
// renamed -- so the flag that matters is whether the title is the machine's.
func TestTheOriginalNameIsShownOnlyWhereTheLibraryRenamedIt(t *testing.T) {
	for _, c := range []struct {
		why    string
		item   Item
		expect string
	}{
		{"renamed by the review", Item{Title: "Obedience and Orgasm Denial",
			OriginalTitle: "Domination3", Generated: []string{"title", "summary"}},
			"Domination3"},
		{"only tidied, not renamed", Item{Title: "Math is hard",
			OriginalTitle: "Math is hard (SFW)", Generated: []string{"summary"}}, ""},
		{"renamed, but only the spacing changed", Item{Title: "Deep Water",
			OriginalTitle: "  deep   water ", Generated: []string{"title"}}, ""},
		{"never renamed at all", Item{Title: "Sleepytime Trance",
			Generated: []string{"summary"}}, ""},
	} {
		if got := c.item.originalTitle(); got != c.expect {
			t.Errorf("%s: got %q, want %q", c.why, got, c.expect)
		}
	}
}
