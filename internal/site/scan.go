// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
	"runtime"
	"sync"
	"sync/atomic"
)

type Library struct {
	Authors []*Author
	Items   []*Item
	Errors  []string
}

var skipDirs = words(".git .hypnotica node_modules __pycache__ .venv")

func about(d object) string {
	k := strings.ToLower(strings.TrimSpace(str(d["kind"])))
	for name, aliases := range map[string]string{
		"config":     "config site settings hypnotica",
		"tags":       "tags tag vocabulary registry",
		"transcript": "transcript transcription",
	} {
		if words(aliases)[k] {
			return name
		}
	}
	return ""
}
func looksAuthor(d object, path string) bool {
	k := strings.ToLower(strings.TrimSpace(str(d["kind"])))
	if words("author authors person")[k] {
		return true
	}
	if words("item file episode track")[k] {
		return false
	}
	name := filepath.Base(path)
	return name == "author.yaml" || name == "author.yml" || strings.HasSuffix(name, ".author.yaml") || strings.HasSuffix(name, ".author.yml") || (truth(d["name"]) && !truth(d["title"]) && !truth(d["author"]))
}
func yamlFiles(root string) ([]string, error) {
	out := []string{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.IsDir() {
			if p != root && skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		ext := strings.ToLower(filepath.Ext(p))
		if (ext == ".yaml" || ext == ".yml") && isFile(p) {
			out = append(out, p)
		}
		return nil
	})
	sort.Strings(out)
	return out, err
}
func readDocs(path string) ([]any, error) {
	b, e := os.ReadFile(path)
	if e != nil {
		return nil, e
	}
	dec := yaml.NewDecoder(bytes.NewReader(b))
	docs := []any{}
	for {
		var node yaml.Node
		e = dec.Decode(&node)
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, e
		}
		legacyYAML(&node, map[*yaml.Node]bool{})
		var d any
		if e = node.Decode(&d); e != nil {
			return nil, e
		}
		docs = append(docs, d)
	}
	return docs, nil
}

func LoadDocuments(root string) Library {
	l := Library{Authors: []*Author{}, Items: []*Item{}, Errors: []string{}}
	files, e := yamlFiles(root)
	if e != nil {
		l.Errors = append(l.Errors, e.Error())
		return l
	}
	transcripts := map[string]object{}
	// Parsing is the expensive half and the files know nothing about each other,
	// so it runs across cores -- but in ordered chunks, folded in file order.
	//
	// Order is not cosmetic here: it decides which of two entries sharing an id
	// is reported as the duplicate, and a build whose warnings move about
	// between runs is a build nobody can diff. Chunking also bounds what is held
	// at once, which matters because the transcripts in this tree are large
	// enough that parsing all of them before folding any would cost gigabytes.
	for _, chunk := range chunks(files, 256) {
		parsed := parseAll(chunk)
		for k, path := range chunk {
			if filepath.Dir(path) == root && words("hypnotica.yaml hypnotica.yml tags.yaml tags.yml")[filepath.Base(path)] {
				continue
			}
			rel, _ := filepath.Rel(root, path)
			docs, e := parsed[k].docs, parsed[k].err
			if e != nil {
				l.Errors = append(l.Errors, fmt.Sprintf("%s: invalid YAML - %v", rel, e))
				continue
			}
			for n, doc := range docs {
				if doc == nil {
					continue
				}
				entries, isList := doc.([]any)
				if !isList {
					entries = []any{doc}
				}
				for j, entry := range entries {
					where := rel
					if len(docs) > 1 || isList {
						pos := n
						if isList {
							pos = j
						}
						where += fmt.Sprintf(" [doc %d]", pos+1)
					}
					d, ok := entry.(map[string]any)
					if !ok {
						l.Errors = append(l.Errors, where+": expected a mapping")
						continue
					}
					switch about(d) {
					case "transcript":
						id := strings.TrimSpace(str(d["item"]))
						if id == "" {
							l.Errors = append(l.Errors, where+": transcript names no item")
						} else {
							transcripts[id] = d
						}
						continue
					case "config", "tags":
						continue
					}
					if looksAuthor(d, path) {
						a, e := newAuthor(d, path)
						if e != nil {
							l.Errors = append(l.Errors, where+": "+e.Error())
						} else {
							l.Authors = append(l.Authors, a)
						}
					} else {
						i, e := newItem(d, path)
						if e != nil {
							l.Errors = append(l.Errors, where+": "+e.Error())
						} else {
							l.Items = append(l.Items, i)
						}
					}
				}
			}
		}
	}
	byID := map[string]*Item{}
	for _, i := range l.Items {
		byID[i.ID] = i
	}
	for _, id := range sortedKeys(transcripts) {
		d := transcripts[id]
		i := byID[id]
		if i == nil {
			l.Errors = append(l.Errors, fmt.Sprintf("transcript for unknown item '%s'", id))
			continue
		}
		if i.Transcript == "" {
			i.Transcript = str(d["text"])
			i.Segments = d["segments"]
			i.TranscriptSource = str(first(d["model"], "transcript"))
		}
	}
	return l
}
func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
func isFile(p string) bool { s, e := os.Stat(p); return e == nil && s.Mode().IsRegular() }
func resolveAsset(ref, path string, c Config) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return ""
	}
	if strings.HasPrefix(ref, "~/") {
		if home, e := os.UserHomeDir(); e == nil {
			ref = filepath.Join(home, ref[2:])
		}
	}
	if filepath.IsAbs(ref) {
		if isFile(ref) {
			return ref
		}
		return ""
	}
	bases := []string{}
	if path != "" {
		bases = append(bases, filepath.Dir(path))
	}
	bases = append(bases, c.Assets, c.Source)
	for _, base := range bases {
		p := filepath.Join(base, ref)
		if isFile(p) {
			if real, e := filepath.EvalSymlinks(p); e == nil {
				return absolute(real)
			}
		}
	}
	return ""
}

