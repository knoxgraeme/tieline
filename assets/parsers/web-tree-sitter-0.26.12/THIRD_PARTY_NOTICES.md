# Parser asset notices

This directory is the pinned `web-tree-sitter-0.26.12` compatibility set. Most
Wasm files are copied unchanged from the npm tarballs identified in
`manifest.json`. The SQL Wasm is built from the immutable upstream release with
the exact Tree-sitter CLI and WASI SDK recorded in its structured provenance.
SHA-256 digests and upstream package integrity values are recorded in the
manifest so releases can verify provenance without downloading anything.

The runtime and grammars are MIT licensed:

- `web-tree-sitter` 0.26.12 — Tree-sitter contributors
- `tree-sitter-javascript` 0.25.0 — Tree-sitter contributors
- `tree-sitter-typescript` 0.23.2 — Tree-sitter contributors
- `tree-sitter-python` 0.25.0 — Tree-sitter contributors
- `tree-sitter-rust` 0.24.0 — Tree-sitter contributors
- `@derekstride/tree-sitter-sql` 0.3.11 — Derek Stride

The corresponding license texts are preserved in `licenses/`.
