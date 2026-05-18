#!/usr/bin/env bun
// Switchyard MCP server entrypoint. Transports today: stdio only (matches
// the install pattern for Claude Desktop, Claude Code, Cline, Gemini CLI,
// etc.). HTTP transport stays optional — only needed if a remote consumer
// wants to subscribe without running a local process.
//
// Errors during boot go to stderr (stdout is the MCP stdio channel — any
// stray text there breaks the protocol).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The transport keeps the process alive; nothing to await further.
}

main().catch((err) => {
  console.error("[switchyard-mcp] fatal:", err);
  process.exit(1);
});
