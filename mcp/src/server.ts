// Switchyard MCP server. Hand-curated tool surface — see PHASES.md Phase 5.0
// for the design rationale (Option C: hand-shaped tools, generated HTTP types).
//
// Tool registration is split across files in tools/ so each domain (tickets,
// projects, etc.) stays readable. This file is just wiring.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerTicketTools } from "./tools/tickets.js";
import { registerTicketLinkTools } from "./tools/ticketLinks.js";
import { registerExternalRefTools } from "./tools/externalRefs.js";
import { registerQueryTools } from "./tools/query.js";
import { registerUserTools } from "./tools/users.js";

export function buildServer(): McpServer {
  const server = new McpServer(
    {
      name: "switchyard",
      version: "0.1.0",
    },
    {
      // Capabilities advertised to clients. Resources/prompts/sampling can
      // come later — tools-only keeps the initial surface tight.
      capabilities: {
        tools: {},
      },
    },
  );

  registerProjectTools(server);
  registerTicketTools(server);
  registerTicketLinkTools(server);
  registerExternalRefTools(server);
  registerQueryTools(server);
  registerUserTools(server);

  return server;
}
