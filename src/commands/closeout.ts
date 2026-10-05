import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildCloseoutScope, verifyCloseoutReport } from "../contract/closeout.js";
import type { CommandIO } from "./shared.js";

export function runCloseout(options: {
  repository?: string; base: string; head?: string; emitScope?: boolean; verify?: string;
}, io: CommandIO): number {
  if (Boolean(options.emitScope) === Boolean(options.verify)) {
    throw new Error("Closeout requires exactly one of --emit-scope or --verify <report.json>.");
  }
  const scope = buildCloseoutScope({ repositoryRoot: resolve(options.repository ?? process.cwd()),
    base: options.base, head: options.head ?? "HEAD" });
  if (options.emitScope) {
    io.write(`${JSON.stringify(scope, null, 2)}\n`);
    return 0;
  }
  const path = resolve(options.verify!);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.size > 2 * 1024 * 1024) throw new Error("Closeout report must be a regular file no larger than 2 MiB.");
  const report = verifyCloseoutReport(scope, JSON.parse(readFileSync(path, "utf8")));
  io.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ready ? 0 : 1;
}
