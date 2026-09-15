// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"html"
	"regexp"
	"strings"

	htmlparser "golang.org/x/net/html"
)

func words(s string) map[string]bool {
	m := map[string]bool{}
	for _, v := range strings.Fields(s) {
		m[v] = true
	}
	return m
}

var keepTags = words("p br hr em i strong b u s del ins sub sup small mark abbr code pre kbd samp blockquote q cite ul ol li dl dt dd h2 h3 h4 h5 h6 a")
var dropTree = words("script style canvas iframe object embed applet form button input select textarea svg math audio video picture source track map area noscript template head title meta link base frame frameset table")
var blockTags = words("p h2 h3 h4 h5 h6 ul ol li blockquote pre hr dl dt dd")
var safeScheme = regexp.MustCompile(`(?i)^(https?:|mailto:|#|/)`)
var repeatBreak = regexp.MustCompile(`(?:\s*<br>\s*){3,}`)
var lineSpace = regexp.MustCompile(`[ \t]*\n[ \t]*`)
var manyLines = regexp.MustCompile(`\n{3,}`)

func escapeText(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}
func escapeAttr(s string) string {
	return strings.NewReplacer(`"`, "&quot;", "'", "&#x27;").Replace(escapeText(s))
}

// Clean keeps text formatting and safe links, removing resource-loading markup.
// A tokenizer (rather than a DOM repair pass) preserves the legacy text order.
func Clean(s string) string {
	var out strings.Builder
	open := []string{}
	muted := []string{}
	closeTo := func(n int) {
		for len(open) > n {
			tag := open[len(open)-1]
			open = open[:len(open)-1]
			out.WriteString("</" + tag + ">")
		}
	}
	z := htmlparser.NewTokenizer(strings.NewReader(s))
	for {
		kind := z.Next()
		if kind == htmlparser.ErrorToken {
			break
		}
		token := z.Token()
		tag := token.Data
		switch kind {
		case htmlparser.TextToken:
			if len(muted) == 0 {
				out.WriteString(escapeText(token.Data))
			}
		case htmlparser.SelfClosingTagToken:
			if len(muted) == 0 && (tag == "br" || tag == "hr") {
				out.WriteString("<" + tag + ">")
			}
		case htmlparser.StartTagToken:
			if len(muted) > 0 {
				if dropTree[tag] {
					muted = append(muted, tag)
				}
				continue
			}
			if dropTree[tag] {
				muted = append(muted, tag)
				continue
			}
			if !keepTags[tag] {
				continue
			}
			if tag == "br" || tag == "hr" {
				out.WriteString("<" + tag + ">")
				continue
			}
			attrs := ""
			if tag == "a" {
				for _, a := range token.Attr {
					if a.Key == "href" && safeScheme.MatchString(strings.TrimSpace(a.Val)) {
						attrs = ` href="` + escapeAttr(strings.TrimSpace(a.Val)) + `" rel="noreferrer nofollow" target="_blank"`
						break
					}
				}
				if attrs == "" {
					continue
				}
			}
			for n := len(open) - 1; n >= 0; n-- {
				here := open[n]
				if (here == "p" && blockTags[tag]) || (here == "li" && tag == "li") || ((here == "dt" || here == "dd") && (tag == "dt" || tag == "dd")) {
					closeTo(n)
					break
				}
				if blockTags[here] {
					break
				}
			}
			out.WriteString("<" + tag + attrs + ">")
			open = append(open, tag)
		case htmlparser.EndTagToken:
			if len(muted) > 0 {
				if muted[len(muted)-1] == tag {
					muted = muted[:len(muted)-1]
				}
				continue
			}
			for n := len(open) - 1; n >= 0; n-- {
				if open[n] == tag {
					closeTo(n)
					break
				}
			}
		}
	}
	closeTo(0)
	result := out.String()
	for n := 0; n < 3; n++ {
		for _, tag := range []string{"p", "li", "blockquote", "h2", "h3", "h4", "h5", "h6"} {
			result = regexp.MustCompile(`<`+tag+`>(?:\s|\x{00a0}|&nbsp;|<br>)*</`+tag+`>`).ReplaceAllString(result, "")
		}
	}
	result = repeatBreak.ReplaceAllString(result, "<br><br>")
	result = lineSpace.ReplaceAllString(result, "\n")
	return strings.TrimSpace(manyLines.ReplaceAllString(result, "\n\n"))
}
func stripHTML(s string) string {
	s = regexp.MustCompile(`<br\s*/?>`).ReplaceAllString(s, "\n")
	s = regexp.MustCompile(`</(p|div|h[1-6]|li)>`).ReplaceAllString(s, "\n")
	return strings.TrimSpace(manyLines.ReplaceAllString(html.UnescapeString(htmlTags.ReplaceAllString(s, "")), "\n\n"))
}
