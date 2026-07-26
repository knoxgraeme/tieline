---
title: "User-story lifecycle, approval, retrieval, and portability hardening"
date: 2026-07-13
status: decided
---

# User-story lifecycle, approval, retrieval, and portability hardening

## What we are solving

The project should treat a user story as the durable thread connecting an idea, the current product definition, implementation code, supporting knowledge, and later operational evidence. The current database already stores the latest story plus normalized entity, code, help-article, and feature-request relationships, but it does not preserve story history and the ordinary MCP writer can rewrite production stories directly.

This work should make the current state easy to search while preserving a trustworthy, human-readable lifecycle. It should also remove the fragile installation, search, portability, and schema issues found in the code review.

## Decisions

### Current search versus lifecycle history

- `user_stories` remains the current, searchable projection. Existing search tools continue to query only this table, so pending changes and superseded text do not pollute results.
- `story_revisions` stores immutable snapshots of the story fields after each accepted story mutation: section, title, actor, narrative, and status. It does not duplicate embeddings.
- `story_events` stores the reason and context for each lifecycle action: created, revised, status changed, relationship added/removed/replaced, proposal approved/rejected, and imported. An event may point to the resulting revision.
- Relationship state remains normalized in the existing join tables. Relationship history is represented by events rather than copying every relationship into every revision.
- `get_story_history` retrieves both revisions and events. Search never returns historical revisions unless a caller explicitly asks for history.

Revisions and events therefore overlap only deliberately: a revision answers “what did the accepted story look like?”, while an event answers “what happened, why, by whom/source, and when?” A status change creates both a new snapshot and a status event. A relationship-only mutation creates an event but no redundant story revision.

### Production approval

Approval is not a lifecycle status. A production story stays `production` while a proposed edit waits separately in `story_change_proposals` with `pending`, `approved`, or `rejected` status.

`STORY_APPROVAL_MODE` controls the boundary:

- `production` (default): changes to an existing production story, changes that move a story into production, and relationship changes on a production story become proposals.
- `all`: every story mutation becomes a proposal.
- `off`: mutations are automatically applied. This is an explicit self-hosted/operator choice.

The ordinary `mcp_writer` credential may create proposals but cannot apply production-sensitive changes directly. Approval and `off` mode use a separately configured `DATABASE_URL_APPROVAL` credential. This keeps the default gate real at the database boundary rather than trusting an MCP argument an agent could choose.

There will be no ordinary MCP approval tool. Humans approve or reject proposals in the localhost review UI or CLI. The review server binds to loopback, validates request origins, uses a per-process CSRF token, and applies a proposal atomically. MCP can list proposal state and read history, but cannot approve it.

Every proposal records the base revision number. Approval locks the story and fails as `stale` if the current revision has moved; the reviewer must rebase or create a fresh proposal. Rejected and stale proposals are immutable audit records.

### OSS, tenancy, and transport boundary

This is currently an OSS/self-serve project, so multi-tenant tables, organization IDs, and a built-in identity system are unnecessary. They would add complexity without a current product requirement.

That does not remove the local/HTTP security boundary:

- stdio stays the safest default;
- HTTP binds to `127.0.0.1` by default, validates `Origin`, and requires an explicit host override for remote use;
- a remote HTTP deployment remains behind an operator-provided authenticated gateway;
- actor/source fields are audit metadata, not authenticated identity claims;
- database roles separate read, ordinary write/proposal, ingest, and approval capabilities.

If a hosted multi-user service is built later, tenant ownership and authenticated actor identity should be designed then rather than partially embedded now.

### Import is batch authoring, not the normal write path

`import_stories` is used for initial bootstrap, a large backfill, migration from another system, or a reviewed bulk curation pass. It is not just a one-time installer, but it is also not the normal runtime mutation path.

- The CLI and local review flow remain the primary import surfaces.
- The MCP `import_stories` tool is disabled by default and enabled only with `ENABLE_IMPORT_TOOL=true`.
- `DATABASE_URL_INGEST` becomes mandatory for migration/import; it must never fall back to the read `DATABASE_URL`.
- Imports are batched (default 50), atomic per batch, bounded in size, and produce a machine-readable report.
- Stable `import_source + import_ref` identifiers make retries idempotent; keyless records without a stable ref are rejected for resumable batch import.
- Production-sensitive imported changes go through the same proposal policy unless the operator uses the explicit approval/off path.

