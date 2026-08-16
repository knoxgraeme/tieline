# Concepts

[README](../README.md) · [Setup](setup.md) · **Concepts** · [CLI](cli.md) · [MCP](mcp.md) · [Operations](operations.md)

## How the contract is structured

```text
Capability → User Story → Acceptance Criteria → zero or more Scenarios
```

Acceptance Criteria (ACs) are the primary graph anchor. Code, test, and Observation
relationships should target the most specific known AC; Story-level links remain useful as a
coarse fallback.

| Term | Meaning |
| --- | --- |
| Capability | A stable product or business area that groups related Stories |
| User Story | Desired behavior expressed through actor, goal, and benefit |
| Acceptance Criteria | Observable outcomes that define when a Story is satisfied |
| Scenario | An optional Given/When/Then example that clarifies an AC |
| Observation | Append-only source evidence: a request, bug, or question |
| Backlog Item | Optional work used to consolidate Observations before or alongside a Story |
| Artifact | Code or test evidence linked to a Story or AC |

An AC stands on its own. A Scenario is useful when a condition, edge case, or concrete example
would make the outcome easier to review; it is not required for the AC to be valid.

## How evidence becomes accepted

From proposed intent to accepted evidence, Tieline combines agent judgment with deterministic
checks. Each layer has a narrower job:

1. The Tieline skill reads configured product context, repository documentation, source entry
   points, schemas, migrations, and tests, then proposes Capabilities, Stories, ACs, and links.
2. Repository links identify a path and optionally a canonical code selector. Tree-sitter
   parsers provide exact symbols, ranges, and bounded snippets when the language is supported.
3. The grading workflow scopes changed claims and gives a fresh agent only the exact AC, current
   evidence, and closed citation allow-list. Verification rejects verdicts with missing, stale,
   or invented citations.
4. The YAML and compiled manifest are reviewed with the implementation. Merge is the acceptance
   boundary; no separate semantic approval service exists.
5. The manifest records hashes for accepted evidence. Later changes make affected links stale and
   therefore visible for review.
6. A separate code topology can follow static dependents and join visited locators back to the
   accepted AC links, producing an AC-aware possible blast radius.

