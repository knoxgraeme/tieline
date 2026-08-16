import { config } from "../config.js";
import { runHttp } from "../http.js";
import { runStdio } from "../stdio.js";

export async function runServeCommand(options: {
  http?: boolean;
  stdio?: boolean;
}): Promise<number> {
  const transport = options.http
    ? "http"
    : options.stdio
      ? "stdio"
      : config.transport;
  if (transport === "http") await runHttp();
  else await runStdio();
  return 0;
}
