// SPDX-License-Identifier: GPL-3.0-only
package site

import (
	"strings"
	"testing"
)

func TestARegistryDeclaringNoNamespacesKeepsTheEight(t *testing.T) {
	got := namespacesOf(object{"content": object{"Rain": "Rain."}})
	if len(got) != len(defaultNamespaces) || got[0].Key != "voice" {
		t.Fatal("a registry written before this feature lost its namespaces:", got)
	}
	if namespacesOf(nil)[7].Key != "content" {
		t.Fatal("a missing registry should still answer with the eight")
	}
}

func TestARegistryMayDeclareItsOwnNamespaces(t *testing.T) {
	got := namespacesOf(object{"namespaces": []any{
		object{"key": "setting", "prefix": "Setting", "label": "Settings",
			"note": "where it happens", "colour": "#445566", "dark": "#99aabb"},
		object{"key": "warning", "prefix": "Warning", "spoiler": true},
		object{"key": "subject"},
		object{"prefix": "Nameless"}, // no key: not a namespace
	}})
	if len(got) != 3 {
		t.Fatal("expected three usable namespaces:", got)
	}
	if got[0].Label != "Settings" || got[0].Note != "where it happens" || got[0].Light != "#445566" {
		t.Fatal("declared fields did not survive:", got[0])
	}
	// A label nobody wrote is the key, capitalised -- not blank.
	if got[1].Label != "Warning" || !got[1].Spoiler {
		t.Fatal("label default or spoiler flag wrong:", got[1])
	}
	if got[2].Prefix != "" || got[2].Label != "Subject" {
		t.Fatal("the unprefixed namespace is how bare tags find a home:", got[2])
	}
}

func TestNamespaceCSSCoversEveryNamespaceInBothThemes(t *testing.T) {
	css := namespaceCSS([]Namespace{
		{Key: "setting", Prefix: "Setting", Label: "Settings", Light: "#445566", Dark: "#99aabb"},
		{Key: "subject", Label: "Subject"},
	})
	for _, want := range []string{
		"--k-setting:#445566", "--k-setting:#99aabb",
		".tag.k-setting{--k:var(--k-setting)}", ".tag.k-subject{--k:var(--k-subject)}",
		"prefers-color-scheme:dark", `:root[data-theme="dark"]`,
	} {
		if !strings.Contains(css, want) {
			t.Fatalf("generated CSS is missing %q:\n%s", want, css)
		}
	}
	// A namespace with no colour of its own should look unremarkable, not broken.
	if !strings.Contains(css, "--k-subject:var(--mut)") {
		t.Fatal("an undeclared colour should fall back to the muted default:\n" + css)
	}
}
