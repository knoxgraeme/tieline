#!/usr/bin/env node
/**
 * Entry point. Loads .env, then starts the transport selected by TRANSPORT.
 * Default: stdio. Set TRANSPORT=http or run `tieline serve --http` for the
 * standalone HTTP server.
 */

import "./load-env.js";
import { removePrivilegedDatabaseEnvironment } from "./tieline/profile.js";

async function main(): Promise<void> {
  removePrivilegedDatabaseEnvironment(process.env);
  const [{ reloadConfig }, { runHttp }, { runStdio }] = await Promise.all([
    import("./config.js"),
    import("./http.js"),
    import("./stdio.js"),
  ]);
  const config = reloadConfig(process.env);
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
