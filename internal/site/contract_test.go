// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"bytes"
	"encoding/json"
	"encoding/xml"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func fixtureConfig(t *testing.T, fixture, mode string) Config {
	t.Helper()
	c, e := LoadConfig(filepath.Join("..", "..", fixture), t.TempDir(), Overrides{Media: mode})
	if e != nil {
		t.Fatal(e)
	}
	c.Transcripts = t.TempDir()
	return c
}
func mustBuild(t *testing.T, c Config) *BuildResult {
	t.Helper()
	r, e := Build(c, BuildOptions{Now: time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)})
	if e != nil {
		t.Fatal(e)
	}
	if len(r.Errors) > 0 {
		t.Fatal(r.Errors)
	}
	return r
}
func jsonValue(t *testing.T, path string) any {
	t.Helper()
	b, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var v any
	if e = json.Unmarshal(b, &v); e != nil {
		t.Fatal(e)
	}
	return v
}

// The snapshots were produced by the Python builder, not this implementation.
func TestPythonOutputContract(t *testing.T) {
	c := fixtureConfig(t, "testdata/contracts", "link")
	mustBuild(t, c)
	golden := filepath.Join("..", "..", "testdata", "golden")
	e := filepath.WalkDir(golden, func(path string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(golden, path)
		t.Run(filepath.ToSlash(rel), func(t *testing.T) {
			actual := filepath.Join(c.Output, rel)
			switch filepath.Ext(path) {
			case ".json":
				want, got := jsonValue(t, path), jsonValue(t, actual)
				if filepath.ToSlash(rel) == "data/index.json" {
					delete(got.(map[string]any)["site"].(map[string]any), "built")
				}
				if !reflect.DeepEqual(want, got) {
					w, _ := json.MarshalIndent(want, "", "  ")
					g, _ := json.MarshalIndent(got, "", "  ")
					t.Errorf("output differs from Python\nwant %s\ngot %s", w, g)
				}
			case ".xml":
				want, got := xmlRecords(t, path), xmlRecords(t, actual)
				if !reflect.DeepEqual(want, got) {
					t.Errorf("feed differs\nwant %#v\ngot %#v", want, got)
				}
			default:
				want, e := os.ReadFile(path)
				if e != nil {
					t.Fatal(e)
				}
				got, e := os.ReadFile(actual)
				if e != nil {
					t.Fatal(e)
				}
				if !bytes.Equal(want, got) {
					t.Error("file differs")
				}
			}
		})
		return nil
	})
	if e != nil {
		t.Fatal(e)
	}
}

// Compare expanded XML names and data, ignoring formatting and build time.
func xmlRecords(t *testing.T, path string) []string {
	t.Helper()
	b, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	dec := xml.NewDecoder(bytes.NewReader(b))
	out := []string{}
	skip := false
	for {
		token, e := dec.Token()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		switch tok := token.(type) {
		case xml.StartElement:
			if tok.Name.Local == "lastBuildDate" {
				skip = true
				continue
			}
			attrs := []string{}
			for _, a := range tok.Attr {
				if a.Name.Space == "xmlns" {
					continue
				}
				attrs = append(attrs, a.Name.Space+":"+a.Name.Local+"="+a.Value)
			}
			out = append(out, "<"+tok.Name.Space+":"+tok.Name.Local+" "+strings.Join(attrs, "|"))
		case xml.EndElement:
			if skip {
				skip = false
				continue
			}
			out = append(out, "</"+tok.Name.Space+":"+tok.Name.Local)
		case xml.CharData:
			if !skip && strings.TrimSpace(string(tok)) != "" {
				out = append(out, string(tok))
			}
		}
	}
	return out
}

func TestManifestAndStableRebuild(t *testing.T) {
	c := fixtureConfig(t, "testdata/contracts", "link")
	mustBuild(t, c)
	manifest := jsonValue(t, filepath.Join(c.Output, "data", "manifest.json")).(map[string]any)
	files := manifest["files"].(map[string]any)
	for rel, v := range files {
		b, e := os.ReadFile(filepath.Join(c.Output, "data", rel))
		if e != nil {
			t.Fatal(e)
		}
		entry := v.(map[string]any)
		if entry["hash"] != digest(b, 8) || entry["bytes"] != float64(len(b)) {
			t.Errorf("incorrect manifest entry %s", rel)
		}
	}
	r := mustBuild(t, c)
	if r.Copied != 0 || r.Tagged != 0 {
		t.Errorf("unchanged rebuild placed media: %+v", r)
	}
	again := jsonValue(t, filepath.Join(c.Output, "data", "manifest.json"))
	if !reflect.DeepEqual(manifest, again) {
		t.Error("unchanged build changed manifest")
	}
}

func TestEmptyLibrary(t *testing.T) {
	c, e := LoadConfig(t.TempDir(), t.TempDir(), Overrides{})
	if e != nil {
		t.Fatal(e)
	}
	mustBuild(t, c)
	head := jsonValue(t, filepath.Join(c.Output, "data/index.json")).(map[string]any)
	if head["pages"] != float64(1) || head["total"] != float64(0) {
		t.Fatal(head)
	}
	if got := jsonValue(t, filepath.Join(c.Output, "data/index/0.json")); !reflect.DeepEqual(got, []any{}) {
		t.Fatal(got)
	}
}

func TestDeclaredFingerprintAvoidsReadingAudio(t *testing.T) {
	source := t.TempDir()
	c, e := LoadConfig(source, t.TempDir(), Overrides{Media: "none"})
	if e != nil {
		t.Fatal(e)
	}
	if e = writeFile(filepath.Join(source, "item.yaml"), []byte("title: Cached\nauthor: someone\nprovenance:\n  fingerprint: supplied-key\n")); e != nil {
		t.Fatal(e)
	}
	if e = writeJSON(filepath.Join(c.Transcripts, "supplied-key.json"), object{"text": "Cached words", "model": "test"}); e != nil {
		t.Fatal(e)
	}
	r := mustBuild(t, c)
	if r.Items[0].Transcript != "Cached words" {
		t.Fatal("declared fingerprint did not load transcript")
	}
}

func TestShellEscapesConfigAndFeedsCDATA(t *testing.T) {
	c, e := LoadConfig(t.TempDir(), t.TempDir(), Overrides{})
	if e != nil {
		t.Fatal(e)
	}
	c.Title = `A "title" & <script>bad()</script>`
	c.Description = "A description with \"quotes\" and a newline\nnext"
	mustBuild(t, c)
	manifest := jsonValue(t, filepath.Join(c.Output, "manifest.webmanifest")).(map[string]any)
	if manifest["name"] != c.Title {
		t.Fatal(manifest)
	}
	b, e := os.ReadFile(filepath.Join(c.Output, "index.html"))
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(b), "<script>bad()") {
		t.Fatal("title injected markup")
	}
	i, _ := newItem(object{"title": "Test", "author": "a", "summary": "]]> boundary"}, "")
	i.OutAudio = "media/audio/a/test.mp3"
	feed := buildFeed([]*Item{i}, nil, c, c.Title, c.Description, "feed/all.xml", "", c.BaseURL, time.Now())
	path := makeFile(t, t.TempDir(), "feed.xml", []byte(feed))
	_ = xmlRecords(t, path)
}
