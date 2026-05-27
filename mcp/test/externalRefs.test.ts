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

const SAMPLE_REF = {
  id: "ref-uuid-1",
  ticket_id: "ticket-uuid-1",
  kind: "github_pr",
  url: "https://github.com/Einlanzerous/switchyard/pull/57",
  state: "merged",
  title: "feat: SWY-75 — project-level default_test_cmd",
  polled_at: "2026-05-26T03:47:59.596Z",
  polled_state_changed_at: "2026-05-26T03:47:59.596Z",
  created_at: "2026-05-26T03:30:59.896Z",
  created_by: { id: "u1", name: "claude", icon: null, type: "agent" },
};

describe("list_external_refs", () => {
  test("calls GET /v1/tickets/:idOrKey/external-refs with the key in the path", async () => {
    const recorder = installFetchRecorder({ body: { items: [SAMPLE_REF] } });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "list_external_refs",
        arguments: { id_or_key: "SWY-75" },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("GET");
      expect(call.url).toContain("/v1/tickets/SWY-75/external-refs");
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      const parsed = JSON.parse(text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].kind).toBe("github_pr");
      expect(parsed[0].id).toBe("ref-uuid-1");
    } finally {
      await close();
      recorder.restore();
    }
  });
});

describe("attach_external_ref", () => {
  test("POSTs the URL to the ticket's external-refs endpoint", async () => {
    const recorder = installFetchRecorder({ status: 201, body: SAMPLE_REF });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "attach_external_ref",
        arguments: {
          id_or_key: "SWY-75",
          url: "https://github.com/Einlanzerous/switchyard/pull/57",
        },
      });
      expect(res.isError).toBeFalsy();
      const call = recorder.calls[0]!;
      expect(call.method).toBe("POST");
      expect(call.url).toContain("/v1/tickets/SWY-75/external-refs");
      const body = call.body as Record<string, unknown>;
      expect(body.url).toBe("https://github.com/Einlanzerous/switchyard/pull/57");
      // kind omitted → server-side inference, do not send the field
      expect(body.kind).toBeUndefined();
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("forwards an explicit kind override in the body", async () => {
    const recorder = installFetchRecorder({ status: 201, body: SAMPLE_REF });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "attach_external_ref",
        arguments: {
          id_or_key: "SWY-75",
          url: "https://example.com/runbook",
          kind: "generic",
        },
      });
      expect(res.isError).toBeFalsy();
      const body = recorder.calls[0]!.body as Record<string, unknown>;
      expect(body.kind).toBe("generic");
      expect(body.url).toBe("https://example.com/runbook");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("surfaces 409 conflict envelope on duplicate URL", async () => {
    const recorder = installFetchRecorder({
      status: 409,
      body: {
        error: {
          code: "conflict",
          message: "this ticket already has an external ref with that URL",
        },
      },
    });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "attach_external_ref",
        arguments: {
          id_or_key: "SWY-75",
          url: "https://github.com/Einlanzerous/switchyard/pull/57",
        },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("switchyard error [conflict]");
      expect(text).toContain("already has an external ref");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("rejects an invalid kind at the schema layer before fetching", async () => {
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "attach_external_ref",
        arguments: {
          id_or_key: "SWY-75",
          url: "https://example.com",
          kind: "github_pull_request",
        },
      });
      expect(res.isError).toBe(true);
    } finally {
      await close();
    }
  });

  test("rejects a non-URL string at the schema layer", async () => {
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "attach_external_ref",
        arguments: {
          id_or_key: "SWY-75",
          url: "not-a-url",
        },
      });
      expect(res.isError).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("detach_external_ref", () => {
  test("ref_id form: calls DELETE /v1/tickets/external-refs/:id directly", async () => {
    const recorder = installFetchRecorder({ status: 204, body: {} });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "detach_external_ref",
        arguments: { ref_id: "ref-uuid-1" },
      });
      expect(res.isError).toBeFalsy();
      expect(recorder.calls).toHaveLength(1);
      const call = recorder.calls[0]!;
      expect(call.method).toBe("DELETE");
      expect(call.url).toContain("/v1/tickets/external-refs/ref-uuid-1");
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("(id_or_key, url) form: GETs list, finds the ref by URL, then DELETEs by id", async () => {
    const router = installFetchRouter([
      { match: "/external-refs/ref-uuid-1", status: 204, body: {} },
      {
        match: (url, method) =>
          method === "GET" && url.includes("/v1/tickets/SWY-75/external-refs"),
        body: { items: [SAMPLE_REF] },
      },
    ]);
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "detach_external_ref",
        arguments: {
          id_or_key: "SWY-75",
          url: "https://github.com/Einlanzerous/switchyard/pull/57",
        },
      });
      expect(res.isError).toBeFalsy();
      expect(router.calls).toHaveLength(2);
      expect(router.calls[0]!.method).toBe("GET");
      expect(router.calls[0]!.url).toContain("/v1/tickets/SWY-75/external-refs");
      expect(router.calls[1]!.method).toBe("DELETE");
      expect(router.calls[1]!.url).toContain("/v1/tickets/external-refs/ref-uuid-1");
    } finally {
      await close();
      router.restore();
    }
  });

  test("(id_or_key, url) form: surfaces not_found when no ref matches the URL", async () => {
    const recorder = installFetchRecorder({ body: { items: [] } });
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "detach_external_ref",
        arguments: {
          id_or_key: "SWY-75",
          url: "https://github.com/Einlanzerous/switchyard/pull/999",
        },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("not_found");
      expect(text).toContain("/pull/999");
      // Should NOT have made a DELETE call — the lookup found nothing
      expect(recorder.calls.every((c) => c.method !== "DELETE")).toBe(true);
    } finally {
      await close();
      recorder.restore();
    }
  });

  test("rejects when neither ref_id nor (id_or_key, url) is supplied", async () => {
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "detach_external_ref",
        arguments: {},
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("supply exactly one");
    } finally {
      await close();
    }
  });

  test("rejects when both ref_id and (id_or_key, url) are supplied", async () => {
    const { client, close } = await connectTestClient();
    try {
      const res = await client.callTool({
        name: "detach_external_ref",
        arguments: {
          ref_id: "ref-uuid-1",
          id_or_key: "SWY-75",
          url: "https://github.com/Einlanzerous/switchyard/pull/57",
        },
      });
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain("supply exactly one");
    } finally {
      await close();
    }
  });
});
