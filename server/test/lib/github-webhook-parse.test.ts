// Pure-function tests for the GitHub webhook key parsers. No DB needed, so
// these run in CI's `test:unit` (unlike the DB-backed handler tests in
// test/integration/external-github-webhook.test.ts).
//
//   bun --cwd server test test/lib/github-webhook-parse.test.ts

import { describe, expect, test } from "bun:test";
import {
  parseKeyMentions,
  parseClosingKeyMentions,
} from "../../src/lib/externalRefs/parseKeys.js";

describe("parseKeyMentions (title / branch — bare keys)", () => {
  test("matches PR-title and branch-name patterns with the configured prefix", () => {
    expect(parseKeyMentions("[SWY-42] Fix the thing", "SWY")).toEqual(["SWY-42"]);
    expect(parseKeyMentions("magos/SWY-7-add-foo", "SWY")).toEqual(["SWY-7"]);
    expect(parseKeyMentions("Resolves SWY-12 and SWY-13", "SWY")).toEqual(["SWY-12", "SWY-13"]);
  });

  test("rejects mid-token false positives (ABBSWY-1 ≠ SWY-1)", () => {
    expect(parseKeyMentions("ABBSWY-1", "SWY")).toEqual([]);
    expect(parseKeyMentions("xSWY-1", "SWY")).toEqual([]);
  });

  test("respects the prefix lock unless wildcard", () => {
    expect(parseKeyMentions("FOO-1 BAR-2", "SWY")).toEqual([]);
    expect(parseKeyMentions("FOO-1 BAR-2", "*")).toEqual(["FOO-1", "BAR-2"]);
  });

  test("dedupes repeats", () => {
    expect(parseKeyMentions("SWY-1 SWY-1 SWY-1", "SWY")).toEqual(["SWY-1"]);
  });
});

describe("parseClosingKeyMentions (body — closing-keyword scoped)", () => {
  test("attaches a single key behind each closing keyword", () => {
    expect(parseClosingKeyMentions("Closes SWY-3", "SWY")).toEqual(["SWY-3"]);
    expect(parseClosingKeyMentions("Fixes: SWY-3", "SWY")).toEqual(["SWY-3"]);
    expect(parseClosingKeyMentions("Resolved SWY-3.", "SWY")).toEqual(["SWY-3"]);
    expect(parseClosingKeyMentions("refs SWY-3", "SWY")).toEqual(["SWY-3"]);
  });

  test("super-PR list: one keyword covering many keys (comma / and / &)", () => {
    expect(parseClosingKeyMentions("Closes APTR-1, APTR-2, APTR-3", "APTR"))
      .toEqual(["APTR-1", "APTR-2", "APTR-3"]);
    expect(parseClosingKeyMentions("Fixes APTR-1 and APTR-2", "APTR"))
      .toEqual(["APTR-1", "APTR-2"]);
    expect(parseClosingKeyMentions("Closes APTR-1, APTR-2 & APTR-3", "APTR"))
      .toEqual(["APTR-1", "APTR-2", "APTR-3"]);
  });

  test("multiple keyword lines each contribute", () => {
    const body = "## Summary\nDoes things.\n\nCloses SWY-1\nFixes SWY-2\n";
    expect(parseClosingKeyMentions(body, "SWY")).toEqual(["SWY-1", "SWY-2"]);
  });

  test("bare mention without a closing keyword is NOT attached", () => {
    // This is the whole point of the body being keyword-scoped: a drive-by
    // mention must not attach (and then auto-close via the SWY-69 rule).
    expect(parseClosingKeyMentions("This is similar to SWY-42", "SWY")).toEqual([]);
    expect(parseClosingKeyMentions("Related: SWY-42", "SWY")).toEqual([]);
    expect(parseClosingKeyMentions("See SWY-42 for context", "SWY")).toEqual([]);
  });

  test("a closing keyword does not swallow keys past the list (newline / prose)", () => {
    // After the closing list ends, an unrelated key on a later line must not
    // be vacuumed in by the keyword above it.
    expect(parseClosingKeyMentions("Closes SWY-1\nSWY-9 is unrelated.", "SWY"))
      .toEqual(["SWY-1"]);
    expect(parseClosingKeyMentions("Closes SWY-1. Also see SWY-9.", "SWY"))
      .toEqual(["SWY-1"]);
  });

  test("honors prefix lock and wildcard, same as bare parsing", () => {
    expect(parseClosingKeyMentions("Closes FOO-1", "SWY")).toEqual([]);
    expect(parseClosingKeyMentions("Closes FOO-1 and BAR-2", "*")).toEqual(["FOO-1", "BAR-2"]);
  });

  test("does not match gerunds / unrelated words (fixing, disclosed)", () => {
    expect(parseClosingKeyMentions("Fixing SWY-1 later", "SWY")).toEqual([]);
    expect(parseClosingKeyMentions("disclosed SWY-1 elsewhere", "SWY")).toEqual([]);
  });

  test("dedupes a key mentioned under several keywords", () => {
    expect(parseClosingKeyMentions("Closes SWY-1\nResolves SWY-1", "SWY")).toEqual(["SWY-1"]);
  });

  test("empty / undefined body is a no-op", () => {
    expect(parseClosingKeyMentions("", "SWY")).toEqual([]);
  });
});
