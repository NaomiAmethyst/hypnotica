// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

const DataSchema = 1
const ItemsPerPage = 250

type BuildResult struct {
	Items            []*Item
	Authors          map[string]*Author
	Errors, Warnings []string
	Copied, Tagged   int
}
type BuildOptions struct {
	Force bool
	Log   io.Writer
	Now   time.Time
}

func writeJSON(path string, v any) error {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		return err
	}
	return writeFile(path, bytes.TrimSuffix(b.Bytes(), []byte{'\n'}))
}
func writeFile(path string, b []byte) error {
	if e := os.MkdirAll(filepath.Dir(path), 0755); e != nil {
		return e
	}
	return os.WriteFile(path, b, 0644)
}
func readObject(path string) object {
	b, e := os.ReadFile(path)
	if e != nil {
		return nil
	}
	var m object
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	return m
}

func Build(c Config, o BuildOptions) (*BuildResult, error) {
	now := o.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	rep := newReporter(o.Log)
	say := rep.say
	scan := rep.phase("scanning "+c.Source, 0)
	lib := LoadDocuments(c.Source)
	scan.add(len(lib.Items) + len(lib.Authors))
	scan.finish("scanned %s", c.Source)
	r := &BuildResult{Authors: map[string]*Author{}, Items: []*Item{}, Errors: lib.Errors, Warnings: []string{}}
	for _, a := range lib.Authors {
		if r.Authors[a.ID] != nil {
			r.Warnings = append(r.Warnings, fmt.Sprintf("duplicate author id '%s'", a.ID))
		}
		r.Authors[a.ID] = a
	}
	seen := map[string]*Item{}
	for _, i := range lib.Items {
		if old := seen[i.ID]; old != nil {
			r.Errors = append(r.Errors, fmt.Sprintf("duplicate item id '%s' (%s and %s)", i.ID, filepath.Base(i.SourcePath), filepath.Base(old.SourcePath)))
			continue
		}
		seen[i.ID] = i
		r.Items = append(r.Items, i)
		if r.Authors[i.Author] == nil {
			a, _ := newAuthor(object{"id": i.Author, "name": i.Author}, "")
			r.Authors[i.Author] = a
			r.Warnings = append(r.Warnings, fmt.Sprintf("no author file for '%s' - using the id as a name", i.Author))
		}
	}
	say("  %d items, %d authors", len(r.Items), len(r.Authors))
	// Every picture this build will emit, hashed up front and in parallel, so
	// that the URL each one is served from says which version it is.
	stamp := loadStamps(c.Cache)
	art := []string{}
	for _, i := range r.Items {
		if p := resolveAsset(i.Cover, i.SourcePath, c); p != "" {
			art = append(art, p)
		}
	}
	for _, id := range sortedKeys(r.Authors) {
		if p := resolveAsset(r.Authors[id].Image, r.Authors[id].SourcePath, c); p != "" {
			art = append(art, p)
		}
	}
	if len(art) > 0 {
		ph := rep.phase("stamping artwork", len(art))
		stamp.warm(art, ph)
		ph.finish("artwork: %d picture(s) stamped", len(art))
	}
	for _, i := range r.Items {
		i.AudioPath = resolveAsset(i.Audio, i.SourcePath, c)
		i.VideoPath = resolveAsset(i.Video, i.SourcePath, c)
		i.CoverPath = resolveAsset(i.Cover, i.SourcePath, c)
		for _, v := range [][3]string{{"audio", i.Audio, i.AudioPath}, {"cover", i.Cover, i.CoverPath}} {
			if v[1] != "" && v[2] == "" {
				r.Warnings = append(r.Warnings, fmt.Sprintf("%s: %s not found (%s)", i.ID, v[0], v[1]))
			}
		}
		if i.AudioPath != "" && i.Duration == 0 {
			i.Duration = probe(i.AudioPath)
		}
	}
	if e := os.MkdirAll(c.Transcripts, 0755); e != nil {
		return r, e
	}
	for _, i := range r.Items {
		if i.Transcript != "" {
			continue
		}
		fingerprint := str(i.Provenance["fingerprint"])
		if fingerprint == "" && i.AudioPath != "" {
			var e error
			fingerprint, e = AudioFingerprint(i.AudioPath)
			if e != nil {
				return r, e
			}
		}
		if fingerprint == "" {
			continue
		}
		hit := readObject(filepath.Join(c.Transcripts, fingerprint+".json"))
		if len(hit) > 0 {
			i.Transcript = str(hit["text"])
			i.Segments = hit["segments"]
			i.TranscriptSource = str(first(hit["model"], "whisper"))
		}
	}
	claimed := map[string]bool{}
	mp := rep.phase("placing media", len(r.Items))
	claim := func(stem, ref, found string) {
		for _, p := range claims(stem, ref, found) {
			claimed[p] = true
		}
	}
	for _, i := range r.Items {
		author := slugify(i.Author)
		for _, asset := range []struct {
			kind, ref, path string
			out             *string
		}{{"cover", i.Cover, i.CoverPath, &i.OutCover}, {"audio", i.Audio, i.AudioPath, &i.OutAudio}, {"video", i.Video, i.VideoPath, &i.OutVideo}} {
			stem := "media/" + asset.kind + "/" + author + "/" + i.ID
			claim(stem, asset.ref, asset.path)
			if asset.path == "" {
				continue
			}
			rel := stem + outputExt(asset.ref, asset.path)
			target := filepath.Join(c.Output, filepath.FromSlash(rel))
			fresh, e := place(asset.path, target, c.Media, o.Force)
			if e != nil {
				return r, fmt.Errorf("place %s: %w", rel, e)
			}
			// The path on disk stays clean; the version rides on the URL, and
			// only for pictures. Audio is large, changes almost never, and a
			// new query string would throw away somebody's offline copy of it.
			if asset.kind == "cover" {
				*asset.out = versioned(rel, stamp.of(asset.path))
			} else {
				*asset.out = rel
			}
			if asset.kind == "audio" {
				if fresh {
					r.Copied++
				}
				ext := outputExt(asset.ref, asset.path)
				if c.Media == "copy" && c.TagMedia && ext == ".mp3" && (fresh || o.Force) {
					if e = tagMP3(target, i, r.Authors[i.Author], i.CoverPath); e != nil {
						r.Warnings = append(r.Warnings, fmt.Sprintf("%s: tagging failed - %v", i.ID, e))
					} else {
						r.Tagged++
					}
				}
				if mime := mimeTypes[ext]; mime != "" {
					i.AudioMIME = mime
				}
				if info, e := os.Stat(target); e == nil {
					i.AudioBytes = info.Size()
				} else if info, e := os.Stat(asset.path); e == nil {
					i.AudioBytes = info.Size()
				}
			}
		}
		// One step per recording, not per asset slot: the total is a count of
		// items, and stepping inside the loop over cover, audio and video ran
		// it to three times that -- mostly over slots no item had anything in.
		mp.step()
	}
	if c.Media != "none" {
		mp.finish("media (%s)", c.Media)
	}
	for _, id := range sortedKeys(r.Authors) {
		a := r.Authors[id]
		found := resolveAsset(a.Image, a.SourcePath, c)
		stem := "media/author/" + slugify(a.ID)
		claim(stem, a.Image, found)
		if found != "" {
			rel := stem + outputExt(a.Image, found)
			if _, e := place(found, filepath.Join(c.Output, rel), c.Media, o.Force); e != nil {
				return r, e
			}
			a.OutImage = versioned(rel, stamp.of(found))
		}
	}
	flat := map[string]string{}
	spoilerData := object{}
	withText := []*Item{}
	for _, i := range r.Items {
		if i.Transcript != "" {
			flat[i.ID] = i.Transcript
			claimed["transcripts/"+i.ID+".json"] = true
			claimed["transcripts/"+i.ID+".txt"] = true
			withText = append(withText, i)
		}
		if len(i.Spoilers) > 0 {
			spoilerData[i.ID] = i.Spoilers
		}
	}
	// Two files per transcript, and on this library that is nineteen thousand
	// writes that wait on each other for no reason: nothing here reads what
	// another one wrote. The bookkeeping above stays sequential because the maps
	// it fills are shared; only the writing fans out.
	tp := rep.phase("writing transcripts", len(withText))
	if e := inParallel(withText, func(i *Item) error {
		segments := i.Segments
		if !truth(segments) {
			segments = []any{}
		}
		if e := writeJSON(filepath.Join(c.Output, "transcripts", i.ID+".json"), object{"id": i.ID, "source": nullable(i.TranscriptSource), "text": i.Transcript, "segments": segments}); e != nil {
			return e
		}
		tp.step()
		return writeFile(filepath.Join(c.Output, "transcripts", i.ID+".txt"), []byte(i.Transcript))
	}); e != nil {
		return r, e
	}
	tp.finish("%d transcript(s) written", len(flat))
	wp := rep.phase("building the word index", len(flat))
	if e := writeWordIndex(filepath.Join(c.Output, "data", "words"), flat); e != nil {
		return r, e
	}
	wp.add(len(flat))
	wp.finish("word index over %d transcript(s)", len(flat))
	if e := writeJSON(filepath.Join(c.Output, "data", "spoilers.json"), spoilerData); e != nil {
		return r, e
	}
	sort.SliceStable(r.Items, func(a, b int) bool {
		x, y := r.Items[a], r.Items[b]
		xs, ys := "", ""
		if x.Date != nil {
			xs = x.Date.Format(time.RFC3339Nano)
		}
		if y.Date != nil {
			ys = y.Date.Format(time.RFC3339Nano)
		}
		if xs != ys {
			return xs > ys
		}
		return x.Title > y.Title
	})
	authorList := make([]*Author, 0, len(r.Authors))
	for _, id := range sortedKeys(r.Authors) {
		authorList = append(authorList, r.Authors[id])
	}
	sort.SliceStable(authorList, func(i, j int) bool { return strings.ToLower(authorList[i].Name) < strings.ToLower(authorList[j].Name) })
	authors := []object{}
	for _, a := range authorList {
		summary := a.Summary
		if summary == "" {
			summary = truncate(stripHTML(a.Description), 200)
		}
		authors = append(authors, object{
			"id":          a.ID,
			"name":        a.Name,
			"url":         nullable(a.URL),
			"image":       nullable(a.OutImage),
			"summary":     summary,
			"description": a.Description,
			"synopsis":    a.Synopsis,
			"generated":   a.Generated,
			"links":       a.Links,
			"feed":        "feed/" + a.ID + ".xml",
		})
	}
	head := object{"site": object{
		"title":       c.Title,
		"tagline":     c.Tagline,
		"description": c.Description,
		"baseUrl":     c.BaseURL,
		"built":       now.Format("2006-01-02T15:04:05Z"),
	}, "authors": authors}
	indexes := []object{}
	details := map[string]object{}
	search := object{}
	tagTable, catTable := []string{}, []string{}
	tagIDs, catIDs := map[string]int{}, map[string]int{}
	intern := func(values []string, table *[]string, ids map[string]int) []int {
		out := []int{}
		for _, v := range values {
			n, ok := ids[v]
			if !ok {
				n = len(*table)
				ids[v] = n
				*table = append(*table, v)
			}
			out = append(out, n)
		}
		return out
	}
	for _, i := range r.Items {
		entry := i.index()
		entry["tags"] = intern(i.Tags, &tagTable, tagIDs)
		entry["categories"] = intern(i.Categories, &catTable, catIDs)
		indexes = append(indexes, entry)
		if details[i.Author] == nil {
			details[i.Author] = object{}
		}
		details[i.Author][i.ID] = i.detail()
		search[i.ID] = i.searchText()
	}
	shards := sortedKeys(details)
	for _, id := range shards {
		a := r.Authors[id]
		side := object{}
		if len(a.CoverPrompts) > 0 {
			side["coverPrompts"] = a.CoverPrompts
		}
		if len(a.Similar) > 0 {
			side["similar"] = a.Similar
		}
		if len(side) > 0 {
			details[id]["_author"] = side
		}
		claimed["data/detail/"+slugify(id)+".json"] = true
	}
	dp := rep.phase("writing detail shards", len(shards))
	if e := inParallel(shards, func(id string) error {
		defer dp.step()
		return writeJSON(filepath.Join(c.Output, "data", "detail", slugify(id)+".json"), details[id])
	}); e != nil {
		return r, e
	}
	dp.finish("detail: %d shard(s)", len(shards))
	head["tagTable"] = tagTable
	head["catTable"] = catTable
	registry := readRegistry(c.Source)
	kinds := namespacesOf(registry)
	head["tagKinds"] = kinds
	if e := writeFile(filepath.Join(c.Output, "namespaces.css"), []byte(namespaceCSS(kinds))); e != nil {
		return r, e
	}
	if glossary := tagGlossary(registry, r.Items); len(glossary) > 0 {
		head["tagInfo"] = glossary
		say("→ tags: %d of the library's %d tags carry a description", len(glossary), len(tagTable))
	}
	ip := rep.phase("writing the index", 0)
	if e := writeJSON(filepath.Join(c.Output, "data", "search.json"), search); e != nil {
		return r, e
	}
	pageDir := filepath.Join(c.Output, "data", "index")
	if e := os.RemoveAll(pageDir); e != nil {
		return r, e
	}
	pages := (len(indexes) + ItemsPerPage - 1) / ItemsPerPage
	if pages == 0 {
		pages = 1
	}
	for n := 0; n < pages; n++ {
		end := (n + 1) * ItemsPerPage
		if end > len(indexes) {
			end = len(indexes)
		}
		if e := writeJSON(filepath.Join(pageDir, fmt.Sprintf("%d.json", n)), indexes[n*ItemsPerPage:end]); e != nil {
			return r, e
		}
	}
	head["pages"] = pages
	head["total"] = len(indexes)
	head["pageSize"] = ItemsPerPage
	ip.add(len(indexes))
	ip.finish("index: %d item(s) in %d page(s)", len(indexes), pages)
	if e := writeJSON(filepath.Join(c.Output, "data", "index.json"), head); e != nil {
		return r, e
	}
	fp := rep.phase("writing feeds", len(r.Authors)+1)
	if e := writeFeeds(r.Items, r.Authors, c, now, claimed); e != nil {
		return r, e
	}
	fp.add(len(r.Authors) + 1)
	fp.finish("feeds: %d", len(r.Authors)+1)
	// Last, with everything written: the build owns these trees, and what it
	// did not put there this time does not belong there. `data/index` is absent
	// because it is rebuilt wholesale, and `data/words` because a shard name is
	// a hash of the vocabulary rather than of anything the library declares.
	pp := rep.phase("pruning", 0)
	if c.Prune {
		total := 0
		for _, sub := range []string{"media", "data/detail", "feed", "transcripts"} {
			gone, _, e := prune(c.Output, sub, claimed)
			if e != nil {
				return r, e
			}
			total += gone
		}
		pp.add(total)
		if total > 0 {
			pp.finish("pruned %d file(s) the library no longer claims", total)
		}
	}
	if e := writeShell(c, o.Force, now); e != nil {
		return r, e
	}
	if e := writeManifest(filepath.Join(c.Output, "data"), now); e != nil {
		return r, e
	}
	if e := stamp.save(); e != nil {
		r.Warnings = append(r.Warnings, fmt.Sprintf("could not keep the artwork stamps: %v", e))
	}
	say("→ built %d items into %s in %s (%d audio placed, %d tagged)",
		len(r.Items), c.Output, short(time.Since(rep.start)), r.Copied, r.Tagged)
	return r, nil
}
func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}

