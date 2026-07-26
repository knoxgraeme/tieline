---
status: complete
priority: p1
issue_id: "003"
tags: [relationships, import, authoring]
dependencies: ["002"]
---

# Complete relationship mutations and safe batched import

## Problem Statement

Runtime tools cannot update all normalized relationships and bulk import is always exposed, owner-credentialed, monolithic, and difficult to retry safely.

## Findings

- Entity/code relationships are only replaced by import.
- Help links have no mutation path.
- Feature-request links are additive only.
- `import_stories` is always registered and ingest credentials fall back to read credentials.

## Proposed Solutions

### Option 1: Typed set/add/remove operations plus resumable batch import

**Approach:** Implement U8-U9 through lifecycle services.

**Pros:** Full agent parity, history, idempotency, and safer privilege boundary.

**Cons:** More explicit schemas.

**Effort:** Large

**Risk:** Medium

### Option 2: Generic polymorphic artifact links

**Approach:** Replace joins with one typed JSON table.

**Pros:** One CRUD path.

**Cons:** Weak constraints and rejected by the product decision.

**Effort:** Large

**Risk:** High

## Recommended Action

Implement option 1 and retain normalized domain tables.

## Technical Details

Plan units U8-U9.

## Acceptance Criteria

- [x] Entity, code, and help links support add/remove/replace.
- [x] Feature-request primary/secondary set is atomically replaceable.
- [x] Production relationship changes become proposals.
- [x] Import is disabled by default, batched, explicitly credentialed, and retry-safe.

## Work Log

### 2026-07-13 - Queued

**By:** Codex

**Actions:**
- Recorded normalized-storage decision and import boundary.

**Learnings:**
- Stable import references are required for keyless retry safety.

### 2026-07-13 - Completed

**By:** Codex

**Actions:**
- Added atomic typed relationship patches, event history, production proposals, and versioned complete FR link replacement.
- Proved 125-record three-batch import, no-op retries, validation, and later-batch rollback behavior.
