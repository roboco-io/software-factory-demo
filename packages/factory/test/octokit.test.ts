import { describe, expect, it } from "vitest";
import { createOctokitPort } from "../src/github/octokit";
import { BranchNotFoundError, ConflictError, TooManyFilesError } from "../src/github/port";

type Route = { method: string; path: RegExp; status: number; body: unknown };

// Response objects built by hand have an empty url; Octokit pagination reads response.url.
function withUrl(res: Response, url: URL): Response {
  Object.defineProperty(res, "url", { value: url.href });
  return res;
}

function fakeFetch(routes: Route[], calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url.pathname}${url.search}`);
    const route = routes.find(
      (r) => r.method === method && r.path.test(decodeURIComponent(url.pathname)),
    );
    if (!route) return new Response(JSON.stringify({ message: "no route" }), { status: 500 });
    return withUrl(
      new Response(route.status === 204 ? null : JSON.stringify(route.body), {
        status: route.status,
        headers: { "content-type": "application/json" },
      }),
      url,
    );
  }) as typeof fetch;
}

const port = (routes: Route[], calls?: string[]) =>
  createOctokitPort({ token: "t", owner: "o", repo: "r", fetch: fakeFetch(routes, calls) });

describe("createOctokitPort", () => {
  it("maps collaborator permission using role_name first", async () => {
    const gh = port([
      {
        method: "GET",
        path: /collaborators\/alice\/permission$/,
        status: 200,
        body: { permission: "write", role_name: "maintain" },
      },
      {
        method: "GET",
        path: /collaborators\/bob\/permission$/,
        status: 404,
        body: { message: "Not Found" },
      },
      {
        method: "GET",
        path: /collaborators\/carol\/permission$/,
        status: 200,
        body: { permission: "write", role_name: "custom-role" },
      },
    ]);
    expect(await gh.getPermission("alice")).toBe("maintain");
    expect(await gh.getPermission("bob")).toBe("none");
    expect(await gh.getPermission("carol")).toBe("write");
  });

  it("reads a file from a branch, returning null for 404", async () => {
    const gh = port([
      {
        method: "GET",
        path: /contents\/runs\/2026-10\.jsonl$/,
        status: 200,
        body: { type: "file", sha: "s1", content: Buffer.from("a\n").toString("base64") },
      },
      {
        method: "GET",
        path: /contents\/runs\/2026-09\.jsonl$/,
        status: 404,
        body: { message: "Not Found" },
      },
    ]);
    expect(await gh.readFile("factory-data", "runs/2026-10.jsonl")).toEqual({
      content: "a\n",
      sha: "s1",
    });
    expect(await gh.readFile("factory-data", "runs/2026-09.jsonl")).toBeNull();
  });

  it("turns a 409 on write into ConflictError", async () => {
    const gh = port([
      { method: "PUT", path: /contents\/runs/, status: 409, body: { message: "sha mismatch" } },
    ]);
    await expect(
      gh.writeFile("factory-data", "runs/x.jsonl", "x", "old", "m"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("keeps only the newest check run per name", async () => {
    const gh = port([
      {
        method: "GET",
        path: /commits\/abc\/check-runs$/,
        status: 200,
        body: {
          total_count: 3,
          check_runs: [
            { id: 1, name: "unit", status: "completed", conclusion: "failure" },
            { id: 5, name: "unit", status: "completed", conclusion: "success" },
            { id: 2, name: "e2e", status: "in_progress", conclusion: null },
          ],
        },
      },
    ]);
    expect(await gh.listCheckRuns("abc")).toEqual([
      { name: "unit", status: "completed", conclusion: "success" },
      { name: "e2e", status: "in_progress", conclusion: null },
    ]);
  });

  it("returns false when the merge is refused", async () => {
    const gh = port([
      { method: "PUT", path: /pulls\/7\/merge$/, status: 405, body: { message: "not mergeable" } },
    ]);
    expect(await gh.mergePull(7, { sha: "s", title: "t", message: "m" })).toBe(false);
  });

  it("marks a draft PR ready through GraphQL, and skips a PR that is already ready", async () => {
    const calls: string[] = [];
    const gh = port(
      [
        {
          method: "GET",
          path: /pulls\/7$/,
          status: 200,
          body: { number: 7, draft: true, node_id: "PR_node" },
        },
        {
          method: "GET",
          path: /pulls\/8$/,
          status: 200,
          body: { number: 8, draft: false, node_id: "PR_other" },
        },
        {
          method: "POST",
          path: /graphql$/,
          status: 200,
          body: { data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_node" } } } },
        },
      ],
      calls,
    );
    await gh.markReady(7);
    await gh.markReady(8);
    expect(calls.filter((c) => c.startsWith("POST"))).toEqual(["POST /graphql"]);
  });

  it("dispatches workflows on main", async () => {
    const calls: string[] = [];
    const gh = port([{ method: "POST", path: /dispatches$/, status: 204, body: null }], calls);
    await gh.dispatchWorkflow("factory-fix.yml", { pr: "3" });
    expect(calls[0]).toBe("POST /repos/o/r/actions/workflows/factory-fix.yml/dispatches");
  });
});

describe("createOctokitPort listPullFiles", () => {
  it("fills additions from the patch and previousFilename from previous_filename", async () => {
    const gh = port([
      { method: "GET", path: /pulls\/4$/, status: 200, body: { changed_files: 2 } },
      {
        method: "GET",
        path: /pulls\/4\/files$/,
        status: 200,
        body: [
          {
            filename: "a.ts",
            status: "modified",
            patch: "@@ -1 +1,2 @@\n ctx\n+added one\n-gone\n+added two",
          },
          { filename: "new.ts", previous_filename: "old.ts", status: "renamed" },
        ],
      },
    ]);
    expect(await gh.listPullFiles(4)).toEqual([
      { filename: "a.ts", additions: ["added one", "added two"] },
      { filename: "new.ts", previousFilename: "old.ts", additions: [], patchMissing: true },
    ]);
  });

  it("marks files GitHub reports as removed", async () => {
    const gh = port([
      { method: "GET", path: /pulls\/5$/, status: 200, body: { changed_files: 1 } },
      {
        method: "GET",
        path: /pulls\/5\/files$/,
        status: 200,
        body: [
          { filename: "a.test.ts", status: "removed", additions: 0, patch: "@@ -1 +0,0 @@\n-x" },
        ],
      },
    ]);
    expect(await gh.listPullFiles(5)).toEqual([
      { filename: "a.test.ts", additions: [], additionCount: 0, removed: true },
    ]);
  });
});

describe("createOctokitPort pagination and caps", () => {
  const link = (path: string, page: number) => ({
    link: `<https://api.github.com${path}?per_page=100&page=${page}>; rel="next"`,
  });

  function pagedFetch(
    pages: Record<string, { body: unknown; headers?: Record<string, string> }>,
  ): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      const key = `${url.pathname}?page=${url.searchParams.get("page") ?? "1"}`;
      const p = pages[key];
      if (!p) return new Response(JSON.stringify({ message: `no route ${key}` }), { status: 500 });
      return withUrl(
        new Response(JSON.stringify(p.body), {
          status: 200,
          headers: { "content-type": "application/json", ...(p.headers ?? {}) },
        }),
        url,
      );
    }) as typeof fetch;
  }
  const mk = (pages: Parameters<typeof pagedFetch>[0]) =>
    createOctokitPort({ token: "t", owner: "o", repo: "r", fetch: pagedFetch(pages) });

  it("follows Link headers for listClosedIssuesWithLabel and drops pull requests", async () => {
    const issue = (number: number, pr = false) => ({
      number,
      title: "t",
      body: null,
      user: { login: "bot" },
      labels: [{ name: "source:error" }],
      state: "closed",
      ...(pr ? { pull_request: {} } : {}),
    });
    const gh = mk({
      "/repos/o/r/issues?page=1": {
        body: [issue(1), issue(2, true)],
        headers: link("/repos/o/r/issues", 2),
      },
      "/repos/o/r/issues?page=2": { body: [issue(3)] },
    });
    expect((await gh.listClosedIssuesWithLabel("source:error")).map((i) => i.number)).toEqual([
      1, 3,
    ]);
  });

  it("lists closed issues newest first and stops after 5 pages", async () => {
    const urls: string[] = [];
    const inner = pagedFetch(
      Object.fromEntries(
        [1, 2, 3, 4, 5, 6, 7].map((p) => [
          `/repos/o/r/issues?page=${p}`,
          {
            body: [
              {
                number: p,
                title: "t",
                body: null,
                user: { login: "bot" },
                labels: [{ name: "source:error" }],
                state: "closed",
              },
            ],
            headers: link("/repos/o/r/issues", p + 1),
          },
        ]),
      ),
    );
    const spy = ((input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return inner(input, init);
    }) as typeof fetch;
    const gh = createOctokitPort({ token: "t", owner: "o", repo: "r", fetch: spy });
    expect((await gh.listClosedIssuesWithLabel("source:error")).map((i) => i.number)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(urls).toHaveLength(5);
    expect(urls[0]).toContain("sort=created");
    expect(urls[0]).toContain("direction=desc");
  });

  it("follows Link headers for listPullFiles", async () => {
    const gh = mk({
      "/repos/o/r/pulls/9?page=1": { body: { changed_files: 2 } },
      "/repos/o/r/pulls/9/files?page=1": {
        body: [{ filename: "a.ts", additions: 1, patch: "@@ -0,0 +1 @@\n+x" }],
        headers: link("/repos/o/r/pulls/9/files", 2),
      },
      "/repos/o/r/pulls/9/files?page=2": { body: [{ filename: "b.ts" }] },
    });
    expect(await gh.listPullFiles(9)).toEqual([
      { filename: "a.ts", additions: ["x"], additionCount: 1 },
      { filename: "b.ts", additions: [], patchMissing: true },
    ]);
  });

  it("follows Link headers for listCheckRuns and keeps the newest per name", async () => {
    const gh = mk({
      "/repos/o/r/commits/abc/check-runs?page=1": {
        body: {
          total_count: 3,
          check_runs: [{ id: 1, name: "unit", status: "completed", conclusion: "failure" }],
        },
        headers: link("/repos/o/r/commits/abc/check-runs", 2),
      },
      "/repos/o/r/commits/abc/check-runs?page=2": {
        body: {
          total_count: 3,
          check_runs: [
            { id: 9, name: "unit", status: "completed", conclusion: "success" },
            { id: 3, name: "e2e", status: "completed", conclusion: "success" },
          ],
        },
      },
    });
    expect(await gh.listCheckRuns("abc")).toEqual([
      { name: "unit", status: "completed", conclusion: "success" },
      { name: "e2e", status: "completed", conclusion: "success" },
    ]);
  });

  it("fails closed at the 3000-file cap", async () => {
    const gh = mk({ "/repos/o/r/pulls/9?page=1": { body: { changed_files: 3000 } } });
    await expect(gh.listPullFiles(9)).rejects.toBeInstanceOf(TooManyFilesError);
  });

  it("fails closed when fewer files are returned than changed_files", async () => {
    const gh = mk({
      "/repos/o/r/pulls/9?page=1": { body: { changed_files: 5 } },
      "/repos/o/r/pulls/9/files?page=1": { body: [{ filename: "a.ts" }] },
    });
    await expect(gh.listPullFiles(9)).rejects.toBeInstanceOf(TooManyFilesError);
  });

  it("maps a missing patch (binary or large diff) to empty additions with patchMissing", async () => {
    const gh = mk({
      "/repos/o/r/pulls/9?page=1": { body: { changed_files: 1 } },
      "/repos/o/r/pulls/9/files?page=1": { body: [{ filename: "img.png" }] },
    });
    expect(await gh.listPullFiles(9)).toEqual([
      { filename: "img.png", additions: [], patchMissing: true },
    ]);
  });

  it("treats 422 as a conflict only for sha problems, and 404 branch as BranchNotFoundError", async () => {
    const other = port([
      { method: "PUT", path: /contents/, status: 422, body: { message: "Invalid request" } },
    ]);
    await expect(other.writeFile("b", "p", "x", null, "m")).rejects.not.toBeInstanceOf(
      ConflictError,
    );
    const sha = port([
      { method: "PUT", path: /contents/, status: 422, body: { message: "sha wasn't supplied" } },
    ]);
    await expect(sha.writeFile("b", "p", "x", null, "m")).rejects.toBeInstanceOf(ConflictError);
    const nb = port([
      { method: "PUT", path: /contents/, status: 404, body: { message: "Branch b not found" } },
    ]);
    await expect(nb.writeFile("b", "p", "x", null, "m")).rejects.toBeInstanceOf(
      BranchNotFoundError,
    );
  });

  it("throws when file content is empty but size is positive", async () => {
    const gh = port([
      {
        method: "GET",
        path: /contents\/big$/,
        status: 200,
        body: { type: "file", sha: "s", size: 2_000_000, content: "" },
      },
    ]);
    await expect(gh.readFile("b", "big")).rejects.toThrow(/too large/);
  });
});

