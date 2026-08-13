# Code topology artifact encoding

Date: 2026-08-11

## Decision status: selected

Deterministic sharded compact JSON (`sharded-compact-json-v1`) is the selected
encoding. It is the only candidate below the absolute repository-artifact
ceilings, and its direct reader stays below the fixed two-role peak, retained,
and latency budgets without introducing another traversal store. Relative
improvement over parse-first remains reported evidence rather than a release
threshold because it varies with parser/runtime allocation while the absolute
artifact-reader budget is the product constraint. The root authority is
`topology.json`; one shard is assigned to each stable source path
and stored content-addressed at `files/<sha256(canonical-shard-bytes)>.json`.
Files and global symbol identities retain their logical string identity. Within
a shard, symbols have zero-based local IDs in identity order; edges address a
source local ID plus a target file/local ID. Repeated kinds, selectors, module
specifiers, rules, and statuses use sorted shard-local dictionaries. Shards are
canonical JSON with one trailing newline. Logical generation identity belongs
to the root index so unchanged physical shards can be reused across generations;
readers still accept legacy schema-v1 shards that carry the former extra
`generation_identity` field. The root index keeps canonical values but places
metadata and each shard entry on stable separate lines so a local change does
not replace a megabyte-long JSON line in Git.

Canonical JSON and JSONL are discarded encodings. Their definitions remain
recorded below, but no production encoder or reader remains for either.

## Logical contract

Schema version 1 and producer `tieline_tree_sitter` version 1 normalize through
the provider-neutral envelope in `src/domain/code-topology-artifact.ts`. The
envelope contains producer/provider identity, fact-producing compatibility,
the selected-input and logical generation identities, projection and artifact
digests, counts, file language/kind/hash facts, locator-bearing symbols,
derived edges, and retained unresolved/ambiguous/external frontiers.

It cannot represent source bodies, snippets, parser ranges, Story or AC IDs,
`retained_bytes`, parser diagnostics, references/resolutions that are not
traversal frontiers, or other persistence-only facts. A future producer must
normalize its facts into the same envelope and pass the same compatibility,
ordering, integrity, capacity, and traversal checks.

The shared capacity is 250,000 total dependency records across derived edges
and retained frontiers. Projection digest ordering is canonical by group and
record, independent of physical shard order. The artifact digest covers the
complete logical envelope except for the digest field itself. Readers consume
index and shard bytes directly and construct only the thin read model; they do
not hydrate a rich generation or initialize a parser/resolver.

## Frozen candidates and selection rule

The candidates were measured in this simplicity order:

1. Canonical JSON: one canonical, ordered logical envelope with string
   identities.
2. JSONL: one canonical record per line, grouped envelope/files/symbols/edges/
   frontiers, with string identities.
3. Sharded compact JSON: stable file partition, deterministic local symbol IDs,
   compact identities, adjacency, and shard-local dictionaries as described in
   the decision.

Choose the first candidate that passes every hard invariant and is not
dominated across bytes, Git locality, latency, and retained memory. Candidates
1 and 2 fail the absolute 32 MiB full-envelope ceiling, so candidate 3 is the
first candidate that passes the selection rule.

## Fixtures and protocol

The reproducible command is:

```sh
npm run benchmark:code-topology-artifact
```

The scale fixture is deterministic: 5,000 paths spread evenly over JavaScript,
TypeScript, Python, and Rust; 100,000 symbols; and exactly 250,000 total
dependency records. `resolved-dense` assigns all 250,000 to edges.
`frontier-heavy` assigns 25,000 to edges and 225,000 to alternating unresolved
and external frontiers. Identity strings are deterministic from their ordinal;
fixture counts and projection digest are asserted during direct-reader parity.
The focused correctness fixture covers all four languages, Unicode selectors,
resolved edges, ambiguous and external frontiers, byte-identical five-write
determinism, producer/schema incompatibility, corruption, duplicate identity,
root-generation digest mismatch, legacy shard compatibility, count mismatch,
and direct-store traversal.

The permanent benchmark runs the winner at full scale. The one-time size
comparison was collected on macOS arm64, Node v24.18.0. The isolated two-role
reader comparison was collected separately on macOS arm64, Node v20.20.2 so
candidate construction could not remain resident during measurement. Pinned
Ubuntu x64 Node 20 CI remains authoritative for release budgets.

