import type { Page } from "@playwright/test";
import type { GeneratedScreen } from "tieline/playwright";

// Written once by the agent that set up capture: everything a generated page
// scene cannot know. Acme Notes needs no sign-in; a note page needs a note.
export async function prepare(_page: Page, screen: GeneratedScreen): Promise<string | void> {
  if (screen.route === "/notes/:noteId") return "/notes/1";
}
