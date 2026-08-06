<p align="center">
  <img src="assets/tieline-logo.png" alt="Tieline" width="520">
</p>

# Tieline

Tieline is a living semantic contract for how a product and business work. It
connects user intent to code, tests, help content, requests, bugs, questions,
and planned work, while keeping the accepted definition reviewable beside the
implementation.

The core hierarchy is:

```text
Capability → User Story → Acceptance Criterion → optional Scenario
```

Acceptance Criteria (ACs) are the primary graph anchor. Code, test, help, and
observation relationships should target the most specific known AC; Story-level
links remain useful as a coarse fallback.

### Vocabulary

| Term | Meaning |
| --- | --- |
| Capability | A stable product or business area that groups related Stories |
| User Story | Desired behavior expressed through actor, goal, and benefit |
| Acceptance Criterion | One observable outcome that defines when a Story is satisfied |
| Scenario | An optional Given/When/Then example for an AC |
| Observation | Append-only source evidence: a request, bug, or question |
| Backlog Item | Optional work used to consolidate Observations before or alongside a Story |
| Artifact | Code, test, or external help content linked to a Story or AC |

## Authority model

A Story stays the same kind of record as it moves from ideation to delivery. Its
lifecycle determines which system may change it:

| Lifecycle | Authority | Writable from |
| --- | --- | --- |
| `backlog` | `planning` | Postgres planning tools |
| `in_progress` | `repository` | `.tieline/spec/**/*.yaml` in a code change |
| `production` | `repository` | `.tieline/spec/**/*.yaml` in a code change |
| `retired` | `repository` | `.tieline/spec/**/*.yaml` in a code change |

Materialization preserves the planning Story and AC stable IDs. Once a code
change containing those IDs merges, repository sync claims the matching rows
and Postgres becomes a searchable projection. Repository-owned definitions
cannot be edited through MCP planning tools.

Normal code review and merge are the acceptance boundary. There is no separate
semantic decision system or ownership roster, and semantic warnings do not stop
deployment in the MVP.

## Four planes

- **Contract plane:** strict repository YAML for accepted Stories/ACs; planning
  Stories/ACs in Postgres while they remain `backlog`.
- **Evidence plane:** append-only Observations (`request`, `bug`, `question`),
  optional Backlog Items, and confirmed/dismissed relationships.
- **Derived plane:** focused Story, AC, Scenario, Backlog Item, and sanitized
  Observation embedding documents; candidate links, coverage, and freshness.
- **Governance plane:** repository history, pull-request review, versioned
  retrieval profiles, sync checkpoints, conflicts, and audit events.

Observations and Backlog Items do not move into the repository. Repository YAML
may retain stable `motivated_by` pointers without copying their source payloads.
Help content also remains external/DB-native; contract links use its stable
`source + external_id` pointer.

## Contract YAML

```yaml
version: 1
capability:
  key: RETRIEVAL
  name: Intent-aware retrieval
  description: People and agents retrieve the right business context.
  stories:
    - key: RETRIEVAL-001
      title: Search with an explicit intent
      actor: support specialist
      goal: find the production behavior behind a question
      benefit: answers are grounded in accepted product intent
      lifecycle: production
      aliases: [production behavior search]
      acceptance_criteria:
        - key: RETRIEVAL-001-AC1
          criterion: Tieline must exclude planning records from support results.
          rationale: Support answers should distinguish shipped behavior from ideas.
          scenarios:
            - given: production and backlog Stories match a query
              when: the support profile is selected
              then: only production contract records must be returned
          links:
            - relation: implements
              provenance: authored
              target:
                kind: code
                repository: tieline
                path: src/adapters/postgres/semantic-repository.ts
            - relation: tests
              provenance: authored
              target:
                kind: test
                repository: tieline
                path: scripts/integration-evidence.ts
                framework_hint: custom-script
            - relation: documents
              provenance: authored
              target:
                kind: help
                source: intercom
                external_id: retrieval-profiles
```

