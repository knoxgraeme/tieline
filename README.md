<p align="center">
  <img src="assets/tieline-logo.png" alt="Tieline" width="520">
</p>

# Tieline

Tieline maps a product into user stories and keeps those stories connected to their lifecycle,
source code, feature requests, and knowledge-base articles. It is a local-first CLI and an MCP
server backed by Postgres with pgvector.

The CLI owns deterministic setup, migration, review, and import. A coding agent understands the
product and analyzes the repository. A human approves product context and stories before they are
persisted.

## Install and initialize

```bash
npm install --global tieline
tieline init /path/to/product-repository
```

When developing Tieline itself, use `npm install && npm run build && npm link` instead. The published
package contains the compiled CLI, migrations, review UI, and agent skill. It does not contain any
product data or seed stories.

`tieline init` is the guided onboarding coordinator. It collects the combined company/product
profile, chooses a database and embedding backend, records the story approval policy, applies
migrations, optionally installs the large local embedding runtime, and writes an MCP client snippet.
The default interactive choices are:

1. a dedicated local Docker PostgreSQL + pgvector container;
2. local `gte-small` embeddings;
3. human approval for production-sensitive story changes.

Every external mutation is shown before the final confirmation. Tieline never accepts credentials as
command-line options. Existing database and hosted embedding credentials must already be present in
the environment (directly, through a password-manager command, or through a local `.env`) before
starting init.

`tieline init` creates a versionable workspace inside the product repository:

```text
.tieline/
  config.json
  product-context.md
  coverage.json
  drafts/            one draft per product area
  stories.draft.json merged, reviewable draft
  AGENT_HANDOFF.md
  mcp.json
```

The workspace is safe to commit and contains no database credentials. Credentials and provider
settings are written to a mode-`0600` profile under
`~/.config/tieline/profiles/<workspace-id>.json`. `serve`, `migrate`, `review`, and `import`
automatically load that profile when run from the repository or when `TIELINE_WORKSPACE` points to it.
Explicit environment variables always override the profile.

Supply optional product context during init:

```bash
tieline init . \
  --product "Company or product name" \
  --description "What the product helps users accomplish" \
  --context https://example.com/product \
  --context docs/product-overview.md
```

The generated handoff tells the coding agent how to complete the product profile, inspect the
codebase, record coverage, and draft stories. Marketing material establishes vocabulary and
intent; repository evidence determines whether behavior is shipped. These semantic analysis and
human approval phases intentionally remain agent/human work; init does not pretend they are
deterministic installation steps.

After a human reviews the completed profile:

```bash
tieline context approve .
tieline status .
```

Approval records a checksum. Later edits make the approval stale and require another human review.

### Init modes

Run the full interactive setup:

```bash
tieline init .
```

Create only the versioned workspace and connect infrastructure later:

```bash
tieline init . --offline
```

Connect your own PostgreSQL + pgvector database instead of running Docker — no container required:

```bash
tieline init . --database existing
```

This reads a connection string from `DATABASE_URL_INGEST` in the environment or a local `.env`
(credentials are never accepted as CLI arguments). Tieline needs only **Postgres 16 with the
`pgvector` extension** — it is not tied to any provider. Any of these work:

- a Postgres you already run locally (`brew install postgresql pgvector`, Postgres.app, …);
- a free hosted database from **Neon**, **Supabase**, or similar (paste the connection string);
- any managed Postgres (RDS, Crunchy, Timescale, …) with `pgvector` enabled.

