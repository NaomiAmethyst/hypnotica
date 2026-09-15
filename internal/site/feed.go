// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func feedURL(base, path string) string {
	s := base + "/" + strings.TrimLeft(path, "/")
	var b strings.Builder
	for _, v := range []byte(s) {
		if (v >= 'a' && v <= 'z') || (v >= 'A' && v <= 'Z') || (v >= '0' && v <= '9') || strings.ContainsRune("-._~:/?&=#", rune(v)) {
			b.WriteByte(v)
		} else {
			fmt.Fprintf(&b, "%%%02X", v)
		}
	}
	return b.String()
}
func cdata(s string) string {
	return "<![CDATA[" + strings.ReplaceAll(s, "]]>", "]]]]><![CDATA[>") + "]]>"
}
func rssDate(t time.Time) string { return t.Format("Mon, 02 Jan 2006 15:04:05 -0700") }
func episode(i *Item, a *Author, base string, now time.Time) string {
	when := now
	if i.Date != nil {
		when = *i.Date
	}
	body := i.Description
	if body == "" {
		body = "<p>" + escapeText(i.Summary) + "</p>"
	}
	if i.Transcript != "" {
		label := "Transcript as supplied with the source"
		if i.TranscriptSource != "source" {
			label = "Automatic transcript (" + escapeText(str(first(i.TranscriptSource, "whisper"))) + ")"
		}
		body += "<hr/><p><strong>Transcript</strong> &mdash; " + label + "</p><pre>" + escapeText(i.Transcript) + "</pre>"
	}
	if len(i.Tags) > 0 {
		body += "<p><em>Tags:</em> " + escapeText(strings.Join(i.Tags, ", ")) + "</p>"
	}
	name := i.Author
	if a != nil {
		name = a.Name
	}
	total := int(i.Duration)
	var b strings.Builder
	b.WriteString("  <item>\n")
	element := func(k, v string) { fmt.Fprintf(&b, "    <%s>%s</%s>\n", k, escapeText(v), k) }
	element("title", i.Title)
	element("link", feedURL(base, "#/item/"+i.ID))
	fmt.Fprintf(&b, "    <guid isPermaLink=\"false\">%s</guid>\n", escapeText("hypnotica:"+i.Author+":"+i.ID))
	element("pubDate", rssDate(when))
	fmt.Fprintf(&b, "    <description>%s</description>\n    <content:encoded>%s</content:encoded>\n    <itunes:summary>%s</itunes:summary>\n", cdata(body), cdata(body), cdata(str(first(i.Summary, stripHTML(i.Description)))))
	element("itunes:author", name)
	element("itunes:duration", fmt.Sprintf("%d:%02d:%02d", total/3600, total%3600/60, total%60))
	element("itunes:explicit", fmt.Sprint(i.Explicit))
	if i.Summary != "" {
		element("itunes:subtitle", truncate(i.Summary, 255))
	}
	if len(i.Tags) > 0 {
		element("itunes:keywords", strings.Join(i.Tags, ", "))
	}
	if i.OutCover != "" {
		fmt.Fprintf(&b, "    <itunes:image href=\"%s\"/>\n", escapeAttr(feedURL(base, i.OutCover)))
	}
	if truth(i.Series) && truth(i.SeriesIndex) {
		element("itunes:episode", str(i.SeriesIndex))
	}
	if len(i.Categories) > 0 {
		element("category", strings.Join(i.Categories, ", "))
	}
	if i.Transcript != "" && i.OutAudio != "" {
		fmt.Fprintf(&b, "    <podcast:transcript url=\"%s\" type=\"text/plain\"/>\n", escapeAttr(feedURL(base, "transcripts/"+i.ID+".txt")))
	}
	if i.OutAudio != "" {
		fmt.Fprintf(&b, "    <enclosure url=\"%s\" length=\"%s\" type=\"%s\"/>\n", escapeAttr(feedURL(base, i.OutAudio)), str(first(i.AudioBytes, 0)), i.AudioMIME)
	}
	b.WriteString("  </item>")
	return b.String()
}
func buildFeed(items []*Item, a *Author, c Config, title, description, selfPath, image, link string, now time.Time) string {
	playable := []*Item{}
	for _, i := range items {
		if i.OutAudio != "" {
			playable = append(playable, i)
		}
	}
	sort.SliceStable(playable, func(i, j int) bool {
		x, y := playable[i].Date, playable[j].Date
		if x == nil {
			return false
		}
		if y == nil {
			return true
		}
		return x.After(*y)
	})
	owner, language, explicit := c.Title, "en", true
	if a != nil {
		owner, language, explicit = a.Name, a.Language, a.Explicit
	}
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>` + "\n" + `<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:atom="http://www.w3.org/2005/Atom">` + "\n<channel>\n")
	fmt.Fprintf(&b, "  <title>%s</title>\n  <link>%s</link>\n  <atom:link href=\"%s\" rel=\"self\" type=\"application/rss+xml\"/>\n  <language>%s</language>\n  <description>%s</description>\n  <itunes:author>%s</itunes:author>\n  <itunes:owner><itunes:name>%s</itunes:name></itunes:owner>\n  <itunes:explicit>%t</itunes:explicit>\n  <itunes:type>episodic</itunes:type>\n  <itunes:category text=\"Arts\"/>\n", escapeText(title), escapeText(link), escapeAttr(feedURL(c.BaseURL, selfPath)), escapeText(language), cdata(description), escapeText(owner), escapeText(owner), explicit)
	if image != "" {
		fmt.Fprintf(&b, "  <itunes:image href=\"%s\"/>\n", escapeAttr(feedURL(c.BaseURL, image)))
	}
	fmt.Fprintf(&b, "  <lastBuildDate>%s</lastBuildDate>\n", rssDate(now))
	for _, i := range playable {
		b.WriteString(episode(i, a, c.BaseURL, now))
		b.WriteByte('\n')
	}
	b.WriteString("</channel>\n</rss>\n")
	return b.String()
}

// writeFeeds records each feed it writes in `claimed`, so a creator who leaves
// the library does not leave a feed behind still being served.
func writeFeeds(items []*Item, authors map[string]*Author, c Config, now time.Time, claimed map[string]bool) error {
	feed := buildFeed(items, nil, c, c.Title, str(first(c.Description, c.Tagline)), "feed/all.xml", c.Icon, c.BaseURL, now)
	claimed["feed/all.xml"] = true
	if e := writeFile(filepath.Join(c.Output, "feed", "all.xml"), []byte(feed)); e != nil {
		return e
	}
	groups := map[string][]*Item{}
	for _, i := range items {
		groups[i.Author] = append(groups[i.Author], i)
	}
	for _, id := range sortedKeys(groups) {
		a := authors[id]
		path := "feed/" + id + ".xml"
		claimed[path] = true
		feed = buildFeed(groups[id], a, c, a.Name, str(first(a.Description, "Audio by "+a.Name+".")), path, str(first(a.OutImage, c.Icon)), str(first(a.URL, c.BaseURL+"/#/author/"+id)), now)
		if e := writeFile(filepath.Join(c.Output, path), []byte(feed)); e != nil {
			return e
		}
	}
	return nil
}