Accepted Stories store `title`, `actor`, `goal`, and `benefit` separately and
render the familiar “As a … I want … so that …” sentence. Each accepted AC states
one observable outcome using `<subject> must <outcome> [when <condition>]`.
Scenarios use framework-neutral Given/When/Then text. Test locators may include a
`framework_hint`, but no test framework is required.

Every link states its provenance: `authored` for a deliberate human-authored
claim, `inferred` for a derived claim, or `materialized` for a copied projection.

Stable IDs are identity, not embedding prose. Aliases support alternate language,
applicability distinguishes legitimately different behavior, and `supersedes`
converges definitions without deleting history.

## Requirements and installation

- Node.js 20.12 or newer.
- Docker with a running daemon when using `--database local`.
- An existing PostgreSQL database with pgvector when using
  `--database existing`.
- Embeddings are optional for retrieval. An OpenAI-compatible provider,
  Supabase Edge function, or the optional local runtime adds vector similarity;
  full-text and identifier search remain available without one.

Install the published CLI from npm:

```bash
npm install --global tieline
tieline --help
```

Contributors, or users who specifically need the current `main` branch, can
instead install from source:

```bash
git clone https://github.com/knoxgraeme/tieline.git
cd tieline
npm ci
npm run build
npm link
tieline --help
```

`npm link` makes that checkout's compiled `tieline` command available on the
current machine. Without it, replace `tieline` in the examples below with
`node dist/cli.js` from the checkout.

## Initialize and onboard a repository

For an interactive setup, run Tieline from the repository and confirm the
detected product, remote-derived repository name, context, source roots,
database, and embedding settings:

```bash
cd /path/to/product-repository
tieline init
```

The same setup remains prompt-free for automation:

```bash
tieline init /path/to/product-repository \
  --database offline \
  --embedding hash \
  --description "A concise description of the product and business" \
  --context docs/product-context.md \
  --yes
```

`--yes` never installs an agent skill unless both the target agents and scope
are explicit. To initialize and install `tieline-author` for multiple agents:

```bash
tieline init /path/to/product-repository \
  --database offline \
  --embedding local \
  --yes \
  --agent codex \
  --agent claude-code \
  --skill-scope project
```

The context file is supplied by the repository; init records its repo-relative
location rather than generating or copying it. A durable product-context file
can hold business purpose, actors, domain terms, invariants, and glossary
entries. It should describe the business, not ideas, feature requests, or a
second backlog.

Choose the database mode based on the workflow:

| Mode | Behavior |
| --- | --- |
| `offline` | Writes the workspace and supports local YAML/manifest authoring without organization-wide matching |
| `local` | Creates or reuses a dedicated Docker PostgreSQL + pgvector database and stores clone-local credentials privately |
| `existing` | Connects your own Postgres 16 + pgvector database identified by `DATABASE_URL_ADMIN`; no Docker container is required |

`--embedding hash` is deterministic and intended only for development and
tests. For a real deployment, choose `local`, `openai`, or `supabase-edge`.
In `existing` mode, the baseline defines the least-privilege roles as
`NOLOGIN`. Before init, provide URLs for operator-managed login roles that
inherit `tieline_reader`, `tieline_planning_writer`, and
`tieline_repository_sync`; init does not create or rotate passwords.
Tieline is provider-neutral: a local Postgres installation, Neon, Supabase,
RDS, or any other managed Postgres with pgvector enabled works. It reads
`DATABASE_URL_ADMIN` from the environment or a local `.env`; credentials are
never accepted as CLI arguments. Provisioning tools that synchronize `.env`
files are picked up automatically.
Init writes shared product context, source roots, contract paths, and runtime
defaults to `.tieline/config.json`. Clone-local setup state and credentials live
in a private profile outside the repository, so a new clone completes its own
runtime setup instead of inheriting another machine's "ready" state.

On a new repository, the only Tieline command a user needs to begin onboarding
is `tieline init`. It captures deterministic setup, then can install the
packaged `tieline-author` skill for manually selected coding agents. Tieline
does not auto-detect or launch an agent, persist agent choices in shared
configuration, or invent generic starter content.

