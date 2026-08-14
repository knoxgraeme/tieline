# Parser assets

Tieline ships a pinned WebAssembly parser compatibility set so installed
packages can analyze JavaScript, TypeScript, TSX, Python, and Rust without a
native compiler, a network connection, or separately installed grammar
packages. The runtime and grammar packages have different native Tree-sitter
peer ranges, so they are staged only as sources for the compatible Wasm files;
they are not Tieline runtime dependencies.

Each compatibility-set directory contains:

- the unchanged runtime and grammar Wasm files;
- `manifest.json`, which records their versions, origins, integrity values,
  ABI versions, and SHA-256 digests;
- the upstream license texts and `THIRD_PARTY_NOTICES.md`; and
- Tieline-authored structure queries used with that set.

## Refresh the current compatibility set

Stage the exact upstream packages in a temporary directory. Ignoring install
scripts avoids their native builds, while legacy peer resolution permits the
different native Tree-sitter peer ranges:

```sh
parser_stage="$(mktemp -d)"
npm install --prefix "$parser_stage" \
  --ignore-scripts \
  --legacy-peer-deps \
  --package-lock=false \
  --no-save \
  web-tree-sitter@0.26.12 \
  tree-sitter-javascript@0.25.0 \
  tree-sitter-typescript@0.23.2 \
  tree-sitter-python@0.25.0 \
  tree-sitter-rust@0.24.0

npm run prepare:parser-assets -- "$parser_stage/node_modules"
```

The preparation command copies only the six Wasm files and refuses any file
whose SHA-256 digest differs from `manifest.json`.

For a version change, update the compatibility-set name and package versions in
the source, `package.json`, this staging command, and `manifest.json`. Record the
new npm tarball origins and integrity values, calculate the staged Wasm
SHA-256 digests, and update the manifest before running the preparation command.
Copy any changed upstream license text and update `THIRD_PARTY_NOTICES.md`.

Keep only queries used by the compatibility set. Git history preserves
superseded query versions.

## Verify a refresh

```sh
npm run build
npm run test:parser-package
npm run check:generated-artifacts
```

Inspect the package contents and the parser asset licenses before committing.
