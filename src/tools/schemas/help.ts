import { z } from "zod";

export const findHelpShape = {
  query: z.string().trim().min(3).max(2_000),
  source: z.array(z.string().trim().min(1)).optional(),
  limit: z.number().int().min(1).max(20).default(5),
};
const findHelpSchema = z.object(findHelpShape).strict();
export type FindHelpInput = z.infer<typeof findHelpSchema>;
export const findHelpOutputShape = {
  query: z.object({
    source: z.array(z.string()).optional(),
  }),
  results: z.array(
    z.object({
      source: z.string(),
      external_id: z.string(),
      title: z.string().nullable(),
      url: z.string().nullable(),
      summary: z.string().nullable(),
      lexical_score: z.number(),
      linked_story_count: z.number(),
      linked_acceptance_criterion_count: z.number(),
    })
  ),
  note: z.string().optional(),
};

const helpArticleRef = () =>
  z
    .object({
      source: z.string().trim().min(1),
      external_id: z.string().trim().min(1),
    })
    .strict();
export const getHelpArticlesShape = {
  articles: z.array(helpArticleRef()).min(1).max(10),
};
const getHelpArticlesSchema = z
  .object(getHelpArticlesShape)
  .strict();
export type GetHelpArticlesInput = z.infer<typeof getHelpArticlesSchema>;
export const getHelpArticlesOutputShape = {
  articles: z.array(z.record(z.unknown())),
  not_found: z.array(helpArticleRef()),
  note: z.string().optional(),
};