// legacyYAML preserves PyYAML's unquoted YAML 1.1 scalars and last-key-wins behavior.
func legacyYAML(n *yaml.Node, seen map[*yaml.Node]bool) {
	if n == nil || seen[n] {
		return
	}
	seen[n] = true
	for _, child := range n.Content {
		legacyYAML(child, seen)
	}
	if n.Alias != nil {
		legacyYAML(n.Alias, seen)
	}
	if n.Kind == yaml.ScalarNode && n.Style == 0 && n.Tag == "!!str" {
		switch n.Value {
		case "yes", "Yes", "YES", "on", "On", "ON":
			n.Tag = "!!bool"
			n.Value = "true"
		case "no", "No", "NO", "off", "Off", "OFF":
			n.Tag = "!!bool"
			n.Value = "false"
		}
		if n.Tag == "!!str" && strings.Contains(n.Value, ":") {
			parts := strings.Split(n.Value, ":")
			total, err := strconv.ParseFloat(parts[0], 64)
			valid := err == nil && total != 0
			sign := 1.0
			if total < 0 {
				sign = -1
				total = -total
			}
			for _, p := range parts[1:] {
				v, e := strconv.ParseFloat(p, 64)
				if e != nil || v < 0 || v >= 60 {
					valid = false
					break
				}
				total = total*60 + v
			}
			if valid {
				n.Tag = "!!float"
				n.Value = strconv.FormatFloat(sign*total, 'f', -1, 64)
			}
		}
	}
	if n.Kind == yaml.MappingNode {
		keys := map[string]bool{}
		keep := make([]bool, len(n.Content)/2)
		for j := len(n.Content) - 2; j >= 0; j -= 2 {
			k := n.Content[j].Tag + ":" + n.Content[j].Value
			if !keys[k] {
				keep[j/2] = true
				keys[k] = true
			}
		}
		content := []*yaml.Node{}
		for j, ok := range keep {
			if ok {
				content = append(content, n.Content[j*2], n.Content[j*2+1])
			}
		}
		n.Content = content
	}
}

// chunks slices a list into runs of at most n, preserving order.
func chunks[T any](all []T, n int) [][]T {
	out := [][]T{}
	for i := 0; i < len(all); i += n {
		out = append(out, all[i:min(i+n, len(all))])
	}
	return out
}

type parsedFile struct {
	docs []any
	err  error
}

// parseAll reads and decodes a batch of files at once, answering in the order
// it was asked. Reading YAML is CPU-bound and the files are independent; the
// fold that follows is not, and stays sequential.
func parseAll(paths []string) []parsedFile {
	out := make([]parsedFile, len(paths))
	workers := min(runtime.NumCPU(), len(paths))
	if workers < 1 {
		return out
	}
	var next atomic.Int64
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				i := int(next.Add(1)) - 1
				if i >= len(paths) {
					return
				}
				out[i].docs, out[i].err = readDocs(paths[i])
			}
		}()
	}
	wg.Wait()
	return out
}
