# CLI reference

[README](../README.md) · [Setup](setup.md) · [Concepts](concepts.md) · **CLI** · [MCP](mcp.md) · [Operations](operations.md)

Examples use `tieline` for readability. Without a global install, run the same command as
`npx -y tieline@latest <command>`.

## Contract commands

Validate and compile without a database:

```bash
tieline contract validate .
tieline contract compile .
tieline contract coverage . --json
```

### Reading exact context

When an asset locator or AC ID is already known, read its exact reviewed
context before editing or using semantic discovery. Asset mode accepts a repository-relative
path plus optional `code`/`test` kind and canonical selector; AC mode accepts one stable ID:

```bash
tieline contract context --path src/contract/impact.ts \
  --kind code --selector function:analyzeContractImpact
tieline contract context --ac CONTRACT-001-AC3 --json
```

The equivalent read-only MCP tools are `get_asset_intent_context` and
`get_acceptance_criterion_context`. Both CLI modes and MCP tools answer from the compiled
manifest without Postgres, embeddings, or network access. Results include the stable repository
key and a content-derived `manifest_digest` for the reviewed contract that answered.

Asset context returns `has_context`, `no_criteria`, or `not_found`. A selector-qualified query
includes exact-selector and file-level claims while excluding claims for other selectors in the
same file; a path-only query keeps every claim's full kind, repository, path, selector, and
framework-hint identity. AC context returns the exact Capability, Story, AC, scenarios, direct
links, and Story-fallback links. Both entry points stop after one AC-mediated hop.

The associated code and tests are an **intent neighborhood** and their shared AC links are
**contract coupling** — not a runtime dependency graph or a comprehensive blast radius.

Each returned claim reports authored provenance, direct or Story-fallback link scope, content
freshness, locator resolution, and semantic support separately. `resolved` or current means only
that structural inspection succeeded; `unresolved`, `not_checked`, broken causes, and unknown
cross-repository states remain explicit. Semantic support is always `not_assessed` in these
reads. No state proves the AC is implemented correctly, and a linked test is an evidence
locator — not a receipt that the test ran or passed.

### Path-to-AC lookup

Use semantic discovery only when the exact path, selector, or AC ID is unknown. For the
compatibility path-to-AC list without selector-aware neighborhood context:

```bash
tieline contract criteria src/commands/check.ts src/server.ts
```

This is an exact path lookup, not semantic search. Each path is reported as `has_criteria`,
`no_criteria`, or `not_found`; results with criteria preserve whether the link is `direct` on an
AC or a `story_fallback`. JSON output also carries a content-derived
`manifest_digest`.

### Link review

Ask which links a human should re-read:

```bash
tieline contract link-review .
```

Link review scores each AC-level code and test link on lexical overlap between the AC's prose and
the linked file's names, comments, and string literals, then
reports the weakest links in the repository's own distribution. This is inference, never
evidence. It never confirms a relationship and never refutes one; each candidate carries a
rationale naming the terms that did and did not overlap so a reviewer can judge the suggestion
instead of trusting a number. An empty candidate list means the heuristic is not asking for
attention, not that the links are correct. Missing files are left to `tieline check` and are
reported as skipped rather than scored. The command is advisory and exits zero.

### Grading

Ask an agent to judge the branch's contract evidence:

```bash
tieline contract grade . --base <base-ref> --emit-scope --json
tieline contract grade . --base <base-ref> --verify <verdicts.json>
```

The first command deterministically emits every changed AC link to grade and
the exact symbol citations allowed for it. A link enters the scope when either of its sides
changed against the base: the artifact side (the linked file was modified, added, renamed, or
deleted) or the claim side (the link is new, belongs to a new AC, or its AC text was
re-worded, even when the linked file is untouched). A base with no manifest is the initial
contract, so onboarding's links are all in scope as `link_added`.

