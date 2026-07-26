---
status: complete
priority: p2
issue_id: "005"
tags: [knowledge-base, embeddings, http, security]
dependencies: ["004"]
---

# KB minimum functionality and runtime hardening

## Problem Statement

The KB has no bundled loader or match-review flow, help filters happen after KNN, nullability drifts, external embeddings can hang, and HTTP defaults trust a gateway without local origin safeguards.

## Findings

- Help tables exist but the bundled ingest does not populate them.
- HTTP embedding calls have no timeout/retry.
- HTTP listens without an explicit host and does not validate Origin.

## Proposed Solutions

### Option 1: Implement U12-U14

**Approach:** Add help batch import/suggestions, SQL filters, fixed 384-dim reliable providers, and safe HTTP defaults.

**Pros:** Coherent minimum KB and resilient self-hosting.

**Cons:** Requires new tests and docs.

**Effort:** Large

**Risk:** Medium

### Option 2: Documentation-only KB and hosting warnings

**Approach:** Leave runtime gaps.

**Pros:** Small.

**Cons:** Does not address explicit requirements.

**Effort:** Small

**Risk:** High

## Recommended Action

Implement option 1.

## Technical Details

Plan units U12-U14.

## Acceptance Criteria

- [x] Help filters apply before KNN limit and nullable rows validate.
- [x] Help articles can be batch imported and links suggested without auto-writing.
- [x] External embedding timeout/retry/redaction/concurrency tests pass at 384 dimensions.
- [x] HTTP binds locally and validates configured origins.

## Work Log

### 2026-07-13 - Queued

**By:** Codex

**Actions:**
- Recorded lower-priority KB scope and required runtime hardening.

**Learnings:**
- Article suggestions must persist only through the normal relationship/approval flow.

### 2026-07-13 - Completed

**By:** Codex

**Actions:**
- Added JSON/JSONL help import, SQL pre-limit facets, and read-only story/article suggestions.
- Fixed storage width at 384 and added bounded external transport plus safe OSS HTTP defaults.
