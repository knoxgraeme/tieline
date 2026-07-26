---
status: complete
priority: p1
issue_id: "001"
tags: [architecture, postgres, migrations]
dependencies: []
---

# Domain ports, PostgreSQL adapter split, and clean privileges

## Problem Statement

The storage port derives from the PostgreSQL implementation, the data layer is monolithic, migrations have no ledger, and clean writer installs lack identity-sequence privileges.

## Findings

- `src/store.ts` imports `db.ts` and declares methods with `typeof pg.*`.
- `src/db.ts` owns unrelated read/write/search/help/taxonomy concerns.
- `scripts/migrate.ts` replays every idempotent file without checksums.
- migration 0009 does not grant sequence usage.

## Proposed Solutions

### Option 1: Domain capability ports and composed PostgreSQL adapter

**Approach:** Define plain domain contracts, split adapter modules, add a migration ledger and exact grants.

**Pros:** Portable, testable, and aligned with the approved plan.

**Cons:** Broad mechanical refactor.

**Effort:** Large

**Risk:** Medium

### Option 2: Patch grants only

**Approach:** Leave architecture intact and add sequence grants.

**Pros:** Fast.

**Cons:** Does not satisfy the portability or structure requirements.

**Effort:** Small

**Risk:** High architectural debt

## Recommended Action

Implement option 1 in behavior-preserving stages, then run the current build/smoke/ranking suite.

## Technical Details

Plan units U1-U3 in `docs/plans/2026-07-13-feat-story-lifecycle-hardening-plan.md`.

## Acceptance Criteria

- [x] Domain contracts have no PostgreSQL imports or derived adapter types.
- [x] PostgreSQL implementation is split into cohesive modules.
- [x] Migration ledger detects changed applied migrations.
- [x] Fresh/upgraded installs grant writer sequence usage.
- [x] Existing build, ranking, and smoke tests pass.

## Work Log

### 2026-07-13 - Started

**By:** Codex

**Actions:**
- Confirmed user approval and mapped plan units U1-U3.

**Learnings:**
- Workspace is a source snapshot without usable Git metadata.

### 2026-07-13 - Domain port completed

**By:** Codex

**Actions:**
- Added explicit domain capability interfaces and result types.
- Added a loud-failure fake adapter seam.
- Moved PostgreSQL composition out of `src/store.ts` into the adapter namespace.
- Verified TypeScript and app bundle builds.

**Learnings:**
- Existing tools consume a small discriminated query result, so the port can stay precise without exposing SQL.

### 2026-07-13 - Completed

**By:** Codex

**Actions:**
- Split the monolith into connection, vector, search, story/history, relationship, help, feature-request, taxonomy, and import repositories.
- Added checksum-ledger migrations and verified 15 files from an empty pgvector database.
- Fixed clean writer sequence/key-mint privileges discovered by live least-privilege testing.
