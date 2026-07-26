/**
 * stdio transport — for local dev and the MCP Inspector / Claude Desktop.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, SERVER_NAME } from "./server.js";

export async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel; logs must go to stderr.
  // eslint-disable-next-line no-console
  console.error(`${SERVER_NAME} running on stdio`);
}
