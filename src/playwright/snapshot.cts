import { test, type Locator, type Page } from "@playwright/test";
import { captureScreen } from "./capture-screen.cjs";

export interface TielineSnapshotOptions {
  /** Elements painted over in the screenshot, such as avatars or timestamps. */
  mask?: Locator[];
  /** Capture the full scrollable page instead of the viewport. */
  fullPage?: boolean;
}

/**
 * Tieline's Playwright capture call, published as `tieline/playwright`.
 *
 * ```ts
 * test("share denied", { tag: "@screen:notes-share-denied" }, async ({ page }) => {
 *   await page.goto("/notes/note-seed-1");
 *   await page.getByRole("button", { name: "Share" }).click();
 *   await tielineSnapshot(page, "notes-share-denied");
 * });
 * ```
 *
 * Visual differences never fail a test: whether a screen changed is decided in
 * review. Operational failures do — a page that does not settle, a screenshot
 * or ARIA snapshot that fails, or a test that is not tagged `@screen:<key>`.
 * Outside a `tieline screens capture` run the call only checks the tag.
 */
export async function tielineSnapshot(
  page: Page,
  key: string,
  options: TielineSnapshotOptions = {}
): Promise<void> {
  await captureScreen(page, key, test.info(), options);
}