Interactive setup offers Claude Code, Codex, Cursor, Gemini CLI, GitHub Copilot,
OpenCode, and Windsurf. Choose `project` to install for this repository or
`global` to install for the current user. Project scope is the interactive
default. Use `--skip-skill-install` to explicitly defer installation.

| `--agent` ID | Coding agent |
| --- | --- |
| `claude-code` | Claude Code |
| `codex` | Codex |
| `cursor` | Cursor |
| `gemini-cli` | Gemini CLI |
| `github-copilot` | GitHub Copilot |
| `opencode` | OpenCode |
| `windsurf` | Windsurf |

Tieline delegates native agent-directory handling to Skillfish. It invokes the
latest installer through `npx`, against Tieline's public default branch and
without adding Skillfish as a package dependency. A single-target project
invocation has this shape:

```bash
npx --yes --package=skillfish@latest skillfish add knoxgraeme/tieline \
  --path skills/tieline-author \
  --agent "Codex" \
  --project \
  --yes \
  --json
```

If the optional install fails or does not finish within two minutes, the
workspace and private runtime profile remain ready. Tieline terminates the
installer, exits non-zero, and prints a retry command using its stable agent
IDs, for example:

```bash
tieline init . --yes --agent codex --skill-scope project
```

The generated `.tieline/mcp.json` is a portable, repository-relative template.
Register it with your MCP host when the host does not load repository MCP
configuration automatically, and ensure the `tieline` command resolves this
package. The installed `$tieline-author` skill and the equivalent
`tieline_author` MCP prompt are two delivery surfaces for the same maintained
semantic workflow. That workflow can:

- shape a planning Story/AC or Backlog Item in Postgres;
- semantically onboard an empty spec from configured descriptions, local
  context, repository docs, code entry points, and tests;
- start implementation from a Story, AC, Backlog Item, Observation, or branch;
- reuse an existing definition, add an alias, or intentionally create a new ID;
- materialize planning IDs into repository YAML;
- reconcile branch changes, compile the manifest, and summarize semantic and
  mapping-coverage changes.

An empty `.tieline/spec/` immediately after init is intentional: init does not
invent generic capabilities. Review the detected `repository.source_roots`
before onboarding or claiming coverage. While the spec has no Stories,
`tieline status --json` exposes `onboarding.required`, the `tieline-author`
skill name, the concise instruction `Use $tieline-author to onboard this
repository.`, and `tieline init .` as the install command. `onboarding` becomes
`null` after the first Story exists. Status also reports whether the local
profile is ready and whether database-backed semantic matching and planning
writes are configured. Tool calls remain the operational check.

Before creating planning work, machine matching searches existing Stories, ACs,
Backlog Items, and similar Observations. It presents candidates and requires an
explicit reuse-or-continue choice. Each candidate reports its raw ranking
features and the `admitted_by` signals that cleared the absolute magnitude
floor; the blended score only orders admitted candidates. Similarity never
confirms a relationship.
Raw Observations remain append-only even when duplicate language is consolidated.
In offline mode, authoring searches local YAML and the compiled manifest and
explicitly reports that organization-wide duplicate checking was unavailable.

Validate and compile without a database:

```bash
tieline contract validate .
tieline contract compile .
tieline contract coverage . --json
```

Before editing code, ask the reviewed manifest which criteria apply:

```bash
tieline contract criteria src/commands/check.ts src/server.ts
```

This is an exact path lookup, not semantic search. Each path is reported as
`has_criteria`, `no_criteria`, or `not_found`; results with criteria preserve
whether the link is `direct` on an acceptance criterion or a `story_fallback`.
JSON output also carries a content-derived `manifest_digest` identifying the
complete reviewed manifest that answered.

Compilation writes `.tieline/manifest/`, one file per capability plus a small
index:

```
.tieline/manifest/
  index.json        schema version and the stable repository key
  CONTRACT.json     one capability, named after its stable ID, with the
  RETRIEVAL.json    specification file and hash it was compiled from
  ...
```

