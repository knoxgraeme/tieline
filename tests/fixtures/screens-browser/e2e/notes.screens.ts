import { expect, test } from "@playwright/test";
import { tielineSnapshot } from "tieline/playwright";

// Each scene is the test for the acceptance criterion it is tagged with: the
// Then is asserted, and the screen it ends on is captured.

test("notes list", { tag: ["@ac:NOTES-001-AC1", "@screen:notes-list"] }, async ({ page }) => {
  await page.goto("/notes");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(2);
  await tielineSnapshot(page, "notes-list");
});

test("notes list without notes", { tag: ["@ac:NOTES-001-AC2", "@screen:notes-list-empty"] }, async ({ page }) => {
  await page.goto("/notes/empty");
  await expect(page.getByRole("button", { name: "New note" })).toBeVisible();
  await tielineSnapshot(page, "notes-list-empty");
});

test("sharing is denied to viewers", { tag: ["@ac:SHARING-001-AC1", "@screen:notes-share-denied"] }, async ({ page }) => {
  await page.goto("/notes/1");
  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.getByRole("alert")).toHaveText("Only editors can share this note");
  await tielineSnapshot(page, "notes-share-denied");
});

test("an ordinary end-to-end test is not a capture", async ({ page }) => {
  await page.goto("/notes");
  await page.getByRole("link", { name: "Grocery list" }).click();
});
