/**
 * Zod input schemas for the three tools. Exported as raw shapes (the form
 * `McpServer.registerTool` expects) plus inferred TS types for internal use.
 */

import { z } from "zod";
import { STORY_STATUSES } from "./types.js";
export { STORY_STATUSES };

export const HELP_RELATIONSHIPS = [
  "primary",
  "supporting",
  "reference",
  "troubleshooting",
] as const;

// --- find_related -----------------------------------------------------------

export const findRelatedShape = {
  context: z
    .string()
    .min(3, "context must be at least 3 characters")
    .max(8000, "context must not exceed 8000 characters")
    .describe(
      "Free-form text OR pasted code/diff describing what you're working on " +
        "(a task, a feature concept, a competitor blurb, a code snippet). Required."
    ),
  mode: z
    .enum(["semantic", "structural", "blended"])
    .default("blended")
    .describe(
      "Ranking mode. 'semantic' = vector similarity only; 'structural' = lean on " +
        "code-path overlap (use for code input); 'blended' = fuse both (default, " +
        "best for a naive call). If omitted and the context looks like code, the " +
        "server auto-forks toward structural."
    ),
  scope: z
    .enum(["areas", "stories"])
    .default("areas")
    .describe(
      "Granularity of results. 'areas' = ranked product sections each with their " +
        "matched stories (default); 'stories' = a flat ranked list of stories."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Max number of areas (or stories) to return. Default 5."),
};

export const findRelatedSchema = z.object(findRelatedShape);
export type FindRelatedInput = z.infer<typeof findRelatedSchema>;

// --- find_help --------------------------------------------------------------

export const findHelpShape = {
  query: z
    .string()
    .min(3, "query must be at least 3 characters")
    .max(2000, "query must not exceed 2000 characters")
    .describe(
      "Free-form description of what the user wants to do or understand, e.g. " +
        "'how do I invite a teammate to a project'. Matched semantically " +
        "against help-center article title + summary + headings."
    ),
  product_area: z
    .array(z.string())
    .optional()
    .describe("Restrict to product-area values from the imported knowledge base."),
  audience: z
    .array(z.string())
    .optional()
    .describe("Restrict to audience values from the imported knowledge base."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Max number of articles to return. Default 5."),
};

export const findHelpSchema = z.object(findHelpShape);
export type FindHelpInput = z.infer<typeof findHelpSchema>;

// --- get_help_article -------------------------------------------------------

export const getHelpArticleShape = {
  article_slug: z
    .string()
    .optional()
    .describe("A single help article slug to fetch, e.g. 'adding-a-cookie-banner-360034018992'."),
  article_slugs: z
    .array(z.string())
    .min(1)
    .max(10)
    .optional()
    .describe("Several slugs to fetch at once (1-10). Combined with article_slug if both are given."),
};

export const getHelpArticleSchema = z
  .object(getHelpArticleShape)
  .refine((v) => Boolean(v.article_slug) || Boolean(v.article_slugs?.length), {
    message: "Provide article_slug and/or article_slugs.",
  });
export type GetHelpArticleInput = z.infer<typeof getHelpArticleSchema>;

// --- find_crossover ---------------------------------------------------------

export const findCrossoverShape = {
  section_key: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A section key whose footprint to find entanglement for, e.g. 'project-sharing'. " +
        "Provide this OR story_key."
    ),
  story_key: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A single story key whose footprint to find entanglement for, e.g. 'SHARING-003'. " +
        "Provide this OR section_key."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Max number of entangled sections to return. Default 5."),
};

export const findCrossoverSchema = z
  .object(findCrossoverShape)
  .refine((v) => Boolean(v.section_key) !== Boolean(v.story_key), {
    message: "Provide exactly one of section_key or story_key.",
  });
export type FindCrossoverInput = z.infer<typeof findCrossoverSchema>;

// --- query_stories ----------------------------------------------------------

// Filter fields live at the TOP LEVEL of the tool input (flat) so there is no
// nested object to mis-target — `query_stories(entity_slug=...)` just works. A
// nested `filters` object is still accepted for back-compat (see below).
//
// IMPORTANT: this is a *factory*, not a shared object. The top-level fields and
// the nested `filters` fields must be DISTINCT zod instances — reusing the same
// instances makes zod-to-json-schema emit `$ref` pointers, which Anthropic's
// tool-schema validation rejects, breaking the server at connect time.
const makeFilterFields = () => ({
  status: z
    .array(z.enum(STORY_STATUSES))
    .optional()
    .describe("Match any of these lifecycle statuses."),
  section_key: z.array(z.string()).optional().describe("Match any of these section keys."),
  story_key: z
    .array(z.string())
    .optional()
    .describe("Fetch exact story keys, e.g. ['SHARING-003']. This is how you fetch a story by id."),
  actor: z.array(z.string()).optional().describe("Match any of these actors."),
  entity_slug: z
    .string()
    .optional()
    .describe("Only stories tagged with this exact entity slug, e.g. 'invitation'."),
  code_path: z
    .string()
    .optional()
    .describe("Only stories touching this exact code path, e.g. 'src/projects/InviteMember.ts'."),
  product_area: z
    .array(z.string())
    .optional()
    .describe(
        "Only stories with a linked help article in any of these product areas."
    ),
  audience: z
    .array(z.string())
    .optional()
    .describe("Only stories whose linked help articles target any of these audiences."),
  help_relationship: z
    .array(z.enum(HELP_RELATIONSHIPS))
    .optional()
    .describe("Only stories with a help link of any of these types: primary, supporting, reference, troubleshooting."),
  help_article_slug: z
    .string()
    .optional()
    .describe("Reverse lookup: only stories linked to this exact help article slug."),
  has_help: z
    .boolean()
    .optional()
    .describe("true = only stories with at least one help article; false = only stories with none."),
  keyword: z
    .string()
    .optional()
    .describe(
      "Full-text keyword filter: only stories whose title/actor/text match this query " +
        "(Postgres full-text search). Works with no embedding provider configured."
    ),
});

// Internal raw shape. Kept separate so the exported `queryStoriesShape` can be a
// *strict* ZodObject (see below) rather than a raw shape.
const queryStoriesFields = {
  ...makeFilterFields(),
  // Back-compat: the same filters may be passed nested. Top-level wins on
  // conflict. `.strict()` so a typo'd key here fails loudly instead of being
  // silently dropped to an unfiltered result. Fresh instances (see above) keep
  // the generated JSON schema free of `$ref`.
  filters: z
    .object(makeFilterFields())
    .strict()
    .optional()
    .describe(
      "Deprecated — pass filters at the top level instead (e.g. entity_slug='invitation'). " +
        "Still accepted nested for back-compat; top-level values take precedence."
    ),
  group_by: z
    .enum(["section", "status", "actor", "product_area"])
    .nullish()
    .describe(
      "If set, return grouped counts instead of full records. 'product_area' counts " +
        "distinct stories per help-article product area (a story spanning two areas counts in each)."
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(25)
    .describe("Max records to return when not grouping. Default 25, server cap 200."),
};

// The TOP-LEVEL query_stories input is `.strict()`: a misspelled top-level filter
// key (e.g. `satus`) must be a validation error, not silently stripped — a silent
// strip would drop the intended filter and return the WHOLE corpus as if it had
// been filtered. Exported as a full ZodObject (not a raw shape): registerTool's
// `inputSchema` accepts either a raw shape or a Zod schema, and only a schema can
// carry the strict flag through to the SDK's parse step (a raw shape is wrapped
// with the default `.strip()`). See src/tools/query_stories.ts `inputSchema`.
// makeFilterFields() hands out fresh zod instances, so the generated JSON schema
// stays `$ref`-free. The nested back-compat `filters` key stays valid because it
// is a declared field of this object (strict only rejects UNKNOWN keys).
export const queryStoriesShape = z.object(queryStoriesFields).strict();

export const queryStoriesSchema = queryStoriesShape;
export type QueryStoriesInput = z.infer<typeof queryStoriesSchema>;

// --- output schemas ---------------------------------------------------------
// Declared so clients can validate `structuredContent` and so the contract is
// machine-readable, not just prose. The SDK validates (safeParse) but does NOT
// strip extra keys, so we declare the documented contract and let internal
// extras pass through. Conditional fields are `.optional()`.
//
// IMPORTANT (same rule as the input schemas): every nested object must be a
// FRESH zod instance. Reusing one instance twice within a single schema makes
// zod-to-json-schema emit `$ref` pointers, which Anthropic's tool-schema
// validation rejects. The factories below return new instances on each call.

const helpArticleLinkObject = () =>
  z.object({
    article_slug: z.string(),
    title: z.string(),
    url: z.string().nullable(),
    relationship_type: z.string(),
    confidence: z.number(),
  });

const whyObject = () =>
  z.object({
    shared_entities: z.array(z.string()),
    shared_code_paths: z.array(z.string()),
  });

const scoreBreakdownObject = () =>
  z.object({ vector: z.number(), entity: z.number(), path: z.number(), lexical: z.number() });

// find_related: results are a superset of AreaHit | StoryHit (scope-dependent),
// so scope-specific fields are optional; the shared core is required.
export const findRelatedOutputShape = {
  query: z.object({
    mode_requested: z.string(),
    mode_used: z.string(),
    scope: z.string(),
    detected_code: z.boolean(),
    candidate_pool_size: z.number(),
    min_vector_score: z.number(),
    min_structural_score: z.number(),
    min_lexical_score: z.number(),
    semantic_candidates: z.number(),
    structural_candidates: z.number(),
    lexical_candidates: z.number(),
    candidate_union_size: z.number(),
    embedding_used: z.boolean(),
    query_entities: z.array(z.string()),
    query_code_paths: z.array(z.string()),
  }),
  results: z.array(
    z.object({
      section_key: z.string(),
      section_name: z.string(),
      score: z.number(),
      score_breakdown: scoreBreakdownObject(),
      code_paths: z.array(z.string()),
      why: whyObject(),
      // areas scope only
      matched_stories: z
        .array(
          z.object({
            story_key: z.string(),
            title: z.string(),
            story_text: z.string(),
            actor: z.string().nullable(),
            status: z.string(),
            score: z.number(),
            help_articles: z.array(helpArticleLinkObject()),
            help_article_count: z.number(),
          })
        )
        .optional(),
      // stories scope only
      story_key: z.string().optional(),
      title: z.string().optional(),
      story_text: z.string().optional(),
      actor: z.string().nullable().optional(),
      status: z.string().optional(),
      help_articles: z.array(helpArticleLinkObject()).optional(),
      help_article_count: z.number().optional(),
    })
  ),
  note: z.string().optional(),
};

export const findCrossoverOutputShape = {
  target: z.object({
    section_key: z.string().optional(),
    story_key: z.string().optional(),
    entity_slugs: z.array(z.string()),
    code_paths: z.array(z.string()),
  }),
  results: z.array(
    z.object({
      section_key: z.string(),
      section_name: z.string(),
      score: z.number(),
      shared_code_paths: z.array(z.object({ path: z.string(), weight: z.number() })),
      shared_entities: z.array(z.object({ slug: z.string(), weight: z.number() })),
    })
  ),
  note: z.string().optional(),
};

export const findHelpOutputShape = {
  query: z.object({
    min_score: z.number(),
    min_lexical_score: z.number(),
    candidate_pool_size: z.number(),
    product_area: z.array(z.string()).optional(),
    audience: z.array(z.string()).optional(),
  }),
  results: z.array(
    z.object({
      article_slug: z.string(),
      title: z.string(),
      summary: z.string().nullable(),
      url: z.string().nullable(),
      product_area: z.string().nullable(),
      audience: z.string().nullable(),
      tags: z.array(z.string()),
      headings: z.array(z.string()),
      score: z.number(),
      linked_story_keys: z.array(z.string()),
      linked_story_count: z.number(),
    })
  ),
  note: z.string().optional(),
};

export const getHelpArticleOutputShape = {
  articles: z.array(
    z.object({
      article_slug: z.string(),
      title: z.string(),
      url: z.string().nullable(),
      product_area: z.string().nullable(),
      audience: z.string().nullable(),
      tags: z.array(z.string()),
      headings: z.array(z.string()),
      markdown: z.string().nullable(),
    })
  ),
  not_found: z.array(z.string()),
  note: z.string().optional(),
};

// query_stories returns one of two shapes (records | grouped). A single
// permissive object covers both: mode + applied_filters always present, the
// rest optional per branch.
export const queryStoriesOutputShape = {
  mode: z.enum(["records", "grouped"]),
  group_by: z.string().nullable(),
  applied_filters: z.record(z.any()),
  // records mode
  total: z.number().optional(),
  count: z.number().optional(),
  truncated: z.boolean().optional(),
  records: z
    .array(
      z.object({
        story_key: z.string(),
        section_key: z.string(),
        section_name: z.string(),
        title: z.string(),
        actor: z.string().nullable(),
        story_text: z.string(),
        status: z.string(),
        entity_slugs: z.array(z.string()),
        code_paths: z.array(z.string()),
        help_articles: z.array(helpArticleLinkObject()),
        help_article_count: z.number(),
        feature_requests: z
          .array(z.object({ id: z.number(), title: z.string(), link_type: z.string() }))
          .optional(),
      })
    )
    .optional(),
  // grouped mode
  groups: z.array(z.object({ group: z.string(), count: z.number() })).optional(),
  // zero-result recovery (records mode)
  no_match: z.boolean().optional(),
  suggestions: z
    .object({
      note: z.string(),
      code_path: z.array(z.string()).optional(),
      entity_slug: z.array(z.string()).optional(),
    })
    .optional(),
  note: z.string().optional(),
};

// --- write tools (create/update stories, feature requests) ------------------
// Status is intentionally NOT an input — the server forces feature_request (the
// only writable status). A fresh writtenStory object per output shape avoids $ref.

const writtenStoryObject = () =>
  z.object({
    id: z.number(),
    story_key: z.string(),
    section_key: z.string(),
    title: z.string(),
    actor: z.string().nullable(),
    story_text: z.string(),
    status: z.string(),
  });

const storyProposalObject = () =>
  z.object({
    id: z.number(),
    operation: z.enum(["create", "update", "relationships"]),
    status: z.enum(["pending", "approved", "rejected", "stale"]),
    story_key: z.string().nullable(),
    base_revision_number: z.number().int().nullable(),
    reason: z.string().nullable(),
    source: z.string(),
    created_at: z.string(),
  });

export const createUserStoryShape = {
  section_key: z
    .string()
    .min(1)
    .describe("The section this story belongs to (must be a valid section_key — the agent assigns it)."),
  title: z.string().min(3).describe("Short story title."),
  story_text: z
    .string()
    .min(3)
    .describe("The story narrative — e.g. 'As a <actor>, I want ... so that ...'."),
  actor: z.string().optional().describe("Optional actor/persona."),
  status: z
    .enum(STORY_STATUSES)
    .optional()
    .describe(
      "Lifecycle status (default 'idea'). Choose deliberately — see docs://how-to-query for definitions. " +
        "'production' = shipped/live; 'in_progress'/'in_review'/'qa' = being built or checked; " +
        "'idea' = proposed, not committed; 'feature_request' = an incoming customer ask captured during triage; " +
        "'cancelled' = dropped."
    ),
  reason: z.string().optional().describe("Why the story is being created."),
  source: z.string().optional().describe("Audit source label (default 'mcp')."),
  proposed_by: z.string().optional().describe("Audit display label; not an authenticated identity."),
};
export const createUserStorySchema = z.object(createUserStoryShape);
export type CreateUserStoryInput = z.infer<typeof createUserStorySchema>;

export const createUserStoryOutputShape = {
  outcome: z.enum(["applied", "proposed", "stale", "not_found", "no_fields"]),
  story: writtenStoryObject().optional(),
  proposal: storyProposalObject().optional(),
  revision_number: z.number().int().optional(),
  note: z.string(),
};

export const updateUserStoryShape = {
  story_key: z.string().min(1).describe("The story to edit."),
  // Optional on update, but a *provided* value must be non-empty — mirror create's
  // `.min(3)` so an update can't blank a real story's title/text and re-embed a
  // degenerate vector. Omission is still allowed.
  title: z.string().min(3).optional().describe("New title."),
  story_text: z.string().min(3).optional().describe("New narrative (re-triggers embedding)."),
  actor: z.string().nullable().optional().describe("New actor; pass null to clear it."),
  section_key: z.string().optional().describe("Move the story to a different section."),
  status: z
    .enum(STORY_STATUSES)
    .optional()
    .describe("New lifecycle status (e.g. promote 'idea' -> 'in_progress' -> 'production'). See docs://how-to-query."),
  expected_revision: z.number().int().positive().optional().describe(
    "Optimistic concurrency guard. A mismatch returns outcome='stale' without writing."
  ),
  reason: z.string().optional().describe("Why this change is requested."),
  source: z.string().optional().describe("Audit source label (default 'mcp')."),
  proposed_by: z.string().optional().describe("Audit display label; not an authenticated identity."),
};
export const updateUserStorySchema = z.object(updateUserStoryShape);
export type UpdateUserStoryInput = z.infer<typeof updateUserStorySchema>;

export const updateUserStoryOutputShape = {
  outcome: z.enum(["applied", "proposed", "stale", "not_found", "no_fields"]),
  story: writtenStoryObject().optional(),
  proposal: storyProposalObject().optional(),
  revision_number: z.number().int().optional(),
  current_revision_number: z.number().int().optional(),
  updated: z.boolean(),
  note: z.string().optional(),
};

export const createFeatureRequestShape = {
  title: z.string().min(3).describe("Short title for the feature request."),
  primary_story_key: z
    .string()
    .min(1)
    .describe("The canonical user story this request maps to (its primaryUserStory). Search first; create one with create_user_story if none fits."),
  secondary_story_keys: z
    .array(z.string())
    .optional()
    .describe("Adjacent/overlapping/dependency stories (secondaryUserStories)."),
  source: z.string().optional().describe("Origin system, e.g. 'intercom'."),
  source_thread_id: z.string().optional(),
  source_thread_url: z.string().optional(),
  summary: z.string().optional(),
  requested_change: z.string().optional(),
  context: z.string().optional(),
  priority_signal: z.string().optional(),
  confidence: z.number().optional(),
  product_area: z.string().optional(),
  notion_page_id: z.string().optional().describe("Pointer to the human mirror page, if one exists."),
  raw_thread_jsonb: z.any().optional().describe("The raw source thread payload."),
  link_source: z.string().optional().describe("How the links were decided, e.g. 'agent-triage'."),
};
export const createFeatureRequestSchema = z.object(createFeatureRequestShape);
export type CreateFeatureRequestInput = z.infer<typeof createFeatureRequestSchema>;

export const createFeatureRequestOutputShape = {
  feature_request_id: z.number(),
  link_revision: z.number().int(),
  links: z.array(z.object({ story_key: z.string(), link_type: z.string() })),
};

export const linkFeatureRequestShape = {
  feature_request_id: z.number().int().describe("The feature request to link."),
  story_key: z.string().min(1).describe("The story to link it to."),
  link_type: z.enum(["primary", "secondary"]).describe("primary (canonical) or secondary (related)."),
  link_source: z.string().optional(),
};
export const linkFeatureRequestSchema = z.object(linkFeatureRequestShape);
export type LinkFeatureRequestInput = z.infer<typeof linkFeatureRequestSchema>;

export const linkFeatureRequestOutputShape = {
  feature_request_id: z.number(),
  story_key: z.string(),
  link_type: z.string(),
  link_revision: z.number().int(),
};

export const setFeatureRequestLinksShape = {
  feature_request_id: z.number().int().positive(),
  primary_story_key: z.string().min(1),
  secondary_story_keys: z.array(z.string().min(1)).optional(),
  link_source: z.string().optional(),
  expected_version: z.number().int().positive().optional(),
};
export const setFeatureRequestLinksSchema = z.object(setFeatureRequestLinksShape);
export type SetFeatureRequestLinksInput = z.infer<typeof setFeatureRequestLinksSchema>;
export const setFeatureRequestLinksOutputShape = {
  outcome: z.enum(["applied", "proposed", "stale", "not_found"]),
  feature_request_id: z.number().optional(),
  link_revision: z.number().int().optional(),
  current_version: z.number().int().optional(),
  links: z.array(z.object({ story_key: z.string(), link_type: z.enum(["primary", "secondary"]) })).optional(),
  proposal: storyProposalObject().optional(),
  note: z.string().optional(),
};

export const getFeatureRequestShape = {
  feature_request_id: z.number().int().describe("The feature request id to fetch."),
};
export const getFeatureRequestSchema = z.object(getFeatureRequestShape);
export type GetFeatureRequestInput = z.infer<typeof getFeatureRequestSchema>;

export const getFeatureRequestOutputShape = {
  feature_request: z
    .object({
      id: z.number(),
      source: z.string().nullable(),
      source_thread_id: z.string().nullable(),
      source_thread_url: z.string().nullable(),
      title: z.string(),
      summary: z.string().nullable(),
      requested_change: z.string().nullable(),
      context: z.string().nullable(),
      priority_signal: z.string().nullable(),
      confidence: z.number().nullable(),
      product_area: z.string().nullable(),
      status: z.string(),
      notion_page_id: z.string().nullable(),
      created_at: z.string(),
      link_revision: z.number().int(),
      primary_story: z.object({ story_key: z.string(), title: z.string() }).nullable(),
      secondary_stories: z.array(z.object({ story_key: z.string(), title: z.string() })),
    })
    .nullable(),
  note: z.string().optional(),
};
