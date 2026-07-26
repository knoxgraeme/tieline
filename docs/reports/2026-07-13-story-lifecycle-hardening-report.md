# User-story lifecycle hardening: implementation report

Date: 2026-07-13

## Outcome

The project now treats `user_stories` as a fast latest-accepted projection while preserving a
retrievable, immutable lifecycle alongside it. Production-sensitive story/content/typed-link
changes are human-reviewed by default. The persistence port is domain-owned, PostgreSQL is a
composed adapter, occasional imports are gated and retry-safe, structural retrieval is no longer
trapped behind semantic KNN, KB articles have a minimum useful import/match flow, and HTTP plus
external embeddings have explicit self-hosted safety boundaries.

Deployments remain intentionally out of scope. They can later be another event/artifact family
without changing current search/history semantics.

## Product model

- `user_stories`: one latest accepted row per story; this is the only story text searched.
- `story_revisions`: immutable accepted content snapshots. A revision answers “what did the
  accepted story say at revision N?”
- `story_events`: immutable semantic facts such as create, status/content revision, relationship
  change, baseline, approval, or rejection. Events may point at a revision but do not need one.
- `story_change_proposals`: pending/approved/rejected/stale human decisions. Pending/rejected text
  never enters current search.
- `story_import_refs`: stable `(import_source, import_ref)` idempotency identities.

This keeps default search clean while `get_story_history` retrieves revisions/events and
`list_story_change_proposals` retrieves the decision trail.

## Approval modes

- `production` (default): non-production mutations apply; production creates, content/status
  edits, and entity/code/help relationship edits become proposals.
- `all`: every story mutation becomes a proposal.
- `off`: sensitive changes are proposed and immediately approved through the separate
  `DATABASE_URL_APPROVAL` credential. This is the requested auto-allow flag, but it does not give
  the ordinary writer direct production privileges.

MCP can submit and read proposals but cannot approve/reject. Decisions use `npm run changes` or
the loopback-only `npm run review:changes` surface.

## Relationships and “artifact links”

All existing normalized relationship families are mutable:

- entities: add/remove/replace;
- code assets: add/remove/replace with repo/path/symbol/type/link/provenance/confidence/order and
  verification metadata;
- help articles: add/remove/replace with relationship type/confidence;
- feature-request mappings: atomically replace one primary plus desired secondaries with an
  optimistic `expected_version`.

“Artifact link” remains an umbrella phrase, not a generic polymorphic table. Domain-specific join
tables retain better constraints and metadata. Production typed story relationship edits follow
the proposal boundary. Feature-request evidence mappings are versioned and evented.

## Imports

`import_stories` is an initial backfill or occasional reviewed batch operation, not a normal
per-story runtime path. It is absent from the base MCP tool roster unless `ENABLE_IMPORT_TOOL=true`.
The CLI requires explicit `DATABASE_URL_INGEST`, defaults to batches of 50 (range 1–200), embeds
before each transaction, writes a checksum/checkpoint report, rejects duplicate/missing refs before
work, and treats completed refs as no-op retries without revision/event noise. Earlier committed
batches remain when a later batch fails.

## Search and document frequency

`find_related` unions semantic candidates with exact entity/path candidates. Semantic and
structural qualification floors are independent (`0.8` vector, `0.01` structural by default), so
an exact structural match outside the vector pool can qualify while off-topic semantic noise
returns an intentional empty result. Exact structural mode can operate without an embedding call.

Document frequency (`df`) is the number of distinct current stories carrying an entity slug or
code path. Ranking uses `1/df`: rare overlaps are stronger evidence than ubiquitous hub terms.
Counts are derived live, so relationship edits affect the next search without refresh/cache rules.

## KB minimum functionality

- Help product-area/audience filters execute inside SQL before nearest-neighbour `LIMIT`.
- Nullable database fields are nullable in TypeScript/Zod outputs.
- `tieline import-help` accepts JSON, `{articles:[...]}`, or JSONL; embeds title + summary +
  headings and upserts in batches.
- `suggest_story_help_links` ranks story→article or article→story pairs without writing.
- Accepted suggestions still use `update_story_relationships`, preserving normal audit/approval.

## Portability and OSS production boundary

Domain interfaces contain no SQL/PostgreSQL-derived types. The bundled adapter is split into one
connection manager plus search, story/history, relationship, help, feature-request, taxonomy,
import, and vector modules. A loud fake adapter is provided for tests/alternate compositions.

Because this is OSS/self-hosted, tenancy and hosted identity are not core requirements. stdio is
the default. HTTP binds to `127.0.0.1`, validates any present browser `Origin`, and refuses a
non-loopback bind without explicit origins plus `HTTP_TRUST_PROXY=true`. Remote HTTP still requires
an authenticated TLS gateway.

## Reliability and defect fixes

- Fixed 384-dimensional storage contract; runtime width knobs were removed.
- OpenAI-compatible calls request 384 by default; compatibility can omit only the request field.
- Added 10-second timeout, bounded transient retry, `Retry-After`, exponential jitter,
  cancellation, concurrency limit, dimension validation, capped/redacted error bodies.
- Added migration checksum ledger and explicit ingest credential; fixed clean writer sequence and
  secure key-mint privileges.
- Fixed create-proposal terminal-state constraint found by clean live approval testing.
- Fixed `find_crossover` XOR, canonical status enum drift, graph embedded-NUL/colliding pair key,
  same-transaction section return, help/output nullability, server/resource comments and env docs.
- Updated esbuild to 0.28.1; npm audit reports zero vulnerabilities.

## Requirement evidence

| Requirement | Evidence |
|---|---|
| Latest-only search + explicit history | lifecycle migrations; `get_story_history`; live integration current/pending checks |
| Immutable lifecycle | append-only triggers; revision/event reads; 47-check integration suite |
| Human production boundary | RLS + security-definer decision functions; separate approver URL; production/all/off live checks |
| Complete relationships | `update_story_relationships`; production-gated feature-request versioned set; rollback/clear/replace/primary-swap tests |
| Safe occasional import | gated registration; explicit ingest URL; 125-record import integration (3 batches, retry, rollback) |
| Clean relevance | candidate union; independent gates; checked-in four-case retrieval evaluation |
| Live df | derived SQL aggregation/view; no process cache/refresh protocol |
| KB minimum | batch importer, SQL pre-limit filters, read-only suggestion tool, live tests |
| Embedding reliability | 11 offline retry/timeout/redaction/dimension/concurrency checks |
| Safe OSS HTTP | 7 boundary/config checks; loopback/gateway documentation |
| Portable persistence | domain-owned port/fake; 8-line compatibility file and cohesive adapter repositories |
| Clean install | `npm ci`; build/UI; all 14 migrations from empty pgvector DB; checksum verification |

## Verification completed

- `npm ci`
- TypeScript build and both app bundles
- UI typecheck
- ranking: 20/20
- retrieval evaluation: 4/4
- MCP smoke: 13/13
- embedding reliability: 11/11
- HTTP boundary: 7/7
- live DB integration: 47/47
- import stress/integrity: 8/8
- approval modes: `all` proposed; `off` applied through approver
- clean pgvector migration: 15/15 plus checksum verification
- `npm audit`: 0 vulnerabilities

## Deferred improvements

- Deployment/release records and code-commit provenance can be added later as new domain events or
  typed relationships.
- Chunked full-body KB retrieval can be added if summary-card embeddings prove insufficient.
- The deprecated additive `link_feature_request` alias can be removed in a future major release;
  new callers should use complete versioned replacement.
