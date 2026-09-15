// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	Source, Output, Assets, Cache, Transcripts             string
	Title, Tagline, Description, BaseURL, ThemeColor, Icon string
	Media                                                  string
	Prune, TagMedia                                        bool
}
type Overrides struct {
	BaseURL, Media   string
	NoMedia, NoPrune bool
}

func absolute(p string) string {
	v, e := filepath.Abs(p)
	if e != nil {
		return p
	}
	return v
}
func rooted(root, p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(root, p)
}
func LoadConfig(source, output string, o Overrides) (Config, error) {
	source = absolute(source)
	d := object{}
	for _, name := range []string{"hypnotica.yaml", "hypnotica.yml"} {
		_, e := os.Stat(filepath.Join(source, name))
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return Config{}, e
		}
		docs, e := readDocs(filepath.Join(source, name))
		if e != nil {
			return Config{}, e
		}
		if len(docs) > 1 {
			return Config{}, fmt.Errorf("configuration must contain one YAML document")
		}
		if len(docs) == 1 && docs[0] != nil {
			var ok bool
			d, ok = docs[0].(map[string]any)
			if !ok {
				return Config{}, fmt.Errorf("configuration must be a mapping")
			}
		}
		break
	}
	site, paths := mapping(d["site"]), mapping(d["paths"])
	get := func(m object, k, fallback string) string {
		if v, ok := m[k]; ok {
			return str(v)
		}
		return fallback
	}
	c := Config{
		Source:      source,
		Output:      absolute(output),
		Assets:      rooted(source, get(paths, "assets", "assets")),
		Cache:       rooted(source, get(paths, "cache", ".hypnotica")),
		Title:       get(site, "title", "Hypnotica"),
		Tagline:     get(site, "tagline", "A library of spoken-audio files."),
		Description: str(site["description"]),
		BaseURL:     strings.TrimRight(str(first(o.BaseURL, site["base_url"], "http://localhost:8080")), "/"),
		ThemeColor:  get(site, "theme_color", "#6633cc"),
		Icon:        str(site["icon"]),
		Media:       strings.ToLower(get(site, "media", "copy")),
		Prune:       true,
		TagMedia:    true,
	}
	if v, ok := site["prune_media"]; ok {
		c.Prune = truth(v)
	}
	if v, ok := site["tag_media"]; ok {
		c.TagMedia = truth(v)
	}
	c.Transcripts = filepath.Join(c.Cache, "transcripts")
	if truth(paths["transcripts"]) {
		c.Transcripts = rooted(source, str(paths["transcripts"]))
	}
	if o.Media != "" {
		c.Media = o.Media
	} else if o.NoMedia {
		c.Media = "none"
	}
	if o.NoPrune {
		c.Prune = false
	}
	if c.Media != "copy" && c.Media != "link" && c.Media != "none" {
		return c, fmt.Errorf("media must be copy, link or none, not %q", c.Media)
	}
	return c, nil
}
