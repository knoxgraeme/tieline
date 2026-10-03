/**
 * The body of every generated page scene: prepare the page, open the screen's
 * route, and capture it. Kept apart from `snapshot.cts` so it can be tested
 * without a Playwright runner.
 */

/** What a generated scene knows about its screen, from the catalog. */
export interface GeneratedScreen {
  key: string;
  title: string;
  route: string;
  /** The screen's `applies_to`, such as `{ role: ["viewer"] }`, or null. */
  applies_to: Readonly<Record<string, readonly string[]>> | null;
}

/**
 * The agent-written setup for generated scenes: signs in as the screen's role,
 * seeds what the page shows, and returns the URL to open when the route has
 * parameters (`/notes/:noteId` → `/notes/note-1`). Returning nothing opens the
 * route as catalogued.
 */
export type ScenePrepare<P> = (page: P, screen: GeneratedScreen) => Promise<string | void> | string | void;

export interface PageSceneTarget {
  goto(url: string): Promise<{ ok(): boolean; status(): number } | null>;
}

const ROUTE_PARAMETER = /(^|\/)(:|\*|\[)/;

export async function openAndCapture<P extends PageSceneTarget>(
  page: P,
  screen: GeneratedScreen,
  prepare: ScenePrepare<P> | undefined,
  snapshot: (page: P, key: string) => Promise<void>
): Promise<void> {
  const prepared = prepare ? await prepare(page, screen) : undefined;
  const target = typeof prepared === "string" && prepared.length > 0 ? prepared : screen.route;
  if (ROUTE_PARAMETER.test(target)) {
    throw new Error(
      `Screen '${screen.key}' has route ${screen.route}, which has parameters: return the URL to open from prepare() in the generated scenes' setup file.`
    );
  }
  const response = await page.goto(target);
  // A page that answers with an error is not the screen the catalog describes.
  if (response && !response.ok()) {
    throw new Error(`Screen '${screen.key}': ${target} answered HTTP ${response.status()}, so it was not captured.`);
  }
  await snapshot(page, screen.key);
}
