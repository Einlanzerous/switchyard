// Test harness for the switchyard MCP server. Builds an in-process
// client+server pair via the SDK's InMemoryTransport, lets each test
// substitute a fake fetch to capture outbound HTTP shape without
// needing the real backend.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.js";
import { __resetClientForTests } from "../src/client.js";

export interface FetchCall {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

export function installFetchRecorder(
  response: { status?: number; body: unknown },
): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url: string;
    let method: string;
    let bodyText: string | undefined;
    const headers: Record<string, string> = {};

    if (input instanceof Request) {
      url = input.url;
      method = input.method.toUpperCase();
      bodyText = await input.clone().text().catch(() => undefined);
      input.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else {
      url = typeof input === "string" ? input : input.toString();
      method = (init?.method ?? "GET").toUpperCase();
      if (init?.body && typeof init.body === "string") bodyText = init.body;
      const h = init?.headers;
      if (h && typeof h === "object" && !Array.isArray(h)) {
        for (const [k, v] of Object.entries(h)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
    }

    let body: unknown = undefined;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }

    calls.push({ url, method, body, headers });
    const status = response.status ?? 200;
    return new Response(JSON.stringify(response.body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

export async function connectTestClient(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  // Each test starts with a fresh openapi-fetch client so it picks up
  // the currently-installed fake fetch instead of one captured earlier.
  __resetClientForTests();

  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: "test-client", version: "0" },
    { capabilities: {} },
  );

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
