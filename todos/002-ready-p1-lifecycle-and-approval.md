---
status: complete
priority: p1
issue_id: "002"
tags: [lifecycle, approval, security]
dependencies: ["001"]
---

# Immutable lifecycle and production approval

## Problem Statement

Current stories can be rewritten without history and production changes have no durable human approval boundary.

## Findings

- `user_stories` is the only state record.
- `mcp_writer` can create and update production rows.
- Current review UI approves bulk drafts, not change proposals.

## Proposed Solutions

### Option 1: Current projection plus revisions, events, and proposals

**Approach:** Implement plan units U4-U7 with a separate approver credential and localhost/CLI review.

**Pros:** Clean search, complete history, real approval gate.

**Cons:** New schema and workflow.

**Effort:** Large

**Risk:** Medium-high

### Option 2: Add an audit JSON column

**Approach:** Append patch blobs to the current row.

**Pros:** Smaller schema.

**Cons:** Weak immutability, poor lifecycle retrieval, no safe concurrency.

**Effort:** Medium

**Risk:** High

## Recommended Action

Implement option 1 exactly as approved.

## Technical Details

Plan units U4-U7.

## Acceptance Criteria

- [x] Accepted story mutations append immutable revisions/events.
- [x] Production-sensitive changes default to pending proposals.
- [x] Ordinary writer cannot apply production changes.
- [x] Local UI and CLI approve/reject with stale-revision protection.
- [x] History/proposal read tools never expose an MCP approval action.

## Work Log

### 2026-07-13 - Queued

**By:** Codex

**Actions:**
- Captured approved proposal-mode and credential decisions.

**Learnings:**
- `off` mode must use the approver connection; a tool argument is not a security boundary.

### 2026-07-13 - Completed

**By:** Codex

**Actions:**
- Added accepted revisions, semantic events, proposals, RLS, separate approver functions, CLI, and loopback review UI.
- Live-tested production propose/approve/reject, current-search invisibility, stale guards, plus `all` and `off` modes.
