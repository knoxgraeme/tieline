# Code topology artifact encoding

Date: 2026-08-13

## Decision status: revised

Tieline stores the reviewed code-topology projection as one deterministic
`.tieline/topology/graph.json` using the `json-v1` encoding. It is a standard
JSON document with named metadata, `files`, `symbols`, `edges`, and `frontiers`
arrays. Each record occupies one stable line. Edges use global source and target
symbol identities; the file has no artifact-local IDs, dictionaries, shards,
or sidecar index.

The earlier compact sharded encoding optimized the synthetic maximum before the
repository workflow needed that complexity. It kept bytes low, but made a
normal compile produce thousands of possible artifact paths and introduced an
index/shard publication protocol. The single document is easier to explain,
review, validate, select from Git, and regenerate after conflicts. Its explicit
64 MiB file limit leaves measured headroom without inventing another compact
format.

## Authority and storage boundary

| Representation | Responsibility | Mutation boundary |
| --- | --- | --- |
| Repository YAML and compiled manifest | Accepted Story and AC meaning | Normal code review and merge |
| `.tieline/topology/graph.json` | Thin code traversal snapshot for the current checkout and historical Git reads | Explicit local compilation, committed with source changes |
| PostgreSQL topology tables | Rich shared projection of an accepted `main` generation | A protected repository publisher after merge |

The JSON file and PostgreSQL are two projections of the same derived generation,
not two product authorities. Local compile, validate, trace, and blast-radius
reads never persist topology to PostgreSQL. The repository file does not copy
Story or AC content. AC-aware blast radius joins its code locators to the
matching compiled manifest at query time. PostgreSQL may retain source ranges,
parser diagnostics, reference and resolution facts, and immutable generation
history that are intentionally absent from `graph.json`.

The current release supplies the relational schema and repository adapter, not
the automatic merge-only publisher. That publisher remains a separate,
protected integration; it must not be folded into local compilation.

## Logical contract

Schema version 1 and producer `tieline_tree_sitter` version 1 normalize through
the provider-neutral envelope in `src/domain/code-topology-artifact.ts`. The
file contains:

- producer/provider and parser/resolver/schema compatibility;
- selected-input, generation, projection, and artifact digests;
- file language, kind, framework hint, path, and source hash;
- locator-bearing symbol identities and selectors;
- resolved code dependency edges; and
- unresolved, ambiguous, and external dependency frontiers.

It cannot represent source bodies, snippets, parser ranges, Story or AC IDs,
retained-memory estimates, or persistence-only facts. Readers validate bounded
JSON shape, record counts, identity uniqueness, edge/frontier referential
integrity, canonical ordering and bytes, projection digest, and artifact digest
before constructing the thin traversal store.

The logical analysis limit remains 5,000 files, 100,000 symbols, and 250,000
combined edges/frontiers. The committed JSON adds a 64 MiB physical guardrail.
Repositories that exceed it fail with a named capacity outcome; they do not
silently shard or switch encodings. We should revisit the representation only
with real repository evidence above that boundary.

## Publication and Git behavior

Compilation writes and flushes one same-directory temporary file, then
atomically replaces `graph.json` while holding the existing bounded
repository-local publication lock. A reader therefore captures either the old
complete document or the new complete document; it cannot mix generations.
The first successful single-file publication safely removes schema-shaped
legacy topology shards.

Arrays use deterministic logical ordering and top-level records are serialized
one per line. A source edit changes the root generation/digest lines and only
the affected logical record lines. The artifact is one Git path, so merge
conflicts are resolved by recompiling from the merged source rather than
manually merging generated JSON.

## Reproducible benchmark

Run:

```sh
npm run benchmark:code-topology-artifact
```

The permanent review-envelope fixture uses 1,500 source files, 30,000 symbols,
75,000 combined dependency records, and 50 MiB of selected source. That maps to
20 symbols and 50 module references per file and is large enough to exercise a
substantial repository without using the absolute parser caps as a file-format
target. `resolved-dense` assigns every dependency to an edge;
`frontier-heavy` assigns 7,500 edges and 67,500 retained frontiers.

Local macOS arm64 Node v24.18.0 measurements:

| Distribution | `graph.json` bytes | Files | Compile | Validate |
| --- | ---: | ---: | ---: | ---: |
| resolved-dense | 31,435,657 | 1 | 714 ms | 796 ms |
| frontier-heavy | 35,175,159 | 1 | 1,047 ms | 1,022 ms |

Two simultaneously loaded artifact roles used 406,978,560 B peak / 346,062,848
B retained growth for `resolved-dense`, and 498,155,520 B peak / 424,198,144 B
retained growth for `frontier-heavy`. The equivalent parse-first runs were
slower and retained more memory. These are synthetic review-envelope numbers;
normal use scales with the committed graph, and this repository's graph is
roughly 1–2 MiB.

Pinned Ubuntu x64 Node 20 CI is authoritative. It enforces:

- one artifact file;
- at most 64 MiB;
- at most 60 seconds to serialize;
- at most 10 seconds to validate;
- at most 640 MiB two-role peak RSS growth; and
- at most 512 MiB two-role retained RSS growth.

The benchmark continues to compare two artifact-backed roles with parsing two
source revisions. That comparison remains diagnostic: absolute repository
artifact size and reader budgets are the release gates.
