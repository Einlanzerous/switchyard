#!/usr/bin/env bun
// Live smoke test for the switchyard MCP server.
//
// Spawns the MCP server via stdio, then exercises every tool against the
// backend pointed to by SWITCHYARD_URL. Creates a transient ticket, mutates
// it, and closes it via transition_ticket — so the smoke ticket lands in
// the closed bucket as audit-trail rather than polluting the active list.
//
// Usage:
//   SWITCHYARD_TOKEN=sw_... SWITCHYARD_URL=http://localhost:4012 \
//     bun mcp/scripts/smoke.ts [--project SWY]
//
// Exit code = number of failed tool calls (0 on full success). Designed to
// be CI-friendly: any non-zero exit means at least one tool is broken
// against the live backend.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";

const PROJECT_KEY = parseProjectArg() ?? "SWY";

interface ToolCallResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
}

const failures: Array<{ tool: string; reason: string }> = [];
let passed = 0;

function logPass(tool: string, detail: string): void {
  passed++;
  console.log(`✅ PASS  ${tool.padEnd(24)}  ${detail}`);
}

function logFail(tool: string, reason: string): void {
  failures.push({ tool, reason });
  console.log(`❌ FAIL  ${tool.padEnd(24)}  ${reason}`);
}

function extractText(res: ToolCallResult): string {
  const block = res.content?.[0];
  return block?.text ?? "";
}

