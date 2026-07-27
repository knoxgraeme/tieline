/**
 * Shared domain types for the user-story knowledge graph and the retrieval
 * responses. Kept framework-agnostic so ranking logic can be unit-tested.
 */

export const STORY_STATUSES = [
  "production",
  "qa",
  "in_progress",
  "in_review",
  "cancelled",
  "idea",
  "feature_request",
] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

/** A help-center article linked to a story (the join carries the per-link
 *  relationship_type + confidence; the article carries slug/title/url). */
export interface HelpArticleLink {
  article_slug: string;
  title: string;
  url: string | null;
  relationship_type: string; // primary | supporting | reference | troubleshooting
  confidence: number; // 0..1, how sure the link is
}

/** A feature request linked to a story (lightweight ref attached to records). */
export interface FeatureRequestRef {
  id: number;
  title: string;
  link_type: string; // primary | secondary
}

/** A single story row with its normalized footprint (slugs + paths + docs). */
export interface StoryRecord {
  id: number;
  story_key: string;
  section_id: number;
  section_key: string;
  section_name: string;
  title: string;
  actor: string | null;
  story_text: string;
  status: string;
  entity_slugs: string[];
  code_paths: string[];
  /** Top help articles for this story (capped); ordered primary-first then by confidence. */
  help_articles: HelpArticleLink[];
  /** Total linked articles, even when help_articles is capped. */
  help_article_count: number;
  /** Feature requests linked to this story. Populated by query_stories only. */
  feature_requests?: FeatureRequestRef[];
}

/** Full feature-request record + its linked stories (get_feature_request). */
export interface FeatureRequestRecord {
  id: number;
  source: string | null;
  source_thread_id: string | null;
  source_thread_url: string | null;
  title: string;
  summary: string | null;
  requested_change: string | null;
  context: string | null;
  priority_signal: string | null;
  confidence: number | null;
  product_area: string | null;
  status: string;
  notion_page_id: string | null;
  created_at: string;
  link_revision: number;
  primary_story: { story_key: string; title: string } | null;
  secondary_stories: { story_key: string; title: string }[];
}

/** A created/updated story returned by the write tools. */
export interface WrittenStory {
  id: number;
  story_key: string;
  section_key: string;
  title: string;
  actor: string | null;
  story_text: string;
  status: string;
}

/** A candidate produced by a retrieval source (story + raw per-signal scores). */
export interface Candidate extends StoryRecord {
  similarity: number; // 1 - cosine distance, ~0..1 (0 when no embedding)
  /** Lexical relevance 0..1: saturated ts_rank_cd over prose blended with
   *  pg_trgm word_similarity over linked code paths / entity slugs. Absent/0
   *  when the candidate did not come from the lexical source. */
  lexical?: number;
}

/** Document frequencies used for 1/df rare-slug/path weighting. */
export interface DocFrequencies {
  entity: Map<string, number>;
  path: Map<string, number>;
}

/** The "why" attached to every ranked result. */
export interface Why {
  shared_entities: string[];
  shared_code_paths: string[];
}

export interface ScoreBreakdown {
  vector: number; // normalized 0..1
  entity: number; // normalized weighted-overlap 0..1
  path: number; // normalized weighted-overlap 0..1
}

/** A matched story inside an area hit. */
export interface MatchedStory {
  story_key: string;
  title: string;
  story_text: string;
  actor: string | null;
  status: string;
  score: number;
  help_articles: HelpArticleLink[];
  help_article_count: number;
}

/** find_related result when scope = "areas". */
export interface AreaHit {
  section_key: string;
  section_name: string;
  score: number;
  score_breakdown: ScoreBreakdown;
  matched_stories: MatchedStory[];
  code_paths: string[];
  why: Why;
}

/** find_related result when scope = "stories". */
export interface StoryHit {
  story_key: string;
  title: string;
  story_text: string;
  actor: string | null;
  status: string;
  section_key: string;
  section_name: string;
  score: number;
  score_breakdown: ScoreBreakdown;
  code_paths: string[];
  help_articles: HelpArticleLink[];
  help_article_count: number;
  why: Why;
}

/** find_help ranked help-center article (pure semantic match). */
export interface HelpHit {
  article_slug: string;
  title: string;
  summary: string | null;
  url: string | null;
  product_area: string | null;
  audience: string | null;
  tags: string[];
  headings: string[];
  score: number; // cosine similarity 0..1
  /** Stories this article documents (reverse of the story-side help_articles). */
  linked_story_keys: string[];
  linked_story_count: number;
}

/** Full help-center article body + metadata (returned by get_help_article). */
export interface HelpArticle {
  article_slug: string;
  title: string;
  url: string | null;
  product_area: string | null;
  audience: string | null;
  tags: string[];
  headings: string[];
  markdown: string | null;
}

/** find_crossover ranked entangled section. */
export interface CrossoverHit {
  section_key: string;
  section_name: string;
  score: number;
  shared_code_paths: { path: string; weight: number }[];
  shared_entities: { slug: string; weight: number }[];
}
