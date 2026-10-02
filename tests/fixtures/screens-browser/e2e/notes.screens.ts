import { test } from "@playwright/test";
import { tielineSnapshot } from "tieline/playwright";

test("notes list", { tag: "@screen:notes-list" }, async ({ page }) => {
  await page.goto("/notes");
  await tielineSnapshot(page, "notes-list");
});

test("notes list without notes", { tag: "@screen:notes-list-empty" }, async ({ page }) => {
  await page.goto("/notes/empty");
  await tielineSnapshot(page, "notes-list-empty");
});

test("sharing is denied to viewers", { tag: "@screen:notes-share-denied" }, async ({ page }) => {
  await page.goto("/notes/1");
  await page.getByRole("button", { name: "Share" }).click();
  await page.getByText("Only editors can share this note").waitFor();
  await tielineSnapshot(page, "notes-share-denied");
});

test("an ordinary end-to-end test is not a capture", async ({ page }) => {
  await page.goto("/notes");
  await page.getByRole("link", { name: "Grocery list" }).click();
});
