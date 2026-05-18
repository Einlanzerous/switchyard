// Env resolution for the MCP server. Two knobs:
//   SWITCHYARD_TOKEN — bearer token for the actor the MCP server runs as.
//     Mint per-agent (claude, n8n-cogitation, cline-magos, etc.) so the
//     audit log attributes correctly.
//   SWITCHYARD_URL — base URL of the switchyard API. Defaults to the
//     local construct-net deploy.
//
// Fail fast on missing config — a stdio MCP server that swallows config
// errors looks healthy but returns 401s on every tool call.

export type Env = {
  token: string;
  baseUrl: string;
};

export function loadEnv(): Env {
  const token = process.env.SWITCHYARD_TOKEN;
  if (!token) {
    throw new Error(
      "SWITCHYARD_TOKEN is required. Mint one against your switchyard instance via " +
        "POST /v1/users/{actor_id}/tokens and set it in your MCP client's env config.",
    );
  }
  const baseUrl = process.env.SWITCHYARD_URL ?? "http://localhost:4002";
  // Strip trailing slash so callers can concat /v1/... without doubling.
  return { token, baseUrl: baseUrl.replace(/\/+$/, "") };
}
