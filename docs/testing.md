# Testing

[README](../README.md) · [Architecture](architecture.md) · [Setup](setup.md) · [CLI](cli.md) · **Testing** · [Operations](operations.md)

## Test layout

| Location | Purpose |
| --- | --- |
| `tests/unit/` | Deterministic tests for contract, retrieval, runtime, topology, and evidence behavior. |
| `tests/integration/` | Database-backed integration tests. These write only to a guarded disposable database. |
| `tests/smoke/` | End-to-end smoke coverage of core repository workflows. |
| `tests/evaluations/` | Retrieval and behavior evaluations with explicit fixtures and scoring. |
| `tests/fixtures/` | Controlled source, contract, and parser inputs. |
| `tests/support/` | Shared test harnesses and helpers. |
| `tests/support/fakes/` | Test doubles; never production adapters. |
| `benchmarks/` | Repeatable performance measurements, outside the ordinary test gate. |
| `scripts/` | Development and verification utilities, including the generated-artifact gate. |

## Commands

```bash
npm ci
npm run check:fast
npm run check
```

`npm run check:fast` runs typechecking, the production build, the offline test suite, and guardrail checks. `npm run check` is the canonical full validation path; it adds CLI/onboarding validation and a package dry run.

During focused work, run the narrowest relevant `npm run test:*` command, then run `npm run check` before handoff. Use `npm run check:generated-artifacts` whenever authored specs or generated artifacts change.

## Disposable database guard

`npm run test:integration` and the other database-writing integration commands require guarded, disposable test credentials and a verified test-only database target. Never point them at a development, staging, or production `DATABASE_URL`. The ordinary offline suite does not need production credentials.
