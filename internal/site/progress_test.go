// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"bytes"
	"strings"
	"testing"
)

/*
A phase counts one thing. Where what it steps over and what it was given as a

	total are not the same thing -- an asset slot against a recording, say -- the
	figure runs past its own total on a terminal and says nothing at all in a log,
	which is how "placing media 10890/9730" got as far as it did.
*/
func TestPhaseSaysWhenTheCountAndTheTotalDisagree(t *testing.T) {
	for _, c := range []struct {
		name  string
		steps int
		total int
		want  string
	}{
		{"matched", 4, 4, ""},
		{"ran past its total", 12, 4, "[counted 12 of 4]"},
		{"stopped short", 2, 4, "[counted 2 of 4]"},
		{"no total to disagree with", 7, 0, ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			var log bytes.Buffer
			p := newReporter(&log).phase("placing media", c.total)
			for i := 0; i < c.steps; i++ {
				p.step()
			}
			p.finish("media (copy)")
			out := log.String()
			if c.want == "" {
				if strings.Contains(out, "counted") {
					t.Fatalf("a phase that added up complained anyway: %q", out)
				}
				return
			}
			if !strings.Contains(out, c.want) {
				t.Fatalf("wanted %q in %q", c.want, out)
			}
		})
	}
}

// The one the bug was in: three asset slots per recording, one step per
// recording, and a total that is a count of recordings.
func TestBuildCountsMediaByRecording(t *testing.T) {
	dir := t.TempDir()
	c, e := LoadConfig("../../tests/fixture", dir, Overrides{Media: "copy"})
	if e != nil {
		t.Skip("fixture not available")
	}
	var log bytes.Buffer
	r, e := Build(c, BuildOptions{Log: &log})
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(log.String(), "counted") {
		t.Fatalf("a phase counted something other than what it was given:\n%s", log.String())
	}
	if len(r.Items) == 0 {
		t.Fatal("the fixture built nothing")
	}
}