A capability is exactly one specification file, so this is the boundary the
contract already has. The schema-v2 index contains only stable repository
identity, stays byte-identical for commit-only changes, and uses normal Git
merging. Different capability shards avoid cross-capability conflicts; edits to
the same shard use normal conflict resolution. Compiling deletes stale
capability shards the specification no longer declares.

Mapping coverage counts a repository file as mapped when any contract link names
it. That records who claimed the file is evidence, not how much is known about
the claim, so coverage also reports a confidence tier. Each mapped file counts
once, at the highest tier it reaches:

| Tier | What is known | What it does not establish |
| --- | --- | --- |
| `asserted` | A link names the file. A human said so. | That anything was measured at all |
| `hash_current` | The file still hashes to the content recorded in the reviewed manifest. | That the review was right, or that the file still does what the criterion says |

The tiers are additive. `eligible_files`, `mapped_files`, `unmapped_files`, and
`percentage` keep their existing meaning, and the tier percentages use the same
denominator, so they sum to `percentage`. With no hash comparison available,
every mapped file reports `asserted` and the numbers are unchanged.

`hash_current` compares against `.tieline/manifest/` when that manifest is
readable and belongs to this repository, because the reviewed manifest is the
only record of the content a reviewer accepted. Without it, coverage compiles
the manifest from the working tree, where the reviewed hash is the hash it just
measured and no drift is observable. Story-level and criterion-level links are
treated alike here: a link names a file whatever its scope, so either can carry
the reviewed hash that lifts the file to `hash_current`.

Ask which links a human should re-read:

```bash
tieline contract link-review .
```

Link review scores each criterion-level code and test link on lexical overlap
between the acceptance criterion's prose and the linked file's names, comments,
and string literals, then reports the weakest links in the repository's own
distribution. This is inference, never evidence. It never confirms a
relationship and never refutes one; each candidate carries a rationale naming
the terms that did and did not overlap so a reviewer can judge the suggestion
instead of trusting a number. An empty candidate list means the heuristic is not
asking for attention, not that the links are correct. Missing files are left to
`tieline check` and are reported as skipped rather than scored. The command is
advisory and exits zero.

Ask an agent to judge the branch's contract evidence:

```bash
tieline contract grade . --base <base-ref> --emit-scope --json
tieline contract grade . --base <base-ref> --verify <verdicts.json>
```

The first command deterministically emits every diff-scoped acceptance-
criterion link to grade and the exact symbol citations allowed for it. The
agent inspects the artifacts and assigns `supported`, `partial`, or
`unsupported`; the second command verifies that every verdict belongs to the
scope and that every claimed citation came from its allow-list. Tieline does
not call a model, database, or network for this workflow. Verification is
advisory by default, including negative results; add `--strict` to the verify
command only when unsupported evidence should fail the gate. The packaged
`tieline-grade` skill leads an agent through the full workflow.

Generate a human-readable browser review of the accepted YAML:

```bash
tieline contract review .
```

This writes `.tieline/review.html`, a self-contained page with capability
navigation, Story and AC cards, scenario steps, evidence links, search,
lifecycle filters, and a print layout. Open the file directly in a browser.
Use `--output <path>` to write it elsewhere.

CI can check affected ACs:

```bash
tieline check --base <base-ref> .
```

Use the comparison ref supplied by the caller when available. Otherwise,
agents should determine it from repository metadata, preferring the
remote-tracking default branch, and ask only when it cannot be determined;
do not assume every repository uses `origin/main`.

The check compares changed, renamed, and deleted paths with manifest locators and
reports each affected AC plus its freshness. It also sweeps every link for broken
targets, whether or not the diff touched them, because a link can rot without the
change under review going near it. The check treats these integrity states
differently:

| State | Cause | Effect |
| --- | --- | --- |
| stale | The linked file changed since it was reviewed, or was never reviewed against a recorded hash. Whether the AC still holds needs a human. | Warning, exit 0 |
| broken | The linked path is missing, is not a file, or resolves outside the repository. | Error, exit 1 |
| stale manifest | The committed manifest differs from what the current contract compiles to. | Error, exit 1 |

