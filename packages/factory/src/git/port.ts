import { scrubEnv } from "../agents/env";
import { runProcess, type ProcessResult, type SpawnFn } from "../exec/process";

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitPort {
  fetch(ref: string): Promise<void>;
  checkoutNewBranch(branch: string, startPoint: string): Promise<void>;
  changedFiles(): Promise<string[]>;
  filesAgainst(base: string): Promise<string[]>;
  diffAgainst(base: string): Promise<string>;
  commitAll(message: string): Promise<string>;
  rebaseOnto(base: string): Promise<boolean>;
  createBundle(file: string): Promise<void>;
  importBundle(file: string, branch: string): Promise<void>;
  push(branch: string, token: string): Promise<void>;
  headSha(): Promise<string>;
}

function splitZ(out: string): string[] {
  return out.split("\0").filter((s) => s.length > 0);
}

export function createGit(
  cwd: string,
  identity: GitIdentity,
  spawnFn: SpawnFn = runProcess,
  env: Record<string, string> = scrubEnv(process.env),
): GitPort {
  // 에이전트가 .git/hooks에 심은 스크립트가 토큰이 있는 publish 단계에서 실행되지 않게 한다.
  const base = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "-c",
    `user.name=${identity.name}`,
    "-c",
    `user.email=${identity.email}`,
  ];
  // name은 오류 메시지용이다. args에는 토큰이 들어갈 수 있으므로 메시지에 넣지 않는다.
  async function git(name: string, args: string[], allowFail = false): Promise<ProcessResult> {
    const r = await spawnFn("git", [...base, ...args], { cwd, env });
    if (r.code !== 0 && !allowFail) {
      throw new Error(`git ${name} failed (${r.code}): ${r.stderr.trim()}`);
    }
    return r;
  }
  const port: GitPort = {
    async fetch(ref) {
      await git("fetch", [
        "fetch",
        "--no-tags",
        "origin",
        `+refs/heads/${ref}:refs/remotes/origin/${ref}`,
      ]);
    },
    async checkoutNewBranch(branch, startPoint) {
      await git("checkout", ["checkout", "-B", branch, startPoint]);
    },
    async changedFiles() {
      const r = await git("status", [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--no-renames",
      ]);
      return splitZ(r.stdout).map((entry) => entry.slice(3));
    },
    async filesAgainst(baseRef) {
      const r = await git("diff", [
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        `${baseRef}...HEAD`,
      ]);
      return [...new Set([...splitZ(r.stdout), ...(await port.changedFiles())])].sort();
    },
    async diffAgainst(baseRef) {
      return (await git("diff", ["diff", "--no-color", "--no-renames", `${baseRef}...HEAD`]))
        .stdout;
    },
    async commitAll(message) {
      await git("add", ["add", "-A"]);
      await git("commit", ["commit", "--no-verify", "-m", message]);
      return port.headSha();
    },
    async rebaseOnto(baseRef) {
      const r = await git("rebase", ["rebase", baseRef], true);
      if (r.code === 0) return true;
      await git("rebase", ["rebase", "--abort"], true);
      return false;
    },
    async createBundle(file) {
      await git("bundle", ["bundle", "create", file, "HEAD"]);
    },
    async importBundle(file, branch) {
      await git("fetch", ["fetch", "--no-tags", file, `+HEAD:refs/heads/${branch}`]);
      await git("checkout", ["checkout", branch]);
    },
    async push(branch, token) {
      const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
      await git("push", [
        "-c",
        `http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth}`,
        "push",
        "--force",
        "origin",
        `HEAD:refs/heads/${branch}`,
      ]);
    },
    async headSha() {
      return (await git("rev-parse", ["rev-parse", "HEAD"])).stdout.trim();
    },
  };
  return port;
}
