# Third-party components

Hypnotica's own code is GPL-3.0-only. The components below retain their own
licenses and copyright notices. Versions and checksums are pinned in go.mod
and go.sum; Go module source is available through the corresponding module paths.

| Go module | Version | Notices |
| --- | --- | --- |
| `github.com/bogem/id3v2/v2` | `v2.1.4` | [LICENSE](LICENSES/github.com_bogem_id3v2_v2_LICENSE) |
| `github.com/tetratelabs/wazero` | `v1.11.1-0.20260428013916-2bbd517b7633` | [LICENSE](LICENSES/github.com_tetratelabs_wazero_LICENSE), [NOTICE](LICENSES/github.com_tetratelabs_wazero_NOTICE) |
| `go.senan.xyz/taglib` | `v0.14.0` | [LICENSE](LICENSES/go.senan.xyz_taglib_LICENSE) |
| `go.yaml.in/yaml/v3` | `v3.0.4` | [LICENSE](LICENSES/go.yaml.in_yaml_v3_LICENSE), [NOTICE](LICENSES/go.yaml.in_yaml_v3_NOTICE) |
| `golang.org/x/crypto` | `v0.57.0` | [LICENSE](LICENSES/golang.org_x_crypto_LICENSE) |
| `golang.org/x/net` | `v0.59.0` | [LICENSE](LICENSES/golang.org_x_net_LICENSE) |
| `golang.org/x/sys` | `v0.48.0` | [LICENSE](LICENSES/golang.org_x_sys_LICENSE) |
| `golang.org/x/text` | `v0.42.0` | [LICENSE](LICENSES/golang.org_x_text_LICENSE) |
| `gopkg.in/check.v1` | `v0.0.0-20161208181325-20d25e280405` | [LICENSE](LICENSES/gopkg.in_check.v1_LICENSE) |

## Embedded audio engine

[go-taglib](https://github.com/sentriz/go-taglib/tree/v0.14.0) embeds TagLib
compiled to WebAssembly and executes it with wazero. TagLib is version 2.1.1 in
this dependency; its [source and license files](https://github.com/taglib/taglib/tree/v2.1.1)
are available upstream. The wrapper's repository includes the C++ bridge,
submodule revision, and build scripts. Follow its
[rebuild instructions](https://github.com/sentriz/go-taglib/tree/v0.14.0#manually-building-and-using-the-wasm-binary)
to reproduce or replace the embedded engine. The default build requires no
system TagLib installation or CGo.

## Browser test dependencies

jsdom and its transitive npm dependencies are development-only; they are not
embedded in the executable or copied into generated sites. package-lock.json
pins them and records their licenses. Their installed packages contain the
original notices.

## Fixtures

Audio fixtures are synthetic silence or tones. The SVG artwork, example text,
and placeholder video bytes were created for these tests and are distributed
under the project's GPL-3.0-only license. No creator recordings or private
library data are included.
