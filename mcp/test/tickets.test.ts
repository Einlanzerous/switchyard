import { describe, expect, test, beforeAll } from "bun:test";
import {
  connectTestClient,
  installFetchRecorder,
  installFetchRouter,
} from "./helpers.js";

beforeAll(() => {
  process.env.SWITCHYARD_TOKEN = "test-token";
  process.env.SWITCHYARD_URL = "http://test.local";
});

const SAMPLE_TICKET = {
  id: "t1",
  key: "SWY-1",
  number: 1,
  project: { id: "p1", key: "SWY", name: "Switchyard", color: null, repo_url: null },
  type: "task",
  title: "Sample",
  status: { id: "s1", category: "backlog", display_name: "Backlog" },
  resolution: null,
  priority: null,
  parent_id: null,
  assignee: null,
  reporter: { id: "u1", name: "claude", icon: null, type: "agent" },
  due_date: null,
  labels: [],
  position: null,
  external_refs: [],
  template_id: null,
  description: "",
  metadata: {},
  comments: [],
};

describe("list_tickets", () => {
  test("calls GET /v1/tickets with all supplied filters in the query string", async () => {
    const recorder = installFetchRecorder({ body: { items: [], next_cursor: null } });
    const { client, close } = await connectTestClient();
    try {
      await client.callTool({
        name: "list_tickets",
        arguments: {
          project: "SWY",
          status: "in_progress",
          sort_by: "due_date",
          sort_order: "asc",
          due: "this_week",
          limit: 25,
        },
      });
      const url = recorder.calls[0]!.url;
      expect(recorder.calls[0]!.method).toBe("GET");
      expect(url).toContain("/v1/tickets");
      expect(url).toContain("project=SWY");
      expect(url).toContain("status=in_progress");
      expect(url).toContain("sort_by=due_date");
      expect(url).toContain("sort_order=asc");
      expect(url).toContain("due=this_week");
      expect(url).toContain("limit=25");
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("get_ticket", () => {
  test("calls GET /v1/tickets/:idOrKey with the key in the path", async () => {
    const recorder = installFetchRecorder({ body: SAMPLE_TICKET });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "get_ticket",
        arguments: { id_or_key: "SWY-1" },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("GET");
      expect(call.url).toContain("/v1/tickets/SWY-1");
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("create_ticket", () => {
  test("POSTs /v1/tickets with the supplied body", async () => {
    const recorder = installFetchRecorder({ status: 201, body: SAMPLE_TICKET });
    const { client, close } = await connectTestClient();
    try {
      await client.callTool({
        name: "create_ticket",
        arguments: {
          project_key: "SWY",
          type: "bug",
          title: "Login broken",
          description: "Repro: click sign in",
          priority: "high",
        },
      });
      const call = recorder.calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toContain("/v1/tickets");
      expect(call.body).toEqual({
        project_key: "SWY",
        type: "bug",
        title: "Login broken",
        description: "Repro: click sign in",
        priority: "high",
      });
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("update_ticket", () => {
  test("PATCHes /v1/tickets/:idOrKey with the patch body (no id_or_key in body)", async () => {
    const recorder = installFetchRecorder({ body: SAMPLE_TICKET });
    const { client, close } = await connectTestClient();
    try {
      await client.callTool({
        name: "update_ticket",
        arguments: {
          id_or_key: "SWY-1",
          title: "New title",
          priority: "critical",
        },
      });
      const call = recorder.calls[0]!;
      expect(call.method).toBe("PATCH");
      expect(call.url).toContain("/v1/tickets/SWY-1");
      expect(call.body).toEqual({ title: "New title", priority: "critical" });
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("transition_ticket", () => {
  test("POSTs /v1/tickets/:idOrKey/transition with status_id, resolution, and comment", async () => {
    const recorder = installFetchRecorder({ body: SAMPLE_TICKET });
    const { client, close } = await connectTestClient();
    try {
      await client.callTool({
        name: "transition_ticket",
        arguments: {
          id_or_key: "SWY-1",
          status_id: "s-closed",
          resolution: "done",
          comment: "merged in PR #123",
        },
      });
      const call = recorder.calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toContain("/v1/tickets/SWY-1/transition");
      expect(call.body).toEqual({
        status_id: "s-closed",
        resolution: "done",
        comment: "merged in PR #123",
      });
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("comment_on_ticket", () => {
  test("POSTs /v1/tickets/:idOrKey/comments with {body}", async () => {
    const recorder = installFetchRecorder({
      status: 201,
      body: { id: "c1", ticket_id: "t1", body: "hi" },
    });
    const { client, close } = await connectTestClient();
    try {
      await client.callTool({
        name: "comment_on_ticket",
        arguments: { id_or_key: "SWY-1", body: "looks good" },
      });
      const call = recorder.calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toContain("/v1/tickets/SWY-1/comments");
      expect(call.body).toEqual({ body: "looks good" });
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("move_ticket", () => {
  test("POSTs /v1/tickets/:idOrKey/move with project_key + optional fields", async () => {
    const recorder = installFetchRecorder({ body: SAMPLE_TICKET });
    const { client, close } = await connectTestClient();
    try {
      await client.callTool({
        name: "move_ticket",
        arguments: {
          id_or_key: "INCUBATOR-3",
          project_key: "NEWREPO",
          status_id: "s-backlog",
        },
      });
      const call = recorder.calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toContain("/v1/tickets/INCUBATOR-3/move");
      expect(call.body).toEqual({
        project_key: "NEWREPO",
        status_id: "s-backlog",
      });
    } finally {
      await close();
      recorder.restore();
    }
  });
});

// Error-path coverage: each tool surfaces switchyard's `{error:{code,message}}`
// envelope through formatApiError as `switchyard error [<code>]: <message>`
// and sets isError on the tool result. One representative error code per tool
// — mixing 401 / 404 / 409 / 422 / 500 so the helper is exercised across the
// full envelope-emitting range.
describe("error paths", () => {
  test("list_tickets surfaces 401 unauthorized", async () => {
    const recorder = installFetchRecorder({
      status: 401,
      body: { error: { code: "unauthorized", message: "missing or invalid token" } },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({ name: "list_tickets", arguments: {} });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("switchyard error [unauthorized]");
      expect(text).toContain("missing or invalid token");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("get_ticket surfaces 404 not_found", async () => {
    const recorder = installFetchRecorder({
      status: 404,
      body: { error: { code: "not_found", message: "ticket SWY-99999 not found" } },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "get_ticket",
        arguments: { id_or_key: "SWY-99999" },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("switchyard error [not_found]");
      expect(text).toContain("ticket SWY-99999 not found");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("create_ticket surfaces 422 unprocessable", async () => {
    const recorder = installFetchRecorder({
      status: 422,
      body: { error: { code: "unprocessable", message: "title is required" } },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "create_ticket",
        arguments: { project_key: "SWY", type: "task", title: "" },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("switchyard error [unprocessable]");
      expect(text).toContain("title is required");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("update_ticket surfaces 404 not_found", async () => {
    const recorder = installFetchRecorder({
      status: 404,
      body: { error: { code: "not_found", message: "ticket NOPE-1 not found" } },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "update_ticket",
        arguments: { id_or_key: "NOPE-1", title: "x" },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("switchyard error [not_found]");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("transition_ticket surfaces 422 (resolution required on close)", async () => {
    const recorder = installFetchRecorder({
      status: 422,
      body: {
        error: {
          code: "unprocessable",
          message: "resolution is required when target status category is closed",
        },
      },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "transition_ticket",
        arguments: { id_or_key: "SWY-1", status_id: "s-closed" },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("switchyard error [unprocessable]");
      expect(text).toContain("resolution is required");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("comment_on_ticket surfaces 404 not_found", async () => {
    const recorder = installFetchRecorder({
      status: 404,
      body: { error: { code: "not_found", message: "ticket SWY-9 not found" } },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "comment_on_ticket",
        arguments: { id_or_key: "SWY-9", body: "x" },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("switchyard error [not_found]");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("move_ticket surfaces 409 conflict (destination key exists)", async () => {
    const recorder = installFetchRecorder({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "destination project NEWREPO has no compatible status",
        },
      },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "move_ticket",
        arguments: { id_or_key: "INCUBATOR-3", project_key: "NEWREPO" },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("switchyard error [conflict]");
    } finally {
      await close();
      recorder.restore();
    }
  });

  describe("list_tickets multi-status + open shortcut (SWY-65)", () => {
    test("serializes array status as comma-separated", async () => {
      const recorder = installFetchRecorder({ body: { items: [] } });
      const { client, close } = await connectTestClient();
      try {
        await client.callTool({
          name: "list_tickets",
          arguments: { status: ["in_progress", "blocked"] },
        });
        const url = recorder.calls[0]!.url;
        expect(url).toContain("status=in_progress%2Cblocked");
      } finally {
        await close();
        recorder.restore();
      }
    });

    test("`open: true` expands to all four non-closed categories", async () => {
      const recorder = installFetchRecorder({ body: { items: [] } });
      const { client, close } = await connectTestClient();
      try {
        await client.callTool({
          name: "list_tickets",
          arguments: { open: true },
        });
        const url = recorder.calls[0]!.url;
        expect(url).toContain("status=backlog%2Cplanning%2Cin_progress%2Cblocked");
      } finally {
        await close();
        recorder.restore();
      }
    });

    test("rejects open + status together", async () => {
      const recorder = installFetchRecorder({ body: { items: [] } });
      const { client, close } = await connectTestClient();
      try {
        const res = await client.callTool({
          name: "list_tickets",
          arguments: { open: true, status: "backlog" },
        });
        expect(res.isError).toBe(true);
        expect(recorder.calls).toHaveLength(0); // no HTTP fired
      } finally {
        await close();
        recorder.restore();
      }
    });
  });

  describe("update_ticket null clears (SWY-65)", () => {
    test("passes assignee_id: null through to PATCH body", async () => {
      const recorder = installFetchRecorder({ body: { ...SAMPLE_TICKET, assignee: null } });
      const { client, close } = await connectTestClient();
      try {
        await client.callTool({
          name: "update_ticket",
          arguments: { id_or_key: "SWY-1", assignee_id: null },
        });
        const call = recorder.calls[0]!;
        expect(call.method).toBe("PATCH");
        const body = call.body as Record<string, unknown>;
        expect(body.assignee_id).toBeNull();
      } finally {
        await close();
        recorder.restore();
      }
    });

    test("passes due_date: null and parent_id: null through", async () => {
      const recorder = installFetchRecorder({ body: SAMPLE_TICKET });
      const { client, close } = await connectTestClient();
      try {
        await client.callTool({
          name: "update_ticket",
          arguments: { id_or_key: "SWY-1", due_date: null, parent_id: null },
        });
        const body = recorder.calls[0]!.body as Record<string, unknown>;
        expect(body.due_date).toBeNull();
        expect(body.parent_id).toBeNull();
      } finally {
        await close();
        recorder.restore();
      }
    });
  });

  describe("transition_ticket_by_category (SWY-65)", () => {
    test("happy path: fetches ticket → statuses → transitions", async () => {
      const router = installFetchRouter([
        {
          match: (url, method) => method === "GET" && url.includes("/v1/tickets/SWY-1") && !url.includes("/comments"),
          body: SAMPLE_TICKET,
        },
        {
          match: "/v1/projects/SWY/statuses",
          body: {
            items: [
              { id: "st-backlog", category: "backlog", display_name: "Backlog" },
              { id: "st-closed", category: "closed", display_name: "Closed" },
            ],
          },
        },
        {
          match: "/v1/tickets/SWY-1/transition",
          body: { ...SAMPLE_TICKET, status: { id: "st-closed", category: "closed", display_name: "Closed" }, resolution: "done" },
        },
      ]);
      const { client, close } = await connectTestClient();
      try {
        const res = await client.callTool({
          name: "transition_ticket_by_category",
          arguments: {
            id_or_key: "SWY-1",
            category: "closed",
            resolution: "done",
            comment: "shipped",
          },
        });
        expect(res.isError).toBeFalsy();
        const calls = router.calls;
        expect(calls).toHaveLength(3);
        expect(calls[2]!.method).toBe("POST");
        expect(calls[2]!.url).toContain("/v1/tickets/SWY-1/transition");
        const body = calls[2]!.body as Record<string, unknown>;
        expect(body.status_id).toBe("st-closed");
        expect(body.resolution).toBe("done");
        expect(body.comment).toBe("shipped");
      } finally {
        await close();
        router.restore();
      }
    });

    test("ambiguity: multiple statuses in same category → error, no transition", async () => {
      const router = installFetchRouter([
        {
          match: (url, method) => method === "GET" && url.includes("/v1/tickets/SWY-1") && !url.includes("/comments"),
          body: SAMPLE_TICKET,
        },
        {
          match: "/v1/projects/SWY/statuses",
          body: {
            items: [
              { id: "st-shipped", category: "closed", display_name: "Shipped" },
              { id: "st-rejected", category: "closed", display_name: "Rejected" },
            ],
          },
        },
      ]);
      const { client, close } = await connectTestClient();
      try {
        const res = await client.callTool({
          name: "transition_ticket_by_category",
          arguments: { id_or_key: "SWY-1", category: "closed", resolution: "done" },
        });
        expect(res.isError).toBe(true);
        const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
        expect(text).toContain("2 statuses");
        expect(text).toContain("transition_ticket");
        // Crucially: no POST to /transition fired.
        expect(router.calls.find((c) => c.url.includes("/transition"))).toBeUndefined();
      } finally {
        await close();
        router.restore();
      }
    });

    test("missing category: surfaces a clear error", async () => {
      const router = installFetchRouter([
        {
          match: (url, method) => method === "GET" && url.includes("/v1/tickets/SWY-1") && !url.includes("/comments"),
          body: SAMPLE_TICKET,
        },
        {
          match: "/v1/projects/SWY/statuses",
          body: {
            items: [
              { id: "st-backlog", category: "backlog", display_name: "Backlog" },
            ],
          },
        },
      ]);
      const { client, close } = await connectTestClient();
      try {
        const res = await client.callTool({
          name: "transition_ticket_by_category",
          arguments: { id_or_key: "SWY-1", category: "closed", resolution: "done" },
        });
        expect(res.isError).toBe(true);
        const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
        expect(text).toContain("no status with category 'closed'");
      } finally {
        await close();
        router.restore();
      }
    });
  });

  describe("get_ticket_comments (SWY-65)", () => {
    test("calls GET /v1/tickets/{id}/comments with pagination params", async () => {
      const recorder = installFetchRecorder({
        body: {
          items: [
            { id: "c1", body: "first", author: { id: "u1", name: "magos", type: "human" } },
          ],
          page: { next_cursor: "abc", has_more: true },
        },
      });
      const { client, close } = await connectTestClient();
      try {
        const res = await client.callTool({
          name: "get_ticket_comments",
          arguments: { id_or_key: "SWY-1", limit: 10 },
        });
        expect(res.isError).toBeFalsy();
        const call = recorder.calls[0]!;
        expect(call.method).toBe("GET");
        expect(call.url).toContain("/v1/tickets/SWY-1/comments");
        expect(call.url).toContain("limit=10");
      } finally {
        await close();
        recorder.restore();
      }
    });
  });

  test("formatApiError falls back when envelope is malformed", async () => {
    const recorder = installFetchRecorder({
      status: 500,
      body: { unexpected: "shape" },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({ name: "list_tickets", arguments: {} });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("switchyard error [unknown_error]");
      expect(text).toContain("(no message)");
    } finally {
      await close();
      recorder.restore();
    }
  });
});

