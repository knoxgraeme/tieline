import { config } from "../config.js";
import { runHttp } from "../http.js";
import { runStdio } from "../stdio.js";

export async function runServeCommand(args: string[]): Promise<number> {
  const unknown = args.filter((arg) => arg !== "--http" && arg !== "--stdio");
  if (unknown.length > 0 || (args.includes("--http") && args.includes("--stdio"))) {
    throw new Error("Usage: tieline serve [--http|--stdio]");
  }
  const transport = args.includes("--http")
    ? "http"
    : args.includes("--stdio")
      ? "stdio"
      : config.transport;
  if (transport === "http") await runHttp();
  else await runStdio();
  return 0;
}
