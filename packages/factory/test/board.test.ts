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
});
