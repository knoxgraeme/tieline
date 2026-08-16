<p align="center">
  <img src="assets/tieline-logo.png" alt="Tieline" width="520">
</p>

<p align="center">
  <strong>Give every agent durable product intent, grounded in the code that delivers it.</strong>
</p>

<p align="center">
  <a href="#how-it-works">How it works</a> ·
  <a href="#quickstart">Quickstart</a> ·
  <a href="#how-the-code-graph-works">Code graph</a> ·
  <a href="#what-agents-can-ask">Agent queries</a> ·
  <a href="docs/setup.md">Docs</a>
</p>

---

Tieline stores accepted Capabilities, Stories, and Acceptance Criteria in Git and links them to
the exact code and tests offered as evidence. Agents no longer have to infer product intent from
scratch on every run.

- **Reviewed intent:** Stories and ACs evolve beside the implementation and are accepted through
  normal pull-request review.
- **Graded evidence:** a fresh grader assesses changed ACs against bounded source evidence and a
  closed citation list, returning `supported`, `partial`, or `unsupported`.
- **A committed code topology:** `.tieline/topology/graph.json` records parsed symbols and static
  dependencies, letting agents trace code and connect possible impact back to accepted ACs.

The contract works directly from a repository. When synced to optional Postgres, any connected
agent—including product, research, and support agents without a checkout—can query the accepted
state of `main`.

## How it works

1. **An agent proposes intent.** The Tieline skill reads product context and code, then drafts or
   updates Stories, ACs, and evidence links for review.
2. **Parsers ground code links.** Tree-sitter extracts canonical symbols, source ranges, and bounded
   snippets. Conservative resolvers preserve ambiguous and unresolved relationships as diagnostics.
3. **A fresh agent grades the evidence.** The grader receives one AC, its current evidence, and a
   closed citation list. Deterministic verification rejects stale or invented citations.
4. **Review establishes acceptance.** The YAML, compiled manifest, topology, and code change travel
   together. Merge accepts that version of the relationship.
5. **Checks make drift visible.** The skill updates intent as behavior changes, while `tieline check`
   flags changed evidence, broken links, invalid contracts, and stale artifacts.

Optional Postgres storage adds Observations such as feature requests, ideas, and bugs, giving agents
context on both accepted behavior and future direction.

[How evidence, authority, and freshness work →](docs/concepts.md)

## What Tieline can prove

Each signal has a narrow meaning. Tieline exposes the boundary instead of presenting static or
agent-generated evidence as formal proof:

| Signal | What it establishes | What it does not establish |
| --- | --- | --- |
| `authored` link | An explicit contract claim was accepted through repository review | Permanent semantic correctness |
| Resolved selector | The current symbol can be identified precisely | That its implementation satisfies the AC |
| `hash_current` | The evidence still matches the bytes accepted in the manifest | That the original review was correct |
| Grade | A fresh agent judged current allowed evidence as supported, partial, or unsupported | Formal proof or test execution |
| Blast-radius result | Static code dependents and their linked ACs may be impacted | Runtime reachability or guaranteed breakage |

## How the code graph works

`.tieline/topology/graph.json` is a committed, derived snapshot of the repository's source
structure. `tieline code compile` uses Tree-sitter parsers to build it; later reads query the
snapshot without starting a parser or writing to Postgres.

| Layer | Role |
| --- | --- |
| Stored file hashes | Identify the exact source bytes represented by the snapshot |
| Stored locator-bearing symbols | Identify code assets for traversal and authored joins |
| Stored resolved adjacency edges | Trace static dependencies and dependents |
| Stored unresolved dependency frontiers | Keep ambiguous imports and unsupported boundaries visible |
| Query-time AC join (not stored) | Match visited paths and selectors to authored AC links |

Source ranges, source snippets, raw reference and resolution facts, and parser diagnostics are not
duplicated in `graph.json`.

