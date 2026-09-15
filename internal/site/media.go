// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"

	id3 "github.com/bogem/id3v2/v2"
	"go.senan.xyz/taglib"
	"golang.org/x/crypto/blake2b"
)

var mimeTypes = map[string]string{
	".mp3":  "audio/mpeg",
	".m4a":  "audio/mp4",
	".m4b":  "audio/mp4",
	".wav":  "audio/wav",
	".flac": "audio/flac",
	".ogg":  "audio/ogg",
	".opus": "audio/opus",
	".mp4":  "video/mp4",
	".webm": "video/webm",
	".mkv":  "video/x-matroska",
	".mov":  "video/quicktime",
}

func outputExt(ref, found string) string {
	ext := filepath.Ext(ref)
	if ext == "" {
		ext = filepath.Ext(found)
	}
	return strings.ToLower(ext)
}
func claims(stem, ref, found string) []string {
	if ref == "" && found == "" {
		return nil
	}
	out := []string{stem + outputExt(ref, found)}
	if filepath.Ext(ref) == "" {
		out = append(out, stem)
		if found != "" {
			out = append(out, stem+strings.ToLower(filepath.Ext(found)))
		}
	}
	return out
}

// place never writes through an output symlink: sources are always read-only.
func place(src, dst, mode string, force bool) (bool, error) {
	if mode == "none" {
		return false, nil
	}
	if e := os.MkdirAll(filepath.Dir(dst), 0755); e != nil {
		return false, e
	}
	if mode == "link" {
		if current, e := os.Readlink(dst); e == nil && !force && current == src {
			return false, nil
		}
		if _, e := os.Lstat(dst); e == nil {
			if e = os.Remove(dst); e != nil {
				return false, e
			}
		}
		return true, os.Symlink(src, dst)
	}
	s, e := os.Stat(src)
	if e != nil {
		return false, e
	}
	if d, e := os.Lstat(dst); e == nil {
		if d.Mode()&os.ModeSymlink == 0 && !force && !d.ModTime().Before(s.ModTime()) {
			return false, nil
		}
	}
	in, e := os.Open(src)
	if e != nil {
		return false, e
	}
	defer in.Close()
	out, e := os.CreateTemp(filepath.Dir(dst), ".hypnotica-media-*")
	if e != nil {
		return false, e
	}
	name := out.Name()
	defer os.Remove(name)
	if _, e = io.Copy(out, in); e != nil {
		out.Close()
		return false, e
	}
	if e = out.Chmod(s.Mode().Perm()); e != nil {
		out.Close()
		return false, e
	}
	if e = out.Close(); e != nil {
		return false, e
	}
	if e = os.Chtimes(name, s.ModTime(), s.ModTime()); e != nil {
		return false, e
	}
	return true, os.Rename(name, dst)
}

