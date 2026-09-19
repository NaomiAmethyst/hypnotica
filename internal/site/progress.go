// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package site

import (
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// What a build is doing while it is doing it.
//
// A build of ten thousand recordings spends minutes between one line of output
// and the next, and from outside there is no way to tell slow from wedged. The
// phases were always there; they just never said how far along they were.
//
// On a terminal this redraws one line in place. Anywhere else -- a pipe, a log,
// a CI job -- it prints a plain line per phase when the phase finishes, because
// a carriage return in a log file is noise and a spinner in CI is thousands of
// wasted lines.

type reporter struct {
	log   io.Writer
	tty   bool
	mu    sync.Mutex
	live  string
	start time.Time
}

// terminal reports whether writes to w land on something that can redraw.
// Anything redirected to a file or a pipe gets plain lines.
func terminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	if !ok {
		return false
	}
	info, err := f.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func newReporter(log io.Writer) *reporter {
	return &reporter{log: log, tty: terminal(log), start: time.Now()}
}

func (r *reporter) say(format string, a ...any) {
	if r == nil || r.log == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clear()
	fmt.Fprintf(r.log, format+"\n", a...)
}

// clear wipes the in-place line so an ordinary message does not land on top of
// it. Caller holds the lock.
func (r *reporter) clear() {
	if r.live != "" {
		fmt.Fprintf(r.log, "\r%s\r", strings.Repeat(" ", len(r.live)+2))
		r.live = ""
	}
}

func (r *reporter) draw(s string) {
	if r == nil || r.log == nil || !r.tty {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.clear()
	r.live = s
	fmt.Fprintf(r.log, "\r%s", s)
}

var spinner = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

// phase tracks one stage of the build. Done is incremented by the workers;
// nothing else about them is synchronised, which is the point -- a progress
// report that needs a lock around the work is a progress report that changes
// how fast the work runs.
type phase struct {
	r       *reporter
	name    string
	total   int64
	done    atomic.Int64
	started time.Time
	stop    chan struct{}
	ended   sync.WaitGroup
}

func (r *reporter) phase(name string, total int) *phase {
	p := &phase{r: r, name: name, total: int64(total), started: time.Now(), stop: make(chan struct{})}
	if r == nil || r.log == nil || !r.tty {
		return p
	}
	p.ended.Add(1)
	go func() {
		defer p.ended.Done()
		tick := time.NewTicker(100 * time.Millisecond)
		defer tick.Stop()
		for n := 0; ; n++ {
			select {
			case <-p.stop:
				return
			case <-tick.C:
				p.r.draw(p.line(spinner[n%len(spinner)]))
			}
		}
	}()
	return p
}

func (p *phase) line(mark string) string {
	done := p.done.Load()
	s := fmt.Sprintf("%s %s", mark, p.name)
	if p.total > 0 {
		s += fmt.Sprintf(" %d/%d", done, p.total)
		if done > 0 && done < p.total {
			per := time.Since(p.started) / time.Duration(done)
			s += fmt.Sprintf(" · %s left", short(per*time.Duration(p.total-done)))
		}
	} else if done > 0 {
		s += fmt.Sprintf(" %d", done)
	}
	return s + fmt.Sprintf(" · %s", short(time.Since(p.started)))
}

func (p *phase) step()      { p.done.Add(1) }
func (p *phase) add(n int)  { p.done.Add(int64(n)) }
func (p *phase) count() int { return int(p.done.Load()) }

// finish closes the phase and leaves one line behind saying what it did. The
// summary is printed whether or not there was a terminal to animate.
func (p *phase) finish(format string, a ...any) {
	if p.r != nil && p.r.tty {
		close(p.stop)
		p.ended.Wait()
		p.r.mu.Lock()
		p.r.clear()
		p.r.mu.Unlock()
	}
	p.r.say("→ %s (%s)", fmt.Sprintf(format, a...), short(time.Since(p.started)))
}

func short(d time.Duration) string {
	switch {
	case d < time.Second:
		return fmt.Sprintf("%dms", d.Milliseconds())
	case d < time.Minute:
		return fmt.Sprintf("%.1fs", d.Seconds())
	default:
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	}
}

// inParallel runs f over every element, on as many goroutines as there are
// cores, and returns the first error. Order of execution is not order of
// effect: use it only where the work items do not read each other's output.
func inParallel[T any](all []T, f func(T) error) error {
	if len(all) == 0 {
		return nil
	}
	workers := min(runtime.NumCPU(), len(all))
	var next atomic.Int64
	var wg sync.WaitGroup
	errs := make([]error, workers)
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for {
				i := int(next.Add(1)) - 1
				if i >= len(all) {
					return
				}
				if e := f(all[i]); e != nil && errs[w] == nil {
					errs[w] = e
				}
			}
		}(w)
	}
	wg.Wait()
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}