describe("createOctokitPort createOrphanBranch", () => {
  const routes = (refStatus: number, refMessage: string): Route[] => [
    {
      method: "GET",
      path: /branches\/factory-data$/,
      status: 404,
      body: { message: "Branch not found" },
    },
    { method: "POST", path: /git\/trees$/, status: 201, body: { sha: "tree1" } },
    { method: "POST", path: /git\/commits$/, status: 201, body: { sha: "commit1" } },
    { method: "POST", path: /git\/refs$/, status: refStatus, body: { message: refMessage } },
  ];

  it("treats 'Reference already exists' as success", async () => {
    const gh = port(routes(422, "Reference already exists"));
    await expect(
      gh.createOrphanBranch("factory-data", { a: "b" }, "init"),
    ).resolves.toBeUndefined();
  });

  it("rethrows other createRef failures", async () => {
    const gh = port(routes(422, "Object does not exist"));
    await expect(gh.createOrphanBranch("factory-data", { a: "b" }, "init")).rejects.toThrow();
  });
});

describe("history listing", () => {
  it("listCommits maps message and committer date", async () => {
    const calls: string[] = [];
    const gh = port(
      [
        {
          method: "GET",
          path: /\/repos\/o\/r\/commits$/,
          status: 200,
          body: [
            { sha: "s1", commit: { message: "m1", committer: { date: "2026-10-10T00:00:00Z" } } },
          ],
        },
      ],
      calls,
    );
    expect(await gh.listCommits(new Date("2026-10-01T00:00:00Z"))).toEqual([
      { sha: "s1", message: "m1", date: "2026-10-10T00:00:00Z" },
    ]);
    expect(calls[0]).toBe(
      "GET /repos/o/r/commits?sha=main&since=2026-10-01T00%3A00%3A00.000Z&per_page=100",
    );
  });

  it("listMergedPulls skips unmerged and old merges and stops paging", async () => {
    const calls: string[] = [];
    const pr = (number: number, merged_at: string | null, updated_at: string) => ({
      number,
      title: `t${number}`,
      body: null,
      user: { login: "u" },
      labels: [{ name: "x" }],
      merged_at,
      updated_at,
    });
    const gh = port(
      [
        {
          method: "GET",
          path: /\/repos\/o\/r\/pulls$/,
          status: 200,
          body: [
            pr(3, "2026-10-11T00:00:00Z", "2026-10-11T00:00:00Z"),
            pr(2, null, "2026-10-05T00:00:00Z"),
            pr(1, "2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"),
          ],
        },
      ],
      calls,
    );
    const out = await gh.listMergedPulls(new Date("2026-10-01T00:00:00Z"));
    expect(out).toEqual([
      {
        number: 3,
        title: "t3",
        body: "",
        author: "u",
        labels: ["x"],
        mergedAt: "2026-10-11T00:00:00Z",
      },
    ]);
    expect(calls).toEqual([
      "GET /repos/o/r/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100",
    ]);
  });
});

describe("listOpenPulls", () => {
  it("lists open pulls against main across pages", async () => {
    const calls: string[] = [];
    const gh = port(
      [
        {
          method: "GET",
          path: /\/repos\/o\/r\/pulls$/,
          status: 200,
          body: [
            {
              number: 5,
              title: "t",
              body: null,
              user: { login: "bot" },
              head: { ref: "h", sha: "s" },
              base: { ref: "main" },
              labels: [{ name: "factory:improve" }],
              draft: false,
              state: "open",
            },
          ],
        },
      ],
      calls,
    );
    const out = await gh.listOpenPulls();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      number: 5,
      author: "bot",
      labels: ["factory:improve"],
      body: "",
    });
    expect(calls[0]).toBe("GET /repos/o/r/pulls?state=open&base=main&per_page=100");
  });
});
