import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPTURE_LIMITS,
  RUN_DIRECTORY_ENV,
  MASK_COLOR,
  RUN_PROTOCOL_VERSION,
  SCREEN_ATTACHMENT,
  SCREEN_TAG_PREFIX,
  SCREENS_DIRECTORY,
  SELECTION_FILE,
  SETTLE_DELAYS_MS,
  screenKeyProblem,
  type CaptureSettingsFile,
} from "./protocol.cjs";

/**
 * The part of a Playwright `Page` a capture uses. Kept structural so the
 * capture can be exercised without a browser; `tielineSnapshot` passes a real
 * `Page`, which the compiler checks against this shape.
 */
export interface SnapshotPage<Mask> {
  waitForLoadState(state: "load"): Promise<void>;
  waitForTimeout(timeout: number): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(options: {
    animations: "disabled";
    caret: "hide";
    scale: "css";
    fullPage: boolean;
    maskColor: string;
    mask?: Mask[];
  }): Promise<Buffer>;
  locator(selector: string): { ariaSnapshot(): Promise<string> };
  viewportSize(): { width: number; height: number } | null;
  context(): {
    browser(): { browserType(): { name(): string }; version(): string } | null;
  };
}

/** The part of Playwright's `TestInfo` a capture uses. */
export interface SnapshotTestInfo {
  tags: readonly string[];
  attach(name: string, options: { body: string; contentType: string }): Promise<void>;
}

export interface CaptureScreenOptions<Mask> {
  /** Elements painted over in the screenshot, such as avatars or timestamps. */
  mask?: Mask[];
  /** Capture the full scrollable page instead of the viewport. */
  fullPage?: boolean;
}

/** Waits for web fonts, so text is never captured in a fallback face. */
const FONTS_READY = "document.fonts ? document.fonts.ready.then(() => true) : true";

/**
 * Rendering settings the page itself reports. Read from the page rather than
 * the Playwright configuration, so a project override or a device preset is
 * recorded as it actually applied.
 */
const PAGE_SETTINGS = `(() => {
  const media = (query) => window.matchMedia(query).matches;
  return {
    device_scale_factor: window.devicePixelRatio,
    color_scheme: media("(prefers-color-scheme: dark)") ? "dark" : media("(prefers-color-scheme: light)") ? "light" : "no-preference",
    reduced_motion: media("(prefers-reduced-motion: reduce)") ? "reduce" : "no-preference",
    forced_colors: media("(forced-colors: active)") ? "active" : "none",
    contrast: media("(prefers-contrast: more)") ? "more" : media("(prefers-contrast: less)") ? "less" : "no-preference",
    locale: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    touch: navigator.maxTouchPoints > 0,
  };
})()`;

const selections = new Map<string, ReadonlySet<string>>();

/** The keys the current run selected, read once per worker and run. */
function selectedKeys(runDirectory: string): ReadonlySet<string> {
  const cached = selections.get(runDirectory);
  if (cached) return cached;
  const path = join(runDirectory, SELECTION_FILE);
  if (statSync(path).size > CAPTURE_LIMITS.selectionBytes) {
    throw new Error(`Tieline's capture selection '${path}' is larger than ${CAPTURE_LIMITS.selectionBytes} bytes.`);
  }
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const keys =
    parsed !== null && typeof parsed === "object" ? (parsed as { keys?: unknown }).keys : undefined;
  if (
    (parsed as { version?: unknown } | null)?.version !== RUN_PROTOCOL_VERSION ||
    !Array.isArray(keys) ||
    !keys.every((key) => typeof key === "string")
  ) {
    throw new Error(`Tieline's capture selection '${path}' is not a version ${RUN_PROTOCOL_VERSION} selection.`);
  }
  const selected = new Set<string>(keys);
  selections.set(runDirectory, selected);
  return selected;
}

function writeAtomically(path: string, content: string | Buffer): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Screenshots until two in a row are identical, so a capture never records a
 * frame in the middle of a transition. Bounded: a page that never settles
 * fails the capture with the screen's key rather than recording a frame.
 */
