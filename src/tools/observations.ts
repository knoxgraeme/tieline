import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { prepareObservation } from "../domain/evidence-write-store.js";
import type {
  EvidenceWriteStore,
  PreparedObservation,
} from "../domain/evidence-write-store.js";
import {
  decideAttributionOutputShape,
  decideAttributionShape,
  recordObservationOutputShape,
  recordObservationShape,
  type DecideAttributionInput,
  type RecordObservationInput,
} from "./schemas/observations.js";
import { getEvidenceWriteStore } from "../store.js";
import {
  getSemanticMatcher,
  type MatchCandidate,
  type SemanticMatcher,
} from "../semantic-matching.js";
import {
  errorResult,
  formatError,
  jsonResult,
  type ToolResult,
} from "./shared.js";

export type ObservationMatchResult =
  | {
      observation: Awaited<
        ReturnType<EvidenceWriteStore["recordObservation"]>
      >;
      suggestions: MatchCandidate[];
    }
  | {
      observation: Awaited<
        ReturnType<EvidenceWriteStore["recordObservation"]>
      >;
      suggestions: [];
      matching_error: string;
      note: string;
    };

export async function recordObservationThenMatch(
  prepared: PreparedObservation,
  store: EvidenceWriteStore = getEvidenceWriteStore(),
  matcher: SemanticMatcher = getSemanticMatcher()
): Promise<ObservationMatchResult> {
  const observation = await store.recordObservation(prepared);
  try {
    return {
      observation,
      suggestions: await matcher.matchObservation(observation),
    };
  } catch (matchingError) {
    return {
      observation,
      suggestions: [],
      matching_error: formatError(matchingError),
      note:
        "The observation was committed before matching and remains available for retry.",
    };
  }
}

export function registerObservationTools(server: McpServer): void {
  server.registerTool(
    "record_observation",
    {
      title: "Record an observation",
      description:
        "Append a request, bug, or question before attempting semantic matching. " +
        "Intake is idempotent by source + external_id when supplied. Payloads use " +
        "strict versioned schemas; only allowlisted fields enter search_text.",
      inputSchema: recordObservationShape,
      outputSchema: recordObservationOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input: RecordObservationInput): Promise<ToolResult> => {
      try {
        const prepared = prepareObservation({
          ...input,
          observed_at: input.observed_at ?? new Date().toISOString(),
          payload: input.payload,
        });
        return jsonResult(await recordObservationThenMatch(prepared));
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );

  server.registerTool(
    "set_observation_attribution",
    {
      title: "Confirm or dismiss an observation attribution",
      description:
        "Record an explicit human/automation decision for an observation → Story, " +
        "AC, or Backlog Item relationship. Similarity alone remains suggested until " +
        "this operation confirms it.",
      inputSchema: decideAttributionShape,
      outputSchema: decideAttributionOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input: DecideAttributionInput): Promise<ToolResult> => {
      try {
        if (
          input.target_kind !== "backlog_item" &&
          !input.repository
        ) {
          return errorResult(
            "repository is required for Story and acceptance-criterion targets."
          );
        }
        const target =
          input.target_kind === "backlog_item"
            ? { stable_id: input.target_stable_id }
            : {
                repository: input.repository!,
                stable_id: input.target_stable_id,
              };
        const attribution =
          await getEvidenceWriteStore().decideAttribution({
            observation_id: input.observation_id,
            target_kind: input.target_kind,
            target,
            relation: input.relation,
            decision: input.decision,
            decided_by: input.decided_by,
          });
        return jsonResult({ attribution });
      } catch (error) {
        return errorResult(formatError(error));
      }
    }
  );
}
