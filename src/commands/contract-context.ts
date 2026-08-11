import {
  readContractManifest,
  type ContractManifest,
} from "../contract/manifest.js";
import {
  lookupAcceptanceCriterionIntentContext,
  lookupAssetIntentContext,
  type AcceptanceCriterionIntentContextResult,
  type AcceptanceCriterionIntentNeighborhood,
  type AssetIntentContextResult,
  type InspectedIntentClaim,
  type IntentAssetKind,
  type MatchingIntentClaim,
} from "../contract/intent-context.js";
import type { Applicability } from "../contract/schema.js";
import type { CommandIO } from "./shared.js";

export interface ContractContextCommand {
  repositoryRoot: string;
  manifestPath: string;
  json: boolean;
  path?: string;
  kind?: string;
  selector?: string;
  ac?: string;
}

function renderIntentClaim(
  claim: InspectedIntentClaim,
  indent: string,
  matchPrecision?: MatchingIntentClaim["match_precision"]
): string {
  const selector = claim.target.selector ?? "file-level";
  const framework = claim.target.framework_hint
    ? `; framework ${claim.target.framework_hint}`
    : "";
  const lines = [
    `${indent}${claim.relation}: ${claim.target.kind} ${claim.target.repository}:${claim.target.path} (${selector}${framework})`,
  ];
  if (matchPrecision) {
    lines.push(`${indent}  match precision: ${matchPrecision}`);
  }
  lines.push(
    `${indent}  provenance: ${claim.provenance}`,
    `${indent}  link scope: ${claim.link_scope}`,
    `${indent}  freshness: ${claim.assurance.freshness}`,
    `${indent}  freshness reason: ${claim.assurance.freshness_reason ?? "none"}`,
    `${indent}  broken cause: ${claim.assurance.broken_cause ?? "none"}`,
    `${indent}  locator resolution: ${claim.assurance.locator_resolution}`,
    `${indent}  locator reason: ${claim.assurance.locator_reason ?? "none"}`,
    `${indent}  structural matches: ${claim.assurance.locator_matches.length}`,
    `${indent}  semantic support: ${claim.assurance.semantic_support}`
  );
  if (claim.assurance.source_evidence) {
    const evidence = claim.assurance.source_evidence;
    lines.push(
      `${indent}  source evidence: ${evidence.language} ${evidence.canonical_selector} (${evidence.native_kind})`,
      `${indent}  analyzed content hash: ${evidence.analyzed_content_hash}`,
      `${indent}  source range: lines ${evidence.range.start.line + 1}-${evidence.range.end.line + 1}; UTF-8 bytes ${evidence.range.utf8Bytes.start}-${evidence.range.utf8Bytes.end}`,
      `${indent}  snippet${evidence.snippet.truncated ? " (truncated)" : ""}:`,
      ...evidence.snippet.text.split("\n").map((line) => `${indent}    ${line}`)
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderApplicability(value: Applicability | null): string {
  return value === null ? "none" : JSON.stringify(value);
}

function renderIntentNeighborhood(
  neighborhood: AcceptanceCriterionIntentNeighborhood,
  indent = ""
): string {
  const { capability, story, acceptance_criterion: criterion } = neighborhood;
  let text = `${indent}Capability: ${capability.stable_id} — ${capability.name}\n`;
  text += `${indent}  Description: ${capability.description}\n`;
  text += `${indent}  Applicability: ${renderApplicability(capability.applies_to)}\n`;
  text += `${indent}Story: ${story.stable_id} — ${story.title}\n`;
  text += `${indent}  Actor: ${story.actor}\n`;
  text += `${indent}  Goal: ${story.goal}\n`;
  text += `${indent}  Benefit: ${story.benefit}\n`;
  text += `${indent}  Lifecycle: ${story.lifecycle}\n`;
  text += `${indent}  Applicability: ${renderApplicability(story.applies_to)}\n`;
  text += `${indent}Acceptance Criterion: ${criterion.stable_id}\n`;
  text += `${indent}  Criterion: ${criterion.criterion}\n`;
  text += `${indent}  Rationale: ${criterion.rationale ?? "none"}\n`;
  text += `${indent}  Applicability: ${renderApplicability(criterion.applies_to)}\n`;
  text += `${indent}  Scenarios:\n`;
  if (criterion.scenarios.length === 0) {
    text += `${indent}    none\n`;
  } else {
    for (const scenario of criterion.scenarios) {
      const label = scenario.name ? `${scenario.name}: ` : "";
      text += `${indent}    ${label}given ${scenario.given}; when ${scenario.when}; then ${scenario.then}\n`;
    }
  }
  text += `${indent}  Direct claims:\n`;
  if (neighborhood.direct_claims.length === 0) {
    text += `${indent}    none\n`;
  } else {
    for (const claim of neighborhood.direct_claims) {
      text += renderIntentClaim(claim, `${indent}    `);
    }
  }
  text += `${indent}  Story-fallback claims:\n`;
  if (neighborhood.story_fallback_claims.length === 0) {
    text += `${indent}    none\n`;
  } else {
    for (const claim of neighborhood.story_fallback_claims) {
      text += renderIntentClaim(claim, `${indent}    `);
    }
  }
  return text;
}

export function renderIntentContextText(
  result: AssetIntentContextResult | AcceptanceCriterionIntentContextResult
): string {
  let text = `Intent context: ${result.status}\n`;
  text += "Reviewed contract:\n";
  text += `  repository key: ${result.repository.key}\n`;
  text += `  manifest digest: ${result.manifest_digest}\n`;
  text +=
    "Relationship: bounded intent neighborhood through contract coupling; this does not establish runtime dependency or semantic proof.\n";
  text += `Answer: ${result.answer}\n`;
  if ("locator" in result) {
    text += `Asset locator: ${result.locator.kind ?? "code/test"} ${result.locator.path}`;
    if (result.locator.selector) text += ` at ${result.locator.selector}`;
    text += "\nMatching claims:\n";
    if (result.matching_claims.length === 0) {
      text += "  none\n";
    } else {
      for (const claim of result.matching_claims) {
        text += renderIntentClaim(claim, "  ", claim.match_precision);
      }
    }
    text += "Intent neighborhood:\n";
    if (result.intent_neighborhood.length === 0) {
      text += "  none\n";
    } else {
      for (const neighborhood of result.intent_neighborhood) {
        text += renderIntentNeighborhood(neighborhood, "  ");
      }
    }
    return text;
  }
  text += `Requested Acceptance Criterion: ${result.requested_stable_id}\n`;
  text += "Intent neighborhood:\n";
  text += result.intent_neighborhood
    ? renderIntentNeighborhood(result.intent_neighborhood, "  ")
    : "  none\n";
  return text;
}

function readIntentContextManifest(
  parsed: ContractContextCommand
): ContractManifest {
  try {
    return readContractManifest(parsed.manifestPath);
  } catch (error) {
    throw new Error(
      `Cannot inspect intent context because the contract manifest at '${parsed.manifestPath}' is unreadable: ${
        error instanceof Error ? error.message : String(error)
      } Run \`tieline contract compile .\` and commit the manifest.`
    );
  }
}

export async function runContractContext(
  parsed: ContractContextCommand,
  io: CommandIO
): Promise<number> {
  const selectedModes =
    Number(parsed.path !== undefined) + Number(parsed.ac !== undefined);
  if (selectedModes !== 1) {
    throw new Error(
      "`contract context` requires exactly one of --path or --ac. Pass --path <repository-relative-path> for asset mode or --ac <stable-id> for Acceptance Criterion mode."
    );
  }
  if (
    parsed.ac !== undefined &&
    (parsed.kind !== undefined || parsed.selector !== undefined)
  ) {
    throw new Error(
      "`--kind` and `--selector` apply only with `contract context --path`."
    );
  }
  const manifest = readIntentContextManifest(parsed);
  const result =
    parsed.path !== undefined
      ? await lookupAssetIntentContext({
          manifest,
          repositoryRoot: parsed.repositoryRoot,
          locator: {
            path: parsed.path,
            ...(parsed.kind === undefined
              ? {}
              : { kind: parsed.kind as IntentAssetKind }),
            ...(parsed.selector === undefined
              ? {}
              : { selector: parsed.selector }),
          },
        })
      : await lookupAcceptanceCriterionIntentContext({
          manifest,
          repositoryRoot: parsed.repositoryRoot,
          stableId: parsed.ac!,
        });
  io.write(
    parsed.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : renderIntentContextText(result)
  );
  return 0;
}
