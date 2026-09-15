// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Naomi Persephone Amethyst <naomi@amethyst.name>
package main

import (
	"hypnotica/internal/site"
	"os"
)

func main() { os.Exit(site.Run(os.Args[1:], os.Stdout, os.Stderr)) }