```text
source code → Tree-sitter → graph.json → symbols and static dependents
                                      + authored AC links
                                      ↓
                              AC-aware blast radius
```

Explicit blast-radius analysis starts from the supplied locators. A Git-base comparison instead
seeds every symbol in changed files plus the endpoints of changed edges. Both follow static
dependents, then perform the authored locator-to-AC join. Cycles, external dependencies,
ambiguity, and traversal limits remain visible. The result is a bounded impact signal, not a
runtime call graph or a guarantee of breakage.

[Topology and blast-radius commands →](docs/cli.md#derived-code-topology-and-blast-radius)

## What the contract looks like

```yaml
version: 1
capability:
  key: CONTRACT
  name: Living product contract
  description: Accepted product behavior is reviewable beside the implementation.
  stories:
    - key: CONTRACT-003
      title: Inspect accepted intent before changing an asset
      actor: implementing agent
      goal: retrieve reviewed context for a known code locator
      benefit: implementation begins from accepted intent
      lifecycle: production
      acceptance_criteria:
        - key: CONTRACT-003-AC4
          criterion: Tieline must expose exact manifest-backed context without a database.
          scenarios:
            - given: the compiled manifest is available
              when: an agent requests context for a known code locator
              then: Tieline returns its accepted intent and linked evidence
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: tieline
                path: src/tools/intent-context.ts
                selector: function:registerIntentContextTools
            - relation: tests
              provenance: authored
              target:
                kind: test
                repository: tieline
                path: scripts/test-intent-context.ts
```

An AC is complete on its own. Given/When/Then Scenarios are optional examples for important
conditions or edge cases.

## Quickstart

```bash
cd /path/to/your-repository
npx -y tieline@latest init
```

Restart your agent, then run the /tieline skill to begin onboarding. The skill proposes the initial contract and code links for review; the generated
`.tieline/review.html` provides a browser-friendly view.

Postgres is optional. Use it to allow all your agents to query the current state of your product, and to record 'Observations' like feature requests alongside the products current state. The postgres DB gets updated with each merge. See [Setup's post-merge sync](docs/setup.md#post-merge-contract-sync) for configuration.

## What agents can ask

| Ask | Tool |
| --- | --- |
| “What is this symbol supposed to do?” | `get_asset_intent_context` |
| “What implements `RETRIEVAL-001-AC1`?” | `get_acceptance_criterion_context` |
| “Which criteria touch these paths?” | `get_path_criteria` |
| “Which code may depend on this symbol?” | `trace_code_dependencies` |
| “Which accepted behaviors may this branch affect?” | `analyze_code_blast_radius` |

Exact manifest and topology reads work from the repository. Database-backed reads expose the
synced accepted contract to agents without repository access. Planning tools can also capture
Observations and shape backlog Stories.

[Full MCP reference →](docs/mcp.md)

## How the contract stays current

During implementation, the Tieline skill proposes new Stories and ACs when behavior was added,
updates existing definitions when behavior changed, reconciles evidence links, grades changed
claims, and refreshes generated artifacts for review.

Run the deterministic check in CI:

```bash
npx -y tieline@latest check --base <base-ref> .
```

Invalid YAML, broken links, and stale generated artifacts fail. Changed linked evidence identifies
the affected ACs for agent or human review. After merge, an idempotent sync publishes accepted
`main` to Postgres.

[GitHub Actions example](docs/examples/tieline-check.yml) · [CLI reference](docs/cli.md)

## Where to learn more

| Guide | Contents |
| --- | --- |
| [Setup](docs/setup.md) | Initialization, database modes, sync, and agent registration |
| [Concepts](docs/concepts.md) | Contract structure, evidence, authority, and freshness |
| [CLI](docs/cli.md) | Contract, topology, check, sync, grading, and review commands |
| [MCP](docs/mcp.md) | Local and database-backed tools for agents |
| [Operations](docs/operations.md) | Serving, credentials, durability, and privacy |

## License

[MIT](LICENSE)
