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
import { escapeTerminalText, type CommandIO } from "./shared.js";

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
  const selector = escapeTerminalText(claim.target.selector ?? "file-level");
  const framework = claim.target.framework_hint
    ? `; framework ${escapeTerminalText(claim.target.framework_hint)}`
    : "";
  const lines = [
    `${indent}${escapeTerminalText(claim.relation)}: ${escapeTerminalText(claim.target.kind)} ${escapeTerminalText(claim.target.repository)}:${escapeTerminalText(claim.target.path)} (${selector}${framework})`,
  ];
  if (matchPrecision) {
    lines.push(`${indent}  match precision: ${escapeTerminalText(matchPrecision)}`);
  }
  lines.push(
    `${indent}  provenance: ${escapeTerminalText(claim.provenance)}`,
    `${indent}  link scope: ${escapeTerminalText(claim.link_scope)}`,
    `${indent}  freshness: ${escapeTerminalText(claim.assurance.freshness)}`,
    `${indent}  freshness reason: ${escapeTerminalText(claim.assurance.freshness_reason ?? "none")}`,
    `${indent}  broken cause: ${escapeTerminalText(claim.assurance.broken_cause ?? "none")}`,
    `${indent}  locator resolution: ${escapeTerminalText(claim.assurance.locator_resolution)}`,
    `${indent}  locator reason: ${escapeTerminalText(claim.assurance.locator_reason ?? "none")}`,
    `${indent}  structural matches: ${claim.assurance.locator_matches.length}`,
    `${indent}  semantic support: ${escapeTerminalText(claim.assurance.semantic_support)}`
  );
  if (claim.assurance.source_evidence) {
    const evidence = claim.assurance.source_evidence;
    lines.push(
      `${indent}  source evidence: ${escapeTerminalText(evidence.language)} ${escapeTerminalText(evidence.canonical_selector)} (${escapeTerminalText(evidence.native_kind)})`,
      `${indent}  analyzed content hash: ${escapeTerminalText(evidence.analyzed_content_hash)}`,
      `${indent}  source range: lines ${evidence.range.start.line + 1}-${evidence.range.end.line + 1}; UTF-8 bytes ${evidence.range.utf8Bytes.start}-${evidence.range.utf8Bytes.end}`,
      `${indent}  snippet${evidence.snippet.truncated ? " (truncated)" : ""}:`,
      ...evidence.snippet.text
        .split("\n")
        .map((line) => `${indent}    ${escapeTerminalText(line)}`)
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderApplicability(value: Applicability | null): string {
  return value === null ? "none" : escapeTerminalText(JSON.stringify(value));
}

function renderIntentNeighborhood(
  neighborhood: AcceptanceCriterionIntentNeighborhood,
  indent = ""
): string {
  const { capability, story, acceptance_criterion: criterion } = neighborhood;
  let text = `${indent}Capability: ${escapeTerminalText(capability.stable_id)} — ${escapeTerminalText(capability.name)}\n`;
  text += `${indent}  Description: ${escapeTerminalText(capability.description)}\n`;
  text += `${indent}  Applicability: ${renderApplicability(capability.applies_to)}\n`;
  text += `${indent}Story: ${escapeTerminalText(story.stable_id)} — ${escapeTerminalText(story.title)}\n`;
  text += `${indent}  Actor: ${escapeTerminalText(story.actor)}\n`;
  text += `${indent}  Goal: ${escapeTerminalText(story.goal)}\n`;
  text += `${indent}  Benefit: ${escapeTerminalText(story.benefit)}\n`;
  text += `${indent}  Lifecycle: ${escapeTerminalText(story.lifecycle)}\n`;
  text += `${indent}  Applicability: ${renderApplicability(story.applies_to)}\n`;
  text += `${indent}Acceptance Criterion: ${escapeTerminalText(criterion.stable_id)}\n`;
  text += `${indent}  Criterion: ${escapeTerminalText(criterion.criterion)}\n`;
  text += `${indent}  Rationale: ${escapeTerminalText(criterion.rationale ?? "none")}\n`;
  text += `${indent}  Applicability: ${renderApplicability(criterion.applies_to)}\n`;
  text += `${indent}  Scenarios:\n`;
  if (criterion.scenarios.length === 0) {
    text += `${indent}    none\n`;
  } else {
    for (const scenario of criterion.scenarios) {
      const label = scenario.name
        ? `${escapeTerminalText(scenario.name)}: `
        : "";
      text += `${indent}    ${label}given ${escapeTerminalText(scenario.given)}; when ${escapeTerminalText(scenario.when)}; then ${escapeTerminalText(scenario.then)}\n`;
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
  let text = `Intent context: ${escapeTerminalText(result.status)}\n`;
  text += "Reviewed contract:\n";
  text += `  repository key: ${escapeTerminalText(result.repository.key)}\n`;
  text += `  manifest digest: ${escapeTerminalText(result.manifest_digest)}\n`;
  text +=
    "Relationship: bounded intent neighborhood through contract coupling; this does not establish runtime dependency or semantic proof.\n";
  text += `Answer: ${escapeTerminalText(result.answer)}\n`;
  if ("locator" in result) {
    text += `Asset locator: ${escapeTerminalText(result.locator.kind ?? "code/test")} ${escapeTerminalText(result.locator.path)}`;
    if (result.locator.selector) {
      text += ` at ${escapeTerminalText(result.locator.selector)}`;
    }
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
  text += `Requested Acceptance Criterion: ${escapeTerminalText(result.requested_stable_id)}\n`;
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
