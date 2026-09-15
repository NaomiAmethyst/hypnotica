// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestMain(m *testing.M) {
	if os.Getenv("HYPNOTICA_CLI_CHILD") == "1" {
		os.Args = append([]string{"hypnotica"}, os.Args[1:]...)
		main()
		return
	}
	os.Exit(m.Run())
}
func TestProcessExitStatus(t *testing.T) {
	executable, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	for _, tc := range []struct {
		args   []string
		status int
		text   string
	}{{[]string{"--help"}, 0, "Usage:"}, {[]string{"unknown"}, 2, "unknown command"}, {[]string{"-s", filepathMissing(t), "check"}, 1, "no such file"}} {
		command := exec.Command(executable, tc.args...)
		command.Env = append(os.Environ(), "HYPNOTICA_CLI_CHILD=1")
		out, e := command.CombinedOutput()
		status := 0
		if e != nil {
			exit, ok := e.(*exec.ExitError)
			if !ok {
				t.Fatal(e)
			}
			status = exit.ExitCode()
		}
		if status != tc.status {
			t.Errorf("%v: status %d, want %d: %s", tc.args, status, tc.status, out)
		}
		if tc.status != 1 && !strings.Contains(string(out), tc.text) {
			t.Errorf("output %q lacks %q", out, tc.text)
		}
	}
}
func filepathMissing(t *testing.T) string { return t.TempDir() + "/missing" }
