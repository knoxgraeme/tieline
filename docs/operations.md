# Operations

[README](../README.md) · [Setup](setup.md) · [Concepts](concepts.md) · [CLI](cli.md) · [MCP](mcp.md) · **Operations**

## Configuration

Copy `.env.example` and set only the credentials needed by the process:

| Variable | Responsibility |
| --- | --- |
| `DATABASE_URL` | Read-only contract, evidence view, and search |
| `DATABASE_URL_WRITE` | Planning Stories/ACs, Observations, Backlog Items, suggestions |
| `DATABASE_URL_SYNC` | Repository authority transfer and projection |
| `DATABASE_URL_ADMIN` | Offline migrations and retention |

The MCP server uses read and planning-write connections. Sync and admin credentials belong to
explicit CLI/CI operations and should not be exposed to ordinary agents.

The packaged migrations must run with an administrative database role. The baseline installs the
`vector`, `pgcrypto`, and `pg_trgm` extensions and creates the three Tieline runtime roles.
Managed Postgres environments may require an administrator to preinstall pgvector/Postgres
contrib extensions or grant the equivalent `CREATE EXTENSION` and `CREATE ROLE` capabilities
before `tieline migrate` runs.

## Run the MCP server

```bash
tieline serve --stdio
tieline serve --http
```

HTTP binds to `127.0.0.1:3000` by default and exposes MCP at `POST /mcp` and liveness at `GET
/health`. Tieline does not provide end-user authentication. Binding to a non-loopback host
therefore requires `HTTP_TRUST_PROXY=true`, at least one comma-separated `HTTP_ALLOWED_ORIGINS`
entry, and an authenticated TLS gateway in front of the server.

## Docker

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

Run migrations separately with `DATABASE_URL_ADMIN`; do not expose that credential to the serving
container. For a stdio-only container host, override the image command and set `TRANSPORT=stdio`
so the HTTP health check is disabled:

```bash
docker run --rm -i \
  -e TRANSPORT=stdio \
  -e DATABASE_URL=postgresql://... \
  -e DATABASE_URL_WRITE=postgresql://... \
  tieline node dist/cli.js serve --stdio
```

## Data durability and privacy

Repository-owned definitions and their review history are durable in Git. Planning revisions, raw
Observations, Backlog Items, attribution decisions, conflicts, and audit events originate in
Postgres and require normal database backups. Rebuilding the repository projection alone cannot
recreate them.

Observation payloads may contain customer or operational data. Store the minimum useful source
text and retain the source-system pointer; ordinary MCP reads use sanitized Observation
projections. Retention or redaction requires a privileged administrative workflow rather than the
read or planning-write connection.

Remote embedding providers receive canonical semantic text or the caller's query — not raw
Observation payloads, external URLs, audit metadata, lifecycle metadata, or repository locators.
Use `EMBEDDING_PROVIDER=local` to keep semantic text local, or `hash` only for deterministic
development tests.

## Verification

```bash
npm run build
npm test
npm run test:tieline
```

`npm test` runs the main offline suite, including contract and manifest behavior, retrieval,
transport, source-scope detection, parser packaging, multi-language symbol extraction,
resolution, topology generation, blast radius, and generated-artifact checks. `npm run
test:tieline` separately builds the CLI, tests skill installation, and exercises repository
onboarding end to end.

Database integration tests require a disposable blank Postgres database with pgvector and an
administrative URL with the migration privileges described above:

```bash
TIELINE_INTEGRATION_TEST_DATABASE=1 \
DATABASE_URL_ADMIN=postgresql://postgres:postgres@localhost:5432/tieline_test \
npm run test:integration
TIELINE_INTEGRATION_TEST_DATABASE=1 \
DATABASE_URL_ADMIN=postgresql://postgres:postgres@localhost:5432/tieline_test \
npm run test:integration:code-topology
```

Before publishing a release, `npm run test:release:focused` runs the focused offline and
onboarding gates. `npm run test:release:database` runs the database-backed baseline, contract-sync,
and topology projections against a disposable database.

The current baseline is intentionally breaking: pre-release databases from the earlier model must
be recreated rather than upgraded in place.

## Post-merge manifest maintenance (opt in)

The default `committed` workflow is unchanged. To delegate fingerprint maintenance,
set the top-level `manifest_mode` to `post_merge` in `.tieline/config.json` and
install the [refresh workflow](examples/tieline-manifest-refresh.yml) on your
integration branch. Use a pinned Tieline npm dependency that includes this feature.
Configure the workflow's branch filter (for example `env/staging`), approved write
identity, and failure notifications before enabling the mode. This repository
itself continues to use committed manifests.

Retain pre-merge YAML validation, `contract reconcile --base <target>`, selected
`contract grade --unit criterion --scope claims`, and `tieline check`. Check and
grade compile current authored definitions in memory; broken evidence still
fails before merge. Use `contract compile --output <temporary-directory>` for a
review artifact without committing fingerprint churn. Claim comparison reads
base YAML, so a delayed publisher cannot fabricate onboarding scope. The existing
generated-artifact gate still recompiles and validates everything, but in this
mode defers the committed-manifest byte comparison only; topology comparison
continues unchanged.

The publisher command is an explicit write operation:

```sh
tieline contract refresh-manifest . --branch env/staging --remote origin --json
```

It fetches the latest remote tip into a private ref and compiles in a temporary
worktree. Only standard `.tieline/manifest/` output is committed; standard
`.tieline/spec/` input is required. Normal pushes prevent overwriting concurrent
merges; up to three attempts recompile newer tips. Git operations have 30-second
timeouts. No-op refreshes create no commit, and the example workflow excludes
manifest-only pushes to avoid loops. Local user changes remain untouched.

A failed refresh remains a failed job; checks report publication as pending until
it succeeds. Rerun the job to recover. Branch protection may reject the bot's push;
retain committed mode until an approved publishing identity/workflow is available,
rather than bypassing required checks. Automatic hashing records a source snapshot,
not a semantic verdict. Existing context/topology reads retain explicit published
snapshot freshness and may remain stale while publication is pending.
