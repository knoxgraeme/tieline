import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type {
  ContractManifest,
  ManifestAcceptanceCriterion,
  ManifestLink,
  ManifestStory,
} from "../src/contract/manifest.js";
import {
  DEFAULT_ABSOLUTE_SCORE_FLOOR,
  LINK_PLAUSIBILITY_METHOD,
  acceptanceCriterionTokenSurface,
  analyzeLinkPlausibility,
  buildDocumentFrequencyIndex,
  extractSourceTokenSurface,
  inverseDocumentFrequency,
  meaningfulTokens,
  scoreLexicalPlausibility,
  splitIdentifier,
  toLinkReviewSuggestion,
} from "../src/contract/link-plausibility.js";

const REPOSITORY = "plausibility-fixture";
const EMPTY_HASH = "0".repeat(64);

// ---------------------------------------------------------------------------
// Identifier splitting and stopword removal
// ---------------------------------------------------------------------------

assert.deepEqual(splitIdentifier("renderInvoiceRefund"), [
  "render",
  "invoice",
  "refund",
]);
assert.deepEqual(splitIdentifier("HTTPServerPool"), ["http", "server", "pool"]);
assert.deepEqual(splitIdentifier("invoice_refund-total"), [
  "invoice",
  "refund",
  "total",
]);
assert.deepEqual(splitIdentifier("Tieline must reconcile the invoice."), [
  "tieline",
  "must",
  "reconcile",
  "the",
  "invoice",
]);

assert.deepEqual(
  meaningfulTokens(["const invoiceRefund = 12; return this.value;"]),
  ["invoice", "refund"],
  "keywords, English function words, digits and short tokens are dropped"
);

// ---------------------------------------------------------------------------
// Source surface extraction without an AST
// ---------------------------------------------------------------------------

const sample = extractSourceTokenSurface(`
// Reconciles the quarterly invoice refund.
/* Block note about currency rounding. */
import { logger } from "../logger.js";

export interface InvoiceRequest {
  refund: string;
}

export function applyInvoiceRounding(request: InvoiceRequest): string {
  logger.debug("applied invoice rounding for one request");
  return "invoice-refund";
}
`);
for (const expected of [
  "invoice",
  "refund",
  "currency",
  "rounding",
  "logger",
  "quarterly",
]) {
  assert.ok(
    sample.tokens.includes(expected),
    `expected surface to include '${expected}'`
  );
}
for (const keyword of ["export", "function", "return", "string", "interface"]) {
  assert.ok(
    !sample.tokens.includes(keyword),
    `expected surface to drop keyword '${keyword}'`
  );
}
assert.ok(sample.comment_blocks >= 2);
assert.ok(sample.string_literals >= 2);
assert.ok(sample.declared_names >= 3);
assert.deepEqual(
  [...sample.tokens].sort(),
  sample.tokens,
  "surface tokens are sorted for determinism"
);
assert.deepEqual(extractSourceTokenSurface("").tokens, []);

// ---------------------------------------------------------------------------
// Fixture repository
// ---------------------------------------------------------------------------

interface Topic {
  key: string;
  words: [string, string, string, string];
  /** Modules that also compute a signature, making that token common. */
  signed: boolean;
}

const TOPICS: Topic[] = [
  { key: "INVOICE", words: ["invoice", "refund", "currency", "rounding"], signed: false },
  { key: "TIMEZONE", words: ["timezone", "calendar", "daylight", "offset"], signed: true },
  { key: "RETENTION", words: ["retention", "archive", "purge", "expiry"], signed: true },
  { key: "PERMISSION", words: ["permission", "role", "grant", "revoke"], signed: false },
  { key: "UPLOAD", words: ["upload", "chunk", "resume", "checksum"], signed: true },
  { key: "DIGEST", words: ["digest", "newsletter", "subscriber", "unsubscribe"], signed: true },
  { key: "THROTTLE", words: ["throttle", "quota", "burst", "backoff"], signed: false },
  { key: "GLOSSARY", words: ["glossary", "terminology", "synonym", "definition"], signed: false },
  { key: "LOCALE", words: ["locale", "translation", "pluralization", "transliteration"], signed: false },
  { key: "SIGNATURE", words: ["signature", "certificate", "revocation", "fingerprint"], signed: false },
];

function pascal(word: string): string {
  return `${word[0].toUpperCase()}${word.slice(1)}`;
}

