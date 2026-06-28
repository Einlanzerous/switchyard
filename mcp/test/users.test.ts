import { describe, expect, test, beforeAll } from "bun:test";
import { connectTestClient, installFetchRecorder } from "./helpers.js";

beforeAll(() => {
  process.env.SWITCHYARD_TOKEN = "test-token";
  process.env.SWITCHYARD_URL = "http://test.local";
});

function textOf(res: unknown): string {
  return ((res as { content: Array<{ type: string; text: string }> }).content)[0]!.text;
}

describe("list_users", () => {
  test("GET /v1/users and unwraps items", async () => {
    const recorder = installFetchRecorder({
      body: {
        items: [
          { id: "u1", name: "magos", type: "human", instance_role: "owner" },
          { id: "u2", name: "claude", type: "agent", instance_role: "member" },
        ],
        page: { next_cursor: null, has_more: false },
      },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({ name: "list_users", arguments: {} });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("GET");
      expect(call.url).toContain("/v1/users");
      expect(call.headers["authorization"]).toBe("Bearer test-token");
      const parsed = JSON.parse(textOf(res));
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("forwards cursor + limit as query params", async () => {
    const recorder = installFetchRecorder({ body: { items: [], page: {} } });
    const { client, close } = await connectTestClient();
    try {
      await client.callTool({
        name: "list_users",
        arguments: { cursor: "abc", limit: 50 },
      });
      const url = recorder.calls[0]!.url;
      expect(url).toContain("cursor=abc");
      expect(url).toContain("limit=50");
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("create_user", () => {
  test("POSTs /v1/users with the supplied body", async () => {
    const recorder = installFetchRecorder({
      status: 201,
      body: { id: "u-new", name: "kglawrence", type: "human", instance_role: "owner" },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "create_user",
        arguments: { name: "kglawrence", type: "human", instance_role: "owner" },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toContain("/v1/users");
      const body = call.body as Record<string, unknown>;
      expect(body.name).toBe("kglawrence");
      expect(body.type).toBe("human");
      expect(body.instance_role).toBe("owner");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("rejects an invalid type at the schema layer (no HTTP call)", async () => {
    const recorder = installFetchRecorder({ body: {} });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "create_user",
        arguments: { name: "x", type: "robot" },
      });
      expect(res.isError).toBe(true);
      expect(recorder.calls).toHaveLength(0);
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("update_user", () => {
  test("PATCHes /v1/users/:id with only supplied fields; id stays out of body", async () => {
    const recorder = installFetchRecorder({
      body: { id: "u1", name: "magos", type: "human", instance_role: "member" },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "update_user",
        arguments: { user_id: "u1", instance_role: "member" },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("PATCH");
      expect(call.url).toContain("/v1/users/u1");
      const body = call.body as Record<string, unknown>;
      expect(body.user_id).toBeUndefined();
      expect(body.instance_role).toBe("member");
      expect(body.name).toBeUndefined();
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("surfaces 422 when demoting the last owner", async () => {
    const recorder = installFetchRecorder({
      status: 422,
      body: { error: { code: "unprocessable", message: "cannot demote the last instance owner" } },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "update_user",
        arguments: { user_id: "u1", instance_role: "member" },
      });
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text).toContain("switchyard error [unprocessable]");
      expect(text).toContain("last instance owner");
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("delete_user", () => {
  test("refuses without confirm:true and makes no HTTP call", async () => {
    const recorder = installFetchRecorder({ status: 204, body: {} });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "delete_user",
        arguments: { user_id: "u1" },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("confirm: true");
      expect(recorder.calls).toHaveLength(0);
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("DELETEs /v1/users/:id when confirm:true", async () => {
    const recorder = installFetchRecorder({ status: 204, body: {} });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "delete_user",
        arguments: { user_id: "u1", confirm: true },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("DELETE");
      expect(call.url).toContain("/v1/users/u1");
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("list_user_tokens", () => {
  test("GET /v1/users/:id/tokens and unwraps items", async () => {
    const recorder = installFetchRecorder({
      body: {
        items: [
          { id: "t1", user_id: "u1", name: "cli", kind: "personal", scopes: ["admin"] },
        ],
      },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "list_user_tokens",
        arguments: { user_id: "u1" },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("GET");
      expect(call.url).toContain("/v1/users/u1/tokens");
      const parsed = JSON.parse(textOf(res));
      expect(parsed).toHaveLength(1);
      // Metadata only — never a secret.
      expect(parsed[0].token).toBeUndefined();
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("create_user_token", () => {
  test("POSTs /v1/users/:id/tokens and surfaces the once-only plaintext", async () => {
    const recorder = installFetchRecorder({
      status: 201,
      body: {
        id: "t-new",
        user_id: "u1",
        name: "kglawrence-cli",
        kind: "personal",
        scopes: ["tickets:read", "tickets:write"],
        token: "sw_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
      },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "create_user_token",
        arguments: {
          user_id: "u1",
          name: "kglawrence-cli",
          scopes: ["tickets:read", "tickets:write"],
        },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toContain("/v1/users/u1/tokens");
      const body = call.body as Record<string, unknown>;
      expect(body.name).toBe("kglawrence-cli");
      expect(body.scopes).toEqual(["tickets:read", "tickets:write"]);
      const text = textOf(res);
      // Surfaces the plaintext + a shown-once warning.
      expect(text).toContain("sw_ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
      expect(text).toContain("ONCE");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("rejects an unknown scope at the schema layer (no HTTP call)", async () => {
    const recorder = installFetchRecorder({ body: {} });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "create_user_token",
        arguments: { user_id: "u1", name: "x", scopes: ["everything"] },
      });
      expect(res.isError).toBe(true);
      expect(recorder.calls).toHaveLength(0);
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("revoke_user_token", () => {
  test("refuses without confirm:true and makes no HTTP call", async () => {
    const recorder = installFetchRecorder({ status: 204, body: {} });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "revoke_user_token",
        arguments: { user_id: "u1", token_id: "t1" },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("confirm: true");
      expect(recorder.calls).toHaveLength(0);
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("DELETEs /v1/users/:id/tokens/:tokenId when confirm:true", async () => {
    const recorder = installFetchRecorder({ status: 204, body: {} });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "revoke_user_token",
        arguments: { user_id: "u1", token_id: "t1", confirm: true },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("DELETE");
      expect(call.url).toContain("/v1/users/u1/tokens/t1");
    } finally {
      await close();
      recorder.restore();
    }
  });
});
