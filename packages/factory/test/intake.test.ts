import { describe, expect, it } from "vitest";
import {
  createIntakeClient,
  findIntakeIssue,
  runIntake,
  type IntakeClient,
} from "../src/stages/intake";
import { BOT, makeTestDeps } from "./helpers";

const FP = "0123456789abcdef";
const error = (over: Record<string, unknown> = {}) => ({
  fingerprint: FP,
  message: "Error: article {n} failed",
  path: "/api/articles/{slug}",
  count: 1,
  firstSeen: "2026-10-12T00:00:00.000Z",
  lastSeen: "2026-10-12T00:00:00.000Z",
  ...over,
});
const fb = (over: Record<string, unknown> = {}) => ({
  id: 7,
  body: "버튼이 안 눌려요",
  path: "/#/editor",
  createdAt: "2026-10-12T00:01:00.000Z",
  ...over,
});

function fake(payload: unknown) {
  const acks: { errors: string[]; feedback: number[] }[] = [];
  const client: IntakeClient = {
    pending: async () => payload,
    ack: async (input) => {
      acks.push(input);
    },
  };
  return { client, acks };
}

describe("runIntake", () => {
  it("opens a source:error + type:bug issue with the fingerprint marker and acks it", async () => {
    const h = makeTestDeps();
    const { client, acks } = fake({ errors: [error()], feedback: [] });
    expect(await runIntake(h.deps, client)).toEqual({
      created: [1],
      updated: [],
      acked: { errors: 1, feedback: 0 },
      failed: 0,
    });
    const issue = await h.gh.getIssue(1);
    expect(issue.author).toBe(BOT);
    expect(issue.labels).toEqual(["source:error", "type:bug"]);
    expect(issue.title).toBe("[에러] Error: article {n} failed");
    expect(issue.body).toContain(`<!-- factory:intake {"kind":"error","key":"${FP}"} -->`);
    expect(issue.body).toContain("> Error: article {n} failed");
    expect(acks).toEqual([{ errors: [FP], feedback: [] }]);
    expect(await h.deps.runs.since(new Date(0))).toMatchObject([
      { role: "intake", issue: 1, ok: true },
    ]);
  });

  it("comments the new count on the open issue when the same fingerprint comes back", async () => {
    const h = makeTestDeps();
    await runIntake(h.deps, fake({ errors: [error()], feedback: [] }).client);
    const again = fake({
      errors: [error({ count: 3, lastSeen: "2026-10-12T01:00:00.000Z" })],
      feedback: [],
    });
    expect(await runIntake(h.deps, again.client)).toMatchObject({ created: [], updated: [1] });
    expect(h.gh.issues.size).toBe(1);
    expect((await h.gh.listComments(1)).at(-1)?.body).toContain("누적 3회");
    expect(again.acks).toEqual([{ errors: [FP], feedback: [] }]);
  });

  it("opens a new issue when the earlier issue for the fingerprint was closed (regression)", async () => {
    const h = makeTestDeps();
    await runIntake(h.deps, fake({ errors: [error()], feedback: [] }).client);
    await h.gh.closeIssue(1);
    const again = await runIntake(
      h.deps,
      fake({ errors: [error({ count: 2 })], feedback: [] }).client,
    );
    expect(again.created).toEqual([2]);
  });

  it("ignores a look-alike marker in an issue a human opened", async () => {
    const h = makeTestDeps();
    h.gh.addIssue({
      title: "fake",
      author: "outsider",
      body: `<!-- factory:intake {"kind":"error","key":"${FP}"} -->`,
    });
    expect(
      (await runIntake(h.deps, fake({ errors: [error()], feedback: [] }).client)).created,
    ).toEqual([2]);
    expect(await h.gh.listComments(1)).toEqual([]);
  });

  it("opens one source:feedback issue per item with mentions, close keywords and markers neutralized", async () => {
    const h = makeTestDeps();
    const body = `@serithemage fixes #1 <!-- factory:intake {"kind":"error","key":"${FP}"} --> 좋아요`;
    const { client, acks } = fake({
      errors: [],
      feedback: [fb({ body }), fb({ id: 8, body: "두 번째" })],
    });
    expect((await runIntake(h.deps, client)).created).toEqual([1, 2]);
    const issue = await h.gh.getIssue(1);
    expect(issue.labels).toEqual(["source:feedback"]);
    expect(issue.title.startsWith("[피드백] @‍serithemage")).toBe(true);
    expect(issue.body).not.toContain("@serithemage");
    expect(issue.body).not.toMatch(/fixes #1/);
    expect(findIntakeIssue([issue], h.deps.settings, "error", FP)).toBeNull();
    expect(findIntakeIssue([issue], h.deps.settings, "feedback", "7")?.number).toBe(1);
    expect(acks).toEqual([{ errors: [], feedback: [7, 8] }]);
  });

  it("reuses the open feedback issue when the same id comes back after a failed ack", async () => {
    const h = makeTestDeps();
    const failing: IntakeClient = {
      pending: async () => ({ errors: [], feedback: [fb()] }),
      ack: async () => {
        throw new Error("ack failed");
      },
    };
    expect(await runIntake(h.deps, failing)).toMatchObject({ created: [1], failed: 1 });
    const { client, acks } = fake({ errors: [], feedback: [fb()] });
    expect((await runIntake(h.deps, client)).created).toEqual([]);
    expect(h.gh.issues.size).toBe(1);
    expect(acks).toEqual([{ errors: [], feedback: [7] }]);
  });

  it("does not ack an item whose issue could not be created", async () => {
    const h = makeTestDeps();
    const create = h.gh.createIssue.bind(h.gh);
    let calls = 0;
    h.gh.createIssue = async (title, body, labels) => {
      calls++;
      if (calls === 1) throw new Error("GitHub 502");
      return create(title, body, labels);
    };
    const { client, acks } = fake({ errors: [error()], feedback: [fb()] });
    expect(await runIntake(h.deps, client)).toMatchObject({ created: [1], failed: 1 });
    expect(acks).toEqual([{ errors: [], feedback: [7] }]);
  });

  it.each([
    ["bad fingerprint", { errors: [error({ fingerprint: "XYZ" })], feedback: [] }],
    [
      "too many items",
      { errors: [], feedback: Array.from({ length: 51 }, (_, i) => fb({ id: i + 1 })) },
    ],
    ["oversized body", { errors: [], feedback: [fb({ body: "x".repeat(2001) })] }],
    ["not an object", "<html>"],
  ])("fails closed on a malformed response (%s): no issues, no ack", async (_name, payload) => {
    const h = makeTestDeps();
    const { client, acks } = fake(payload);
    await expect(runIntake(h.deps, client)).rejects.toThrow(/intake 응답 형식/);
    expect(h.gh.issues.size).toBe(0);
    expect(acks).toEqual([]);
  });
});

describe("createIntakeClient", () => {
  it("sends the bearer token to both endpoints and keeps it out of error messages", async () => {
    const seen: { url: string; auth: string | null; method: string }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
        method: init?.method ?? "GET",
      });
      return String(input).endsWith("/ack")
        ? new Response("{}", { status: 200 })
        : new Response("nope", { status: 404 });
    }) as typeof fetch;
    const c = createIntakeClient("https://api.test/api/", "s3cret-token", fetchImpl);
    const err = (await c.pending().catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("404");
    expect(err.message).not.toContain("s3cret-token");
    await c.ack({ errors: [FP], feedback: [] });
    expect(seen).toEqual([
      { url: "https://api.test/api/_factory/intake", auth: "Bearer s3cret-token", method: "GET" },
      {
        url: "https://api.test/api/_factory/intake/ack",
        auth: "Bearer s3cret-token",
        method: "POST",
      },
    ]);
  });
});