function sourceOf(topic: Topic): string {
  const [a, b, c, d] = topic.words;
  return [
    `import { logger } from "../logger.js";`,
    ``,
    `// Reviewers reconcile Tieline drift in this area.`,
    ``,
    `/**`,
    ` * ${pascal(a)} handling: ${b}, ${c}, ${d}.`,
    ` */`,
    `export interface ${pascal(a)}Request {`,
    `  ${b}: string;`,
    `  ${c}: number;`,
    ...(topic.signed ? [`  signature: string;`] : []),
    `}`,
    ``,
    `export function apply${pascal(a)}${pascal(d)}(request: ${pascal(a)}Request): string {`,
    `  logger.debug("applied ${a} ${d} for one request");`,
    `  return "${a}-${b}";`,
    `}`,
    ``,
  ].join("\n");
}

function pathOf(topic: Topic): string {
  return `src/${topic.words[0]}.ts`;
}

function codeLink(path: string, relation = "implements"): ManifestLink {
  return {
    relation: relation as ManifestLink["relation"],
    target: { kind: "code", repository: REPOSITORY, path },
    reviewed_content_hash: null,
  };
}

function criterionOf(
  topic: Topic,
  links: ManifestLink[]
): ManifestAcceptanceCriterion {
  const [a, b, c, d] = topic.words;
  return {
    stable_id: `AC-${topic.key}-001`,
    criterion: `Tieline must reconcile the ${a} ${b} using ${c} and ${d}.`,
    rationale: null,
    aliases: [],
    applies_to: null,
    position: 0,
    supersedes: null,
    scenarios: [],
    links,
    contract_hash: EMPTY_HASH,
  };
}

function storyOf(topic: Topic, links: ManifestLink[]): ManifestStory {
  const [a, b, c, d] = topic.words;
  return {
    stable_id: `US-${topic.key}-001`,
    title: `${pascal(a)} ${b}`,
    actor: "reviewers",
    goal: `reconcile the ${a} ${c}`,
    benefit: `the ${b} and ${d} agree`,
    lifecycle: "production",
    aliases: [],
    applies_to: null,
    motivated_by: [],
    supersedes: null,
    planning_origin: null,
    links: [],
    acceptance_criteria: [criterionOf(topic, links)],
    contract_hash: EMPTY_HASH,
  };
}

function manifestOf(stories: ManifestStory[]): ContractManifest {
  return {
    schema_version: 1,
    repository: { key: REPOSITORY, commit: "fixture" },
    inputs: [],
    capabilities: [
      {
        stable_id: "CAP-FIXTURE",
        name: "Fixture capability",
        description: "Fixture capability for link plausibility.",
        aliases: [],
        applies_to: null,
        supersedes: null,
        stories,
        contract_hash: EMPTY_HASH,
      },
    ],
  };
}