Because Tieline reads `DATABASE_URL_INGEST` from `.env`, provisioning tools that sync a `.env`
(for example [Stripe Projects](https://docs.stripe.com/projects)) are picked up automatically — no
extra configuration.

For automation, pass `--yes` plus explicit `--database`, `--embedding`, and `--approval` choices.
`--yes` alone is deliberately offline so it cannot start containers or migrate a database by
surprise. `--skip-migrate` records a resumable profile without changing the database.

If setup is interrupted, rerun `tieline init .`. Tieline reuses the workspace/profile and reports the
next product-mapping action through `tieline status`.

## Database and imports

Guided local init starts PostgreSQL and applies the packaged migrations. Manual database setup is
also supported:

```bash
# Inject an extension-capable owner URL using your shell or password manager.
tieline migrate
```

Tieline does not seed stories. Initial records come only from the target repository's reviewed
`.tieline/stories.draft.json`:

```bash
tieline merge /path/to/product-repository
tieline review /path/to/product-repository/.tieline/stories.draft.json
tieline import /path/to/product-repository/.tieline/stories.draft.json --batch-size 50
```

### Sharded drafting

The agent writes one draft per product area into `.tieline/drafts/<area>.draft.json` rather than
producing the whole map in a single file write. Each shard is a checkpoint, so an interrupted
drafting session keeps every area already written, and regenerating one area leaves the rest alone.

`tieline merge` folds the shards into `stories.draft.json`. It is deterministic and idempotent, and
it preserves review decisions already recorded — re-merging after regenerating one area does not
reset the board to pending. Merge refuses to write when two shards define the same section
differently, collide on a review id or `import_ref`, disagree on the repository or product-context
checksum, or when a shard is unparseable. It also refuses to drop merged stories that no shard
produces any more unless `--prune` is passed.

Shard-local `_review.id` values are namespaced as `<shard>/<id>` on merge, so every shard may mint
`d-0001` independently. This matters because a keyless story's review id becomes its `import_ref`:
un-namespaced collisions would make the importer treat a second story as already committed.

```bash
tieline merge .                # fold .tieline/drafts/*.draft.json into stories.draft.json
tieline merge . --prune        # also drop stories no shard produces any more
tieline status .               # shard count, unreadable shards, and whether a merge is pending
```

`tieline review` starts a loopback-only review page. `tieline import` imports approved records,
embeds them in bounded batches, and writes a checkpoint report next to the draft. Stable review
IDs become import references, so retrying a completed batch does not duplicate stories.

Tieline-managed imports reject:

- unapproved or stale product context;
- a draft created from another context checksum;
- incomplete repository coverage;
- a conflicting repository identity;
- missing, absolute, escaping, or symlink-escaping code paths;
- an embedding provider different from the workspace provider.

Standalone import payloads may be used without a Tieline workspace, but code paths always require
an explicit repository identity through `import_source` or `REPO_NAME`.

## Run the MCP server

```bash
export DATABASE_URL=postgresql://mcp_reader:password@localhost:5432/knowledge
tieline serve                 # stdio
tieline serve --http          # streamable HTTP
```

Copy or merge `.tieline/mcp.json` into the MCP host configuration. Its only environment value is the
non-secret `TIELINE_WORKSPACE` path; the server discovers the private profile itself.

HTTP binds to `127.0.0.1` by default. A non-loopback bind requires `HTTP_TRUST_PROXY=true`, an
explicit `HTTP_ALLOWED_ORIGINS` list, and an authenticated TLS gateway.

### Read tools

| Tool | Purpose |
|---|---|
| `find_related` | Find conceptually or structurally similar product areas and stories |
| `find_crossover` | Find areas sharing code paths or entity concepts with a known story/section |
| `query_stories` | Exact filtered story lookup and grouped counts |
| `find_help` | Search knowledge-base articles semantically |
| `get_help_article` | Retrieve a known article's full content |
| `get_story_history` | Retrieve accepted revisions, events, and proposal history |
| `suggest_story_help_links` | Rank possible story/article links without writing them |

The server also provides `schema://taxonomy` and `docs://how-to-query` resources.

### Write tools and approval

Write tools use a dedicated `mcp_writer` connection. The default
`STORY_APPROVAL_MODE=production` requires human approval for production creates, content changes,
status changes, relationship changes, and production-sensitive feature-request link changes.

| Mode | Behavior |
|---|---|
| `production` | Production-sensitive mutations become proposals |
| `all` | Every story mutation becomes a proposal |
| `off` | Mutations auto-apply through the separate approval credential |

Set:

```bash
DATABASE_URL_WRITE=postgresql://mcp_writer:password@host/database
DATABASE_URL_APPROVAL=postgresql://mcp_approver:password@host/database
```

The MCP writer cannot approve its own proposals. Accepted content is stored in the current
`user_stories` projection; immutable `story_revisions` and semantic `story_events` preserve the
lifecycle.

Bulk import is disabled on the MCP surface by default. Set `ENABLE_IMPORT_TOOL=true` only on a
deliberately privileged local or gateway instance.

## Knowledge-base articles

Knowledge-base articles are domain records, not a provider-specific storage feature. The Postgres
adapter stores them in `help_articles` and links them through `story_help_articles`.

Import JSON or JSONL articles from a source you control:

```bash
tieline import-help articles.jsonl
```

Article embeddings use `title + summary + headings`. `suggest_story_help_links` proposes matches;
`update_story_relationships` accepts selected links with typed relationship metadata.

## Embeddings

Storage is fixed at 384 dimensions. Import and retrieval must use the same provider.

| Provider | Behavior |
|---|---|
| `local` | In-process `gte-small`; install `@huggingface/transformers` separately |
| `openai` | Any OpenAI-compatible embeddings endpoint returning 384 dimensions |
| `supabase-edge` | Compatibility adapter for an existing embedding edge function |
| `hash` | Deterministic test-only embeddings |

The local provider is the interactive default but is not bundled because its native runtime is
large. Guided init can install it into the per-user Tieline runtime directory, or it can be installed
manually into the Tieline package environment:

```bash
npm install @huggingface/transformers
```

Alternatively configure:

```bash
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=https://api.example.com/v1
EMBEDDING_API_KEY=...
```

## Database roles

Use separate credentials for each boundary:

| Environment variable | Role |
|---|---|
| `DATABASE_URL` | Read-only MCP runtime |
| `DATABASE_URL_INGEST` | Migrations and reviewed bulk imports |
| `DATABASE_URL_WRITE` | Ordinary MCP mutations and proposals |
| `DATABASE_URL_APPROVAL` | Human decision or explicitly configured auto-allow |

Migrations create `mcp_reader`, `mcp_writer`, and `mcp_approver` without passwords. Assign
credentials out of band or use the hosting platform's identity mechanism.

## Project structure

```text
migrations/                 portable Postgres + pgvector schema
src/cli.ts                  Tieline command dispatcher
src/commands/               compiled serve, migrate, review, and import commands
src/tieline/                workspace initialization, shard merge, and validation
src/domain/                 storage port
src/adapters/postgres/      Postgres implementation
src/tools/                  MCP read/write tools
src/authoring/              draft, import, and review UI
skills/backfill-stories/    provider-neutral coding-agent workflow
```

## Development and verification

```bash
npm install
npm run build
npm run typecheck:ui
npm run test:tieline
npm run test:ranking
npm run test:retrieval
npm run test:embeddings
npm run test:http
npm run test:smoke
```

Database integration tests skip when their required credentials are absent.

## Docker

The runtime image includes production dependencies and compiled output only:

```bash
docker build -t tieline .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL=postgresql://user:password@host/database \
  -e EMBEDDING_PROVIDER=openai \
  -e EMBEDDING_API_KEY=... \
  -e HTTP_HOST=0.0.0.0 \
  -e HTTP_TRUST_PROXY=true \
  -e HTTP_ALLOWED_ORIGINS=https://mcp-client.example \
  tieline
```

The container starts `tieline serve --http`. Run `tieline migrate` and reviewed imports separately
using the published CLI.

## License

MIT