The [README assurance table](../README.md#what-tieline-can-prove) summarizes what each signal
establishes and where its claims stop.

## Who can change each record

A Story stays the same kind of record as it moves from planning to delivery. Its lifecycle
determines which system may change it:

| Lifecycle | Authority | Writable from |
| --- | --- | --- |
| `backlog` | `planning` | Postgres planning tools |
| `in_progress` | `repository` | `.tieline/spec/**/*.yaml` in a code change |
| `production` | `repository` | `.tieline/spec/**/*.yaml` in a code change |
| `retired` | `repository` | `.tieline/spec/**/*.yaml` in a code change |

Materialization preserves planning Story and AC stable IDs. Once a code change containing those
IDs merges, repository sync claims the matching rows and Postgres becomes a searchable projection
of the accepted repository state. Repository-owned definitions cannot be edited through MCP
planning tools.

Observations and Backlog Items do not turn into repository records. Repository YAML may retain
stable `motivated_by` pointers without copying their source payloads.

## How the data is separated

- **Contract plane** — strict repository YAML for accepted Stories and ACs; planning Stories and
  ACs live in Postgres while they remain `backlog`.
- **Evidence plane** — append-only Observations, optional Backlog Items, and confirmed or dismissed
  relationships.
- **Derived plane** — the compiled manifest, code topology, grading scopes, candidate links,
  coverage, and freshness.
- **Governance plane** — repository history, pull-request review, sync checkpoints, conflicts, and
  audit events.

## Where data lives

| Location | Contents |
| --- | --- |
| `.tieline/` in the repository | Product context (`config.json`), contract YAML (`spec/`), compiled manifest (`manifest/`), and derived code topology (`topology/graph.json`) |
| PostgreSQL (optional) | A synced queryable projection of the accepted contract, plus Observations, Backlog Items, planning Stories, revisions, and search data |
| Private config directory | Database credentials and clone-local setup state; `~/.config/tieline/` by default and never committed |

The private config location can be changed through `TIELINE_CONFIG_HOME`, `XDG_CONFIG_HOME`, or
the platform-specific application-data directory.

## What contract YAML contains

```yaml
version: 1
capability:
  key: CONTRACT
  name: Living product contract
  description: Accepted product behavior is reviewable beside the implementation.
  stories:
    - key: CONTRACT-001
      title: Review accepted behavior with code
      actor: maintainer
      goal: define product behavior in a stable Story and AC hierarchy
      benefit: intent and implementation change through the same review
      lifecycle: production
      acceptance_criteria:
        - key: CONTRACT-001-AC1
          criterion: Tieline must reject contract documents that violate the accepted schema.
          rationale: Structural failures make impact analysis and synchronization untrustworthy.
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: tieline
                path: src/contract/schema.ts
            - relation: tests
              provenance: authored
              target:
                kind: test
                repository: tieline
                path: tests/unit/contract/test-contract.ts
                framework_hint: custom-script
```

Accepted Stories store `title`, `actor`, `goal`, and `benefit` separately and render the familiar
"As a … I want … so that …" sentence. Each accepted AC states one observable outcome using
`<subject> must <outcome> [when <condition>]`. Scenarios use framework-neutral Given/When/Then
text; no test framework is required.

Every link states its provenance. `authored` means the claim is explicitly declared in repository
YAML and accepted through normal review, regardless of whether a person or agent drafted it.
`inferred` identifies a derived claim, and `materialized` identifies a copied projection.

Stable IDs are identity, not search prose. Aliases support alternate language, applicability
distinguishes legitimately different behavior, and `supersedes` converges definitions without
deleting history.

## What the compiled manifest contains

Compilation writes `.tieline/manifest/`, one file per capability plus a small index:

```text
.tieline/manifest/
  index.json        schema version and stable repository key
  CONTRACT.json     one capability plus its source file and reviewed hashes
  RETRIEVAL.json
  ...
```

A capability is exactly one specification file, so capability shards follow the boundary already
present in the contract. Separate shards reduce unrelated merge conflicts. Compilation deletes
stale shards for capabilities the specification no longer declares.

The manifest intentionally repeats normalized contract content. YAML is the authoring source;
the manifest is the deterministic, hash-bearing read model used by local tools, CI, and sync.

## What the code topology contains

`tieline code compile` writes `.tieline/topology/graph.json`. It records source hashes,
locator-bearing symbols, resolved static adjacency edges, and unresolved dependency frontiers for
supported source languages. Reads query this committed snapshot without starting a parser or
writing to Postgres.

The topology is not a second source of product truth. It describes code-to-code relationships;
the contract describes accepted intent-to-code relationships. Exact repository/path/selector
locators join them for dependency tracing and AC-aware blast-radius analysis.

Repository sync and topology compilation are separate operations. A main-branch workflow should
compile and commit the reviewed topology with code changes, then sync the accepted contract and
topology projection after merge when Postgres-backed access is configured.

## How coverage and freshness work

Implementation-link and test-link coverage are independently `none`, `partial`, or `complete` for
repository-owned Stories. Only direct AC links count; Story-level fallback links remain
searchable.

Freshness compares linked repository content with the reviewed manifest hash. It does not claim
that a test ran or passed. Test-execution receipts are outside the current assurance model.

Repository mapping coverage uses the configured source roots and exclusions as its denominator.
Reports include the percentage and every unmapped eligible file. Path coverage and behavioral
correctness remain separate. When no eligible files exist, coverage is `null` with
`status=no_eligible_files`; it is never reported as 100%.

Each mapped file has a confidence tier:

| Tier | What is known | What remains unknown |
| --- | --- | --- |
| `asserted` | An accepted link names the file | Whether the evidence was measured against current bytes |
| `hash_current` | The file matches the content recorded in the reviewed manifest | Whether the implementation still does what the AC says |

`hash_current` compares against the committed manifest because that is the record of the content
a reviewer accepted. Compiling a new manifest from the working tree measures the current state but
cannot, by itself, show drift from the previously accepted state.
