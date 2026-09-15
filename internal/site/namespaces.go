// SPDX-License-Identifier: GPL-3.0-only
package site

import (
	"fmt"
	"strings"
)

// A tag namespace: the `Kind:` half of a `Kind: Value` tag, and how the site
// presents the section it becomes.
//
// These were compiled in here, in `app.js`, and twice in `style.css`, which
// made adding one a change to this repository rather than to a library. Worse,
// it failed quietly: an unrecognised prefix is filed under content and renders
// as an ordinary tag, so a ninth block resolved perfectly and never became a
// section. A registry may now declare its own; one that declares none keeps
// these eight, because every library written before this did.
type Namespace struct {
	Key     string `json:"key"`
	Prefix  string `json:"prefix"`
	Label   string `json:"label"`
	Spoiler bool   `json:"spoiler,omitempty"`
	Note    string `json:"note,omitempty"`
	Light   string `json:"-"`
	Dark    string `json:"-"`
}

var defaultNamespaces = []Namespace{
	{"voice", "Voice", "Voice", false, "how the speaker presents", "#8a3f86", "#dda3d6"},
	{"audience", "Audience", "Audience", false, "who it speaks to", "#1f6f85", "#6cc2d6"},
	{"induction", "Induction", "Induction", false, "how trance is brought on", "#35619f", "#8fb3e8"},
	{"production", "Production", "Production", false, "how the audio was made", "#4f7042", "#a6c890"},
	{"trigger", "Trigger", "Triggers", true, "cues it installs", "#9c6612", "#e2b459"},
	{"compulsion", "Compulsion", "Compulsions", true, "drives it leaves behind", "#8f4520", "#e2946e"},
	{"cw", "CW", "Content warnings", false, "touched on, not the subject", "#a8323f", "#f28c8c"},
	{"content", "", "Content", false, "what happens in it", "#6b5c63", "#a2919a"},
}

// namespacesOf reads a registry's `namespaces:` list, or answers with the eight.
func namespacesOf(registry object) []Namespace {
	rows, _ := registry["namespaces"].([]any)
	out := []Namespace{}
	for _, v := range rows {
		r := mapping(v)
		key := strings.TrimSpace(str(r["key"]))
		if key == "" {
			continue
		}
		n := Namespace{Key: key,
			Prefix: strings.TrimSpace(str(r["prefix"])),
			Label:  strings.TrimSpace(str(r["label"])),
			Note:   strings.TrimSpace(str(r["note"])),
			Light:  strings.TrimSpace(str(r["colour"])),
			Dark:   strings.TrimSpace(str(r["dark"]))}
		if b, ok := r["spoiler"].(bool); ok {
			n.Spoiler = b
		}
		if n.Label == "" {
			n.Label = strings.ToUpper(key[:1]) + key[1:]
		}
		out = append(out, n)
	}
	if len(out) == 0 {
		return defaultNamespaces
	}
	return out
}

// namespaceCSS writes the custom property each namespace's chips read.
//
// A namespace with no colour of its own falls back to the muted default rather
// than to nothing: an undeclared colour should look unremarkable, not broken.
func namespaceCSS(kinds []Namespace) string {
	var light, dark, rules strings.Builder
	for _, k := range kinds {
		l, d := k.Light, k.Dark
		if l == "" {
			l = "var(--mut)"
		}
		if d == "" {
			d = "var(--mut)"
		}
		fmt.Fprintf(&light, "  --k-%s:%s;\n", k.Key, l)
		fmt.Fprintf(&dark, "  --k-%s:%s;\n", k.Key, d)
		fmt.Fprintf(&rules, ".tag.k-%s{--k:var(--k-%s)}\n", k.Key, k.Key)
	}
	return "/* One hue per tag namespace, from the registry. Generated; edit the\n" +
		"   registry's `namespaces:` list, not this file. */\n" +
		":root{\n" + light.String() + "}\n" +
		"@media(prefers-color-scheme:dark){:root{\n" + dark.String() + "}}\n" +
		":root[data-theme=\"dark\"]{\n" + dark.String() + "}\n" +
		rules.String()
}
