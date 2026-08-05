---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
title: "Contract link provenance - Plan"
date: 2026-08-04
type: feat
depth: standard
---

# Contract link provenance - Plan

## Goal capsule

- **Objective:** Record where every contract claim came from and preserve that origin from accepted YAML through compiled manifests, database projections, and agent-facing reads.
- **User:** Maintainers and agents inspecting or authoring Tieline contracts.
- **Boundary:** Provenance describes claim origin. It does not score evidence, record a grader, timestamp a decision, or become part of link identity.
- **Compatibility posture:** This is intentionally breaking while Tieline has no users: every link must state provenance, with no optional field or inferred default.

## Product contract

### Problem

The relation and target describe what a contract link claims, while freshness and grade describe aspects of its evidence. None records how the claim entered the contract. Agents therefore cannot distinguish a directly authored claim from one introduced by inference or carried through planning materialization.

### Requirements

- **R1.** Every accepted and planning contract link must require exactly one stable provenance value: `authored`, `inferred`, or `materialized`.
- **R2.** Provenance must mean where the claim came from and remain distinct from grade, freshness, authority, and link scope.
- **R3.** Existing repository-maintained links and representative authored test fixtures must be explicitly labeled `authored`; no parser or storage default may guess a missing value.
- **R4.** Compiled manifests must serialize provenance and include it in existing link-bearing contract semantics, so changing provenance changes the owning Story or Acceptance Criterion contract hash.
- **R5.** Repository sync must persist provenance for code, test, and help links, and contract reads must return it for direct and Story-fallback evidence.
- **R6.** Deterministic manifest-backed path lookup, reconciliation, grading scope, impact reporting, and link-review output must preserve provenance when they expose a particular claim.
- **R7.** Provenance must not become part of the link identity tuple. Re-labeling the same owner, target, and relation updates claim metadata rather than creating a second link.
- **R8.** Mutable facts such as grader identity, timestamps, commits, or confidence must remain outside authored YAML and contract-link provenance.
- **R9.** One owner must not declare the same relation and target more than once with contradictory provenance values.

### Key decisions

- **KTD1. Required explicit provenance.** Use a required field and label the corpus rather than an optional field or `authored` default, because silent defaults erase the exact distinction this feature exists to retain. Governs R1 and R3. (session-settled: user-directed — chosen over optional/defaulted provenance after the no-user migration tradeoff was stated)
- **KTD2. Small stable vocabulary.** Limit provenance to `authored | inferred | materialized`; keep mutable grading and audit facts in derived output. Governs R2 and R8. (session-settled: user-directed — chosen over richer mutable metadata because link fields participate in contract hashes)
- **KTD3. Metadata, not identity.** Persist provenance on each ownership junction and update it with the link, without widening primary keys or locator maps. Governs R5 and R7.
- **KTD4. Agent-visible end to end.** Any representation that returns a concrete contract claim carries its provenance; aggregate coverage and semantic identifiers need not incorporate it. Governs R5 and R6.

### Acceptance examples

- An accepted link with no provenance fails validation with an actionable schema issue.
- Identical code links labeled `authored`, `inferred`, and `materialized` each parse when tested independently.
- Changing only a criterion link from `authored` to `inferred` changes that criterion's `contract_hash` and serialized manifest link.
- Syncing the same link after changing only provenance updates one junction row rather than creating another.
- Declaring the same owner, relation, and target twice with different provenance fails validation rather than selecting a value by source order.
- `query_stories` returns provenance for code/test and help links, including Story fallback links.
- Contract graph evidence edges return provenance; hierarchy and lifecycle edges return no provenance because they are not contract links.
- `get_path_criteria`, reconciliation JSON, grade scope, and impact JSON retain the provenance of the exact manifest link that produced each claim.

## Planning contract

### Current architecture constraints

- `src/contract/schema.ts` owns accepted/planning link validation; `src/contract/manifest.ts` has a separate strict schema for compiled artifacts.
- `criterionSemantics()` and `storySemantics()` include source links verbatim, so provenance naturally participates in contract hashes.
- `src/adapters/postgres/contract-sync-repository.ts` replaces owner-link junctions on sync; the four junction tables in `migrations/0001_baseline.sql` are the projection boundary.
- `src/adapters/postgres/contract-read-repository.ts` reconstructs the shared `ContractEvidenceLink` returned by query tools.
- `buildContractClaimIndex()` is the shared traversal for reconciliation and deterministic path lookup. Provenance must be added to that claim record rather than recovered by another manifest walk.
- The repository uses script-based tests and a compiled, sharded manifest that must be regenerated before push.

### Provenance semantics

- `authored`: the claim was introduced directly by a person in its current planning or repository authority surface.
- `inferred`: the claim originated in deterministic or model-assisted inference in its current authority surface and retains that origin through review within that surface.
- `materialized`: the accepted repository claim was copied from a planning record during planning-to-repository authority transfer.

The values describe mutually exclusive introduction paths, not current trust or ownership. A planning link is `authored` or `inferred`; materialization deliberately establishes `materialized` on the repository copy, regardless of the planning link's earlier origin. Later review within the same authority surface does not rewrite provenance merely because a human approved the claim.

## Implementation units

### U1 - Require and compile provenance

**Goal:** Establish the source and manifest data contracts.

**Files:**

- Update `src/contract/schema.ts`
- Update `src/contract/validate.ts`
- Update `src/contract/manifest.ts`
- Update `scripts/test-contract.ts`
- Update `scripts/test-manifest.ts`

