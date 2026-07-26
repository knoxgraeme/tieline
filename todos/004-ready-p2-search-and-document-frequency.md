---
status: complete
priority: p2
issue_id: "004"
tags: [search, ranking, postgres]
dependencies: ["003"]
---

# Hybrid candidate retrieval and live document frequency

## Problem Statement

Structural ranking is gated by semantic KNN, the current relevance floor is too permissive, and process-lifetime document-frequency caching becomes stale.

## Findings

- `find_related` retrieves KNN before extracting/ranking structural overlap.
- `FIND_RELATED_MIN_SCORE=0.15` combines signals that need independent qualification.
- `getDocFrequencies` never expires.

## Proposed Solutions

### Option 1: Candidate union, independent gates, live counts

**Approach:** Implement U10-U11 with an evaluation fixture.

**Pros:** Correct recall, cleaner results, no invalidation protocol.

**Cons:** Additional SQL candidate path.

**Effort:** Medium-large

**Risk:** Medium

### Option 2: Increase KNN pool and add cache TTL

**Approach:** Tune around current design.

**Pros:** Small.

**Cons:** Structural matches can still be omitted and cache correctness remains approximate.

**Effort:** Small

**Risk:** Medium-high

## Recommended Action

Implement option 1.

## Technical Details

Plan units U10-U11.

## Acceptance Criteria

- [x] Exact structural candidates outside KNN can qualify.
- [x] Semantic and structural floors are independent and evaluated.
- [x] Relationship changes affect document frequency immediately.
- [x] Ranking and integration tests cover clean empty results.

## Work Log

### 2026-07-13 - Queued

**By:** Codex

**Actions:**
- Captured ranking changes and evaluation requirement.

**Learnings:**
- `df` is distinct-story frequency, not raw link count.

### 2026-07-13 - Completed

**By:** Codex

**Actions:**
- Unioned semantic and exact structural candidate paths with independent gates.
- Replaced cached/materialized counts with live distinct-story frequencies and checked in relevance fixtures.
