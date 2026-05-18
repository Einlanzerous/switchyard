import { describe, expect, test, beforeAll } from "bun:test";
import { connectTestClient, installFetchRecorder } from "./helpers.js";

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
