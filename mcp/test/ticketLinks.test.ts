import { describe, expect, test, beforeAll } from "bun:test";
import { connectTestClient, installFetchRecorder } from "./helpers.js";

beforeAll(() => {
  process.env.SWITCHYARD_TOKEN = "test-token";
  process.env.SWITCHYARD_URL = "http://test.local";
});

const SAMPLE_LINK = {
  id: "link-uuid-1",
  type: "blocks",
  direction: "outgoing",
  other_ticket: { id: "t2", key: "LOOP-7", title: "Cogitation halts on missing test_cmd" },
  created_at: "2026-05-26T00:00:00.000Z",
  created_by: { id: "u1", name: "claude", icon: null, type: "agent" },
};

describe("list_ticket_links", () => {
  test("calls GET /v1/tickets/:idOrKey/links with the key in the path", async () => {
    const recorder = installFetchRecorder({
      body: { items: [SAMPLE_LINK] },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "list_ticket_links",
        arguments: { id_or_key: "SWY-1" },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("GET");
      expect(call.url).toContain("/v1/tickets/SWY-1/links");
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      const parsed = JSON.parse(text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].direction).toBe("outgoing");
      expect(parsed[0].other_ticket.key).toBe("LOOP-7");
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("create_ticket_link", () => {
  test("POSTs cross-project link with the source key in the path and target in the body", async () => {
    const recorder = installFetchRecorder({ status: 201, body: SAMPLE_LINK });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "create_ticket_link",
        arguments: {
          source_id_or_key: "SWY-1",
          target_id_or_key: "LOOP-7",
          type: "blocks",
        },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toContain("/v1/tickets/SWY-1/links");
      const body = call.body as Record<string, unknown>;
      expect(body.type).toBe("blocks");
      expect(body.target).toBe("LOOP-7");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("surfaces 409 conflict envelope on duplicate edge", async () => {
    const recorder = installFetchRecorder({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "link already exists: blocks between these tickets",
        },
      },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "create_ticket_link",
        arguments: {
          source_id_or_key: "SWY-1",
          target_id_or_key: "LOOP-7",
          type: "blocks",
        },
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

  test("rejects an invalid type at the schema layer before fetching", async () => {
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "create_ticket_link",
        arguments: {
          source_id_or_key: "SWY-1",
          target_id_or_key: "LOOP-7",
          type: "depends_on",
        },
      });
      expect(res.isError).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("delete_ticket_link", () => {
  test("calls DELETE /v1/tickets/links/{id} with the supplied UUID", async () => {
    const recorder = installFetchRecorder({ status: 204, body: {} });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "delete_ticket_link",
        arguments: { link_id: "link-uuid-1" },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("DELETE");
      expect(call.url).toContain("/v1/tickets/links/link-uuid-1");
    } finally {
      await close();
      recorder.restore();
    }
  });
});