Broken links fail the check because deciding they are wrong needs no judgement:
the manifest points at evidence that is not there. Pass `--no-fail-on-broken`
to downgrade broken links to warnings and exit zero. A stale manifest also
fails by default: run `tieline contract compile .`, review the semantic diff,
and commit the result. Use `--no-fail-on-stale-manifest` only when intentionally
downgrading that integrity gate to a warning. Invalid YAML or an unreadable
manifest fails because no trustworthy result can be computed. See
[the GitHub Actions example](docs/examples/tieline-check.yml).

After merge, run:

```bash
tieline contract sync . --expected-previous-commit <previous-main-sha>
```

Sync is idempotent and checkpointed. A delayed job cannot overwrite a newer
projection. If planning changed while a materializing pull request was open, the
merged repository version wins and the later planning revision is preserved as a
handoff conflict for reconciliation.

## MCP tools

Reads:

| Tool | Purpose |
| --- | --- |
| `search_knowledge` | Cross-type semantic search with a required retrieval profile and optional typed context |
| `find_related` | Engineering-oriented semantic discovery with applied profile metadata |
| `query_stories` | Exact Story/AC lookup by authority, lifecycle, IDs, or locators |
| `get_path_criteria` | Exact path-to-AC lookup from the compiled manifest; no database required |
| `get_backlog_item` | Read a Backlog Item revision and its complete Observation/Story/AC link set |
| `list_handoff_conflicts` | Read unresolved or historical planning-to-repository conflicts |
| `find_help` | Search ingested external help content |
| `get_help_article` | Fetch selected help bodies by `source + external_id` |
| `list_attribution_suggestions` | Review machine suggestions and their provenance |

Evidence and planning writes:

| Tool | Purpose |
| --- | --- |
| `record_observation` | Append a request, bug, or question, then return suggestions |
| `decide_attribution` | Confirm or dismiss an Observation relationship |
| `create_backlog_item`, `update_backlog_item` | Manage optional work records after reading their current revision |
| `set_backlog_item_links` | Replace Observation and Story/AC targets atomically |
| `create_planning_story`, `update_planning_story` | Shape `backlog` Stories and ACs |
| `decide_attribution_suggestion` | Confirm or dismiss a machine suggestion |

## External help content

Help articles remain DB-native rather than being copied into repository YAML.
Set `DATABASE_URL_SYNC`, then import a JSON array, an
`{"articles": [...]}` object, or one article per line in a `.jsonl` file:

```json
[
  {
    "source": "intercom",
    "external_id": "retrieval-profiles",
    "title": "Choose a retrieval profile",
    "summary": "How support and engineering views differ.",
    "url": "https://help.example.com/retrieval-profiles",
    "markdown": "Use the support profile for production-only answers."
  }
]
```

```bash
tieline import-help ./articles.json --batch-size 50
```

Batch size may be 1–200. The command writes
`articles.json.import-report.json` after a complete import. Contracts refer to
articles by stable `source + external_id`; imported bodies and metadata stay in
Postgres, while YAML may optionally repeat the public URL for review.

## Retrieval profiles

Every `search_knowledge` call names a profile. Explicit filters are additional
constraints and cannot broaden it.

| Profile | Intended view |
| --- | --- |
| `support` | Repository-owned production Stories/ACs and confirmed evidence |
| `engineering` | Repository-owned in-progress, production, and retired context |
| `discovery` | Planning and repository contract, Backlog Items, and Observations |
| `all` | Full corpus permitted by the connected database role |

Use `search_knowledge` when a caller needs heterogeneous results, explicit
profile selection, narrowing filters, or graph/artifact context. Use
`find_related` for a shorter engineering-oriented semantic lookup, and
`query_stories` for exact IDs, lifecycle, authority, capability, or artifact
locators without semantic ranking. Use `get_path_criteria` when the question is
which acceptance criteria the accepted contract records for an exact path; use
`search_knowledge` when the question is what context is related to that path.

An MCP `search_knowledge` input can carry a reusable Story/AC anchor and
artifacts from the caller's current task:

```json
{
  "query": "why are support searches production-only?",
  "profile": "engineering",
  "context": {
    "anchor": {
      "kind": "acceptance_criterion",
      "repository": "tieline",
      "stable_id": "RETRIEVAL-001-AC1"
    },
    "artifacts": [
      {
        "kind": "code",
        "repository": "tieline",
        "path": "src/tools/search-knowledge.ts"
      }
    ]
  },
  "limit": 10
}
```

Responses include the profile version and each result’s authority/lifecycle or
planning state, attribution state when applicable, coverage, freshness, applied
retrieval signals, ranking features, and reader-facing match reasons.
An optional `context` can name an Observation, Backlog Item, Story, or AC anchor
and/or code, test, or help artifacts. Context reranks only the candidate set
already allowed by the profile and filters. Artifact overlap and confirmed graph
proximity appear in each result’s ranking features; suggested and dismissed
relationships do not create proximity or become confirmed through search. Each
result also includes a typed `context_anchor` when it can be used directly in a
follow-up search. Callers can inspect the scores without Tieline claiming that
an unresolved artifact locator was applied.

Lexical retrieval is always on. English full-text search covers semantic prose,
while `pg_trgm` identifier matching recalls stable IDs, aliases, code/test
paths, selectors, and external help identifiers that stemming handles poorly.
Vector similarity is added when an embedding provider is available. Reciprocal
rank fusion combines the available lexical and vector rankings with exact alias,
artifact-overlap, and confirmed graph-proximity signals, so a missing embedding
backend does not turn search into an error. Absolute vector, lexical, or exact
alias magnitude determines whether a candidate is credible enough to present;
the blended rank-fusion score orders those admitted candidates but does not
filter them through a second fixed cutoff.

Graph proximity traverses structural links, repository-declared relationships,
and confirmed attributions up to three hops. The graph feature decays from
`1.0` at the anchor to `0.75`, `0.5`, and `0.25`; records beyond three hops
receive no graph boost. The bound covers useful chains such as
Observation → Story → AC → Scenario while keeping broad, weakly related graph
neighborhoods from dominating semantic relevance.

Profiles are versioned:

```bash
tieline profile list --json
tieline profile put \
  --key support \
  --file ./support-profile.json \
  --created-by maintainer
```

## Coverage, freshness, and mapping

Implementation-link, test-link, and help-link coverage are independently
`none`, `partial`, or `complete` for repository-owned Stories. Only direct AC
links count; Story-level fallback links remain searchable.

Freshness compares linked repository content with the reviewed manifest hash.
It does not claim that a test ran or passed. Test execution receipts are
deliberately deferred beyond the MVP.

Repository mapping coverage uses `.tieline/config.json` source roots and
exclusions as its denominator. Reports include both the percentage and every
unmapped eligible file. Path coverage and behavioral correctness remain separate.
When no eligible files exist, coverage is `null` with
`status=no_eligible_files`; it is never reported as 100%.

## Configuration

Copy `.env.example` and set only the credentials needed by the process:

| Variable | Responsibility |
| --- | --- |
| `DATABASE_URL` | Read-only contract, evidence view, profiles, and search |
| `DATABASE_URL_WRITE` | Planning Stories/ACs, Observations, Backlog Items, suggestions |
| `DATABASE_URL_SYNC` | Repository authority transfer, projection, help ingestion |
| `DATABASE_URL_ADMIN` | Offline migrations, profile publication, retention |

The MCP server uses read and planning-write connections. Sync/admin credentials
belong to explicit CLI/CI operations and should not be exposed to ordinary agents.
The baseline migration must run with an administrative database role that can
install the `vector`, `pgcrypto`, and `pg_trgm` extensions and create the three
Tieline runtime roles. Managed Postgres environments may require an
administrator to preinstall pgvector/Postgres contrib extensions or grant the
equivalent `CREATE EXTENSION` and `CREATE ROLE` capabilities before
`tieline migrate` runs.

Choose one embedding provider:

| Provider | Configuration |
| --- | --- |
| `local` | Keeps text local; install the optional runtime during init with `--install-local-embedder` |
| `openai` | Set `EMBEDDING_BASE_URL` and `EMBEDDING_API_KEY`; the endpoint must return 384-dimensional vectors |
| `supabase-edge` | Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` |
| `hash` | Deterministic development/test provider; do not use for semantic quality |

When Tieline is already initialized, rerun init with
`--embedding local --install-local-embedder` to install the local runtime in
Tieline's private runtime directory. Container builds can instead use
`--build-arg WITH_LOCAL_EMBEDDER=true`.

Remote embedding providers receive canonical semantic text or the caller’s query,
not raw Observation payloads, external URLs, audit metadata, lifecycle metadata,
or repository locators. Use `EMBEDDING_PROVIDER=local` to keep semantic text local,
or `hash` only for deterministic development tests.

## Run the MCP server

Start the transport expected by the MCP host:

```bash
tieline serve --stdio
tieline serve --http
```

HTTP binds to `127.0.0.1:3000` by default and exposes MCP at `POST /mcp` and
liveness at `GET /health`. Tieline does not provide end-user authentication.
Binding to a non-loopback host therefore requires `HTTP_TRUST_PROXY=true`, at
least one comma-separated `HTTP_ALLOWED_ORIGINS` entry, and an authenticated
TLS gateway in front of the server.

### Docker

The image defaults to HTTP mode:

```bash
docker build -t tieline .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=postgresql://... \
  -e DATABASE_URL_WRITE=postgresql://... \
  -e EMBEDDING_PROVIDER=openai \
  -e EMBEDDING_API_KEY=... \
  -e HTTP_HOST=0.0.0.0 \
  -e HTTP_TRUST_PROXY=true \
  -e HTTP_ALLOWED_ORIGINS=https://mcp.example.com \
  tieline
```

Run migrations separately with `DATABASE_URL_ADMIN`; do not expose that
credential to the serving container. For a stdio-only container host, override
the image command with `node dist/cli.js serve --stdio` and set
`TRANSPORT=stdio` so the HTTP health check is disabled:

```bash
docker run --rm -i \
  -e TRANSPORT=stdio \
  -e DATABASE_URL=postgresql://... \
  -e DATABASE_URL_WRITE=postgresql://... \
  tieline node dist/cli.js serve --stdio
```

## Data durability and privacy

Repository-owned definitions and their review history are durable in Git.
Planning revisions, raw Observations, Backlog Items, retrieval profiles,
attribution decisions, help content, conflicts, and audit events originate in
Postgres and require normal database backups. Rebuilding the repository
projection alone cannot recreate them.

Observation payloads may contain customer or operational data. Store the
minimum useful source text and retain the source-system pointer; ordinary MCP
reads use sanitized Observation projections. Retention or redaction requires a
privileged administrative workflow rather than the read or planning-write
connection.

## Verification

```bash
npm run build
npm run test:contract
npm run test:contract-read
npm run test:impact
npm run test:evidence
npm run test:embeddings
npm run test:ranking
npm run test:retrieval
npm run test:http
npm run test:tieline
npm run test:smoke
npm run test:baseline
```

Database integration tests require a disposable blank Postgres database with
pgvector and an administrative URL with the migration privileges described
above:

```bash
DATABASE_URL_ADMIN=postgresql://... npm run test:integration
```

The current baseline is intentionally breaking: pre-release databases from the
earlier model must be recreated rather than upgraded in place.

## Project structure

| Path | Purpose |
| --- | --- |
| `src/contract/` | YAML schemas, loading, validation, and manifest compilation |
| `src/tools/` | MCP read, evidence, and planning tools |
| `src/adapters/postgres/` | Least-privilege persistence and semantic retrieval |
| `src/tieline/` | Repository initialization, profiles, status, and setup |
| `migrations/` | PostgreSQL/pgvector schema and role baseline |
| `scripts/` | Contract, retrieval, transport, and integration verification |
| `skills/tieline-author/` | Packaged semantic authoring workflow |
| `skills/tieline-grade/` | Packaged agent workflow for grading diff-scoped contract evidence |
| `.tieline/` | This repository's own accepted contract and compiled manifest |

## License

[MIT](LICENSE)
