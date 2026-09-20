// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Run implements the command-line contract and returns a process exit status.
func Run(args []string, stdout, stderr io.Writer) int {
	source := "content"
	command := ""
	rest := []string{}
	// Accept -s on either side of the subcommand, including the documented form.
	for n := 0; n < len(args); n++ {
		a := args[n]
		if a == "-s" || a == "--source" {
			if n+1 == len(args) {
				fmt.Fprintln(stderr, "source requires a value")
				return 2
			}
			n++
			source = args[n]
			continue
		}
		if strings.HasPrefix(a, "--source=") {
			source = strings.TrimPrefix(a, "--source=")
			continue
		}
		if command == "" && !strings.HasPrefix(a, "-") {
			command = a
		} else {
			rest = append(rest, a)
		}
	}
	usage := func() {
		fmt.Fprintln(stdout, "Usage: hypnotica [-s SOURCE] <build|check|serve|init|sync> [options]\n\nBuild a static, offline-capable site from YAML.\nUse hypnotica <command> --help for command options.")
	}
	if command == "" {
		usage()
		if len(rest) > 0 && rest[0] != "--help" && rest[0] != "-h" {
			return 2
		}
		return 0
	}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(stderr)
	output := "www"
	var base, media string
	var force, noMedia, noPrune, quiet bool
	var syncDir, syncInvite, syncRemove string
	var syncOpen bool
	syncDisk := 5
	port := 8080
	bind := "0.0.0.0"
	switch command {
	case "build":
		flags.StringVar(&output, "o", output, "output directory")
		flags.StringVar(&output, "output", output, "output directory")
		flags.StringVar(&base, "base-url", "", "public base URL for podcast enclosures")
		flags.StringVar(&media, "media", "", "copy, link, or none")
		flags.BoolVar(&force, "force", false, "recopy and retag media")
		flags.BoolVar(&noMedia, "no-media", false, "alias for --media none")
		flags.BoolVar(&noPrune, "no-prune", false, "keep unclaimed output media")
	case "serve":
		flags.StringVar(&output, "o", output, "output directory")
		flags.StringVar(&output, "output", output, "output directory")
		flags.IntVar(&port, "p", port, "listen port")
		flags.IntVar(&port, "port", port, "listen port")
		flags.StringVar(&bind, "bind", bind, "listen address")
		flags.BoolVar(&quiet, "quiet", false, "suppress request logging")
		flags.StringVar(&syncDir, "sync", "", "serve the sync endpoint from this directory")
		flags.StringVar(&syncInvite, "sync-invite", "", "token that may create a new sync group")
		flags.BoolVar(&syncOpen, "sync-open", false, "let anybody create a sync group, with no token")
		flags.IntVar(&syncDisk, "sync-disk", syncDisk, "gigabytes the sync store may use")
	case "sync":
		flags.StringVar(&syncDir, "dir", "", "sync directory to inspect")
		flags.StringVar(&syncRemove, "rm", "", "group or profile id to delete")
	case "init", "check":
	default:
		fmt.Fprintf(stderr, "unknown command %q\n", command)
		usage()
		return 2
	}
	if e := flags.Parse(rest); e != nil {
		if errors.Is(e, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintf(stderr, "unexpected arguments: %s\n", strings.Join(flags.Args(), " "))
		return 2
	}
	switch command {
	case "check":
		l := LoadDocuments(absolute(source))
		fmt.Fprintf(stdout, "%d items, %d authors, %d problems\n", len(l.Items), len(l.Authors), len(l.Errors))
		known := map[string]bool{}
		for _, a := range l.Authors {
			known[a.ID] = true
		}
		seen := map[string]bool{}
		for _, i := range l.Items {
			if !known[i.Author] {
				l.Errors = append(l.Errors, fmt.Sprintf("%s: unknown author '%s'", i.ID, i.Author))
			}
			if seen[i.ID] {
				l.Errors = append(l.Errors, fmt.Sprintf("duplicate item id '%s'", i.ID))
			}
			seen[i.ID] = true
		}
		return report(nil, l.Errors, stderr)
	case "sync":
		if syncDir == "" {
			fmt.Fprintln(stderr, "sync needs --dir")
			return 2
		}
		if e := SyncInspect(absolute(syncDir), syncRemove, stdout); e != nil {
			fmt.Fprintln(stderr, e)
			return 1
		}
		return 0
	case "init":
		if e := Init(source, stdout); e != nil {
			fmt.Fprintln(stderr, e)
			return 1
		}
		return 0
	case "build":
		c, e := LoadConfig(source, output, Overrides{BaseURL: base, Media: media, NoMedia: noMedia, NoPrune: noPrune})
		if e != nil {
			fmt.Fprintln(stderr, e)
			return 1
		}
		r, e := Build(c, BuildOptions{Force: force, Log: stdout})
		if e != nil {
			fmt.Fprintln(stderr, e)
			return 1
		}
		return report(r.Warnings, r.Errors, stderr)
	case "serve":
		root := absolute(output)
		if !isFile(filepath.Join(root, "index.html")) {
			fmt.Fprintf(stderr, "No build in %s. Run hypnotica build first.\n", root)
			return 1
		}
		listener, e := net.Listen("tcp", net.JoinHostPort(bind, fmt.Sprint(port)))
		if e != nil {
			fmt.Fprintln(stderr, e)
			return 1
		}
		defer listener.Close()
		fmt.Fprintf(stdout, "Serving %s\n  site: http://localhost:%d/\n", root, listener.Addr().(*net.TCPAddr).Port)
		var log io.Writer
		if !quiet {
			log = stderr
		}
		handler := PreviewHandler(root, log)
		if syncDir != "" {
			dir := absolute(syncDir)
			// A sync directory under the output is served by the file server,
			// which would hand out every blob and honour none of the rules.
			if dir == root || strings.HasPrefix(dir+string(filepath.Separator), root+string(filepath.Separator)) {
				fmt.Fprintf(stderr, "The sync directory must be outside %s.\n", root)
				return 2
			}
			if syncOpen && syncInvite != "" {
				fmt.Fprintln(stderr, "Use --sync-open or --sync-invite, not both.")
				return 2
			}
			sync := SyncHandler(SyncOptions{Dir: dir, Invite: syncInvite, Open: syncOpen,
				Ceiling: int64(syncDisk) << 30, Log: log})
			handler = syncRoutes(sync, handler)
			how := "closed to new libraries"
			if syncOpen {
				how = "open to new libraries"
			} else if syncInvite != "" {
				how = "new libraries need the invite"
			}
			fmt.Fprintf(stdout, "  sync: %s (%s, up to %d GiB)\n", dir, how, syncDisk)
		}
		server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second}
		if e = server.Serve(listener); e != nil && !errors.Is(e, http.ErrServerClosed) {
			fmt.Fprintln(stderr, e)
			return 1
		}
		return 0
	}
	return 1
}
func report(warnings, problems []string, w io.Writer) int {
	for _, s := range warnings {
		fmt.Fprintln(w, "  ! "+s)
	}
	for _, s := range problems {
		fmt.Fprintln(w, "  ✗ "+s)
	}
	if len(problems) > 0 {
		fmt.Fprintf(w, "\n%d problem(s) found.\n", len(problems))
		return 1
	}
	return 0
}

