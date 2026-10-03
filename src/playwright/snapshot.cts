import { test, type Locator, type Page } from "@playwright/test";
import { captureScreen } from "./capture-screen.cjs";
import { openAndCapture, type GeneratedScreen, type ScenePrepare } from "./page-scene.cjs";

export type { GeneratedScreen, ScenePrepare } from "./page-scene.cjs";

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

/**
 * The body of a scene `tieline screens scenes` generates for a catalogued
 * page: runs the setup module's `prepare` (sign in, seed data, choose the URL
 * for a route with parameters), opens the page, and captures it. A route left
 * with parameters, or a page that answers with an error, fails the test.
 */
export async function tielinePageScene(
  page: Page,
  screen: GeneratedScreen,
  prepare?: ScenePrepare<Page>
): Promise<void> {
  await openAndCapture(page, screen, prepare, (target, key) => tielineSnapshot(target, key));
}
