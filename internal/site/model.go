// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

type object = map[string]any

// Item is the normalized content record. Output paths are assigned by Build.
type Item struct {
	ID, Title, Author                                             string
	Date                                                          *time.Time
	Audio, Video, Cover, SourcePath                               string
	Duration                                                      float64
	Tags, Categories, AlsoTitled, Generated                       []string
	Series                                                        any
	SeriesIndex                                                   any
	Summary, Description, Transcript, TranscriptSource, SourceURL string
	Segments                                                      any
	Acoustic                                                      object
	Spoilers                                                      []object
	CoverPrompts                                                  object
	Provenance                                                    object
	Explicit                                                      bool
	Variant                                                       any
	AudioPath, VideoPath, CoverPath, OutAudio, OutVideo, OutCover string
	AudioBytes                                                    any
	AudioMIME                                                     string
}

type Author struct {
	ID, Name, URL, Image, Description, Summary, Synopsis, Language, SourcePath, OutImage string
	Explicit                                                                             bool
	Links, CoverPrompts                                                                  object
	Generated                                                                            []string
	Similar                                                                              []object
}

func str(v any) string {
	if v == nil {
		return ""
	}
	if b, ok := v.(bool); ok {
		if b {
			return "True"
		}
		return "False"
	}
	return fmt.Sprint(v)
}
func mapping(v any) object {
	if m, ok := v.(map[string]any); ok && m != nil {
		return m
	}
	return object{}
}
func truth(v any) bool {
	if v == nil {
		return false
	}
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return x != ""
	case int:
		return x != 0
	case float64:
		return x != 0
	case []any:
		return len(x) > 0
	case []string:
		return len(x) > 0
	case map[string]any:
		return len(x) > 0
	}
	return true
}
func first(values ...any) any {
	for _, v := range values {
		if truth(v) {
			return v
		}
	}
	return nil
}
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func list(v any) []string {
	out := []string{}
	var values []any
	switch x := v.(type) {
	case string:
		for _, s := range strings.Split(x, ",") {
			values = append(values, s)
		}
	case []any:
		values = x
	case []string:
		for _, s := range x {
			values = append(values, s)
		}
	}
	for _, v := range values {
		if s := strings.TrimSpace(str(v)); s != "" {
			out = append(out, s)
		}
	}
	return out
}
func boolean(v any, fallback bool) bool {
	if v == nil {
		return fallback
	}
	s := strings.ToLower(strings.TrimSpace(str(v)))
	return s == "true" || s == "1" || s == "yes" || s == "y" || s == "on"
}
func number(v any) (float64, bool) {
	n, e := strconv.ParseFloat(str(v), 64)
	return n, e == nil && !math.IsNaN(n) && !math.IsInf(n, 0)
}
func slugify(s string) string {
	var b strings.Builder
	for _, r := range norm.NFKD.String(s) {
		if unicode.Is(unicode.Mn, r) {
			continue
		}
		if unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' || r == '-' || unicode.IsSpace(r) {
			b.WriteRune(unicode.ToLower(r))
		}
	}
	out := regexp.MustCompile(`[-\s]+`).ReplaceAllString(strings.TrimSpace(b.String()), "-")
	if out == "" {
		return "untitled"
	}
	return out
}
func date(v any) *time.Time {
	if t, ok := v.(time.Time); ok {
		return &t
	}
	s := strings.TrimSpace(str(v))
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02 15:04:05Z07:00", "2006-01-02 15:04:05", "2006-01-02", "02/01/2006", "01/02/2006", "2006/01/02", "2 January 2006", "January 2, 2006"} {
		if t, e := time.Parse(layout, s); e == nil {
			return &t
		}
	}
	return nil
}
func prompts(v any) object {
	out := object{}
	m := mapping(v)
	for _, k := range []string{"tagged", "natural", "negative"} {
		if s := strings.TrimSpace(str(m[k])); truth(m[k]) && s != "" {
			out[k] = s
		}
	}
	return out
}
func generated(d object) []string {
	out := []string{}
	said := mapping(d["provenance"])["generated"]
	switch said.(type) {
	case []any, []string:
	default:
		return out
	}
	values := list(said)
	for _, k := range []string{"title", "summary", "description", "synopsis", "cover", "image", "tags", "spoilers"} {
		for _, v := range values {
			if k == v {
				out = append(out, k)
				break
			}
		}
	}
	return out
}
func spoilers(v any) []object {
	out := []object{}
	if !truth(v) {
		return out
	}
	values, ok := v.([]any)
	if !ok {
		values = []any{v}
	}
	for _, v := range values {
		m, ok := v.(map[string]any)
		if !ok {
			out = append(out, object{"effect": strings.TrimSpace(str(v))})
			continue
		}
		row := object{}
		for _, k := range strings.Fields("severity disclosure confidence timestamp tagged source source_title trigger effect quote note") {
			if s := strings.TrimSpace(str(m[k])); s != "" {
				row[k] = s
			}
		}
		if len(row) > 0 {
			out = append(out, row)
		}
	}
	return out
}
func newAuthor(d object, path string) (*Author, error) {
	name := str(first(d["name"], d["title"]))
	if name == "" {
		return nil, fmt.Errorf("author needs a 'name'")
	}
	if truth(d["links"]) {
		if _, ok := d["links"].(map[string]any); !ok {
			return nil, fmt.Errorf("author 'links' must be a mapping")
		}
	}
	a := &Author{
		ID:           str(first(d["id"], slugify(name))),
		Name:         name,
		URL:          str(d["url"]),
		Image:        str(d["image"]),
		Description:  Clean(str(d["description"])),
		Summary:      str(d["summary"]),
		Synopsis:     str(d["synopsis"]),
		Language:     str(first(d["language"], "en")),
		Explicit:     boolean(d["explicit"], true),
		SourcePath:   path,
		Links:        object{},
		CoverPrompts: prompts(d["cover_prompts"]),
		Generated:    generated(d),
		Similar:      []object{},
	}
	for k, v := range mapping(d["links"]) {
		a.Links[k] = str(v)
	}
	if rows, ok := d["similar"].([]any); ok {
		for _, v := range rows {
			m := mapping(v)
			score, valid := number(first(m["score"], 0))
			if truth(m["id"]) && valid {
				a.Similar = append(a.Similar, object{
					"id":          str(m["id"]),
					"score":       math.RoundToEven(score*1000) / 1000,
					"same_person": truth(m["same_person"]),
				})
			}
		}
	}
	return a, nil
}
func newItem(d object, path string) (*Item, error) {
	if !truth(d["title"]) {
		return nil, fmt.Errorf("item needs a 'title'")
	}
	if !truth(d["author"]) {
		return nil, fmt.Errorf("item needs an 'author'")
	}
	i := &Item{
		ID:               str(first(d["id"], slugify(str(d["title"])))),
		Title:            str(d["title"]),
		Author:           str(d["author"]),
		Date:             date(first(d["date"], d["published"])),
		Audio:            str(d["audio"]),
		Video:            str(d["video"]),
		Cover:            str(first(d["cover"], d["image"])),
		Tags:             list(d["tags"]),
		Categories:       list(d["categories"]),
		AlsoTitled:       list(d["also_titled"]),
		Generated:        generated(d),
		Summary:          str(d["summary"]),
		Description:      Clean(str(d["description"])),
		Transcript:       str(d["transcript"]),
		TranscriptSource: str(d["transcript_source"]),
		SourceURL:        str(first(d["source_url"], d["url"])),
		Segments:         d["transcript_segments"],
		Acoustic:         mapping(d["acoustic"]),
		Spoilers:         spoilers(d["spoilers"]),
		CoverPrompts:     prompts(d["cover_prompts"]),
		Provenance:       mapping(d["provenance"]),
		Explicit:         boolean(d["explicit"], true),
		Variant:          d["variant"],
		SourcePath:       path,
		AudioMIME:        "audio/mpeg",
	}
	if truth(i.Variant) && !truth(d["id"]) {
		i.ID += "--" + slugify(str(i.Variant))
	}
	series, index := d["series"], d["series_index"]
	if m, ok := series.(map[string]any); ok {
		series = m["name"]
		if v, ok := m["index"]; ok {
			index = v
		} else if v, ok := m["part"]; ok {
			index = v
		}
	}
	if truth(series) {
		i.Series = str(series)
	}
	if text, ok := index.(string); ok {
		if n, e := strconv.Atoi(strings.TrimSpace(text)); e == nil {
			i.SeriesIndex = n
		}
	} else if n, ok := number(index); ok {
		i.SeriesIndex = int(n)
	}
	if s, ok := d["duration"].(string); ok && strings.Contains(s, ":") {
		for _, p := range strings.Split(s, ":") {
			n, ok := number(p)
			if !ok {
				return nil, fmt.Errorf("invalid duration %q", s)
			}
			i.Duration = i.Duration*60 + n
		}
	} else {
		i.Duration, _ = number(d["duration"])
	}
	if d["transcript"] == nil && truth(d["transcript_file"]) {
		if b, e := os.ReadFile(filepath.Join(filepath.Dir(path), str(d["transcript_file"]))); e == nil {
			i.Transcript = string(b)
		}
	}
	if i.Transcript != "" && i.TranscriptSource == "" {
		i.TranscriptSource = "source"
	}
	return i, nil
}
func (i *Item) index() object {
	var day any
	if i.Date != nil {
		day = i.Date.Format("2006-01-02")
	}
	unlisted := 0
	for _, s := range i.Spoilers {
		if s["disclosure"] != "declared" {
			unlisted++
		}
	}
	out := object{
		"id":              i.ID,
		"title":           i.Title,
		"author":          i.Author,
		"date":            day,
		"duration":        math.RoundToEven(i.Duration),
		"tags":            i.Tags,
		"categories":      i.Categories,
		"series":          i.Series,
		"seriesIndex":     i.SeriesIndex,
		"cover":           nullable(i.OutCover),
		"audio":           nullable(i.OutAudio),
		"bytes":           i.AudioBytes,
		"summary":         i.Summary,
		"variant":         i.Variant,
		"hasTranscript":   i.Transcript != "",
		"spoilerCount":    len(i.Spoilers),
		"spoilerUnlisted": unlisted,
	}
	if i.OutVideo != "" {
		out["hasVideo"] = true
	}
	for _, v := range i.Generated {
		if v == "title" {
			out["titleGenerated"] = true
		}
	}
	return out
}
func (i *Item) detail() object {
	out := object{"id": i.ID}
	for k, v := range map[string]string{
		"description":      i.Description,
		"sourceUrl":        i.SourceURL,
		"transcriptSource": i.TranscriptSource,
		"video":            i.OutVideo,
	} {
		if v != "" {
			out[k] = v
		}
	}
	if len(i.Acoustic) > 0 {
		out["acoustic"] = i.Acoustic
	}
	if len(i.CoverPrompts) > 0 {
		out["coverPrompts"] = i.CoverPrompts
	}
	if len(i.Generated) > 0 {
		out["generated"] = i.Generated
	}
	return out
}

var htmlTags = regexp.MustCompile(`<[^>]+>`)

func (i *Item) searchText() string {
	return strings.ToLower(strings.Join(strings.Fields(strings.Join([]string{i.Title, strings.Join(i.AlsoTitled, " "), i.Summary, strings.Join(i.Tags, " "), strings.Join(i.Categories, " "), str(i.Series), htmlTags.ReplaceAllString(i.Description, " ")}, " ")), " "))
}
