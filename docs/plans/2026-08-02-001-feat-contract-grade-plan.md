---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-brainstorm
title: "Contract grade - agent-graded evidence for contract links"
date: 2026-08-02
updated: 2026-08-04
type: feat
depth: deep
---

# Contract grade - agent-graded evidence for contract links

## Goal capsule

- **Objective:** Let a host agent judge whether every acceptance-criterion link affected by a diff still supports its criterion, then deterministically validate the agent's citations and verdicts.
- **User:** An implementing or reviewing agent working in a repository with a compiled Tieline contract.
- **Boundary:** Tieline derives the work list and validates evidence; it does not call a model, persist grades, or claim that a linked test ran.
- **Enforcement:** Grading is advisory by default. `--strict` exits non-zero when any scoped link remains unsupported after verification.

## Product contract

### Problem

The manifest can prove that a link is structurally present and current, but not that the linked artifact actually supports the acceptance criterion. A host agent can make that semantic judgment after reading the criterion and code, provided Tieline supplies a complete deterministic scope and refuses fabricated citations.

### Requirements

- **R1.** `tieline contract grade --base <ref> --emit-scope` must emit every non-contract evidence link associated with the diff-scoped acceptance criteria.
- **R2.** Scope derivation must reuse reconciliation's shared contract-claim index; lexical plausibility may rank review work but must never remove a scoped link.
- **R3.** Each scope entry must include the acceptance-criterion stable ID and text, relation, artifact path, link scope, change reason, and the exact symbols that may be cited for that artifact.
- **R4.** Legal symbols must come from `indexSourceSymbols` in `src/contract/selector.ts`; C3 must not add another source walk or symbol extractor.
- **R5.** `--emit-scope --json` must be stable, machine-readable output. Prose output must remain sufficient for an agent to perform the task.
- **R6.** `--verify <verdicts.json>` must rederive the same scope from `--base` and accept exactly one verdict for each scoped entry.
- **R7.** The only submitted grades are `supported`, `partial`, and `unsupported`. `supported` requires a citation selected from the supplied vocabulary; `partial` and `unsupported` require a reason and do not accept a citation.
- **R8.** Missing verdicts become `unsupported`; duplicate or out-of-scope verdicts make the submission invalid; fabricated citations are deterministically downgraded to `unsupported` with cause `fabricated_citation`.
- **R9.** Verification is ephemeral and offline: no database, network, model client, or grade persistence.
- **R10.** Verification exits zero in advisory mode even when unsupported entries remain. `--strict` exits non-zero exactly when the validated result contains unsupported entries. Malformed submissions exit non-zero in either mode.
- **R11.** A bundled `tieline-grade` skill must tell the host agent to read every scoped artifact, judge every entry, print its grades and citations before verification, and treat unsupported evidence as an expected useful result rather than a reason to invent support.

### Key decisions

- The host agent grades because semantic entailment is not a deterministic parser task; Tieline owns scope and citation integrity because those are deterministic.
- Grades are discrete and deliberately small. Confidence scores would imply calibration the feature cannot establish.
- Citations name real source symbols, not arbitrary prose or line numbers. The emitted vocabulary is the complete allow-list for `supported`.
- Scope output identifies files and symbols but does not embed entire file contents. The host agent reads the files through its normal repository tools.
- Grading remains separate from mapping coverage and link plausibility. Coverage answers whether a link exists; plausibility ranks review candidates; grading records a host agent's scoped judgment.
- `GRADING` remains a separate contract capability for C3. Whether it should later fold into `CONTRACT` is a follow-up design question, not an implementation prerequisite.

### Acceptance examples

- A changed linked TypeScript file yields one entry per acceptance criterion/link pair, including both direct and story-fallback claims where both exist.
- A changed unlinked file yields no grading entry; reconciliation, not grading, reports that authoring question.
- A supported verdict citing a symbol in the emitted vocabulary remains supported.
- A supported verdict citing a made-up symbol becomes unsupported with `fabricated_citation`.
- A missing verdict becomes unsupported and is visible in the result rather than silently omitted.
- A partial or unsupported verdict without a reason is rejected as malformed.
- A verdict for an entry not in the rederived scope is rejected, preventing a stale or substituted scope from being verified.
- Advisory verification exits zero with unsupported results; the same result exits non-zero with `--strict`.

## Planning contract

### Current architecture constraints

- The manifest is the sharded directory `.tieline/manifest/`, read through `readContractManifest`.
- Diff changes are parsed by `parseNameStatus` and scoped to criteria by `analyzeContractReconciliation`, which consumes the shared `buildContractClaimIndex` traversal.
- Canonical source declarations are indexed by `indexSourceSymbols`; supported extensions are declared by `RESOLVABLE_SOURCE_EXTENSIONS`.
- Path-to-criteria indexing is shared through reconciliation for path queries, but grading remains diff-scoped and must not introduce a parallel contract traversal.
- Contract actions are registered in `src/cli.ts` and dispatched by `src/commands/contract.ts`.
- Script tests are the repository's established framework. `npm run test:contract` is the aggregate contract suite.

### Data contract

Each scope entry has a deterministic identity derived from:

```text
acceptance_criterion_stable_id + NUL + relation + NUL + linked_path + NUL + path + NUL + link_scope
```

The JSON scope shape is:

```ts
interface GradeScopeEntry {
  id: string;
  acceptance_criterion_stable_id: string;
  acceptance_criterion: string;
  relation: string;
  linked_path: string;
  path: string;
  link_scope: "direct" | "story_fallback";
  reason: "modified" | "added" | "deleted" | "renamed";
  symbols: string[];
}
```

