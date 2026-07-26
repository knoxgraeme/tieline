#!/usr/bin/env node
/**
 * Entry point. Loads .env, then starts the transport selected by TRANSPORT.
 * Default: stdio. Set TRANSPORT=http or run `tieline serve --http` for the
 * standalone HTTP server.
 */

import "./loadEnv.js";
import { config } from "./config.js";
import { runHttp } from "./http.js";
import { runStdio } from "./stdio.js";

async function main(): Promise<void> {
  if (config.transport === "stdio") {
    await runStdio();
  } else {
    await runHttp();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Fatal server error:", error);
  process.exit(1);
});
