// URL→kind inference. Used by POST /v1/tickets/.../external-refs when
// the caller omits `kind`. Returns "generic" for anything that doesn't
// match a known GitHub pattern; callers can override by passing kind
// explicitly.

import type { ExternalRefKind } from "@switchyard/shared";

const GITHUB_PR_RE = /^https?:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+\/?(?:[?#].*)?$/i;
const GITHUB_ISSUE_RE = /^https?:\/\/github\.com\/[^\/]+\/[^\/]+\/issues\/\d+\/?(?:[?#].*)?$/i;
const GITHUB_COMMIT_RE = /^https?:\/\/github\.com\/[^\/]+\/[^\/]+\/commit\/[0-9a-f]{7,40}\/?(?:[?#].*)?$/i;
const GITHUB_ACTION_RE = /^https?:\/\/github\.com\/[^\/]+\/[^\/]+\/actions\/runs\/\d+\/?(?:[?#].*)?$/i;

export function detectKind(url: string): ExternalRefKind {
  if (GITHUB_PR_RE.test(url)) return "github_pr";
  if (GITHUB_ISSUE_RE.test(url)) return "github_issue";
  if (GITHUB_COMMIT_RE.test(url)) return "github_commit";
  if (GITHUB_ACTION_RE.test(url)) return "github_action";
  return "generic";
}

// Inverse: given a URL and an asserted kind, sanity-check that the URL
// looks right for that kind. `generic` accepts anything.
export function urlMatchesKind(url: string, kind: ExternalRefKind): boolean {
  switch (kind) {
    case "github_pr": return GITHUB_PR_RE.test(url);
    case "github_issue": return GITHUB_ISSUE_RE.test(url);
    case "github_commit": return GITHUB_COMMIT_RE.test(url);
    case "github_action": return GITHUB_ACTION_RE.test(url);
    case "generic": return true;
  }
}

// Parse `owner/repo/path` out of a GitHub URL so the poller can build
// the corresponding REST API URL without re-running regexes.
export function parseGitHubUrl(url: string): { owner: string; repo: string; rest: string } | null {
  const m = url.match(/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/(.+?)\/?(?:[?#].*)?$/i);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, rest: m[3]! };
}
