import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGit } from "../src/git/port";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    },
  ).trim();
}

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "git-port-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "pipe" });
  execFileSync("git", ["clone", origin, work], { stdio: "pipe" });
  git(work, "symbolic-ref", "HEAD", "refs/heads/main");
  const port = createGit(work, { name: "bot", email: "bot@example.com" });
  writeFileSync(path.join(work, "README.md"), "r\n");
  mkdirSync(path.join(work, "packages/factory/src"), { recursive: true });
  writeFileSync(path.join(work, "packages/factory/src/x.ts"), "x\n");
  await port.commitAll("init");
  await port.push("main", "unused-for-file-remotes");
  await port.fetch("main");
  return { root, origin, work, port };
}

describe("createGit", () => {
  it("reports modified, untracked and both sides of a rename", async () => {
    const { work, port } = await setup();
    await port.checkoutNewBranch("factory/issue-1", "origin/main");
    writeFileSync(path.join(work, "README.md"), "changed\n");
    mkdirSync(path.join(work, "apps/api/src"), { recursive: true });
    writeFileSync(path.join(work, "apps/a.ts"), "a\n");
    git(work, "mv", "packages/factory/src/x.ts", "apps/api/src/x.ts");
    expect((await port.changedFiles()).sort()).toEqual([
      "README.md",
      "apps/a.ts",
      "apps/api/src/x.ts",
      "packages/factory/src/x.ts",
    ]);
  });

  it("commits with hooks disabled and lists committed files against the base", async () => {
    const { work, port } = await setup();
    await port.checkoutNewBranch("factory/issue-2", "origin/main");
    const hook = path.join(work, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    chmodSync(hook, 0o755);
    writeFileSync(path.join(work, "apps.ts"), "a\n");
    const sha = await port.commitAll("feat: x\n\nFactory-Issue: #2");
    expect(sha).toBe(await port.headSha());
    expect(git(work, "log", "-1", "--format=%B")).toContain("Factory-Issue: #2");
    expect(await port.filesAgainst("origin/main")).toEqual(["apps.ts"]);
    expect(await port.diffAgainst("origin/main")).toContain("+++ b/apps.ts");
  });

  it("pushes HEAD to the named branch", async () => {
    const { work, port, origin } = await setup();
    await port.checkoutNewBranch("factory/issue-3", "origin/main");
    writeFileSync(path.join(work, "f.ts"), "f\n");
    const sha = await port.commitAll("f");
    await port.push("factory/issue-3", "token");
    expect(git(origin, "rev-parse", "refs/heads/factory/issue-3")).toBe(sha);
  });

  it("moves commits between checkouts with a bundle", async () => {
    const { root, origin, work, port } = await setup();
    await port.checkoutNewBranch("factory/issue-5", "origin/main");
    writeFileSync(path.join(work, "b.ts"), "b\n");
    const sha = await port.commitAll("b");
    const bundle = path.join(root, "work.bundle");
    await port.createBundle(bundle);
    const fresh = path.join(root, "fresh");
    execFileSync("git", ["clone", origin, fresh], { stdio: "pipe" });
    const other = createGit(fresh, { name: "bot", email: "bot@example.com" });
    await other.importBundle(bundle, "factory/issue-5");
    expect(await other.headSha()).toBe(sha);
    expect(git(fresh, "rev-parse", "--abbrev-ref", "HEAD")).toBe("factory/issue-5");
    expect(await other.filesAgainst("origin/main")).toEqual(["b.ts"]);
  });

  it("returns false on a rebase conflict and leaves no rebase in progress", async () => {
    const { root, origin, work, port } = await setup();
    await port.checkoutNewBranch("factory/issue-4", "origin/main");
    writeFileSync(path.join(work, "README.md"), "branch\n");
    await port.commitAll("branch change");
    const other = path.join(root, "other");
    execFileSync("git", ["clone", origin, other], { stdio: "pipe" });
    writeFileSync(path.join(other, "README.md"), "main\n");
    git(other, "commit", "-am", "main change");
    git(other, "push", "origin", "main");
    await port.fetch("main");
    expect(await port.rebaseOnto("origin/main")).toBe(false);
    expect(existsSync(path.join(work, ".git/rebase-merge"))).toBe(false);
    expect(existsSync(path.join(work, ".git/rebase-apply"))).toBe(false);
  });

  describe("createGit ref validation", () => {
    it("rejects branch names and start points outside the factory pattern", async () => {
      const { port } = await setup();
      await expect(port.checkoutNewBranch("--orphan", "origin/main")).rejects.toThrow(
        /invalid branch/,
      );
      await expect(port.checkoutNewBranch("factory/issue-1", "-x")).rejects.toThrow(/start point/);
      await expect(port.importBundle("/tmp/x", "evil;rm")).rejects.toThrow(/invalid branch/);
    });
  });
});
