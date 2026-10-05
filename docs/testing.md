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

## Browser test for screen capture

`npm run test:screens:browser` builds Tieline and captures a synthetic Acme Notes app
(`tests/fixtures/screens-browser/`) with real Playwright and Chromium, in a CommonJS and an ESM
test project. It needs a browser, so it is opt-in and not part of `npm run check`: run
`npx playwright install chromium` first, or run it in the official Playwright Docker image at the
version `package.json` pins. Set `TIELINE_BROWSER_CHANNEL=chrome` to use an installed Chrome
instead. The canonical suite covers capture with fakes and needs no browser.

## Object storage check for hosted screens

The integration suite covers hosted screens against the disposable database with an in-memory
bucket. `tests/integration/object-store-s3.ts` checks the S3 client against a real
S3-compatible server that verifies signatures, such as a local SeaweedFS or MinIO. It creates and
deletes a disposable bucket, refuses any endpoint that is not on a loopback host, and is not part
of `npm run check`:

```bash
TIELINE_S3_TEST_ENDPOINT=http://127.0.0.1:8333 \
TIELINE_S3_TEST_ACCESS_KEY_ID=... TIELINE_S3_TEST_SECRET_ACCESS_KEY=... \
  npx tsx tests/integration/object-store-s3.ts
```

## Disposable database guard

`npm run test:integration` and the other database-writing integration commands require guarded, disposable test credentials and a verified test-only database target. Never point them at a development, staging, or production `DATABASE_URL`. The ordinary offline suite does not need production credentials.
