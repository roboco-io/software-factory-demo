import { describe, expect, it } from "vitest";
import { forbiddenGitHub } from "../src/github/forbidden";
import { InMemoryGitHub } from "../src/github/memory";
import { BranchNotFoundError, ConflictError } from "../src/github/port";

const BOT = "roboco-software-factory-bot[bot]";

describe("InMemoryGitHub", () => {
  it("shares numbering between issues and pulls and tracks labels on both", async () => {
    const gh = new InMemoryGitHub({ botLogin: BOT });
    const issue = gh.addIssue({ title: "t" });
    gh.setBranch("factory/issue-1", "sha-1", ["a.ts"]);
    const pr = await gh.createPull({
      title: "p",
      body: "b",
      head: "factory/issue-1",
      base: "main",
      draft: false,
    });
    expect([issue.number, pr]).toEqual([1, 2]);
    await gh.addLabels(pr, ["risk:T1"]);
    await gh.addLabels(issue.number, ["factory:triaged", "factory:triaged"]);
    expect((await gh.getPull(pr)).labels).toEqual(["risk:T1"]);
    expect((await gh.getIssue(issue.number)).labels).toEqual(["factory:triaged"]);
    expect((await gh.getIssue(pr)).isPullRequest).toBe(true);
    expect(await gh.listPullFiles(pr)).toEqual([{ filename: "a.ts", additions: [] }]);
  });

  it("moves an open pull's head when the branch is pushed again", async () => {
    const gh = new InMemoryGitHub({ botLogin: BOT });
    gh.setBranch("b", "s1", ["a"]);
    const pr = await gh.createPull({ title: "p", body: "", head: "b", base: "main", draft: false });
    gh.setBranch("b", "s2", ["a", "b"]);
    expect((await gh.getPull(pr)).headSha).toBe("s2");
  });

  it("merges only the expected head sha", async () => {
    const gh = new InMemoryGitHub({ botLogin: BOT });
    gh.setBranch("b", "s1", []);
    const pr = await gh.createPull({ title: "p", body: "", head: "b", base: "main", draft: false });
    expect(await gh.mergePull(pr, { sha: "old", title: "t", message: "m" })).toBe(false);
    expect(await gh.mergePull(pr, { sha: "s1", title: "t", message: "Factory-Issue: #1" })).toBe(
      true,
    );
    expect(await gh.getCommitMessage(gh.merges[0]!.mergeSha)).toBe("t\n\nFactory-Issue: #1");
  });

  it("enforces sha on writeFile and can inject conflicts", async () => {
    const gh = new InMemoryGitHub({ botLogin: BOT });
    await gh.createOrphanBranch("d", {}, "init");
    await gh.writeFile("d", "f", "1", null, "m");
    const cur = await gh.readFile("d", "f");
    await expect(gh.writeFile("d", "f", "2", "wrong", "m")).rejects.toBeInstanceOf(ConflictError);
    gh.injectConflicts = 1;
    await expect(gh.writeFile("d", "f", "2", cur!.sha, "m")).rejects.toBeInstanceOf(ConflictError);
    await gh.writeFile("d", "f", "2", cur!.sha, "m");
    expect((await gh.readFile("d", "f"))?.content).toBe("2");
  });
});

describe("InMemoryGitHub missing branch", () => {
  it("throws BranchNotFoundError when writing to a branch that does not exist", async () => {
    const gh = new InMemoryGitHub({ botLogin: BOT });
    await expect(gh.writeFile("nope", "f", "1", null, "m")).rejects.toBeInstanceOf(
      BranchNotFoundError,
    );
  });
});

describe("forbiddenGitHub", () => {
  it("rejects every call with the reason and is not thenable", async () => {
    const gh = forbiddenGitHub("agent 단계");
    await expect(gh.getIssue(1)).rejects.toThrow(/getIssue.*agent 단계/);
    expect((gh as unknown as { then?: unknown }).then).toBeUndefined();
    expect((gh as unknown as { toJSON?: unknown }).toJSON).toBeUndefined();
    expect((gh as unknown as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined();
  });
});
