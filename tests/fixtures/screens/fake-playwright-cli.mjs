// A stand-in for `@playwright/test/cli`, used to test how Tieline runs
// Playwright as a child process. It records what it was given, then behaves
// as FAKE_PLAYWRIGHT_MODE says: exit with a code, hang, or ignore SIGTERM.
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_PLAYWRIGHT_MODE ?? "exit";
if (mode === "stubborn") process.on("SIGTERM", () => {});
const report = process.env.FAKE_PLAYWRIGHT_REPORT;
if (report) {
  writeFileSync(
    report,
    JSON.stringify({
      args: process.argv.slice(2),
      run: process.env.TIELINE_SCREENS_RUN ?? null,
      cwd: process.cwd(),
    })
  );
}
if (mode === "exit") process.exit(Number(process.env.FAKE_PLAYWRIGHT_CODE ?? "0"));
setInterval(() => {}, 1_000);
