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
      body: {
        id: "p1",
        key: "SWY",
        name: "Switchyard",
        repo_url: null,
        default_test_cmd: "bun test",
      },
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
        default_test_cmd: "bun test",
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
          default_test_cmd: "bun test",
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
      expect(body.default_test_cmd).toBe("bun test");
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

describe("create_status", () => {
  test("POSTs /v1/projects/:key/statuses with the supplied body", async () => {
    const recorder = installFetchRecorder({
      status: 201,
      body: {
        id: "s-new",
        project_id: "p1",
        category: "in_progress",
        display_name: "Reviewing",
        position: 2,
        is_default: false,
      },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "create_status",
        arguments: {
          project_key: "SWY",
          category: "in_progress",
          display_name: "Reviewing",
          position: 2,
        },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toContain("/v1/projects/SWY/statuses");
      const body = call.body as Record<string, unknown>;
      expect(body.category).toBe("in_progress");
      expect(body.display_name).toBe("Reviewing");
      expect(body.position).toBe(2);
      expect(body.is_default).toBeUndefined();
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("rejects an invalid category at the schema layer", async () => {
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "create_status",
        arguments: {
          project_key: "SWY",
          category: "wip",
          display_name: "Reviewing",
        },
      });
      expect(res.isError).toBe(true);
    } finally {
      await close();
    }
  });

  test("surfaces 409 conflict envelope on duplicate display_name", async () => {
    const recorder = installFetchRecorder({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: 'status "Reviewing" already exists in this project',
        },
      },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "create_status",
        arguments: {
          project_key: "SWY",
          category: "in_progress",
          display_name: "Reviewing",
        },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("switchyard error [conflict]");
      expect(text).toContain('"Reviewing"');
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("update_status", () => {
  test("PATCHes /v1/projects/:key/statuses/:id with only supplied fields", async () => {
    const recorder = installFetchRecorder({
      body: {
        id: "s1",
        project_id: "p1",
        category: "backlog",
        display_name: "Inbox",
        position: 0,
        is_default: true,
      },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "update_status",
        arguments: {
          project_key: "SWY",
          status_id: "s1",
          display_name: "Inbox",
          is_default: true,
        },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("PATCH");
      expect(call.url).toContain("/v1/projects/SWY/statuses/s1");
      const body = call.body as Record<string, unknown>;
      expect(body.display_name).toBe("Inbox");
      expect(body.is_default).toBe(true);
      expect(body.category).toBeUndefined();
      expect(body.position).toBeUndefined();
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("delete_status", () => {
  test("calls DELETE /v1/projects/:key/statuses/:id", async () => {
    const recorder = installFetchRecorder({ status: 204, body: {} });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "delete_status",
        arguments: { project_key: "SWY", status_id: "s1" },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("DELETE");
      expect(call.url).toContain("/v1/projects/SWY/statuses/s1");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("surfaces 422 when the status is in use", async () => {
    const recorder = installFetchRecorder({
      status: 422,
      body: {
        error: {
          code: "unprocessable",
          message: "status is in use by 3 tickets",
        },
      },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "delete_status",
        arguments: { project_key: "SWY", status_id: "s1" },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("switchyard error [unprocessable]");
      expect(text).toContain("in use by 3 tickets");
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("create_label", () => {
  test("POSTs /v1/labels with name + color", async () => {
    const recorder = installFetchRecorder({
      status: 201,
      body: { id: "l-new", name: "il-6", color: "#a855f7" },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "create_label",
        arguments: { name: "il-6", color: "#a855f7" },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toContain("/v1/labels");
      const body = call.body as Record<string, unknown>;
      expect(body.name).toBe("il-6");
      expect(body.color).toBe("#a855f7");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("rejects a non-hex color at the schema layer", async () => {
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "create_label",
        arguments: { name: "bug", color: "red" },
      });
      expect(res.isError).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("update_label", () => {
  test("PATCHes /v1/labels/:id with only supplied fields", async () => {
    const recorder = installFetchRecorder({
      body: { id: "l1", name: "renamed", color: "#3b82f6" },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "update_label",
        arguments: { label_id: "l1", name: "renamed" },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("PATCH");
      expect(call.url).toContain("/v1/labels/l1");
      const body = call.body as Record<string, unknown>;
      expect(body.name).toBe("renamed");
      expect(body.color).toBeUndefined();
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("delete_label", () => {
  test("DELETE /v1/labels/:id with no force query by default", async () => {
    const recorder = installFetchRecorder({ status: 204, body: {} });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "delete_label",
        arguments: { label_id: "l1" },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("DELETE");
      expect(call.url).toContain("/v1/labels/l1");
      expect(call.url).not.toContain("force=");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("appends ?force=true when force is supplied", async () => {
    const recorder = installFetchRecorder({ status: 204, body: {} });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "delete_label",
        arguments: { label_id: "l1", force: true },
      });
      expect(res.isError).toBeFalsy();
      expect(recorder.calls[0]!.url).toContain("force=true");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("surfaces 422 when the label is in use and force was not passed", async () => {
    const recorder = installFetchRecorder({
      status: 422,
      body: {
        error: {
          code: "unprocessable",
          message: "label is in use by 4 tickets — re-issue with ?force=true to delete anyway",
        },
      },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "delete_label",
        arguments: { label_id: "l1" },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("switchyard error [unprocessable]");
      expect(text).toContain("in use by 4 tickets");
      expect(text).toContain("force=true");
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