const root = mkdtempSync(resolve(tmpdir(), "tieline-link-plausibility-"));
try {
  mkdirSync(resolve(root, "src"), { recursive: true });
  mkdirSync(resolve(root, "assets"), { recursive: true });
  for (const topic of TOPICS) {
    writeFileSync(resolve(root, pathOf(topic)), sourceOf(topic));
  }
  writeFileSync(resolve(root, "src/blank.ts"), "");
  writeFileSync(
    resolve(root, "src/oversized.ts"),
    `// ${"padding ".repeat(80_000)}\n`
  );
  writeFileSync(
    resolve(root, "assets/blob.bin"),
    Buffer.from([0x89, 0x00, 0x01, 0x02, 0x00, 0x7f])
  );

  const timezone = TOPICS[1];
  const signature = TOPICS[9];

  // Every story links its acceptance criterion to its own module. The signature
  // criterion additionally links to the timezone module: a link that drifted.
  const stories = TOPICS.map((topic) =>
    storyOf(
      topic,
      topic === signature
        ? [codeLink(pathOf(signature)), codeLink(pathOf(timezone))]
        : [codeLink(pathOf(topic))]
    )
  );

  const edgeStory: ManifestStory = {
    ...storyOf(TOPICS[0], []),
    stable_id: "US-EDGE-001",
    title: "Edge handling",
    acceptance_criteria: [
      {
        ...criterionOf(TOPICS[0], [
          codeLink("src/absent.ts"),
          codeLink("src/blank.ts"),
          codeLink("src/oversized.ts"),
          codeLink("assets/blob.bin"),
          {
            relation: "documents",
            target: {
              kind: "help",
              source: "helpcenter",
              external_id: "article-1",
            },
            reviewed_content_hash: null,
          },
          {
            relation: "implements",
            target: {
              kind: "code",
              repository: "another-repository",
              path: "src/elsewhere.ts",
            },
            reviewed_content_hash: null,
          },
        ]),
        stable_id: "AC-EDGE-001",
      },
    ],
  };

  const manifest = manifestOf([...stories, edgeStory]);
  const report = analyzeLinkPlausibility({ repositoryRoot: root, manifest });

  // -------------------------------------------------------------------------
  // The report is structurally advisory
  // -------------------------------------------------------------------------

  assert.equal(report.advisory, true);
  assert.equal(report.method, LINK_PLAUSIBILITY_METHOD);
  assert.equal(report.status, "reviewed");
  assert.match(report.disclaimer, /never evidence/i);
  assert.ok(
    !Object.keys(report).some((key) => /invalid|wrong|broken|fail/i.test(key)),
    "no report key reads as a verdict"
  );

  // -------------------------------------------------------------------------
  // Scoring: a related pair beats an unrelated pair
  // -------------------------------------------------------------------------

  const surfaces = new Map(
    TOPICS.map((topic) => [
      topic.words[0],
      extractSourceTokenSurface(sourceOf(topic)).tokens,
    ])
  );
  const index = buildDocumentFrequencyIndex([...surfaces.values()]);
  const signatureStory = stories[9];
  const signatureCriterion = signatureStory.acceptance_criteria[0];
  const signatureTokens = acceptanceCriterionTokenSurface(
    signatureStory,
    signatureCriterion
  );

  const related = scoreLexicalPlausibility(
    signatureTokens,
    surfaces.get("signature")!,
    index
  );
  const unrelated = scoreLexicalPlausibility(
    signatureTokens,
    surfaces.get("timezone")!,
    index
  );
  assert.ok(
    related.score > unrelated.score,
    `related ${related.score} should beat unrelated ${unrelated.score}`
  );
  assert.ok(related.score >= DEFAULT_ABSOLUTE_SCORE_FLOOR);
  assert.ok(unrelated.score < DEFAULT_ABSOLUTE_SCORE_FLOOR);
  assert.ok(unrelated.score > 0, "the unrelated pair still has real overlap");

  // Shared and absent terms are real, not decorative.
  for (const term of related.shared_terms) {
    assert.ok(signatureTokens.includes(term));
    assert.ok(surfaces.get("signature")!.includes(term));
  }
  for (const term of unrelated.absent_terms) {
    assert.ok(signatureTokens.includes(term), `'${term}' is a criterion term`);
    assert.ok(
      !surfaces.get("timezone")!.includes(term),
      `'${term}' is genuinely absent from the linked file`
    );
  }
  assert.deepEqual(unrelated.shared_terms, ["signature"]);
  for (const term of ["certificate", "fingerprint", "revocation"]) {
    assert.ok(
      unrelated.absent_terms.includes(term),
      `expected '${term}' among the absent terms`
    );
  }

  // -------------------------------------------------------------------------
  // Document-frequency damping suppresses ubiquitous tokens
  // -------------------------------------------------------------------------

  assert.equal(index.frequency.get("logger"), TOPICS.length);
  assert.equal(
    inverseDocumentFrequency(index, "logger"),
    0,
    "a token in every linked file carries no weight"
  );
  assert.equal(inverseDocumentFrequency(index, "tieline"), 0);
  assert.ok(inverseDocumentFrequency(index, "signature") > 0);
  assert.ok(
    inverseDocumentFrequency(index, "signature") <
      inverseDocumentFrequency(index, "fingerprint"),
    "a token in half the files weighs less than a token in one file"
  );

  // The unrelated pair literally overlaps on 'tieline', 'reconcile',
  // 'reviewers' and 'logger'; damping keeps them out of the score entirely.
  for (const ubiquitous of ["tieline", "reconcile", "reviewers"]) {
    assert.ok(signatureTokens.includes(ubiquitous));
    assert.ok(surfaces.get("timezone")!.includes(ubiquitous));
    assert.ok(!unrelated.shared_terms.includes(ubiquitous));
  }
  const dampedOnly = scoreLexicalPlausibility(
    ["tieline", "reconcile", "reviewers", "fingerprint"],
    surfaces.get("timezone")!,
    index
  );
  assert.equal(dampedOnly.score, 0);
  assert.deepEqual(dampedOnly.shared_terms, []);

  // -------------------------------------------------------------------------
  // Flagging: only the weakest link, and only below the absolute floor
  // -------------------------------------------------------------------------

  assert.equal(report.scored_links, 11);
  assert.equal(report.distribution?.sample_size, 11);
  assert.equal(report.review_candidates.length, 1);

  const candidate = report.review_candidates[0];
  assert.equal(candidate.acceptance_criterion_stable_id, "AC-SIGNATURE-001");
  assert.equal(candidate.story_stable_id, "US-SIGNATURE-001");
  assert.equal(candidate.path, "src/timezone.ts");
  assert.equal(candidate.repository, REPOSITORY);
  assert.equal(candidate.relation, "implements");
  assert.equal(candidate.rank, 1);
  assert.ok(candidate.score < DEFAULT_ABSOLUTE_SCORE_FLOOR);
  assert.ok(candidate.percentile > 0 && candidate.percentile < 0.2);

  // The same criterion's well-matched link is NOT flagged: a high score simply
  // produces no finding.
  assert.ok(
    !report.review_candidates.some((entry) => entry.path === "src/signature.ts"),
    "the plausible link produced no finding"
  );
  for (const topic of TOPICS) {
    assert.ok(
      !report.review_candidates.some(
        (entry) =>
          entry.acceptance_criterion_stable_id === `AC-${topic.key}-001` &&
          entry.path === pathOf(topic)
      ),
      `${topic.key} matched its own module and must not be flagged`
    );
  }

  // -------------------------------------------------------------------------
  // Rationale names the terms behind the number
  // -------------------------------------------------------------------------

  assert.match(candidate.rationale, /human review only/i);
  assert.match(candidate.rationale, /does not mean the link is wrong/i);
  assert.match(candidate.rationale, /Shares signature/);
  for (const term of candidate.absent_terms) {
    assert.ok(
      candidate.rationale.includes(term),
      `rationale names absent term '${term}'`
    );
    assert.ok(signatureTokens.includes(term));
    assert.ok(!surfaces.get("timezone")!.includes(term));
  }
  for (const term of candidate.shared_terms) {
    assert.ok(candidate.rationale.includes(term));
    assert.ok(signatureTokens.includes(term));
    assert.ok(surfaces.get("timezone")!.includes(term));
  }

  // -------------------------------------------------------------------------
  // Unreadable, missing and non-local targets are skipped, never scored
  // -------------------------------------------------------------------------

  const skipReasons = new Map(
    report.skipped.map((entry) => [entry.path ?? "help", entry.reason])
  );
  assert.equal(skipReasons.get("src/absent.ts"), "file_missing");
  assert.equal(skipReasons.get("src/blank.ts"), "no_extractable_text");
  assert.equal(skipReasons.get("src/oversized.ts"), "file_too_large");
  assert.equal(skipReasons.get("assets/blob.bin"), "binary_content");
  assert.equal(skipReasons.get("help"), "help_target");
  assert.equal(skipReasons.get("src/elsewhere.ts"), "other_repository");
  assert.equal(report.skipped.length, 6);
  for (const skipped of report.skipped) {
    assert.ok(
      !report.review_candidates.some((entry) => entry.path === skipped.path),
      `${skipped.path} was skipped and must produce no finding`
    );
  }
  assert.ok(
    !report.review_candidates.some(
      (entry) => entry.acceptance_criterion_stable_id === "AC-EDGE-001"
    ),
    "a criterion whose every link was skipped produces no finding"
  );

  // -------------------------------------------------------------------------
  // Too few links to place anything in a distribution
  // -------------------------------------------------------------------------

  const small = analyzeLinkPlausibility({
    repositoryRoot: root,
    manifest: manifestOf(stories.slice(0, 3)),
  });
  assert.equal(small.status, "insufficient_distribution");
  assert.equal(small.scored_links, 3);
  assert.equal(small.distribution, null);
  assert.deepEqual(small.review_candidates, []);
  assert.match(small.notes[0], /distribution was insufficient/i);
  assert.match(small.notes[0], /not because the links looked plausible/i);

  // An absent smell signal is reported as absent, never as approval.
  const generous = analyzeLinkPlausibility({
    repositoryRoot: root,
    manifest,
    absoluteScoreFloor: 0.001,
  });
  assert.equal(generous.status, "reviewed");
  assert.deepEqual(generous.review_candidates, []);
  assert.match(generous.notes[0], /not a statement that the links are correct/i);

  // A percentile window too narrow to select anything says so.
  const narrow = analyzeLinkPlausibility({
    repositoryRoot: root,
    manifest,
    reviewPercentile: 0.01,
  });
  assert.deepEqual(narrow.review_candidates, []);
  assert.match(narrow.notes[0], /selects\s+no links at all/i);

  // -------------------------------------------------------------------------
  // Shape is compatible with saveAttributionSuggestion, without touching it
  // -------------------------------------------------------------------------

  const suggestion = toLinkReviewSuggestion({
    candidate,
    acceptanceCriterionId: "3f0d0d9c-1a4b-4a6f-9c3e-000000000001",
  });
  assert.equal(suggestion.state, "suggested");
  assert.equal(suggestion.source_kind, "acceptance_criterion");
  assert.equal(suggestion.target_kind, "acceptance_criterion");
  assert.equal(suggestion.method, LINK_PLAUSIBILITY_METHOD);
  assert.equal(suggestion.score, candidate.score);
  assert.equal(suggestion.rationale.path, "src/timezone.ts");
  assert.equal(suggestion.rationale.advisory, true);
  assert.deepEqual(suggestion.rationale.absent_terms, candidate.absent_terms);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("link plausibility tests passed");