// prune removes what a managed output subtree holds and the library no longer
// claims. The build owns everything under these directories, and a build that
// only ever adds to them accumulates: a creator who is renamed, merged away or
// deleted leaves a detail shard and a feed behind for ever, still served, still
// linkable. One such shard here was four days stale and still answering for an
// id that had been folded into another item.
//
// `claimed` is what the library declares, never what resolved on disk -- the
// two diverge exactly when a prune would do the most damage. A dangling symlink
// goes whatever the claim says, because it serves nothing either way.
func prune(root, sub string, claimed map[string]bool) (int, int64, error) {
	media := filepath.Join(root, filepath.FromSlash(sub))
	if _, e := os.Lstat(media); os.IsNotExist(e) {
		return 0, 0, nil
	}
	removed := 0
	var freed int64
	dirs := []string{}
	err := filepath.WalkDir(media, func(path string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.IsDir() {
			dirs = append(dirs, path)
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		linked := d.Type()&os.ModeSymlink != 0
		_, statErr := os.Stat(path)
		dangling := linked && os.IsNotExist(statErr)
		if !dangling && claimed[filepath.ToSlash(rel)] {
			return nil
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		if e = os.Remove(path); e != nil {
			return e
		}
		removed++
		if !linked {
			freed += info.Size()
		}
		return nil
	})
	for n := len(dirs) - 1; n >= 0; n-- {
		if dirs[n] != media {
			_ = os.Remove(dirs[n])
		}
	}
	return removed, freed, err
}

func probe(path string) float64 {
	p, e := taglib.ReadProperties(path)
	if e != nil {
		return 0
	}
	return math.RoundToEven(p.Length.Seconds()*10) / 10
}

// AudioFingerprint matches Inductor's BLAKE2b-128 cache keys, excluding ID3.
func AudioFingerprint(path string) (string, error) {
	f, e := os.Open(path)
	if e != nil {
		return "", e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil {
		return "", e
	}
	start, end := int64(0), info.Size()
	head := make([]byte, 10)
	n, _ := f.ReadAt(head, 0)
	if n == 10 && string(head[:3]) == "ID3" {
		size := int64(0)
		for _, b := range head[6:10] {
			size = (size << 7) | int64(b&0x7f)
		}
		start = 10 + size
		if head[5]&0x10 != 0 {
			start += 10
		}
	}
	tail := make([]byte, 3)
	pos := end - 128
	if pos < 0 {
		pos = 0
	}
	if n, _ := f.ReadAt(tail, pos); n == 3 && string(tail) == "TAG" {
		end -= 128
	}
	h, _ := blake2b.New(16, nil)
	if end > start {
		if _, e = io.Copy(h, io.NewSectionReader(f, start, end-start)); e != nil {
			return "", e
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func digest(b []byte, size int) string {
	h, _ := blake2b.New(size, nil)
	_, _ = h.Write(b)
	return hex.EncodeToString(h.Sum(nil))
}

// Remove legacy ID3v1 as well as ID3v2 so stale metadata cannot survive retagging.
func removeID3v1(path string) error {
	f, e := os.OpenFile(path, os.O_RDWR, 0)
	if e != nil {
		return e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil {
		return e
	}
	if info.Size() < 128 {
		return nil
	}
	tail := make([]byte, 3)
	if _, e = f.ReadAt(tail, info.Size()-128); e != nil {
		return e
	}
	if string(tail) == "TAG" {
		return f.Truncate(info.Size() - 128)
	}
	return nil
}
func tagMP3(path string, i *Item, a *Author, cover string) error {
	if e := removeID3v1(path); e != nil {
		return e
	}
	tag, e := id3.Open(path, id3.Options{Parse: false})
	if e != nil {
		return e
	}
	defer tag.Close()
	tag.DeleteAllFrames()
	tag.SetVersion(3)
	text := func(k, v string) { tag.AddFrame(k, rawID3Frame{key: k, body: append([]byte{1}, utf16Text(v)...)}) }
	name := i.Author
	if a != nil {
		name = a.Name
	}
	text("TIT2", i.Title)
	text("TPE1", name)
	text("TPE2", name)
	text("TALB", str(first(i.Series, name)))
	if i.Date != nil {
		text("TYER", i.Date.Format("2006"))
		text("TDAT", i.Date.Format("0201"))
	}
	if truth(i.SeriesIndex) {
		text("TRCK", str(i.SeriesIndex))
	}
	if len(i.Categories) > 0 {
		text("TCON", strings.Join(i.Categories, "/"))
	}
	if blurb := str(first(i.Summary, stripHTML(i.Description))); blurb != "" {
		tag.AddFrame("COMM", textPairFrame("description", "eng", blurb))
	}
	for k, v := range map[string]string{"TAGS": strings.Join(i.Tags, "; "), "KEYWORDS": strings.Join(i.Tags, "; "), "AUTHOR_ID": i.Author} {
		if v != "" {
			tag.AddFrame("TXXX", textPairFrame(k, "", v))
		}
	}
	if i.SourceURL != "" {
		tag.AddFrame("WOAR", id3.UnknownFrame{Body: []byte(i.SourceURL)})
	}
	if i.Transcript != "" {
		tag.AddFrame("USLT", textPairFrame("transcript", "eng", i.Transcript))
	}
	if cover != "" {
		b, e := os.ReadFile(cover)
		if e != nil {
			return fmt.Errorf("cover: %w", e)
		}
		mime := "image/jpeg"
		if strings.ToLower(filepath.Ext(cover)) == ".png" {
			mime = "image/png"
		}
		body := append([]byte{1}, []byte(mime)...)
		body = append(body, 0, 3)
		body = append(body, utf16Text("Cover")...)
		body = append(body, 0, 0)
		body = append(body, b...)
		tag.AddFrame("APIC", rawID3Frame{key: "Cover", body: body})
	}
	return tag.Save()
}

// ID3v2.3 permits UTF-16 with a BOM. Encode frame payloads here because the
// dependency's UTF-16 encoder adds an extra byte after some strings, corrupting
// multi-field frames for independent readers (including Mutagen).
// The dependency still handles container parsing, sizing, and file replacement.
type rawID3Frame struct {
	key  string
	body []byte
}

func (f rawID3Frame) UniqueIdentifier() string           { return f.key }
func (f rawID3Frame) Size() int                          { return len(f.body) }
func (f rawID3Frame) WriteTo(w io.Writer) (int64, error) { n, e := w.Write(f.body); return int64(n), e }
func utf16Text(s string) []byte {
	r := utf16.Encode([]rune(s))
	b := make([]byte, 2+len(r)*2)
	b[0], b[1] = 0xff, 0xfe
	for n, v := range r {
		binary.LittleEndian.PutUint16(b[2+n*2:], v)
	}
	return b
}
func textPairFrame(description, language, value string) rawID3Frame {
	b := append([]byte{1}, []byte(language)...)
	b = append(b, utf16Text(description)...)
	b = append(b, 0, 0)
	b = append(b, utf16Text(value)...)
	return rawID3Frame{key: description + language, body: b}
}