For JavaScript, JSX, TypeScript, TSX, Python, Rust, and SQL source, each scope entry also
carries ephemeral `code_evidence` from Tieline's Tree-sitter analyzers: the analyzed content hash
and parser compatibility, diagnostics, and bounded source evidence for each legal declaration.
`symbols` remains the complete, closed citation allow-list. An explicit link selector must
exactly match one canonical parser selector and limits the entry to that declaration. A link
without a selector offers only unique canonical top-level or owner-aware declarations; comments
and local variables do not become citations. Missing, unreadable, oversized, unsupported, or
structurally incomplete source — or an invalid, unresolved, or ambiguous explicit selector —
instead produces unavailable evidence and an empty allow-list.

SQL evidence is deliberately narrow in this increment: it identifies conservative top-level
table, view, and function declarations when their names can be represented safely. SQL object
references and dependency edges are not yet derived, so SQL symbols can be linked to Acceptance
Criteria without being treated as SQL blast-radius coverage.

The agent inspects the evidence and artifact and assigns `supported`, `partial`, or
`unsupported`; parser evidence establishes which current declaration may be cited, not whether
its implementation semantically satisfies the AC. Grade IDs bind the exact AC text and current
source/parser evidence, so verdicts become stale after either the AC or source
changes. The second command verifies that every verdict belongs to the current scope and that
every claimed citation came from its allow-list. Tieline does not call a model, database, or
network or persist grades for this workflow. Verification is advisory by default, including
negative results; add `--strict` only when unsupported evidence should fail the gate. The
installed `tieline` skill carries this grading workflow as an internal reference and dispatches
fresh grading contexts so authors do not judge their own rationale.

### Browser review

```bash
tieline contract review .
```

Writes `.tieline/review.html`, a self-contained page with capability navigation, Story and AC
cards, scenario steps, evidence links, search, lifecycle filters, and a print layout. Open the
file directly in a browser. Use `--output <path>` to write it elsewhere.

## CI check

```bash
tieline check --base <base-ref> .
```

Use the comparison ref supplied by the caller when available. Otherwise, agents should determine
it from repository metadata, preferring the remote-tracking default branch, and ask only when it
cannot be determined; do not assume every repository uses `origin/main`.

The check compares changed, renamed, and deleted paths with manifest locators and reports each
affected AC plus its freshness. It also sweeps every link for broken targets, whether or not the
diff touched them, because a link can rot without the change under review going near it.

| State | Cause | Effect |
| --- | --- | --- |
| stale | The linked file changed since it was reviewed, or was never reviewed against a recorded hash. Whether the AC still holds needs a human. | Warning, exit 0 |
| broken | The linked path is missing, is not a file, or resolves outside the repository. | Error, exit 1 |
| stale manifest | The committed manifest differs from what the current contract compiles to. | Error, exit 1 |

Broken links fail the check because deciding they are wrong needs no judgement: the manifest
points at evidence that is not there. Pass `--no-fail-on-broken` to downgrade broken links to
warnings and exit zero. A stale manifest also fails by default: run `tieline contract compile .`,
review the semantic diff, and commit the result. Use `--no-fail-on-stale-manifest` only when
intentionally downgrading that integrity gate to a warning. Invalid YAML or an unreadable
manifest fails because no trustworthy result can be computed.

See [the GitHub Actions example](examples/tieline-check.yml).

## Post-merge sync

```bash
tieline contract sync . --expected-previous-commit <previous-main-sha>
```

Sync is idempotent and checkpointed. A delayed job cannot overwrite a newer projection. If
planning changed while a materializing pull request was open, the merged repository version wins
and the later planning revision is preserved as a handoff conflict for reconciliation.

## Derived code topology and blast radius

Tieline can separately derive a conservative code topology from repository source. This does not
replace the authored contract and does not use a graph database. Developers explicitly compile
one thin, reviewable `.tieline/topology/graph.json`; local and historical reads select that file
without parsing source or writing files. PostgreSQL can hold the richer, queryable projection of
an accepted `main` generation. Local compilation never writes it. The compiled manifest remains
the authority for business intent.

The repository artifact retains a thin traversal projection: file hashes, locator-bearing
symbols, adjacency, and unresolved dependency frontiers. Parser diagnostics, source ranges,
reference facts, and resolved explanations remain available in committed PostgreSQL generations
but are not duplicated in the artifact.

