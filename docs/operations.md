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
DATABASE_URL_ADMIN=postgresql://... npm run test:integration
DATABASE_URL_ADMIN=postgresql://... npm run test:integration:code-topology
```

Before publishing a release, `npm run test:release:focused` runs the focused offline and
onboarding gates. `npm run test:release:database` runs the database-backed baseline, contract-sync,
and topology projections against a disposable database.

The current baseline is intentionally breaking: pre-release databases from the earlier model must
be recreated rather than upgraded in place.
