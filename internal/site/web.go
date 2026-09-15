// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"bytes"
	"embed"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

//go:embed web/*
var webFiles embed.FS

func hexColor(s string) [3]uint8 {
	s = strings.TrimLeft(s, "#")
	if len(s) == 3 {
		s = string([]byte{s[0], s[0], s[1], s[1], s[2], s[2]})
	}
	if len(s) != 6 {
		return [3]uint8{190, 58, 82}
	}
	n, e := strconv.ParseUint(s, 16, 24)
	if e != nil {
		return [3]uint8{190, 58, 82}
	}
	return [3]uint8{uint8(n >> 16), uint8(n >> 8), uint8(n)}
}
func spiralIcon(size int, accent string) ([]byte, error) {
	a, bg := hexColor(accent), hexColor("#151013")
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	center := float64(size-1) / 2
	outer := float64(size) * .42
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			dx, dy := float64(x)-center, float64(y)-center
			dist := math.Hypot(dx, dy)
			c := color.NRGBA{bg[0], bg[1], bg[2], 0}
			if dist <= outer {
				phase := dist/outer*3*2*math.Pi - math.Atan2(dy, dx)
				band := (math.Sin(phase) + 1) / 2
				edge := math.Min(1, (outer-dist)/(outer*.12))
				t := band * band * edge
				channel := func(n int) uint8 { return uint8(math.RoundToEven(float64(bg[n]) + (float64(a[n])-float64(bg[n]))*t)) }
				c = color.NRGBA{channel(0), channel(1), channel(2), 255}
			}
			img.SetNRGBA(x, y, c)
		}
	}
	var b bytes.Buffer
	e := png.Encode(&b, img)
	return b.Bytes(), e
}
func writeShell(c Config, force bool, now time.Time) error {
	icon := "icons/icon-192.png"
	if c.Icon != "" {
		if supplied := resolveAsset(c.Icon, "", c); supplied != "" {
			icon = "icons/site" + strings.ToLower(filepath.Ext(supplied))
			if _, e := place(supplied, filepath.Join(c.Output, icon), "copy", force); e != nil {
				return e
			}
		}
	}
	for _, size := range []int{192, 512} {
		path := filepath.Join(c.Output, "icons", fmt.Sprintf("icon-%d.png", size))
		if !isFile(path) {
			b, e := spiralIcon(size, c.ThemeColor)
			if e != nil {
				return e
			}
			if e = writeFile(path, b); e != nil {
				return e
			}
		}
	}
	short := c.Title
	if fields := strings.Fields(c.Title); len(fields) > 0 {
		short = truncate(fields[0], 12)
	}
	subs := []string{"__TITLE__", c.Title, "__SHORT__", short, "__DESCRIPTION__", truncate(strings.ReplaceAll(str(first(c.Description, c.Tagline)), `"`, "'"), 300), "__THEME__", c.ThemeColor, "__BG__", "#151013", "__ICON__", icon, "__BUILD_ID__", strconv.FormatInt(now.Unix(), 10)}
	replacements := func(name string) *strings.Replacer {
		values := append([]string(nil), subs...)
		for n := 1; n < len(values); n += 2 {
			switch name {
			case "index.html":
				values[n] = escapeAttr(values[n])
			case "manifest.webmanifest":
				b, _ := json.Marshal(values[n])
				values[n] = string(b[1 : len(b)-1])
			}
		}
		return strings.NewReplacer(values...)
	}
	for _, name := range []string{"index.html", "manifest.webmanifest", "sw.js", "app.js", "style.css"} {
		b, e := webFiles.ReadFile("web/" + name)
		if e != nil {
			return e
		}
		if name != "app.js" && name != "style.css" {
			b = []byte(replacements(name).Replace(string(b)))
		}
		if e = writeFile(filepath.Join(c.Output, name), b); e != nil {
			return e
		}
	}
	return nil
}