var wordPattern = regexp.MustCompile(`[a-z0-9']+`)

func writeWordIndex(root string, transcripts map[string]string) error {
	if e := os.RemoveAll(root); e != nil {
		return e
	}
	ids := sortedKeys(transcripts)
	if e := writeJSON(filepath.Join(root, "_ids.json"), ids); e != nil {
		return e
	}
	// Tokenising ten thousand transcripts is the slowest thing a build does and
	// none of it depends on anything else, so the corpus is cut into contiguous
	// runs and each one indexed on its own core.
	//
	// Contiguous is the whole trick. Every posting list is a list of document
	// numbers in ascending order, and merging the runs back in the order they
	// were cut keeps it that way -- which is why the ranges are ranges rather
	// than a work queue handing out documents as workers come free.
	runs := chunks(ids, max(1, (len(ids)+runtime.NumCPU()-1)/max(1, runtime.NumCPU())))
	partial := make([]map[string]map[string][]int, len(runs))
	base := 0
	offsets := make([]int, len(runs))
	for i, run := range runs {
		offsets[i] = base
		base += len(run)
	}
	var wg sync.WaitGroup
	for i, run := range runs {
		wg.Add(1)
		go func(i, from int, run []string) {
			defer wg.Done()
			out := map[string]map[string][]int{}
			seen := map[string]bool{}
			for k, id := range run {
				clear(seen)
				for _, word := range wordPattern.FindAllString(strings.ToLower(transcripts[id]), -1) {
					if len(word) <= 2 || seen[word] {
						continue
					}
					seen[word] = true
					name := word[:2]
					if strings.Contains(name, "'") {
						name = "_other"
					}
					if out[name] == nil {
						out[name] = map[string][]int{}
					}
					out[name][word] = append(out[name][word], from+k)
				}
			}
			partial[i] = out
		}(i, offsets[i], run)
	}
	wg.Wait()
	shards := map[string]map[string][]int{}
	for _, part := range partial {
		for name, words := range part {
			if shards[name] == nil {
				shards[name] = map[string][]int{}
			}
			for word, hits := range words {
				shards[name][word] = append(shards[name][word], hits...)
			}
		}
	}
	names := sortedKeys(shards)
	return inParallel(names, func(name string) error {
		return writeJSON(filepath.Join(root, name+".json"), shards[name])
	})
}