function parseJson(res: ToolCallResult): unknown {
  const text = extractText(res);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const token = process.env.SWITCHYARD_TOKEN;
  const url = process.env.SWITCHYARD_URL ?? "http://localhost:4002";
  if (!token) {
    console.error("SWITCHYARD_TOKEN is required");
    process.exit(2);
  }
  console.log(`switchyard-mcp smoke against ${url} (project=${PROJECT_KEY})`);
  console.log("─".repeat(72));

  const serverEntry = resolve(import.meta.dir, "..", "src", "index.ts");
  const transport = new StdioClientTransport({
    command: "bun",
    args: [serverEntry],
    env: { SWITCHYARD_TOKEN: token, SWITCHYARD_URL: url, PATH: process.env.PATH ?? "" },
  });
  const client = new Client({ name: "switchyard-smoke", version: "0" }, { capabilities: {} });
  await client.connect(transport);

  try {
    // ── reads ──────────────────────────────────────────────────────────
    const projects = await client.callTool({ name: "list_projects", arguments: {} });
    const projectItems = parseJson(projects) as Array<{ key: string }> | null;
    if (projects.isError || !Array.isArray(projectItems)) {
      logFail("list_projects", extractText(projects));
    } else {
      logPass("list_projects", `${projectItems.length} project(s)`);
    }

    const statuses = await client.callTool({
      name: "get_project_statuses",
      arguments: { project_key: PROJECT_KEY },
    });
    const statusItems = parseJson(statuses) as Array<{
      id: string;
      category: string;
      display_name: string;
    }> | null;
    if (statuses.isError || !Array.isArray(statusItems) || statusItems.length === 0) {
      logFail("get_project_statuses", extractText(statuses));
      throw new Error("cannot continue without project statuses");
    }
    logPass("get_project_statuses", `${statusItems.length} status(es)`);
    const closedStatus = statusItems.find((s) => s.category === "closed");
    if (!closedStatus) {
      logFail("get_project_statuses", "no closed-category status on project — can't smoke transition_ticket");
      throw new Error("project lacks a closed-category status");
    }

    const listed = await client.callTool({
      name: "list_tickets",
      arguments: { project: PROJECT_KEY, limit: 5 },
    });
    if (listed.isError) logFail("list_tickets", extractText(listed));
    else logPass("list_tickets", "items array returned");

    const myOpen = await client.callTool({ name: "query_my_open", arguments: {} });
    if (myOpen.isError) logFail("query_my_open", extractText(myOpen));
    else {
      const payload = parseJson(myOpen) as { count?: number } | null;
      logPass("query_my_open", `count=${payload?.count ?? "?"}`);
    }

    // ── writes (on a transient smoke ticket) ──────────────────────────
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const created = await client.callTool({
      name: "create_ticket",
      arguments: {
        project_key: PROJECT_KEY,
        type: "task",
        title: `[smoke ${stamp}] switchyard-mcp live tool exercise`,
        description:
          "Created by mcp/scripts/smoke.ts. Transitioned to closed at end of run; safe to delete.",
        priority: "low",
      },
    });
    const createdTicket = parseJson(created) as { key?: string; id?: string } | null;
    if (created.isError || !createdTicket?.key) {
      logFail("create_ticket", extractText(created));
      throw new Error("create_ticket failed — can't run remaining write tools");
    }
    const smokeKey = createdTicket.key;
    logPass("create_ticket", `created ${smokeKey}`);

    const fetched = await client.callTool({
      name: "get_ticket",
      arguments: { id_or_key: smokeKey },
    });
    const fetchedTicket = parseJson(fetched) as { key?: string } | null;
    if (fetched.isError || fetchedTicket?.key !== smokeKey) {
      logFail("get_ticket", extractText(fetched));
    } else {
      logPass("get_ticket", `round-tripped ${smokeKey}`);
    }

    const updated = await client.callTool({
      name: "update_ticket",
      arguments: { id_or_key: smokeKey, priority: "medium" },
    });
    if (updated.isError) logFail("update_ticket", extractText(updated));
    else logPass("update_ticket", "priority low → medium");

    const commented = await client.callTool({
      name: "comment_on_ticket",
      arguments: { id_or_key: smokeKey, body: "smoke comment ✓" },
    });
    if (commented.isError) logFail("comment_on_ticket", extractText(commented));
    else logPass("comment_on_ticket", "body posted");

    // move_ticket: best-effort. Only exercise if ≥2 projects exist.
    if (projectItems && projectItems.length >= 2) {
      const dest = projectItems.find((p) => p.key !== PROJECT_KEY);
      if (dest) {
        const moved = await client.callTool({
          name: "move_ticket",
          arguments: { id_or_key: smokeKey, project_key: dest.key },
        });
        const movedTicket = parseJson(moved) as { key?: string; project?: { key?: string } } | null;
        if (moved.isError) {
          logFail("move_ticket", extractText(moved));
        } else {
          const newKey = movedTicket?.key ?? smokeKey;
          logPass("move_ticket", `→ ${dest.key} (new key ${newKey})`);
          // Need destination project's closed status to land the close cleanly.
          const destStatuses = await client.callTool({
            name: "get_project_statuses",
            arguments: { project_key: dest.key },
          });
          const destStatusItems = parseJson(destStatuses) as Array<{
            id: string;
            category: string;
          }> | null;
          const destClosed = destStatusItems?.find((s) => s.category === "closed");
          if (destClosed) {
            await transitionToClosed(client, newKey, destClosed.id);
            return;
          }
          // Fall through to original-project transition if destination lacks closed.
        }
      }
    } else {
      console.log(`ℹ️  SKIP  move_ticket               only one project (${PROJECT_KEY}) — skipping cross-project move`);
    }

    await transitionToClosed(client, smokeKey, closedStatus.id);
  } finally {
    await client.close();
  }

  console.log("─".repeat(72));
  console.log(`${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("");
    for (const f of failures) console.log(`  ✗ ${f.tool}: ${f.reason}`);
    process.exit(failures.length);
  }
}

async function transitionToClosed(
  client: Client,
  key: string,
  closedStatusId: string,
): Promise<void> {
  const closed = await client.callTool({
    name: "transition_ticket",
    arguments: {
      id_or_key: key,
      status_id: closedStatusId,
      resolution: "done",
      comment: "smoke run complete",
    },
  });
  if (closed.isError) logFail("transition_ticket", extractText(closed));
  else logPass("transition_ticket", `${key} → closed (resolution=done)`);
}

function parseProjectArg(): string | undefined {
  const idx = process.argv.indexOf("--project");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

main().catch((err) => {
  console.error("smoke aborted:", err.message ?? err);
  process.exit(1);
});
