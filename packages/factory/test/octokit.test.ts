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
      { filename: "new.ts", previousFilename: "old.ts", additions: [] },
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

  it("follows Link headers for listPullFiles", async () => {
    const gh = mk({
      "/repos/o/r/pulls/9?page=1": { body: { changed_files: 2 } },
      "/repos/o/r/pulls/9/files?page=1": {
        body: [{ filename: "a.ts", patch: "+x" }],
        headers: link("/repos/o/r/pulls/9/files", 2),
      },
      "/repos/o/r/pulls/9/files?page=2": { body: [{ filename: "b.ts" }] },
    });
    expect(await gh.listPullFiles(9)).toEqual([
      { filename: "a.ts", additions: ["x"] },
      { filename: "b.ts", additions: [] },
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

  it("maps a missing patch (binary or large diff) to empty additions", async () => {
    const gh = mk({
      "/repos/o/r/pulls/9?page=1": { body: { changed_files: 1 } },
      "/repos/o/r/pulls/9/files?page=1": { body: [{ filename: "img.png" }] },
    });
    expect(await gh.listPullFiles(9)).toEqual([{ filename: "img.png", additions: [] }]);
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
