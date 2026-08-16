# Parser assets

Tieline ships a pinned WebAssembly parser compatibility set so installed
packages can analyze JavaScript, TypeScript, TSX, Python, Rust, and SQL without
a native compiler, a network connection, or separately installed grammar
packages. SQL is shipped from a pinned upstream release and build toolchain.
The runtime and grammar packages have different native Tree-sitter peer ranges,
so they are staged only as sources for the compatible Wasm files; they are not
Tieline runtime dependencies.

Each compatibility-set directory contains:

- the verified runtime and grammar Wasm files;
- `manifest.json`, which distinguishes npm-copied and source-built provenance
  and records versions, origins, integrity values, ABI versions, and SHA-256
  digests;
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

sql_source="$parser_stage/sql-source"
sql_archive="$parser_stage/tree-sitter-sql-v0.3.11.tar.gz"
mkdir -p "$sql_source" "$parser_stage/node_modules/@derekstride/tree-sitter-sql"
curl -fL \
  https://github.com/DerekStride/tree-sitter-sql/releases/download/v0.3.11/tree-sitter-sql-v0.3.11.tar.gz \
  -o "$sql_archive"
printf '%s  %s\n' \
  a97a324eae9c81ed68f6e162b9b33f8911fc6442caa2950e57c498e2460d1387 \
  "$sql_archive" | shasum -a 256 -c -
tar -xzf "$sql_archive" -C "$sql_source"
npm exec --yes --package=tree-sitter-cli@0.26.3 -- \
  tree-sitter build --wasm \
  --output "$parser_stage/node_modules/@derekstride/tree-sitter-sql/tree-sitter-sql.wasm" \
  "$sql_source"

npm run prepare:parser-assets -- "$parser_stage/node_modules"
```

Tree-sitter CLI 0.26.3 uses WASI SDK 29.0 for this build. The preparation
command copies only the seven Wasm files and refuses any file whose SHA-256
digest differs from `manifest.json`.

The release gates allow at most 8 MiB of parser assets, a 7 MiB packed package,
and a 13 MiB installed parser footprint including `web-tree-sitter`. With the
2.36 MiB SQL Wasm included, the totals are about 7.18 MiB, 3.40 MiB, and
11.55 MiB respectively, leaving explicit headroom without a custom compression
or sharding format.

For a version change, update the compatibility-set name and package versions in
the source, `package.json`, this staging command, and `manifest.json`. Record the
new npm tarball origins and integrity values, calculate the staged Wasm
SHA-256 digests, and update the manifest before running the preparation command.
Copy any changed upstream license text and update `THIRD_PARTY_NOTICES.md`.

For SQL, also update and verify the immutable release archive digest plus exact
Tree-sitter CLI and WASI SDK versions in its structured `source_build`
provenance, and the generated Wasm digest in the artifact-level `sha256` field.
Do not replace the pinned build with an install-time or runtime grammar
dependency.

Keep only queries used by the compatibility set. Git history preserves
superseded query versions.

## Verify a refresh

```sh
npm run build
npm run test:parser-package
npm run check:generated-artifacts
```

Inspect the package contents and the parser asset licenses before committing.
