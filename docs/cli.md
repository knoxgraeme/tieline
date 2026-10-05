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
links, and Story-fallback links, and its `history`: the AC's latest 20 changes, newest first,
each with its commit, date, and pull request, read from git as [`contract history`](#history)
reads it, or why there is none. Both entry points stop after one AC-mediated hop.

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

Writes `.tieline/review.html`, a self-contained page with capability navigation, each Story's
lifecycle and acceptance criteria, scenarios and evidence links folded under each criterion,
search (`/`), `j` and `k` to move between Stories, links to a single criterion (`#<AC key>`), and
a print layout that expands everything. Open the file directly in a browser. Use `--output <path>` to write it elsewhere. When
[screens](screens.md) are enabled, the page adds a Screens view and shows each Story's and AC's
linked screens.

```bash
tieline contract review . --base origin/main
```

`--base <ref>` highlights the Stories, ACs, and screens the branch added, changed, or removed
relative to the manifest committed where the branch left that ref (`git merge-base <ref> HEAD`).
It reads only git, so it works offline. See [Changes on a branch](screens.md#changes-on-a-branch).

`contract review` also shows when each Story, AC, and screen last changed ("Last changed in #71 ·
2026-09-30 · 4 changes"), linked to the pull request when `origin` is on GitHub, from the history
`contract history` reads. Without git history the page is written without it and says why.

### History

```bash
tieline contract history [--key <stable-id>] [--limit <n>] [--ref <ref>] [--json]
```

Lists when Stories, ACs, and screens were added, changed, or removed, newest first, with the pull
request that did it, or one item's changes with `--key`. A commit changed an item when the
manifest it commits differs from its first parent's for that item: its content, its `shows`
links, its place, or a screen's screenshot digest or ARIA snapshot. History follows the
first-parent line, so on `main` a pull request merged with a merge commit counts as that commit,
and the pull request number is read from the commit subject (`… (#123)` or
`Merge pull request #123`). It reads at most `--limit` commits that changed the contract (200 by
default, up to 2000) and says when older history was not read. A shallow clone's history is
reported as cut short, and commits a partial clone does not hold are listed as unreadable
instead of being fetched.

## Screens

Screens are an optional feature; see [Screens](screens.md) to opt in. Once enabled, import
catalog entries from a JSON file:

```bash
tieline screens import screens.json --dry-run
tieline screens import screens.json
tieline contract compile .
```

Re-importing updates entries by key and never duplicates them. `--prune` removes entries the file
omits, only within the capabilities it names. An entry for a capability the spec does not declare
stops the import unless `--skip-unknown-capabilities` is passed. Pass `--json` for a
machine-readable summary.

```bash
tieline screens capture --changed --base origin/main [--dry-run | --verify] [--repeat <n>] [--json]
tieline screens capture --all [--verify]
```

Captures the screens a branch may have changed with the repository's own Playwright tests tagged
`@screen:<key>`, each selected with the rule and file that selected it. `--all` and
`--screen <key>` select every screen or named ones. `--dry-run` only reports the selection;
`--verify` compares a fresh capture with the committed outputs, writes nothing (with hosted
screens on, it keeps the screenshots it reproduced exactly in the git-ignored captures directory),
and exits 1 on any difference; `capture --changed --base <base> --verify` is the recommended
pull-request check, and verifies every screen when a selection rule cannot run. `--repeat <n>` keeps
only screens captured identically n times. Screens marked not captured are skipped, and selected
screens no test tags are listed as not covered. See [Capture with Playwright](screens.md#capture-with-playwright) and
[Selecting screens to capture](screens.md#selecting-screens-to-capture).

```bash
tieline screens scenes [--check] [--json]
```

Writes `screens.capture.generated_scenes.file`: a scene for every catalogued page no other test
captures, each calling the configured setup module and capturing the page, so no one writes a
test just to open a page. `--check` writes nothing and exits 1 when the file is out of date with
the catalog. See [Generated page scenes](screens.md#generated-page-scenes).

```bash
tieline screens audit [--strict | --capture] [--json]
```

Lists screens missing a screenshot digest, capture record, committed ARIA snapshot, or
`@screen` test, mismatched and orphaned ARIA snapshots, page files no screen claims, and UI
acceptance criteria no `@ac:`-tagged test proves, and generated page scenes that are out of date,
without capturing anything. `--strict` exits 1
on any of them, as a coverage gate. `--capture` re-captures every screen and reports the drift.
See [Audit](screens.md#audit) and [Coverage](screens.md#coverage).

```bash
tieline screens publish (--pull-request <number> | --branch <name>) [--commit <sha>] [--summary-file <path>] [--trusted <path>] [--json]
tieline screens close --pull-request <number> [--json]
tieline screens prune [--json]
```

With [hosted screens](screens.md#hosted-screens) enabled, `publish` stores a pull request's or
branch's review page, compared with `main`, and uploads the screenshots the bucket lacks; it
publishes nothing unless every screenshot the page shows is stored. `--trusted <path>` names a
checkout Tieline trusts, such as the default branch's: the published checkout must name its
repository key, bucket, and site URL, or nothing is published. `close` marks a pull request
closed, and `prune`, run after sync on `main`, deletes what retention no longer keeps. `main` is
published by `tieline contract sync`, never by `publish`. `--summary-file` writes the Markdown
CI posts as the pull request's screens comment.

```bash
tieline hosted init --host netlify [--directory <path>] [--force] [--json]
tieline hosted check [--url <site>] [--json]
```

`hosted init` writes a Netlify site that serves hosted screens into `.tieline/hosted/`, without
replacing edited files unless `--force` is passed. `hosted check` writes, finds, and deletes a
probe object in the bucket, checks that each database credential set in the environment can do
its job, and, given the site's URL (or `screens.hosted.site_url`), fails if the site answers a
visitor who has not logged in. See [Hosted screens](screens.md#hosted-screens).

## CI check

```bash
tieline check --base <base-ref> .
```

Use the comparison ref supplied by the caller when available. Otherwise, agents should determine
it from repository metadata, preferring the remote-tracking default branch, and ask only when it
cannot be determined; do not assume every repository uses `origin/main`.

Every `--base` comparison — `check`, `contract reconcile`, `contract grade`, and
`code blast-radius` — starts from where the current branch left the base, `git merge-base <base>
HEAD`, not from the base's latest commit. Commits that reached the base after the branch point are
therefore never reported as this branch's changes. In CI a pull request is normally checked out
merged into the base's tip, whose merge-base is that tip, so CI results are unaffected. JSON
output from `check` and `reconcile` records the commit used as `base_commit`. The comparison needs
the branch point in local history, so shallow clones must fetch it (`fetch-depth: 0`). When a
criss-cross merge history leaves more than one equally good branch point, the command refuses to
guess; pass the commit to compare with as `--base`.

The check compares changed, renamed, and deleted paths with manifest locators and reports each
affected AC plus its freshness. It also sweeps every link for broken targets, whether or not the
diff touched them, because a link can rot without the change under review going near it.

| State | Cause | Effect |
| --- | --- | --- |
| stale | The linked file differs from its compiled baseline, or has no recorded baseline. Whether the AC still holds needs semantic review. | Warning, exit 0 |
| broken | The linked path is missing, is not a file, or resolves outside the repository. | Error, exit 1 |
| stale manifest | The committed manifest differs from what the current contract compiles to. | Error, exit 1 |

Broken links fail the check because deciding they are wrong needs no judgement: the manifest
points at evidence that is not there. Pass `--no-fail-on-broken` to downgrade broken links to
warnings and exit zero. A stale manifest also fails by default: run `tieline contract compile .`,
review the semantic diff, and commit the result. Use `--no-fail-on-stale-manifest` only when
intentionally downgrading that integrity gate to a warning. Invalid YAML or an unreadable
manifest fails because no trustworthy result can be computed.

When [screens](screens.md) are enabled, the check also fails when the screen catalog does not
validate, and treats a `shows` link in the working-tree spec to a screen the catalog does not
contain as a broken link. It also warns, without changing the exit code, about the screens
`tieline screens audit` reports. Repositories without screens see no difference.

See [the GitHub Actions example](examples/tieline-check.yml).

## Post-merge sync

```bash
tieline contract sync . --expected-previous-commit <previous-main-sha>
```

Sync is idempotent and checkpointed. A delayed job cannot overwrite a newer projection. If
planning changed while a materializing pull request was open, the merged repository version wins
and the later planning revision is preserved as a handoff conflict for reconciliation.

Sync also records **change events**: when each Story, AC, and screen was added, changed, or
removed on the synced branch, and in which pull request, read from the committed manifest's git
history as [`contract history`](#history) reads it. The first sync records the history git holds
(at most 2000 commits that changed the contract); each later one records what changed after the
last recorded commit, so several pull requests merged between syncs are each recorded. Recording
the same commit again changes nothing. When the synced commit is not a git commit (an explicit
`--commit` label) or git history cannot be read, sync says so and is otherwise unchanged. When
some commits cannot be read, such as those a partial clone does not hold, changes newer than
them wait: recording them would move the resume point past the gap, so a later sync, once git
can read those commits, records the gap and what followed it; when the
database refuses the events, the contract stays synced, sync exits 1, and running it again
records what was missed. Run `tieline migrate` after upgrading so the table exists.

Screens are not synced to the contract tables: sync removes screen catalogs and `shows` links
before writing and reports what it skipped. With hosted screens enabled, sync then publishes
`main`'s hosted page and exits 1 if it could not, after the contract was synced; running it again
at the same commit retries only the screens. See [Screens](screens.md#database-sync).

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

### Review complete criteria

Legacy `contract grade` callers retain link-level, all-impacted behavior. For
routine closeout, select changed claims and grade an AC across its evidence:

```sh
tieline contract grade . --base origin/main --unit criterion --scope claims --emit-scope --json
tieline contract grade . --base origin/main --unit criterion --scope claims --verify verdicts.json --json
```

Claims include criterion text, scenarios, AC/Story applicability, and code/test
link changes, including removal. All local evidence of a selected AC is included,
not just changed files. `implementation_only_criteria` and `removed_criteria`
remain explicit reconciliation work. Use `--scope impacted` for sensitive or
uncertain implementation drift. An empty claims scope is not a semantic approval.

Each verdict requires `id`, `grade`, and `reason`. Supported verdicts carry a
`citations` array of exact `{link_id, selector}` pairs. Optional `link_findings`
records irrelevant locators independently of overall support. `inconclusive`
distinguishes unavailable evidence from a contradicted claim. Verification binds
all supporting source snapshots, rejects duplicate/out-of-scope identities, and
downgrades missing judgments or fabricated citations. Strict criterion mode fails
on unsupported, inconclusive, or link findings; partial alone remains advisory.
Scopes are bounded to 1,000 criteria/5,000 links and verdict input to 16 MiB.
See the [agent workflow](../skills/tieline/references/criterion-grading.md).

### Publish a post-merge manifest

`manifest_mode: "post_merge"` is an explicit opt-in in `.tieline/config.json`.
The default remains `committed`. In post-merge mode, `check` and `contract grade`
validate current YAML in memory and report pending publication; broken evidence
still fails. Grading compares authored YAML at the base, not a stale generated
baseline. Existing artifact-first context reads retain published freshness.

```sh
tieline contract refresh-manifest . --branch env/staging --remote origin --json
```

This command **writes to the named remote branch**. Run it only in the approved
post-merge publisher. It uses a temporary worktree, stages only standard manifest
output, and uses normal pushes with at most three attempts for concurrent merges.
The working checkout and current branch are left alone. See
[maintenance setup and recovery](operations.md#post-merge-manifest-maintenance-opt-in).

### Compiled fingerprints and legacy manifests

Manifest version 3 names file fingerprints `compiled_content_hash`. This is a
whole-file SHA-256 measurement made by compilation, not proof that a rule was
reviewed. Current readers also accept version 2 manifests and normalize the old
`reviewed_content_hash` field without changing its baseline. Conflicting old/new
values are rejected. Serialization emits only the new field. Upgrade consumers
before publishing v3 manifests; older clients reject the new manifest version.
Context and reconciliation responses retain a deprecated `reviewed_content_hash`
alias during migration. Database column names remain unchanged behind adapters.
The normalized manifest digest changes on migration, so regenerate dependent
topology artifacts once. Hash freshness and semantic review remain separate facts.

### Commit-bound closeout

```bash
tieline contract closeout . --base origin/main --head HEAD --emit-scope --json
tieline contract closeout . --base origin/main --head HEAD --verify .context/closeout.json --json
```

Closeout reads committed config and authored YAML from the target/head merge base
and head, independently of compiled manifests and dirty working-tree content.
Both old and new links contribute affected ACs, including removed rules, inherited
applicability/lifecycle changes and implementation-only edits. Configuration changes
conservatively include all ACs. Output records resolved full commits, a scope hash,
and `unmapped_changed_paths`; completeness applies only to the listed ACs.

The report copies the emitted `binding` and records `still_valid`, `updated`, or
`unresolved` dispositions with explanations; related ACs may share a disposition.
Updated findings cite changed repository paths. Changed claims cannot be marked
`still_valid`. See [the report format](../skills/tieline/references/closeout.md).
Missing/unresolved dispositions return exit 1; stale bindings, duplicates, unknown
ACs and invalid paths fail validation. `complete: true` does not imply `ready: true`
or semantic correctness. A zero exit is evidence of current, resolved review
records, not proof of their truth, executed tests or human approval.

Keep the report outside its own commit and include it in the PR body. A new head
or target revision requires renewed verification. For CI, supply expected revisions
from trusted PR event metadata, not from the report. This command does not install
a CI job or change branch protection. It requires root-level committed Tieline
configuration, at most 1,000 affected ACs and a report no larger than 2 MiB.
