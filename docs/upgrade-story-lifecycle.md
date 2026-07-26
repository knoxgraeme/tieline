# Upgrade to lifecycle history and approval

This upgrade keeps `user_stories` as the latest accepted, searchable projection. It adds
append-only revisions/events, pending change proposals, stable import refs, typed relationship
operations, and separated writer/approver credentials.

## Before migrating

1. Back up the database.
2. Record counts for `user_stories`, `story_entities`, `story_code_assets`,
   `story_help_articles`, and `feature_request_story_links`.
3. Configure an explicit owner-grade `DATABASE_URL_INGEST`. The migration runner no longer
   falls back to the read URL.
4. Keep the previous runtime stopped while role policies and lifecycle functions change.

## Apply and verify

```bash
DATABASE_URL_INGEST=postgresql://owner:... tieline migrate
DATABASE_URL_INGEST=postgresql://owner:... tieline migrate --verify
```

The ledger stores a SHA-256 checksum for each applied migration and refuses edited history.
After applying, verify:

```sql
select count(*) from user_stories;
select count(distinct story_id) from story_revisions;
select count(*) from user_stories where revision_number < 1;
select count(*) from story_change_proposals where status = 'pending';
```

Every pre-existing story should have a baseline revision/event, and relationship counts should
match the pre-migration values.

## Configure roles

Migrations create `mcp_reader`, `mcp_writer`, and `mcp_approver` without repository secrets.
Assign login credentials through your platform/Vault and configure:

```dotenv
DATABASE_URL=postgresql://mcp_reader:.../db
DATABASE_URL_WRITE=postgresql://mcp_writer:.../db
DATABASE_URL_APPROVAL=postgresql://mcp_approver:.../db
STORY_APPROVAL_MODE=production
```

`production` applies non-production changes immediately but proposes production creates,
updates, and typed relationship changes. `all` proposes all story mutations. `off` auto-allows
through the separate approval credential; it does not restore direct writer access.

Approve/reject outside MCP:

```bash
npm run changes -- list
npm run changes -- show 42
npm run changes -- approve 42 --by "Release owner"
npm run changes -- reject 43 --by "Product owner" --note "Superseded"
npm run review:changes
```

The review web surface binds to loopback, uses a per-process mutation token, validates Origin,
sets a restrictive CSP, and is not a remote/team auth system.

## Search and history

`find_related`, `find_crossover`, and `query_stories` read only current accepted rows. Historical,
rejected, and pending text does not affect KNN. Use `get_story_history` for accepted revisions and
events, and `list_story_change_proposals` for decision records.

## Imports

Story import is an initial/occasional reviewed operation, not a normal runtime write. It is CLI
first, uses batches (default 50, max 200), requires explicit ingest credentials, and writes a
checkpoint report. Keyless retryable records require stable `import_source` plus `import_ref`.
The MCP import tool is absent unless `ENABLE_IMPORT_TOOL=true`.

KB articles use `tieline import-help articles.jsonl`. They embed title, summary, and headings.
Use `suggest_story_help_links` to rank candidates and `update_story_relationships` to accept one.

## Embeddings and HTTP

All vectors are fixed at 384 dimensions. OpenAI-compatible requests ask for 384 by default;
`EMBEDDING_REQUEST_DIMENSIONS=false` only removes that request field and does not change storage
width. A width change needs a vector-column migration and full re-embed.

HTTP remains optional. It binds `127.0.0.1` and checks browser Origin. Non-loopback exposure
requires explicit allowed origins and `HTTP_TRUST_PROXY=true`, plus an authenticated TLS gateway.
The OSS core intentionally does not implement multi-tenancy or hosted identity.

## Rollback limits

Application rollback can leave proposal/history tables in place; older code ignores them.
Do not delete revisions/events or edit applied migration files. Once production RLS is tightened,
old code that attempts direct production writes fails safely. Restore from backup for a true schema
rollback while preserving audit records separately.
