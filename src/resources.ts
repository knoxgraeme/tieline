import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SUPPORTED_SKILL_AGENTS } from "./tieline/skill-install.js";
import { ONBOARDING_SKILL_INSTALL_COMMAND } from "./tieline/status.js";

const HOW_TO_QUERY = `# Tieline contract guide

Tieline distinguishes accepted behavior, planning work, and source evidence.

- A **Story** describes desired user value using structured actor, goal, and benefit.
- An **acceptance criterion (AC)** states one observable outcome and is the primary
  anchor for code, test, help, and observation relationships.
- An optional **Scenario** illustrates an AC with Given / When / Then.
- An **Observation** is append-only source evidence: a request, bug, or question.
- A **Backlog Item** is optional work that may target Stories or ACs. It is not a
  second representation or lifecycle container for a Story.

## Authority and lifecycle

Postgres owns Stories and ACs only while their lifecycle is \`backlog\`. Once the
same stable IDs are materialized into strict YAML under \`.tieline/spec/\` and the
pull request merges, the repository owns them as \`in_progress\`, \`production\`,
or \`retired\`. Repository-owned definitions change only through another code
change and pull request.

## Reads

- \`search_knowledge\` performs cross-type hybrid search and requires a retrieval
  profile: \`support\`, \`engineering\`, \`discovery\`, or \`all\`. Full-text
  and identifier recall are always available; vector similarity is optional.
  It is the canonical discovery tool for Stories, ACs, Scenarios, Backlog Items,
  sanitized Observations, and ingested help articles. Its typed context accepts
  an Observation, Backlog Item, Story, AC, or help article anchor
  and code, test, or help artifacts.
- \`query_stories\` is an exact Story/AC lookup with authority and lifecycle filters.
- \`get_asset_intent_context\` reads the exact manifest-backed intent neighborhood
  and contract coupling for a known path, optional code/test kind, and optional
  selector. Use it before semantic search when that locator is known.
- \`get_acceptance_criterion_context\` reads the exact manifest-backed intent
  neighborhood and contract coupling for a known AC stable ID. Use it before
  semantic search when that ID is known.
- \`get_path_criteria\` returns the acceptance criteria the accepted contract
  records for exact repository paths, directly from the compiled manifest and
  without a database. It remains available for compatibility; use
  \`get_asset_intent_context\` when selector-aware neighborhood context is needed,
  or \`search_knowledge\` when no exact locator or AC ID is known.
- \`trace_code_dependencies\` traverses bounded, statically derived project-local
  dependencies or dependents from one exact code locator. It reports the selected
  artifact provenance, generation, ordered paths, unresolved frontiers, and
  truncation state. Repository reads never parse, compile, repair, or write.
- \`analyze_code_blast_radius\` compares a Git base or explicit changed locators,
  computes derived reachability first, and then joins visited code to authored
  direct or Story-fallback AC claims from the matching base/current manifest
  roles. Its \`may_be_impacted\` result is advisory,
  keeps \`semantic_support: not_assessed\`, and never treats a shared AC as a code edge.
- \`get_backlog_item\` returns a Backlog Item's optimistic revision and complete
  Observation/Story/AC link set before an update replaces state.
- \`list_handoff_conflicts\` returns the merged repository definition alongside
  later planning content for explicit reconciliation.
- \`get_help_articles\` hydrates up to ten help results by their exact stable
  source + external_id pointers. \`find_related\` and \`find_help\` are deprecated
  compatibility tools; new clients should discover through \`search_knowledge\`.

Explicit filters only narrow a profile; they cannot re-include records the profile
excluded. Context reranks that same authorized candidate set using artifact
overlap and graph proximity across structural links, repository-declared
relationships, and confirmed attributions. Traversal is bounded to three hops;
suggested and dismissed relationships do not create proximity. Search results
return lifecycle/authority or planning state explicitly and include a reusable
typed context anchor when one is available. Results also disclose which signals
were applied, their ranking features, and concise match reasons.

## Intake and planning writes

1. \`record_observation\` commits a request, bug, or question before matching.
2. Review the returned suggestions; semantic similarity never confirms a link.
3. Use \`set_observation_attribution\` or \`review_semantic_suggestion\` to
   confirm or dismiss the appropriate relationship.
4. Create a Backlog Item only when work consolidation is useful.
5. Read a Backlog Item before updating it or replacing its links; preserve links
   that were not explicitly removed.
6. Create or update planning Stories/ACs through the planning tools. The tools
   search before creation and require an explicit reuse-or-continue decision.

Invoke the MCP \`tieline\` prompt (or use the bundled
\`$tieline\` skill) to onboard repository behavior, materialize planning
definitions, reconcile branch changes, validate/compile YAML, and review the
semantic diff. Normal pull-request merge is the semantic approval event.
During deterministic setup, interactive \`tieline init\` asks which coding
agents should receive this onboarding and authoring skill. While the spec has
no Stories,
\`tieline status --json\` exposes concise structured onboarding state and
\`${ONBOARDING_SKILL_INSTALL_COMMAND}\` as the skill-install entry point.
That command is interactive. An agent running init without a terminal must
append \`--yes --agent <id>\` (supported IDs: ${SUPPORTED_SKILL_AGENTS.map(
  (agent) => `\`${agent.id}\``
).join(", ")}),
or append \`--skip-skill-install\` when it is only reconfiguring the runtime.

Coverage describes whether every AC has direct implementation, test, or help
links. Freshness separately describes whether linked repository content still
matches its reviewed hash. A linked test is not a test execution receipt; execution
receipts are intentionally deferred beyond the MVP.
`;

export function registerResources(server: McpServer): void {
  server.registerResource(
    "Tieline contract guide",
    "docs://tieline-contract",
    {
      title: "Tieline contract guide",
      description:
        "Vocabulary, authority, retrieval profiles, and evidence/planning workflow.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: HOW_TO_QUERY,
        },
      ],
    })
  );
}
