/**
 * Two static orientation resources. Everything dynamic goes through tools;
 * an agent that ignores these still has full functionality.
 *
 *   schema://taxonomy     — valid keys/actors/statuses + slug vocab w/ df + modes
 *   docs://how-to-query   — routing, lifecycle, and mutation guide
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getStore } from "./store.js";
import { formatError } from "./tools/shared.js";

const HOW_TO_QUERY = `# How to query the user-story context server

Five primary read verbs cover search and exact fetches; lifecycle reads are explicit.

- **"things *like* this"** -> \`find_related(context, mode?, scope?, limit?)\`
  Primary entry point. Pass free text OR pasted code. Returns ranked areas/stories
  with story text + code paths + a "why". Start here when all you have is prose/code.

- **"things *entangled with* this"** -> \`find_crossover(section_key? | story_key?, limit?)\`
  You already have a key. Returns OTHER sections that share its code paths / entity
  slugs, weighted so rare shared signals outrank hub tags.

- **"things *matching* these attributes"** -> \`query_stories(status?, section_key?, actor?, entity_slug?, code_path?, product_area?, audience?, help_relationship?, help_article_slug?, has_help?, group_by?, limit?)\`
  Exact, complete, deterministic. Whitelisted top-level filters (status, section_key,
  actor, entity_slug, code_path, plus help-doc facets product_area / audience /
  help_relationship / help_article_slug / has_help), optionally grouped into counts.
  Every response echoes \`applied_filters\` so you can confirm what the server filtered on.

- **"which help article explains this?"** -> \`find_help(query, product_area?, audience?, limit?)\`
  Semantic search over the help-center corpus itself (not the stories). Returns ranked
  article POINTERS + previews (title, summary, url, headings) with the stories each one
  documents. Use when you want end-user docs; use the others when you want product stories.

- **"give me that article's full text"** -> \`get_help_article(article_slug? , article_slugs?)\`
  The fetch step after find_help / query_stories / find_related hand you a slug. Returns the
  full markdown body by exact slug. Pull only the slugs you need — bodies cost real tokens.

## Typical flow
1. Start with \`find_related\` using whatever context you hold.
2. Take a returned \`section_key\`/\`story_key\` and call \`find_crossover\` to widen, or
   \`query_stories\` to pull exact matching records (incl. \`query_stories(story_key=[...])\` to fetch one by id).
3. For docs: \`find_help\` to locate articles, then \`get_help_article\` to read the one(s) you pick.

## Writing stories (the WRITE tools)
1. **Search first** — \`find_related(scope='stories')\` / \`query_stories\` — reuse or edit an
   existing story rather than duplicating.
2. \`create_user_story(section_key, title, story_text, status?, actor?)\` — you assign the
   section and the key is minted. Accepted stories are embedded and immediately searchable.
   A production create is a pending proposal by default and is not searchable until approved.
3. \`update_user_story(story_key, expected_revision?, ...)\` — edit content, move sections, or
   promote status. Production-sensitive changes are proposals; stale revisions never overwrite.
4. \`update_story_relationships\` atomically adds/removes/replaces typed entity, code, and help
   links. \`get_story_history\` retrieves accepted revisions plus lifecycle/relationship events.
   Ordinary search always uses only the latest accepted row.

## Feature-request triage
Mapping an incoming customer request to product work:
1. Search for an existing story; a **strong match** is the primary, **adjacent** ones are secondary.
2. **No match** → \`create_user_story(..., status='feature_request')\` — the canonical record of the request.
3. \`create_feature_request(title, primary_story_key, secondary_story_keys?, ...)\` — logs the
   request (every request is logged; dedup is at the story level) and writes its links in one
   call. Read it back with \`get_feature_request\`.

## Concept & status definitions
Nouns:
- **section** — a product area (e.g. \`project-sharing\`); every story lives in exactly one.
- **user story** — a unit of product behavior ("as an <actor>, I want … so that …"), with a
  \`story_key\`, \`title\`, \`story_text\`, \`actor\`, and \`status\`.
- **entity slug** — a canonical product concept a story touches (e.g. \`invitation\`); vocabulary +
  document frequency live in schema://taxonomy.
- **code path** — a real repository file a story is implemented in; shared paths are what
  \`find_crossover\` ranks (rarer shared paths weigh more, via 1/df).
- **document frequency (df)** — the number of distinct current stories carrying an entity slug
  or code path. Ranking uses \`1/df\`, so a rare exact overlap carries more evidence than a hub.
- **help article** — an end-user help-center doc, linked to the stories it documents.
- **feature request** — one incoming customer ask (append-only evidence); many can map to one story.
- **actor** — the persona a story serves (e.g. \`member\`, \`administrator\`).

Statuses (a story's lifecycle — you pick it on create/update):
- **production** — shipped and live in the product.
- **in_review** — built, under review.
- **qa** — in testing / quality assurance.
- **in_progress** — actively being built.
- **idea** — proposed, not yet committed (the default for a newly created story).
- **feature_request** — an incoming customer/stakeholder ask captured during triage.
- **cancelled** — dropped / won't do.

## Good to know
- \`find_related\` returns an empty list when we genuinely lack a matching pattern —
  that's correct, not a failure. Don't retry with looser intent expecting matches.
- Scores: \`find_related.score\` is an absolute 0..1 relevance blend; \`score_breakdown\`
  shows pool-normalized per-signal strength (vector / entity / path).
- Read \`schema://taxonomy\` to learn valid section keys, actors, statuses, the
  entity-slug vocabulary (with document frequency), and the help-doc facets
  (product areas, audiences, relationship types) before constructing filters.
- Every story result carries \`help_articles\` (capped at 5, primary-first) plus a
  \`help_article_count\` — the help-center docs that explain that feature. Filter or
  group by \`product_area\` / \`has_help\` to slice by documentation coverage.
- \`suggest_story_help_links\` is read-only. It ranks possible story/article pairs; accepting a
  suggestion still requires \`update_story_relationships\` and therefore the normal approval rule.
`;

export function registerResources(server: McpServer): void {
  server.registerResource(
    "taxonomy",
    "schema://taxonomy",
    {
      title: "Corpus taxonomy",
      description:
        "Valid section keys, actors, statuses, the entity-slug vocabulary with " +
        "document frequency, the help-doc facets (product areas, audiences, relationship " +
        "types), the mode enum, and corpus totals. Learn our vocabulary so tool calls are " +
        "well-formed. Honestly advertises gaps (e.g. no interaction-pattern slug facet exists yet).",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const taxonomy = await getStore().getTaxonomy();
        const enriched = {
          ...taxonomy,
          gaps: [
            "No interaction-pattern slug facet exists yet (verbs like drag/drop/reorder " +
              "are not tagged); 'do we have this pattern elsewhere' currently rides on the " +
              "vector embedding only.",
          ],
        };
        return {
          contents: [
            { uri: uri.href, mimeType: "application/json", text: JSON.stringify(enriched, null, 2) },
          ],
        };
      } catch (error) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: `Error loading taxonomy: ${formatError(error)}`,
            },
          ],
        };
      }
    }
  );

  server.registerResource(
    "how-to-query",
    "docs://how-to-query",
    {
      title: "How to query",
      description:
        "Short orientation: start with find_related; use returned keys with " +
        "find_crossover / query_stories.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: HOW_TO_QUERY }],
    })
  );
}
