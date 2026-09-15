// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import "testing"

func TestSanitise(t *testing.T) {
	for _, tc := range [][2]string{
		{`<figure class="wp"><img src="https://elsewhere/a.png"></figure><p class="wp">A <em>walk</em>.</p>`, `<p>A <em>walk</em>.</p>`},
		{`<div><span>kept</span></div>`, `kept`},
		{`<figure><img src='http://x/y.png'><figcaption>a caption</figcaption></figure>`, `a caption`},
		{`<div id="player"><canvas></canvas><button>Play</button></div><p>Words.</p>`, `<p>Words.</p>`},
		{`<p><a href="https://example.com/x" class="btn" onclick="x()">link</a></p>`, `<p><a href="https://example.com/x" rel="noreferrer nofollow" target="_blank">link</a></p>`},
		{`<p><a href="javascript:alert(1)">text</a></p>`, `<p>text</p>`},
		{`<p><a href="data:text/html,x">text</a></p>`, `<p>text</p>`},
		{`<p><a href="&#106;avascript:alert(1)">text</a></p>`, `<p>text</p>`},
		{`<ul><li>one<li>two</ul>`, `<ul><li>one</li><li>two</li></ul>`},
		{`<p>one <em>two<p>three`, `<p>one <em>two</em></p><p>three</p>`},
		{`<ul><li><p>a</p><p>b</p></li></ul>`, `<ul><li><p>a</p><p>b</p></li></ul>`},
		{`<p>5 < 6 & 7 > 2</p>`, `<p>5 &lt; 6 &amp; 7 &gt; 2</p>`},
		{`<p><img src="x"></p><p>yes</p>`, `<p>yes</p>`},
		{`a<br><br><br><br>b`, `a<br><br>b`},
		{`<p/>text`, `text`},
		{`no markup at all`, `no markup at all`},
		{``, ``},
	} {
		t.Run(tc[0], func(t *testing.T) {
			if got := Clean(tc[0]); got != tc[1] {
				t.Errorf("got %q, want %q", got, tc[1])
			}
		})
	}
	for _, s := range []string{`<script>alert(1)</script>`, `<iframe src="https://elsewhere/"></iframe>`, `<canvas></canvas>`, `<audio src="x"></audio>`, `<svg><use href="https://elsewhere/s.svg#i"/></svg>`, `<video poster="x"></video>`, `<table><tr><td>widget</td></tr></table>`} {
		if got := Clean(s + "<p>after</p>"); got != "<p>after</p>" {
			t.Errorf("%s: %q", s, got)
		}
	}
}

func FuzzClean(f *testing.F) {
	for _, s := range []string{"<p>hello</p>", "<script>alert(1)</script>", "<a href='javascript:x'>x</a>", "<svg><script>x</script></svg>"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) { _ = Clean(s) })
}
