import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPTURE_LIMITS,
  RUN_PROTOCOL_VERSION,
  RUN_RECORD_FILE,
  type RunRecord,
  type RunRecordTest,
} from "./protocol.cjs";

function bounded(message: string): string {
  return message.length > CAPTURE_LIMITS.errorChars
    ? `${message.slice(0, CAPTURE_LIMITS.errorChars)}…`
    : message;
}

/**
 * Collects what a capture run did from plain test events and writes the run
 * record when it ends. The reporter adapts Playwright's events to this, so the
 * record's content can be tested without a browser.
 *
 * Only a test's last attempt counts: a retry that passed replaces the attempt
 * that failed. The record lists every test's outcome and the keys it attached;
 * deciding whether the run is complete is the command's job.
 */
export class CaptureRunRecorder {
  private playwright = "unknown";
  private readonly tests = new Map<string, RunRecordTest>();
  private readonly errors: string[] = [];

  /** Null outside a capture run, where nothing is recorded. */
  constructor(private readonly runDirectory: string | null) {}

  begin(playwrightVersion: string): void {
    this.playwright = playwrightVersion;
  }

  testEnded(test: RunRecordTest): void {
    this.tests.set(test.id, { ...test, error: test.error === null ? null : bounded(test.error) });
  }

  error(message: string): void {
    if (this.errors.length < CAPTURE_LIMITS.errors) this.errors.push(bounded(message));
  }

  record(status: string): RunRecord {
    return {
      version: RUN_PROTOCOL_VERSION,
      playwright: this.playwright,
      status,
      tests: [...this.tests.values()],
      errors: [...this.errors],
    };
  }

  /** Writes the run record, through a temporary file so it is never partial. */
  end(status: string): void {
    if (!this.runDirectory) return;
    mkdirSync(this.runDirectory, { recursive: true });
    const path = join(this.runDirectory, RUN_RECORD_FILE);
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(this.record(status))}\n`);
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}
