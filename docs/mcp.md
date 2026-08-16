# MCP reference

[README](../README.md) · [Setup](setup.md) · [Concepts](concepts.md) · [CLI](cli.md) · **MCP** · [Operations](operations.md)

The MCP server exposes exact local context, derived code traversal, and optional database-backed
product knowledge. Prefer exact identity when a path, selector, or stable ID is already known;
use discovery only when it is not.

## Intent and topology reads

| Tool | Purpose | Data source | Database |
| --- | --- | --- | --- |
| `get_asset_intent_context` | Read the selector-aware intent neighborhood for a known code or test locator | Compiled manifest | No |
| `get_acceptance_criterion_context` | Read one exact AC and its associated code and tests | Compiled manifest | No |
| `get_path_criteria` | List the ACs linked to one or more repository paths | Compiled manifest | No |
| `trace_code_dependencies` | Follow statically derived imports or references from an exact symbol | Topology snapshot | No |
| `analyze_code_blast_radius` | Find code and linked ACs that may be affected by changes since a Git base | Topology plus manifest | No |
| `query_stories` | Filter synced Stories and ACs by authority, lifecycle, IDs, or locators | PostgreSQL | Yes |
| `find_related` | Discover related product records when exact identity is unknown | PostgreSQL | Yes |

Manifest and topology reads require the MCP server to run with the repository as its workspace.
Database-backed reads make the accepted contract available to connected agents that do not have
their own checkout.

## Evidence and planning

| Tool | Purpose | Writes state |
| --- | --- | --- |
| `record_observation` | Append a request, bug, or question and return possible relationships | Yes |
| `decide_attribution` | Confirm or dismiss an Observation relationship | Yes |
| `get_backlog_item` | Read a Backlog Item revision and its Observation, Story, and AC links | No |
| `create_backlog_item`, `update_backlog_item` | Manage optional work records after reading the current revision | Yes |
| `set_backlog_item_links` | Replace Observation and Story/AC targets atomically | Yes |
| `create_planning_story`, `update_planning_story` | Shape `backlog` Stories and ACs | Yes |
| `list_attribution_suggestions` | Review machine-proposed relationships and their provenance | No |
| `decide_attribution_suggestion` | Confirm or dismiss a machine suggestion | Yes |
| `list_handoff_conflicts` | Read planning-to-repository conflicts preserved during sync | No |

All evidence and planning tools require PostgreSQL. Repository-owned Stories and ACs cannot be
modified through these tools; they change in `.tieline/spec/**/*.yaml` and are accepted through
normal code review.

## Choosing a read

Use the narrowest known identity:

1. For a known code path or selector, call `get_asset_intent_context`.
2. For a known AC stable ID, call `get_acceptance_criterion_context`.
3. For a compatibility path-to-AC list, call `get_path_criteria`.
4. For a known symbol's static dependents, call `trace_code_dependencies`.
5. For branch-level possible impact, call `analyze_code_blast_radius`.
6. Without a repository, use `query_stories` for exact filters against the synced accepted state.
7. Use `find_related` only when the exact Story, AC, or locator is unknown.

Exact manifest reads return the stable repository key and a content-derived `manifest_digest` for
the contract that answered. They keep link provenance, direct versus Story-fallback scope,
freshness, locator resolution, and semantic support separate. A resolved locator proves that the
artifact can be found; it does not prove that the implementation satisfies the AC or that
a linked test ran.

## Code dependency traversal

`trace_code_dependencies` starts from an exact file plus canonical symbol selector. It reads the
committed `.tieline/topology/graph.json` snapshot rather than parsing during the request.

Traversal defaults to dependents, which answers “what may rely on this?” It can instead follow
dependencies. Results include visited symbols, static edges, cycles, unresolved or ambiguous
frontiers, truncation state, and the source commit represented by the snapshot.

## AC-aware blast radius

`analyze_code_blast_radius` compares the workspace with a Git base, identifies changed symbols,
follows possible dependents, and joins visited code back to exact authored Story and AC locators in
the manifest.

The response distinguishes:

- code reached through static dependency analysis;
- ACs linked directly to changed or reached locators;
- unresolved, ambiguous, and external frontiers;
- traversal limits or cycles that constrained the result; and
- missing or stale topology and manifest prerequisites.

Returned ACs are `may_be_impacted`, with `semantic_support: not_assessed`. The traversal is a
conservative review aid rather than a claim about runtime execution or behavioral correctness.

## Connecting an agent

`npx -y tieline@latest init` registers the MCP server for selected coding agents. Repository-local
hosts launch the exact pinned Tieline package with `TIELINE_WORKSPACE` set to the repository.

For a remotely hosted MCP service backed by Postgres, follow [Operations](operations.md). Keep
repository-sync and administrative credentials out of ordinary agent environments; the MCP
server should receive only the read and planning-write credentials it needs.
