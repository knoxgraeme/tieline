import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
  Its typed context accepts an Observation, Backlog Item, Story, or AC anchor
  and code, test, or help artifacts.
- \`find_related\` is the shorter engineering-oriented semantic entry point and
  still returns the applied profile version.
- \`query_stories\` is an exact Story/AC lookup with authority and lifecycle filters.
- \`get_path_criteria\` returns the acceptance criteria the accepted contract
  records for exact repository paths, directly from the compiled manifest and
  without a database. Use \`search_knowledge\` instead when asking what is related.
- \`get_backlog_item\` returns a Backlog Item's optimistic revision and complete
  Observation/Story/AC link set before an update replaces state.
- \`list_handoff_conflicts\` returns the merged repository definition alongside
  later planning content for explicit reconciliation.
- \`find_help\` and \`get_help_article\` search/fetch external help content by its
  stable source + external_id pointer.

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
3. Use \`decide_attribution\` or the suggestion decision tools to confirm/dismiss.
4. Create a Backlog Item only when work consolidation is useful.
5. Read a Backlog Item before updating it or replacing its links; preserve links
   that were not explicitly removed.
6. Create or update planning Stories/ACs through the planning tools. The tools
   search before creation and require an explicit reuse-or-continue decision.

Invoke the MCP \`tieline_author\` prompt (or use the bundled
\`$tieline-author\` skill) to onboard repository behavior, materialize planning
definitions, reconcile branch changes, validate/compile YAML, and review the
semantic diff. Normal pull-request merge is the semantic approval event.
During deterministic setup, interactive \`tieline init\` can install the skill
for explicitly selected coding agents. While the spec has no Stories,
\`tieline status --json\` exposes concise structured onboarding state and
\`tieline init .\` as the skill-install entry point.

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