### Relationships and “artifact links”

“Artifact links” was shorthand for the relationships from a story to implementation and knowledge artifacts. The project already stores these in domain-specific tables:

- `story_code_assets` for code;
- `story_help_articles` for knowledge-base articles;
- `story_entities` for concepts;
- `feature_request_story_links` for incoming-request evidence.

We will not collapse these into one polymorphic `artifact_links(type, id, json)` table. That would weaken constraints and make queries harder. Storage remains normalized and domain-specific. The MCP/domain API will expose consistent `set/add/remove` operations across the relationship families, with typed metadata for each family.

Code relationships should retain `repo`, `path`, optional symbol/type/summary, link type, provenance, confidence, reason, sort order, and verification time. Deployment links are explicitly deferred.

### Portable knowledge-store boundary

The current `KnowledgeStore` interface is derived from `typeof` functions in the PostgreSQL implementation, so it is not genuinely domain-owned. The new port will define plain domain request/result types and capability interfaces without importing PostgreSQL, SQL clients, or adapter functions.

The PostgreSQL implementation will move under `src/adapters/postgres/` and implement the composed domain interfaces. A different backend can implement the same capabilities in its own way. Atomic import and approval are high-level port operations; the domain layer does not expose SQL transactions.

### Search and relevance

- Structural search will union exact entity/path candidates with semantic KNN candidates before ranking. A structurally exact story can therefore be found even when it is outside the vector pool.
- Relevance uses independent qualification gates: a calibrated semantic cosine floor or meaningful exact structural overlap. The current single blended `0.15` floor is removed.
- The initial GTE-small semantic floor is `0.80`, then locked/tuned with a checked-in positive/negative evaluation set rather than intuition alone.
- `score` remains the absolute interpretable qualification score; normalized signal values remain ranking diagnostics.
- Help `product_area` and `audience` filters move into the SQL candidate query so filtered matches are not lost after KNN limiting.
- Document frequency means the number of distinct stories referencing an entity or code path. It is used inversely (`1 / df`) so uncommon, distinctive overlaps count more. Counts will be queried from relationships (or a view) instead of relying on a process-lifetime cache and manually refreshed columns.

### Knowledge-base functionality

Knowledge-base work is lower priority, but the minimum coherent solution is:

- add a batch help-article importer that validates and embeds `title + summary + headings`;
- preserve nullable database fields as nullable in TypeScript/MCP output;
- add a read-only link-suggestion operation that compares an existing story with existing articles, and can also work article-to-stories;
- persist accepted links through the normal typed relationship mutation/approval flow.

Automatic matching produces suggestions with scores and explanations, not silent links. Chunked full-body retrieval can wait until summary-card recall proves inadequate.

### Embeddings

The supported storage width is fixed at 384 dimensions. GTE-small is the reference local model. Every provider must return 384 dimensions; changing vector width becomes an explicit schema migration and full re-embed, not a runtime environment toggle.

HTTP providers use a shared request helper with a 10-second timeout, at most three attempts, `Retry-After` support, exponential backoff with jitter, retry only for network/408/429/5xx failures, bounded response bodies, and redacted errors. Batch embedding uses bounded concurrency.

## Deferred

- Deployment/release records and story-to-deployment links.
- Multi-tenant ownership and first-party OAuth/identity.
- A generic polymorphic artifact table.
- Help-article body chunking and a full editorial KB workflow.
- Search across superseded revisions by default.

## Success criteria

- A normal search returns only the latest accepted story state.
- A caller can retrieve the full story lifecycle and relationship events explicitly.
- Production-sensitive changes cannot bypass the default human gate with the ordinary MCP writer credential.
- A self-hosted operator can explicitly choose automatic application.
- New and existing stories can add, replace, and remove every currently supported relationship type.
- Fresh migrations grant the sequence privileges needed by write tools.
- Search can find exact structural matches outside the semantic pool and produces cleaner empty results.
- Import is safe, batched, resumable, and disabled from the base MCP surface by default.
- Storage interfaces no longer depend on the PostgreSQL adapter.

