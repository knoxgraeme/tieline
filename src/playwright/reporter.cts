import type {
  FullConfig,
  FullResult,
  Reporter,
  TestCase,
  TestError,
  TestResult,
} from "@playwright/test/reporter";
import { RUN_DIRECTORY_ENV, SCREEN_ATTACHMENT } from "./protocol.cjs";
import { CaptureRunRecorder } from "./run-recorder.cjs";

/**
 * The reporter `tieline screens capture` passes to Playwright by path. It
 * records which test captured which screens and how every test ended, and
 * prints nothing itself, so Playwright keeps its usual progress output.
 */
export default class TielineScreensReporter implements Reporter {
  private readonly recorder = new CaptureRunRecorder(process.env[RUN_DIRECTORY_ENV] ?? null);

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig): void {
    this.recorder.begin(config.version);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.recorder.testEnded({
      id: test.id,
      file: test.location.file,
      line: test.location.line,
      title: test.titlePath().filter((part) => part.length > 0).join(" › "),
      project: test.parent.project()?.name ?? "",
      status: result.status,
      keys: result.attachments
        .filter((attachment) => attachment.name === SCREEN_ATTACHMENT && attachment.body)
        .map((attachment) => attachment.body!.toString("utf8")),
      error: result.error?.message ?? result.error?.value ?? null,
    });
  }

  onError(error: TestError): void {
    this.recorder.error(error.message ?? error.value ?? "unknown error");
  }

  onEnd(result: FullResult): void {
    this.recorder.end(result.status);
  }
}
