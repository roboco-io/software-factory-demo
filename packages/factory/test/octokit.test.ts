import { describe, expect, it } from "vitest";
import { createOctokitPort } from "../src/github/octokit";
import { ConflictError } from "../src/github/port";

type Route = { method: string; path: RegExp; status: number; body: unknown };

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
    return new Response(route.status === 204 ? null : JSON.stringify(route.body), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
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
