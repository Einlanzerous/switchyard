import { describe, expect, test, beforeAll } from "bun:test";
import { connectTestClient } from "./helpers.js";

beforeAll(() => {
  process.env.SWITCHYARD_TOKEN = "test-token";
  process.env.SWITCHYARD_URL = "http://test.local";
});

describe("query_my_open", () => {
  test("resolves /users/me then queries tickets and filters closed-category client-side", async () => {
    const calls: { url: string; method: string }[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = (input instanceof Request ? input.method : init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });

      if (url.includes("/v1/users/me")) {
        return new Response(
          JSON.stringify({ id: "u-claude", name: "claude", icon: null, type: "agent" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/v1/tickets")) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "t1",
                key: "SWY-1",
                number: 1,
                project: { id: "p1", key: "SWY", name: "Switchyard", color: null, repo_url: null },
                type: "task",
                title: "Open one",
                status: { id: "s1", category: "in_progress", display_name: "In progress" },
                resolution: null,
                priority: null,
                parent_id: null,
                assignee: { id: "u-claude", name: "claude", icon: null, type: "agent" },
                reporter: { id: "u-claude", name: "claude", icon: null, type: "agent" },
                due_date: null,
                labels: [],
                position: null,
                external_refs: [],
                template_id: null,
              },
              {
                id: "t2",
                key: "SWY-2",
                number: 2,
                project: { id: "p1", key: "SWY", name: "Switchyard", color: null, repo_url: null },
                type: "task",
                title: "Closed one",
                status: { id: "s2", category: "closed", display_name: "Done" },
                resolution: "done",
                priority: null,
                parent_id: null,
                assignee: { id: "u-claude", name: "claude", icon: null, type: "agent" },
                reporter: { id: "u-claude", name: "claude", icon: null, type: "agent" },
                due_date: null,
                labels: [],
                position: null,
                external_refs: [],
                template_id: null,
              },
            ],
            next_cursor: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not mocked", { status: 500 });
    }) as typeof fetch;

    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "query_my_open",
        arguments: { project: "SWY" },
      });
      expect(res.isError).toBeFalsy();

      // Should have called /users/me first, then /v1/tickets with assignee=u-claude
      expect(calls[0]!.url).toContain("/v1/users/me");
      const ticketsCall = calls.find((c) => c.url.includes("/v1/tickets"))!;
      expect(ticketsCall.url).toContain("assignee=u-claude");
      expect(ticketsCall.url).toContain("project=SWY");

      // Result should contain only the open ticket; closed one filtered out.
      const content = (res.content as Array<{ type: string; text: string }>)[0]!;
      const parsed = JSON.parse(content.text);
      expect(parsed.count).toBe(1);
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0].key).toBe("SWY-1");
    } finally {
      await close();
      globalThis.fetch = originalFetch;
    }
  });
});
