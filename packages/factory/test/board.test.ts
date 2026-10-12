import { describe, expect, it } from "vitest";
import { reconcileBoard } from "../src/stages/board";
import { moveTo } from "../src/stages/common";
import { makeTestDeps } from "./helpers";

describe("board sync", () => {
  it("syncs the board after a label transition", async () => {
    const h = makeTestDeps();
    const n = await h.gh.createIssue("t", "b", ["factory:triaged"]);
    await moveTo(h.deps, n, "approved", "command");
    expect(h.gh.board.get(n)).toBe("approved");
  });

  it.each(["missing", "ambiguous", "error"] as const)(
    "keeps the transition when the board is %s",
    async (state) => {
      const h = makeTestDeps();
      h.gh.boardState = state;
      const n = await h.gh.createIssue("t", "b", ["factory:triaged"]);
      expect(await moveTo(h.deps, n, "approved", "command")).toBe(true);
      expect((await h.gh.getIssue(n)).labels).toContain("factory:approved");
      expect(h.logs.some((l) => l.startsWith("board"))).toBe(true);
    },
  );

  it("reconciles open issues with a state label, skipping PRs and unlabeled issues", async () => {
    const h = makeTestDeps();
    const a = await h.gh.createIssue("a", "", ["factory:in-review"]);
    await h.gh.createIssue("b", "", []);
    expect(await reconcileBoard(h.deps)).toBe(1);
    expect(h.gh.board.get(a)).toBe("in-review");
  });

  it("caps attempts, not just successes, so persistent errors stay bounded", async () => {
    const h = makeTestDeps();
    h.gh.boardState = "error";
    for (let i = 0; i < 5; i++) await h.gh.createIssue(`i${i}`, "", ["factory:approved"]);
    let calls = 0;
    const orig = h.gh.syncBoardStatus.bind(h.gh);
    h.gh.syncBoardStatus = (...a) => (calls++, orig(...a));
    expect(await reconcileBoard(h.deps, 3)).toBe(0);
    expect(calls).toBe(1);
  });

  it("stops at the first failure when nothing has synced yet", async () => {
    const h = makeTestDeps();
    for (let i = 0; i < 5; i++) await h.gh.createIssue(`i${i}`, "", ["factory:approved"]);
    let calls = 0;
    h.gh.syncBoardStatus = async () => {
      calls++;
      throw new Error("denied");
    };
    expect(await reconcileBoard(h.deps)).toBe(0);
    expect(calls).toBe(1);
  });

  it("keeps going after a failure once a sync has succeeded", async () => {
    const h = makeTestDeps();
    const nums: number[] = [];
    for (let i = 0; i < 3; i++)
      nums.push(await h.gh.createIssue(`i${i}`, "", ["factory:approved"]));
    const orig = h.gh.syncBoardStatus.bind(h.gh);
    h.gh.syncBoardStatus = (spec, n, s) => {
      if (n === nums[1]) throw new Error("flaky");
      return orig(spec, n, s);
    };
    expect(await reconcileBoard(h.deps)).toBe(2);
  });

  it("reconciles the newest issues first under the cap", async () => {
    const h = makeTestDeps();
    const nums: number[] = [];
    for (let i = 0; i < 5; i++)
      nums.push(await h.gh.createIssue(`i${i}`, "", ["factory:approved"]));
    expect(await reconcileBoard(h.deps, 2)).toBe(2);
    expect([...h.gh.board.keys()].sort((a, b) => a - b)).toEqual(nums.slice(-2));
  });
});
