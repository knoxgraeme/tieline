# Tieline grading contract

## What grading answers

`compile` proves a linked path exists and is a file inside the repository.
`reviewed_content_hash` proves its bytes have not changed since review. Neither
proves the artifact relates to the Acceptance Criterion. Grading converts the
unfalsifiable claim *"this file implements this AC"* into a falsifiable one:
*"this named symbol does, and the symbol demonstrably exists."*

## Where the judgment happens

Tieline holds no LLM client, provider configuration, or model credential, and
gains none from grading. Both CLI modes are pure functions of the manifest, the
working tree, and the git diff, and both run with no database and no network.
The judgment lives here, in the host agent running this skill, inside the same
pull-request loop that accepts every other contract change.

```
contract grade --emit-scope   ->   you read and judge   ->   contract grade --verify
      deterministic                   the only step               deterministic
                                   Tieline cannot check           fence + report
```

## The fence

A `supported` grade must cite a symbol drawn from the `vocabulary` emitted for
that artifact. The test is **membership**, not substring presence:

- Tieline strips line comments, block comments, and string and template literals
  before matching declarations. An identifier that appears only in a comment or
  a string is **not** in the vocabulary and cannot support a grade.
- Vocabulary is built from declaration forms — `function`, `class`, `interface`,
  `type`, `enum`, and `const`/`let`/`var` bindings, exported or not. A private
  helper is a legitimate citation.
- Imported names are not in the vocabulary of the file that imports them. They
  are declared elsewhere; cite them where they are declared.
- A citation outside the vocabulary is downgraded to `unsupported` and the
  downgrade is reported as `fabricated_citation`. It is never silently accepted
  and never silently dropped.

The extractor is deliberately conservative. It may miss a symbol that genuinely
exists, which wrongly downgrades a valid grade — safe, visible, and correctable.
It cannot invent a symbol that is absent from the file, which is the failure that
would actually matter.

## Grades

Three discrete states. There is no numeric confidence field anywhere, and asking
for one is out of scope: continuous confidence scores collapse toward the middle
of their range and stop discriminating.

| Grade | Meaning |
| --- | --- |
| `supported` | A named symbol in the artifact serves this AC. Cite it. |
| `partial` | The artifact participates in the behavior, but no single symbol carries the AC. Give a reason. |
| `unsupported` | No support found. This is the refusal path. Give a reason. |

`unsupported` must never be dropped, hidden, or inferred away. A scoped link with
no submitted verdict is reported `unsupported` rather than skipped, because a
skill that dies halfway — or a grader that quietly avoids a hard link — must not
read as success.

## Verdict shape

```json
{
  "acceptance_criterion_stable_id": "GRADING-001-AC1",
  "path": "src/contract/grade.ts",
  "relation": "implements",
  "grade": "supported",
  "symbol": "buildGradeScope"
}
```

- `relation` is optional and echoed from scope for readability.
- `symbol` is required if and only if `grade` is `supported`.
- `reason` is required if and only if `grade` is not `supported`.
- A `partial` or `unsupported` verdict carrying a `symbol` is malformed.
- Two verdicts for one `(acceptance_criterion_stable_id, path)` pair are
  rejected rather than resolved by last-write-wins.
- Verify re-derives the scope from the same `--base`, so a hand-widened work
  list is rejected.

## Exit codes

Grading is advisory. The default exit is 0 whatever the grades are, because
grade quality varies with whichever model runs this skill and a noisy gate would
be routed around. `--strict` is the only path to a non-zero exit, and only while
an `unsupported` grade remains.

The separate deterministic gate — `tieline check --strict`, which fails on a
stale manifest — is unaffected by grading and stays reproducible.

## Durability

Nothing is persisted: no grades file, no database write, no grade history. The
one durable fact a grade produces is the symbol that serves an AC, and the
contract's `selector` field already holds it. Surface `supported` citations as
proposed `selector` values and let the author accept them through pull-request
review. Do not write them into YAML from this skill.