// PreviewHandler serves byte ranges for audio seeking and prevents stale workers.
func PreviewHandler(root string, log io.Writer) http.Handler {
	files := http.FileServer(http.Dir(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(strings.TrimRight(r.URL.Path, "/"), "sw.js") {
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		}
		if mime := mimeTypes[strings.ToLower(filepath.Ext(r.URL.Path))]; mime != "" {
			w.Header().Set("Content-Type", mime)
		}
		switch filepath.Ext(r.URL.Path) {
		case ".webmanifest":
			w.Header().Set("Content-Type", "application/manifest+json")
		case ".json":
			w.Header().Set("Content-Type", "application/json")
		case ".xml":
			w.Header().Set("Content-Type", "application/rss+xml")
		}
		if log != nil {
			fmt.Fprintf(log, "%s %s\n", r.Method, r.URL.Path)
		}
		files.ServeHTTP(w, r)
	})
}

const initConfig = `site:
  title: Hypnotica
  tagline: A library of spoken-audio files.
  base_url: http://localhost:8080
  theme_color: "#6633cc"

paths:
  assets: assets
  cache: .hypnotica
`
const initAuthor = `kind: author
id: example-author
name: Example Author
url: https://example.com
summary: One line about them.
description: <p>A longer introduction.</p>
links:
  website: https://example.com
`
const initItem = `title: An Example File
author: example-author
date: 2026-01-01
audio: audio/example.mp3
cover: images/example.jpg
tags: [Example, Demo]
categories: [Audio]
summary: One line shown in listings and podcast apps.
description: <p>The full write-up. Text formatting is preserved.</p>
# transcript: |
#   Supply text here, in a Transcript document, or in the transcript cache.
`

func Init(root string, w io.Writer) error {
	root = absolute(root)
	for _, dir := range []string{"items", "authors", "assets/audio", "assets/images"} {
		if e := os.MkdirAll(filepath.Join(root, dir), 0755); e != nil {
			return e
		}
	}
	for _, entry := range [][2]string{{"hypnotica.yaml", initConfig}, {"authors/example-author.yaml", initAuthor}, {"items/an-example-file.yaml", initItem}} {
		f, e := os.OpenFile(filepath.Join(root, entry[0]), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if os.IsExist(e) {
			fmt.Fprintln(w, "  skip "+entry[0]+" (exists)")
			continue
		}
		if e != nil {
			return e
		}
		_, e = f.WriteString(entry[1])
		closeErr := f.Close()
		if e != nil {
			return e
		}
		if closeErr != nil {
			return closeErr
		}
		fmt.Fprintln(w, "  wrote "+entry[0])
	}
	fmt.Fprintf(w, "\nSource tree ready at %s\n  hypnotica -s %s build\n", root, root)
	return nil
}