async function settledScreenshot<Mask>(
  page: SnapshotPage<Mask>,
  key: string,
  options: Parameters<SnapshotPage<Mask>["screenshot"]>[0]
): Promise<{ image: Buffer; attempts: number }> {
  let previous: Buffer | null = null;
  for (const [index, delay] of SETTLE_DELAYS_MS.slice(0, CAPTURE_LIMITS.settleAttempts).entries()) {
    if (delay > 0) await page.waitForTimeout(delay);
    const image = await page.screenshot(options);
    if (image.length > CAPTURE_LIMITS.imageBytes) {
      throw new Error(
        `Screen '${key}': the screenshot is ${image.length} bytes; the limit is ${CAPTURE_LIMITS.imageBytes}.`
      );
    }
    if (previous?.equals(image)) return { image, attempts: index + 1 };
    previous = image;
  }
  throw new Error(
    `Screen '${key}' did not settle: ${CAPTURE_LIMITS.settleAttempts} screenshots in a row differed. Freeze what moves (animations, clocks, carousels) or mask it.`
  );
}

/**
 * Captures one screen for the current `tieline screens capture` run: waits for
 * the page to settle, takes the screenshot, records the ARIA snapshot and the
 * rendering settings, writes all three to the run directory, and attaches the
 * key so the reporter knows which test captured it.
 *
 * The test must be tagged `@screen:<key>`, checked on every run so a wrong tag
 * fails where it is written. Outside a capture run, or when this run did not
 * select the key, nothing is captured, so calls in ordinary end-to-end tests
 * cost nothing.
 */
export async function captureScreen<Mask>(
  page: SnapshotPage<Mask>,
  key: string,
  testInfo: SnapshotTestInfo,
  options: CaptureScreenOptions<Mask> = {},
  environment: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const problem = screenKeyProblem(key);
  if (problem) throw new Error(`tielineSnapshot: screen key '${key}' ${problem}.`);
  const tag = `${SCREEN_TAG_PREFIX}${key}`;
  if (!testInfo.tags.includes(tag)) {
    throw new Error(
      `tielineSnapshot('${key}') is called from a test that is not tagged ${tag}; add { tag: "${tag}" } to the test.`
    );
  }
  const runDirectory = environment[RUN_DIRECTORY_ENV];
  if (!runDirectory || !selectedKeys(runDirectory).has(key)) return;

  await page.waitForLoadState("load");
  await page.evaluate(FONTS_READY);
  const masks = options.mask ?? [];
  const snapshot = {
    animations: "disabled" as const,
    caret: "hide" as const,
    scale: "css" as const,
    fullPage: options.fullPage === true,
    maskColor: MASK_COLOR,
    ...(masks.length > 0 ? { mask: masks } : {}),
  };
  const { image, attempts } = await settledScreenshot(page, key, snapshot);
  const text = await page.locator("body").ariaSnapshot();
  if (Buffer.byteLength(text) > CAPTURE_LIMITS.textBytes) {
    throw new Error(
      `Screen '${key}': the ARIA snapshot is larger than ${CAPTURE_LIMITS.textBytes} bytes.`
    );
  }
  const browser = page.context().browser();
  const settings: CaptureSettingsFile = {
    version: RUN_PROTOCOL_VERSION,
    key,
    browser: {
      name: browser?.browserType().name() ?? "unknown",
      version: browser?.version() ?? "unknown",
    },
    page: {
      viewport: page.viewportSize(),
      ...((await page.evaluate(PAGE_SETTINGS)) as Omit<CaptureSettingsFile["page"], "viewport">),
    },
    snapshot: {
      full_page: snapshot.fullPage,
      animations: snapshot.animations,
      caret: snapshot.caret,
      scale: snapshot.scale,
      mask_color: MASK_COLOR,
      masks: masks.map((mask) => String(mask)),
    },
    settle_attempts: attempts,
  };
  const directory = join(runDirectory, SCREENS_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  writeAtomically(join(directory, `${key}.png`), image);
  writeAtomically(join(directory, `${key}.yml`), text.endsWith("\n") ? text : `${text}\n`);
  writeAtomically(join(directory, `${key}.json`), `${JSON.stringify(settings, null, 2)}\n`);
  await testInfo.attach(SCREEN_ATTACHMENT, { body: key, contentType: "text/plain" });
}
