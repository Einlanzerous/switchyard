import { describe, expect, test, beforeAll } from "bun:test";
import { connectTestClient, installFetchRecorder } from "./helpers.js";

beforeAll(() => {
  process.env.SWITCHYARD_TOKEN = "test-token";
  process.env.SWITCHYARD_URL = "http://test.local";
});

describe("list_projects", () => {
  test("calls GET /v1/projects with default include_archived=false", async () => {
    const recorder = installFetchRecorder({
      body: { items: [{ id: "p1", key: "SWY", name: "Switchyard" }] },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({ name: "list_projects", arguments: {} });
      expect(res.isError).toBeFalsy();
      expect(recorder.calls).toHaveLength(1);
      const call = recorder.calls[0]!;
      expect(call.method).toBe("GET");
      expect(call.url).toContain("/v1/projects");
      expect(call.url).toContain("include_archived=false");
      expect(call.headers["authorization"]).toBe("Bearer test-token");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("passes include_archived=true when requested", async () => {
    const recorder = installFetchRecorder({ body: { items: [] } });
    const { client, close } = await connectTestClient();
    try {
      await client.callTool({
        name: "list_projects",
        arguments: { include_archived: true },
      });
      expect(recorder.calls[0]!.url).toContain("include_archived=true");
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("get_project", () => {
  test("calls GET /v1/projects/:key with the project key in the path", async () => {
    const recorder = installFetchRecorder({
      body: { id: "p1", key: "SWY", name: "Switchyard", repo_url: null },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "get_project",
        arguments: { project_key: "SWY" },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("GET");
      expect(call.url).toContain("/v1/projects/SWY");
      expect(call.url).not.toContain("/statuses");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("rejects malformed keys at the schema layer", async () => {
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "get_project",
        arguments: { project_key: "sw y" },
      });
      // Zod validation runs server-side before fetch — no HTTP call should fire.
      expect(res.isError).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("create_project", () => {
  test("POSTs /v1/projects with the supplied body", async () => {
    const recorder = installFetchRecorder({
      body: {
        id: "new-uuid",
        key: "FLOW",
        name: "Flow Project",
        description: "test",
        color: null,
        repo_url: "https://github.com/foo/flow",
        archived_at: null,
      },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "create_project",
        arguments: {
          key: "FLOW",
          name: "Flow Project",
          description: "test",
          repo_url: "https://github.com/foo/flow",
        },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toContain("/v1/projects");
      const body = call.body as Record<string, unknown>;
      expect(body.key).toBe("FLOW");
      expect(body.name).toBe("Flow Project");
      expect(body.repo_url).toBe("https://github.com/foo/flow");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("surfaces 409 conflict envelope on duplicate key", async () => {
    const recorder = installFetchRecorder({
      status: 409,
      body: { error: { code: "conflict", message: "project key SWY already exists" } },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "create_project",
        arguments: { key: "SWY", name: "Switchyard" },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("switchyard error [conflict]");
      expect(text).toContain("already exists");
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("list_labels", () => {
  test("calls GET /v1/labels and unwraps items", async () => {
    const recorder = installFetchRecorder({
      body: {
        items: [
          { id: "l1", name: "bug", color: "#ef4444" },
          { id: "l2", name: "docs", color: "#3b82f6" },
        ],
      },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({ name: "list_labels", arguments: {} });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("GET");
      expect(call.url).toContain("/v1/labels");
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      const parsed = JSON.parse(text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("get_project_statuses", () => {
  test("calls GET /v1/projects/:key/statuses with the project key in the path", async () => {
    const recorder = installFetchRecorder({
      body: {
        items: [
          { id: "s1", category: "backlog", display_name: "Backlog" },
          { id: "s2", category: "closed", display_name: "Done" },
        ],
      },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "get_project_statuses",
        arguments: { project_key: "SWY" },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("GET");
      expect(call.url).toContain("/v1/projects/SWY/statuses");
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("error paths", () => {
  test("list_projects surfaces 401 unauthorized envelope", async () => {
    const recorder = installFetchRecorder({
      status: 401,
      body: { error: { code: "unauthorized", message: "missing or invalid token" } },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({ name: "list_projects", arguments: {} });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("switchyard error [unauthorized]");
      expect(text).toContain("missing or invalid token");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("get_project_statuses surfaces 404 not_found envelope", async () => {
    const recorder = installFetchRecorder({
      status: 404,
      body: { error: { code: "not_found", message: "project NOPE not found" } },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "get_project_statuses",
        arguments: { project_key: "NOPE" },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("switchyard error [not_found]");
      expect(text).toContain("project NOPE not found");
    } finally {
      await close();
      recorder.restore();
    }
  });
});
