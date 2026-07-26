---
status: complete
priority: p2
issue_id: "006"
tags: [quality, docs, tests]
dependencies: ["005"]
---

# Defect cleanup, docs, and completion audit

## Problem Statement

Small defects and documentation drift reduce reliability, and the full plan needs requirement-by-requirement verification before completion.

## Findings

- XOR validation, duplicate help keys, status enums, graph pair keys, counts/comments, nullability, and environment docs drift.
- esbuild currently has a moderate advisory.

## Proposed Solutions

### Option 1: Complete U15-U16 and audit every requirement

**Approach:** Fix all drift, update docs/upgrade guide, and run clean/upgrade/full test matrices.

**Pros:** Complete, evidence-backed delivery.

**Cons:** Requires database-backed environment for strongest migration proof.

**Effort:** Medium-large

**Risk:** Low-medium

### Option 2: Fix only test failures

**Approach:** Stop when current tests pass.

**Pros:** Faster.

**Cons:** Existing tests do not prove the requested scope.

**Effort:** Small

**Risk:** High

## Recommended Action

Implement option 1.

## Technical Details

Plan units U15-U16 and definition of done.

## Acceptance Criteria

- [x] Every listed defect/drift item is fixed and covered.
- [x] Documentation and MCP resources match runtime behavior.
- [x] Build/UI/ranking/smoke/embedding/HTTP/integration/audit checks pass.
- [x] Completion audit maps every plan requirement to authoritative evidence.

## Work Log

### 2026-07-13 - Queued

**By:** Codex

**Actions:**
- Created final quality and audit gate.

**Learnings:**
- A green narrow suite is not sufficient evidence for this plan.

### 2026-07-13 - Completed

**By:** Codex

**Actions:**
- Fixed schema XOR/status drift, graph tuple serialization, transactional section reads, nullability, docs/comments, and esbuild advisory.
- Completed clean npm install/build plus empty-database migration/checksum and 47-check live integration matrices.
