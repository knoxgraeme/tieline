import { z } from "zod";

export const helpArticleImportSchema = z.object({
  article_slug: z.string().trim().min(1).max(300),
  title: z.string().trim().min(1).max(500),
  summary: z.string().nullable().optional(),
  url: z.string().url().nullable().optional(),
  product_area: z.string().trim().min(1).nullable().optional(),
  audience: z.string().trim().min(1).nullable().optional(),
  tags: z.array(z.string().trim().min(1)).default([]),
  headings: z.array(z.string().trim().min(1)).default([]),
  markdown: z.string().nullable().optional(),
});

export const helpArticleImportPayloadSchema = z.union([
  z.array(helpArticleImportSchema),
  z.object({ articles: z.array(helpArticleImportSchema) }).transform((value) => value.articles),
]);

export type HelpArticleImportRecord = z.infer<typeof helpArticleImportSchema>;