**Approach:** Export one canonical provenance vocabulary/type, require it in every discriminated contract-link arm, copy it into `ManifestLink`, and require it when reading manifest shards. Keep the existing link sort and identity based on relation plus target; the complete serialized link still participates in Story/criterion semantic hashes. Validate duplicate owner links by relation plus canonical target while excluding provenance from that key, so contradictory source declarations fail instead of relying on order.

**Proof first:** Cover rejection of a missing field, acceptance of all three values, duplicate identity with conflicting provenance, manifest round-trip, and a contract-hash change caused only by provenance.

### U2 - Persist and return provenance

**Goal:** Preserve origin through repository synchronization and structured contract reads.

**Files:**

- Update `migrations/0001_baseline.sql`
- Update `src/adapters/postgres/contract-sync-repository.ts`
- Update `src/adapters/postgres/contract-read-repository.ts`
- Update `src/domain/contract-read-store.ts`
- Update `scripts/integration-contract-sync.ts`
- Update `scripts/test-contract-read.ts`

**Approach:** Add a required constrained provenance column to all four Story/criterion code/help junctions. Insert provenance during replacement sync and select it into `ContractEvidenceLink`. Contract graph evidence edges copy the link provenance, while hierarchy and lifecycle edges omit it. Do not add provenance to junction primary keys. Because there are no deployed users, update the baseline rather than add a compatibility migration.

**Proof first:** Assert code/test/help persistence and read-back, Story fallback visibility, and metadata replacement without duplicate link identity. Run the database integration when a usable Postgres/pgvector service is available; otherwise report the environmental limitation while retaining compile and unit proof.

### U3 - Propagate provenance through claim views

**Goal:** Make the new distinction available anywhere an agent sees a concrete contract claim.

**Files:**

- Update `src/contract/reconciliation.ts`
- Update `src/contract/path-criteria.ts`
- Update `src/contract/impact.ts`
- Update `src/contract/grade.ts`
- Update `src/contract/link-plausibility.ts`
- Update `src/contract/review-page.ts`
- Update `src/schemas.ts`
- Update corresponding `scripts/test-*.ts` contract tests

**Approach:** Add provenance to existing claim/result records at the point each record is constructed. Path lookup and grading inherit it from reconciliation's shared claim index; no additional manifest walk is allowed. Contract-definition impact entries use `provenance: null` because they do not arise from a link; linked and broken-link impacts carry the exact value. Show provenance beside concrete links in the contract review page. Preserve existing ordering and IDs because provenance is metadata rather than identity.

**Proof first:** Extend exact JSON assertions for direct and Story-fallback claims, and prove a path lookup receives provenance without a new traversal.

### U4 - Migrate the accepted corpus and self-host the rule

**Goal:** Leave no unlabeled contract link and record the behavior in Tieline's own contract.

**Files:**

- Update every `.tieline/spec/*.yaml` link
- Update YAML fixtures under `scripts/`
- Update typed `ManifestLink` and `ContractEvidenceLink` fixtures under `scripts/`
- Update the appropriate criterion in `.tieline/spec/contract.yaml`
- Regenerate `.tieline/manifest/`

**Approach:** Label all existing accepted claims `authored`. Use `inferred` and `materialized` only in focused tests that establish their semantics. Re-read every spec before selecting the self-hosted stable ID. Run `tieline contract compile .` after all source and spec edits and commit the generated manifest.

**Proof first:** Add a corpus/schema assertion that missing provenance fails, then migrate all fixtures until the full suite passes without a fallback.

## Verification contract

- `npm run test:contract`
- `npm run test:contract-read`
- `npm run test:integration:contract-sync` when database prerequisites are available
- `npm run build`
- `node dist/cli.js contract validate .`
- `node dist/cli.js contract compile .`
- `node dist/cli.js contract coverage .`
- `node dist/cli.js contract reconcile . --base origin/main`
- `node dist/cli.js check --base origin/main`
- `git diff --exit-code -- .tieline/manifest`

## Dependency order

```text
U1 -> U2 -> U3 -> U4 -> review -> PR -> green CI -> merge
```

## Risks and mitigations

- **Silent data loss:** A schema-only change could drop provenance in Postgres. U2 requires persistence and read-back proof across all four junctions.
- **Identity inflation:** Adding provenance to primary keys could allow contradictory duplicate claims. KTD3 keeps existing identity and replaces metadata.
- **Parallel contract traversal:** Re-deriving provenance for path lookup would regress the shared-index design. U3 extends `ClaimingCriterion` once.
- **Stale generated evidence:** Provenance changes contract hashes and manifest content. U4 makes compilation and a clean manifest diff a shipping gate.

## Out of scope

- Recording grade, grader, confidence, timestamps, commits, or audit history in YAML provenance.
- Automatically inferring or rewriting provenance.
- Changing coverage semantics, link plausibility ranking, freshness, or grade behavior.
- Compatibility defaults or upgrade migrations for users that do not exist.

## Definition of done

- All contract links require and serialize one valid provenance.
- Existing contracts and fixtures are explicitly labeled without a default.
- Database sync/read and agent-facing exact claim views preserve the value.
- No link identity or aggregate coverage semantics change.
- Tests, build, contract verification, and compiled manifest are clean.
- The PR is reviewed, CI is green, and the branch is merged.