`symbols` is sorted and contains canonical selectors such as `function:runGradeCommand`, not bare names. An unsupported language, missing/deleted artifact, or artifact with no recognized symbols has an empty vocabulary; such an entry cannot honestly receive `supported`.

Submitted verdicts use:

```ts
interface SubmittedGradeVerdict {
  id: string;
  grade: "supported" | "partial" | "unsupported";
  citation?: string;
  reason?: string;
}
```

The verification report repeats the current scope entry, records the normalized grade, citation/reason, and a machine cause where the fence changed or supplied the outcome (`fabricated_citation` or `missing_verdict`). Summary counts are derived from the normalized results.

## Implementation units

### U1 - Grade domain and selector-backed citation vocabulary

**Goal:** Define stable scope/result types and build an allow-list from existing selector extraction.

**Files:**

- Add `src/contract/grade.ts`
- Add `scripts/test-grade.ts`
- Update `package.json`

**Approach:**

- Convert `SymbolIndex.kinds` entries into canonical `kind:name` selectors and sort them.
- Read only repository-local, supported source files. Missing, deleted, directory, binary, oversized, and unsupported files yield an empty vocabulary instead of throwing.
- Derive entries from reconciliation's `claimed_changes`, retaining direct and story-fallback as distinct work. Preserve `ClaimingCriterion.linked_path` separately from the changed artifact's current path so links to both sides of a rename cannot collapse.
- Contract-definition changes are reconciliation exclusions, not gradeable artifacts; unrelated broken-link sweeps are outside this diff-scoped command.

**Proof first:** Add focused tests for deterministic IDs/order, selector vocabulary, empty vocabularies, direct/story-fallback distinction, and no relevance filtering.

**Verification:** `npm run test:grade` and `npm run build`.

### U2 - Emit the diff-scoped grading work list

**Goal:** Expose deterministic scope through the CLI.

**Files:**

- Update `src/commands/contract.ts`
- Update `src/cli.ts`
- Extend `scripts/test-grade.ts`

**Approach:**

- Register `contract grade` directly because it has mutually exclusive `--emit-scope` and `--verify` modes plus required `--base`.
- Resolve the workspace/manifest through the existing contract-command path, run `git diff --name-status --find-renames <base>`, and pass its parsed changes to the grade domain.
- Emit JSON for agents and concise prose for humans. Empty scope is an explicit successful result.

**Proof first:** CLI tests cover JSON/prose, required mode, real git diff, empty scope, and missing manifest errors.

**Verification:** `npm run test:grade`, `npm run test:contract-command`, and `npm run build`.

### U3 - Verify verdict completeness and citation integrity

**Goal:** Validate agent output against a freshly derived scope.

**Files:**

- Update `src/contract/grade.ts`
- Update `src/commands/contract.ts`
- Extend `scripts/test-grade.ts`

**Approach:**

- Parse a JSON document containing a `verdicts` array and reject unreadable/malformed documents with actionable errors.
- Reject duplicate IDs and IDs outside the current scope.
- Normalize missing verdicts to unsupported.
- Require a legal citation for supported; downgrade an illegal or absent citation to unsupported with `fabricated_citation`.
- Require a non-empty reason for partial/unsupported and reject a citation on those grades.
- Derive exit status from invalid submission versus advisory/strict normalized results.

**Proof first:** Cover all three valid grades, fabricated and missing citations, missing verdicts, duplicates, out-of-scope IDs, malformed JSON, and strict/advisory exit behavior.

**Verification:** `npm run test:grade`, `npm run test:contract`, and `npm run build`.

### U4 - Bundle the host-agent grading workflow

**Goal:** Make correct use discoverable without binding Tieline to an agent runtime.

**Files:**

- Add `skills/tieline-grade/SKILL.md`
- Add `skills/tieline-grade/agents/openai.yaml`

**Approach:** Document the two-phase invocation, require reading every scoped artifact, require visible judgments before invoking verification, prohibit invented citations, and recommend a precise selector as a contract-maintenance suggestion without editing YAML automatically.

**No-test exception:** This is instruction-only content. Replacement verification is frontmatter/config parsing plus manual comparison against the CLI contract.

### U5 - Self-host the grading behavior

**Goal:** Record the shipped behavior in Tieline's own accepted contract.

**Files:**

- Add `.tieline/spec/grading.yaml`
- Regenerate `.tieline/manifest/`

**Approach:** Add a `GRADING` capability with criteria for complete scope, citation fencing, advisory/strict behavior, and the host-agent workflow. Link each criterion to the narrowest code/test/skill evidence. Re-read every spec file before selecting IDs.

**Verification:**

```sh
npm run test:contract
npm run build
node dist/cli.js contract validate .
node dist/cli.js contract compile .
node dist/cli.js contract coverage .
node dist/cli.js contract reconcile . --base origin/main
node dist/cli.js check --base origin/main
git diff --exit-code -- .tieline/manifest
```

## Dependency order

```text
U1 -> U2 -> U3 -> U4 -> U5 -> review -> ship
```

U2 depends on the grade domain. U3 extends the same domain and command after scope output is stable. U4 documents the finished interface. U5 links only final code and instructions, then manifest compilation records the exact reviewed basis.

## Out of scope

- Calling or configuring an LLM.
- Persisting grades or grading history.
- Treating grades as test-run receipts.
- Whole-contract grading sweeps.
- Relevance filtering of diff-scoped work.
- Adding a second symbol extractor or a third manifest/contract traversal.
- Editing contract selectors automatically from an agent verdict.

## Done when

- The focused grade suite proves complete scope and every fence outcome.
- The aggregate contract suite and TypeScript build pass.
- The bundled skill accurately drives the two-phase workflow.
- The accepted GRADING contract is valid and the sharded manifest is byte-current.
- A pull request is green, reviewed, and merged before the next roadmap unit begins.