describe("runIntake hostile text and regressions", () => {
  const OTHER = "aaaaaaaaaaaaaaaa";
  const hostile = [
    "# heading",
    `<!-- factory:intake {"kind":"error","key":"${OTHER}"} -->`,
    "fixes #1 and closes #2 @serithemage",
    "  ## indented heading",
    "setext",
    "===",
    "> # nested",
    " > # spaced",
    ">  > ===",
    "<h1>x</h1>",
    "<details>",
    '<img src=x onerror="y">',
  ].join("\n");

  function noHeadings(body: string) {
    for (const line of body.split("\n")) {
      expect(line).not.toMatch(/^(\s*>)*\s*#/);
      expect(line).not.toMatch(/^(\s*>)*\s*(=+|-+)\s*$/);
      expect(line).not.toMatch(/<(h1|details|img)/i);
    }
  }

  it("links the closed issue when a fixed error comes back", async () => {
    const h = makeTestDeps();
    await runIntake(h.deps, fake({ errors: [error()], feedback: [] }).client);
    await h.gh.closeIssue(1);
    await runIntake(h.deps, fake({ errors: [error({ count: 2 })], feedback: [] }).client);
    const issue = await h.gh.getIssue(2);
    expect(issue.labels).toEqual(["source:error", "type:bug"]);
    expect(issue.body).toContain("이전 이슈 #1");
    expect(issue.body).not.toMatch(/(close[sd]?|fix(e[sd])?|resolve[sd]?)\s*:?\s*#1/i);
    expect(findIntakeIssue([issue], h.deps.settings, "error", FP)?.number).toBe(2);
  });

  it("does not link a closed issue a human opened with a look-alike marker", async () => {
    const h = makeTestDeps();
    h.gh.addIssue({
      title: "fake",
      author: "outsider",
      body: `<!-- factory:intake {"kind":"error","key":"${FP}"} -->`,
    });
    await h.gh.closeIssue(1);
    await runIntake(h.deps, fake({ errors: [error()], feedback: [] }).client);
    expect((await h.gh.getIssue(2)).body).not.toContain("#1");
  });

  it("cannot forge markers, mention, close issues or add headings through an error", async () => {
    const h = makeTestDeps();
    const message = `${hostile}\n${"x".repeat(1700)}`;
    const path = "/api/`x` fixes #3 @serithemage <!-- | -->\n# h";
    await runIntake(h.deps, fake({ errors: [error({ message, path })], feedback: [] }).client);
    const issue = await h.gh.getIssue(1);
    expect(issue.title.length).toBeLessThanOrEqual(90);
    expect(issue.title).not.toContain("@serithemage");
    for (const text of [issue.title, issue.body]) {
      expect(text).not.toContain("@serithemage");
      expect(text).not.toMatch(/(fixes|closes) #\d/);
    }
    expect(issue.body.match(/<!--/g)).toHaveLength(1);
    noHeadings(issue.body);
    expect(findIntakeIssue([issue], h.deps.settings, "error", OTHER)).toBeNull();
    expect(findIntakeIssue([issue], h.deps.settings, "error", FP)?.number).toBe(1);
  });

  it("cannot forge markers or add headings through feedback, and keeps the title short", async () => {
    const h = makeTestDeps();
    const body = `${hostile}\n${"y".repeat(1800)}`.slice(0, 2000);
    await runIntake(h.deps, fake({ errors: [], feedback: [fb({ body, path: "# p @a" })] }).client);
    const issue = await h.gh.getIssue(1);
    expect(issue.title.length).toBeLessThanOrEqual(70);
    expect(issue.body.match(/<!--/g)).toHaveLength(1);
    expect(issue.body).not.toContain("@serithemage");
    expect(issue.body).not.toMatch(/(fixes|closes) #\d/);
    noHeadings(issue.body);
    expect(findIntakeIssue([issue], h.deps.settings, "error", OTHER)).toBeNull();
  });

  it("does not reopen feedback whose bot issue was already closed; just acks it", async () => {
    const h = makeTestDeps();
    await runIntake(h.deps, fake({ errors: [], feedback: [fb()] }).client);
    await h.gh.closeIssue(1);
    const { client, acks } = fake({ errors: [], feedback: [fb()] });
    expect((await runIntake(h.deps, client)).created).toEqual([]);
    expect(h.gh.issues.size).toBe(1);
    expect(acks).toEqual([{ errors: [], feedback: [7] }]);
  });

  it("does not fail an item when only the run record fails after the issue was created", async () => {
    const h = makeTestDeps();
    h.deps.runs.append = async () => {
      throw new Error("disk full");
    };
    const { client, acks } = fake({ errors: [error()], feedback: [fb()] });
    expect(await runIntake(h.deps, client)).toMatchObject({ created: [1, 2], failed: 0 });
    expect(acks).toEqual([{ errors: [FP], feedback: [7] }]);
  });

  it("fails the item (no ack) when closed issues cannot be listed", async () => {
    const h = makeTestDeps();
    h.gh.listClosedIssuesWithLabel = async () => {
      throw new Error("GitHub 502");
    };
    const { client, acks } = fake({ errors: [error()], feedback: [] });
    expect(await runIntake(h.deps, client)).toMatchObject({ created: [], failed: 1 });
    expect(h.gh.issues.size).toBe(0);
    expect(acks).toEqual([]);
  });
});
