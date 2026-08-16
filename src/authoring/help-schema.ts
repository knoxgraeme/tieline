import { z } from "zod";

export const helpArticleImportSchema = z
  .object({
    source: z.string().trim().min(1).max(160),
    external_id: z.string().trim().min(1).max(500),
    title: z.string().trim().min(1).max(500).nullable().optional(),
    summary: z.string().nullable().optional(),
    url: z.string().url().nullable().optional(),
    markdown: z.string().nullable().optional(),
  })
  .strict();

export const helpArticleImportPayloadSchema = z.union([
  z.array(helpArticleImportSchema),
  z
    .object({ articles: z.array(helpArticleImportSchema) })
    .strict()
    .transform((value) => value.articles),
]);

export type HelpArticleImportRecord = z.infer<typeof helpArticleImportSchema>;