| Store | Role | Update boundary |
| --- | --- | --- |
| `.tieline/topology/graph.json` | Deterministic, repository-local traversal snapshot for review and Git history | Explicit `tieline code compile`; commit it with the source change |
| PostgreSQL topology tables | Rich shared projection for hosted reads of accepted code | A protected repository publisher after merge to `main` |

They identify the same derived generation but are not competing authorities. `graph.json`
contains no Story or AC bodies; trace and blast radius join its code locators to the matching
compiled manifest at read time.

This release defines the relational schema and repository but does not attach topology
publication to the existing repository-sync command. Until that merge-only publisher is added,
`code compile` writes only `graph.json` and hosted topology is available only when a trusted
integration explicitly persists a complete generation.

```bash
# Explicitly derive the artifact after selected source or resolver changes.
tieline code compile . --json

# Verify integrity and freshness without parsing or writing.
tieline code validate . --json

# Follow statically derived imports from one exact symbol.
tieline code trace --path src/commands/code-topology.ts \
  --selector function:executeDependencyTrace --direction dependencies --json

# Find code that may depend on changes since a Git base, then join visited
# locators to authored AC claims. The default direction is dependents.
tieline code blast-radius --base origin/main --json
```

The equivalent read-only MCP tools are `trace_code_dependencies` and
`analyze_code_blast_radius`. CLI and MCP delegate to the same domain results. Local reads need no
database and never compile or silently repair topology. Missing, stale, incompatible, invalid,
over-capacity, and unsafe artifacts are named nonzero outcomes with an explicit compile
remediation only for mutable workspace state. Historical reads load the topology and, for blast
radius, the manifest from the same resolved commit. A hosted dependency trace can continue to
select a compatible complete Postgres generation when no checkout is available.

### Supported structural facts

Intentionally narrower than each language:

| Language | Parsed symbols and module forms | Conservative resolution |
| --- | --- | --- |
| JavaScript, JSX, TypeScript, TSX | Classes, functions, methods, interfaces, types, enums, namespaces, top-level bindings, static imports, exports, re-exports, and literal dynamic imports | Relative files with supported extensions and index files, static `baseUrl`/`paths` aliases, and named exports/re-exports |
| Python | Classes, functions, methods, `import`, `from ... import`, relative imports, and public top-level exports | Repository and statically declared source roots, modules, packages, and named public symbols |
| Rust | Structs, enums, traits, types, modules, functions, constants, statics, methods within impl owners, `mod`, `use`, `pub use`, and grouped paths | Static Cargo crate roots, conventional module files, and `crate`, `self`, and `super` paths |
| SQL | Conservative top-level table, view, and function declarations with safely representable names | Not yet supported; SQL object references do not produce dependency edges or frontiers |

Dynamic module names, glob imports, generated modules, unsupported or non-static configuration,
external packages/crates, conditional package exports, and multiple possible targets remain named
`unresolved`, `external`, or `ambiguous` frontiers. Tieline never guesses an exact edge for them.
Parser recovery and capture truncation are also explicit.

Parser symbol and reference facts are tied to immutable source bytes and record zero-based UTF-16
code-unit offsets plus zero-based UTF-8 byte offsets; line and column values use the same named
coordinate systems. Derived edges preserve that identity through their source facts rather than
duplicating offsets on every record. Persisted compatibility includes the pinned parser/grammar
set, normalized query contract, resolver implementation and configuration digest, topology
schema, and fact policy. Incompatible generations are refused rather than silently mixed.

### Traversal limits

Traversal locates an exact repository path and optional canonical selector before walking.
Defaults are depth 4, 500 visited nodes, 2,000 edges/frontiers, and 100 returned paths. Hard
maxima are depth 8, 1,000 nodes, 4,000 edges/frontiers, and 200 paths. Results are cycle-safe and
report each independent truncation reason.

Code paths are labeled `derived_code_dependency`; authored joins are `contract_coupling` and say
only `may_be_impacted` with `semantic_support: not_assessed`. Two files sharing an AC do not
thereby depend on one another, and no topology result proves that an implementation satisfies an
AC or that a linked test passed.
