import { z } from "zod";
import { canonicalRepositoryRelativePath } from "../../contract/paths.js";
import { parseSelector } from "../../contract/selector.js";

export const exactAssetPath = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine(
    (value) => canonicalRepositoryRelativePath(value) !== null,
    "must name a file inside the repository"
  );

export const exactAssetSelector = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .superRefine((value, ctx) => {
    const parsed = parseSelector(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error });
    }
  });