// readRegistry finds the tag registry: by name first, then by what a document
// says it is, because a tree may keep it anywhere.
func readRegistry(root string) object {
	for _, name := range []string{"tags.yaml", "tags.yml"} {
		path := filepath.Join(root, name)
		if isFile(path) {
			docs, e := readDocs(path)
			if e == nil && len(docs) == 1 {
				return mapping(docs[0])
			}
			break
		}
	}
	files, _ := yamlFiles(root)
	for _, path := range files {
		docs, e := readDocs(path)
		if e == nil && len(docs) == 1 && about(mapping(docs[0])) == "tags" {
			return mapping(docs[0])
		}
	}
	return nil
}

func tagGlossary(registry object, items []*Item) object {
	meanings := object{}
	prefixes := map[string]string{}
	for _, k := range namespacesOf(registry) {
		if k.Prefix != "" {
			prefixes[k.Key] = k.Prefix
		}
	}
	for kind, value := range registry {
		for name, value := range mapping(value) {
			meaning, ok := value.(string)
			if !ok || name == "_about" {
				continue
			}
			full := name
			if prefix := prefixes[strings.ToLower(kind)]; prefix != "" {
				full = prefix + ": " + name
			}
			meanings[full] = strings.TrimSpace(meaning)
		}
	}
	out := object{}
	for _, i := range items {
		for _, tag := range i.Tags {
			if meaning, ok := meanings[tag]; ok {
				out[tag] = meaning
			}
		}
	}
	return out
}
func writeManifest(root string, now time.Time) error {
	files := object{}
	e := filepath.WalkDir(root, func(path string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.IsDir() || filepath.Ext(path) != ".json" || d.Name() == "manifest.json" {
			return nil
		}
		b, e := os.ReadFile(path)
		if e != nil {
			return e
		}
		rel, _ := filepath.Rel(root, path)
		files[filepath.ToSlash(rel)] = object{"hash": digest(b, 8), "bytes": len(b)}
		return nil
	})
	if e != nil {
		return e
	}
	return writeJSON(filepath.Join(root, "manifest.json"), object{
		"apiVersion": "hypnotica/v1",
		"kind":       "Manifest",
		"schema":     DataSchema,
		"built":      now.Format("2006-01-02T15:04:05Z"),
		"files":      files,
	})
}