## Measurements

| Distribution / candidate | Bytes | Files | Largest file | Compile | Validate | Result |
|---|---:|---:|---:|---:|---:|---|
| resolved-dense canonical JSON | 150,926,659 | 1 | 150,926,659 | — | — | fails 32 MiB |
| resolved-dense JSONL | 159,646,640 | 1 | 159,646,640 | — | — | fails 32 MiB |
| resolved-dense sharded compact JSON | 27,039,406 | 5,001 | 1,129,136 | 2,448.59 ms | 4,302.58 ms | passes measured full-envelope ceilings |
| frontier-heavy canonical JSON | 121,541,662 | 1 | 121,541,662 | — | — | fails 32 MiB |
| frontier-heavy JSONL | 131,161,644 | 1 | 131,161,644 | — | — | fails 32 MiB |
| frontier-heavy sharded compact JSON | 28,268,840 | 5,001 | 1,129,140 | 1,719.43 ms | 4,023.11 ms | passes measured full-envelope ceilings |

Both winning distributions are below 32 MiB total, 8 MiB per file, 60 seconds
compile, and 10 seconds full first-read. Stable file partition means a logical
one-file edit changes one old/new immutable shard pair plus the root index (3
touched artifact paths); a rename also changes the old/new shards whose logical
edge locators point at the renamed path (5 paths in the representative fixture),
under the 8-file ceiling. The fixture's largest possible local patch is bounded by
two 1.13 MiB shards plus index metadata; a representative edit changes one
shard and the index and stays below 2 MiB.

The full two-role Node 20 read measurements were:

| Distribution | Artifact peak growth | Artifact retained growth | Parse-first peak / retained | Artifact / parse elapsed |
|---|---:|---:|---:|---:|
| resolved-dense | 331,055,104 B | 291,799,040 B | 577,912,832 B / 451,166,208 B | 6.38 s / 28.50 s |
| frontier-heavy | 344,981,504 B | 306,053,120 B | 702,824,448 B / 579,846,144 B | 6.76 s / 25.39 s |

Both artifact modes pass the 512 MiB peak, 384 MiB retained, and 10-second
first-read ceilings. Relative memory improvement ranges from 35.3% to 50.9%
and is retained as diagnostic evidence, not used to justify another compact
query engine or representation.

The repository itself has 272 tracked files and 1,826,781 bytes across selected
source/config inputs, so its artifact is structurally bounded below the 2 MiB
repository ceiling; the explicit repository cold-validation/trace measurement
is deferred to the U3/U4 production selection integration because U2 does not
write or select repository artifacts.

## Fixed CI budgets

The permanent total-byte budget is `min(measured bytes × 1.25, 32 MiB)`. The
absolute 32 MiB safeguard remains unchanged: it prevents an already-supported
maximum fixture from growing simply to manufacture nominal headroom. Applied
to the worst measured result, frontier-heavy is 28,268,840 bytes and therefore
receives the capped 33,554,432-byte budget—5,285,592 bytes, or 18.7% (about
19%), of headroom at the supported maximum. This is sufficient measured room
without adding another physical compaction layer solely for a synthetic 25%
margin. The other size, locality, latency, and memory regression budgets retain
the fixed 25% headroom rule.

The winner must satisfy the absolute product ceilings and these fixture
regression budgets, rounded up where appropriate:

- full artifact total: `min(measured × 1.25, 33,554,432)` bytes; the current
  supported-maximum budget is 33,554,432 bytes;
- per artifact file: 1,411,425 bytes;
- full compile: 3,061 ms;
- full direct validation: 5,379 ms;
- two-role peak RSS growth: 431,226,880 bytes;
- two-role retained RSS growth: 382,566,400 bytes;
- touched artifact paths: 5 for the representative rename fixture (3 for edit);
- representative patch bytes: 1,411,425;
- dependency records: exactly 250,000 maximum across edges and frontiers.

The permanent benchmark continues to report the parse-first comparison, but
enforces the artifact reader's fixed size, latency, peak, and retained budgets.
U4 must use this direct reader and the existing traversal store; it must not add
a second compact graph store merely to improve a relative benchmark ratio.
