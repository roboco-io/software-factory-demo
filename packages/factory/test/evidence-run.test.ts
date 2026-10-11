import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess, type SpawnFn } from "../src/exec/process";
import { renderEvidenceText, runEvidence, type EvidencePlan } from "../src/stages/evidence";
import { makeTestDeps, type TestHarness } from "./helpers";

const SRC = "apps/web/src/pages.ts";
const TEST = "apps/web/src/pages.test.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

function put(dir: string, file: string, content: string): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), content);
}

// base: 버그가 있는 코드와 예전 테스트. head: 고친 코드와 새 재현 테스트.
function setup(): { h: TestHarness; base: string; head: string } {
  const h = makeTestDeps({
    settings: { env: { PATH: process.env.PATH, HOME: process.env.HOME } },
  });
  git(h.dir, "init", "-q", "-b", "main");
  put(h.dir, SRC, "export const pages = (n: number) => Math.floor(n / 10);\n");
  put(h.dir, TEST, "// base test\n");
  git(h.dir, "add", "-A");
  git(h.dir, "commit", "-qm", "base");
  const base = git(h.dir, "rev-parse", "HEAD");
  put(h.dir, SRC, "export const pages = (n: number) => Math.ceil(n / 10);\n");
  put(h.dir, TEST, "// head reproduction test\n");
  git(h.dir, "add", "-A");
  git(h.dir, "commit", "-qm", "head");
  return { h, base, head: git(h.dir, "rev-parse", "HEAD") };
}

interface Seen {
  where: "base" | "head";
  args: string[];
  src: string;
  test: string;
}

// git은 실제로 실행하고, pnpm install은 성공, vitest는 트리별 종료 코드를 돌려준다.
function fakeSpawn(
  h: TestHarness,
  codes: { base: number | null; head: number | null },
  seen: Seen[],
): SpawnFn {
  return async (cmd, args, opts) => {
    if (cmd === "git") return runProcess(cmd, args, opts);
    if (args[0] === "install") return { code: 0, stdout: "", stderr: "" };
    const where = opts.cwd === h.dir ? "head" : "base";
    seen.push({
      where,
      args: [...args],
      src: readFileSync(path.join(opts.cwd, SRC), "utf8"),
      test: readFileSync(path.join(opts.cwd, TEST), "utf8"),
    });
    const code = codes[where];
    return { code, stdout: `${where} vitest`, stderr: "" };
  };
}

const plan = (base: string, head: string, over: Partial<EvidencePlan> = {}): EvidencePlan => ({
  pr: 7,
  required: true,
  reason: "연결 이슈 #6가 type:bug다.",
  reasonCode: "evaluated",
  baseSha: base,
  headSha: head,
  testFiles: [TEST],
  ...over,
});

describe("runEvidence", () => {
  it("runs the head test on the base tree (must fail) and on the head tree (must pass)", async () => {
    const { h, base, head } = setup();
    const seen: Seen[] = [];
    h.deps.spawn = fakeSpawn(h, { base: 1, head: 0 }, seen);
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.ok).toBe(true);
    expect(r.reasonCode).toBe("evaluated");
    expect(seen.map((s) => s.where)).toEqual(["base", "head"]);
    // base 트리에는 버그 코드가 그대로 있고, 테스트만 head 버전으로 덮였다.
    expect(seen[0]!.src).toContain("Math.floor");
    expect(seen[0]!.test).toBe("// head reproduction test\n");
    expect(seen[1]!.src).toContain("Math.ceil");
    expect(seen[0]!.args).toEqual([
      "--filter",
      "web",
      "exec",
      "vitest",
      "run",
      "src/pages.test.ts",
    ]);
    expect(r.suites).toMatchObject([{ suite: "web", baseCode: 1, headCode: 0 }]);
    // 임시 worktree는 정리된다.
    expect(git(h.dir, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("fails when the reproduction test also passes on the base tree", async () => {
    const { h, base, head } = setup();
    h.deps.spawn = fakeSpawn(h, { base: 0, head: 0 }, []);
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("수정 전(base) 코드에서도 통과");
  });

  it("fails when the test does not pass on the head tree", async () => {
    const { h, base, head } = setup();
    h.deps.spawn = fakeSpawn(h, { base: 1, head: 1 }, []);
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("수정 후(head) 코드에서 실패");
  });

  it("does not count a killed or timed-out base run as a reproduction", async () => {
    const { h, base, head } = setup();
    h.deps.spawn = fakeSpawn(h, { base: null, head: 0 }, []);
    const r = await runEvidence(h.deps, plan(base, head));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("시간 제한");
  });

  it("passes immediately without running anything when evidence is not required", async () => {
    const { h, base, head } = setup();
    const seen: Seen[] = [];
    h.deps.spawn = fakeSpawn(h, { base: 1, head: 0 }, seen);
    const r = await runEvidence(
      h.deps,
      plan(base, head, { required: false, reasonCode: "not_bug", testFiles: [] }),
    );
    expect(r.ok).toBe(true);
    expect(seen).toEqual([]);
  });

  it("fails a bug PR without test files and a bug PR with only e2e specs", async () => {
    const { h, base, head } = setup();
    const seen: Seen[] = [];
    h.deps.spawn = fakeSpawn(h, { base: 1, head: 0 }, seen);
    const none = await runEvidence(
      h.deps,
      plan(base, head, { reasonCode: "no_test_files", testFiles: [] }),
    );
    expect(none.ok).toBe(false);
    expect(none.reason).toContain("테스트 파일 변경이 없다");
    const e2e = await runEvidence(
      h.deps,
      plan(base, head, { testFiles: ["apps/web/e2e/a.spec.ts"] }),
    );
    expect(e2e.ok).toBe(false);
    expect(e2e.unsupported).toEqual(["apps/web/e2e/a.spec.ts"]);
    expect(e2e.reason).toContain("Playwright E2E");
    expect(seen).toEqual([]);
  });

  // 판정 T2-a: required인데 테스트 파일이 없으면 reasonCode와 관계없이 실패하고, 출력에 reasonCode가 있다.
  it("fails a required plan with no test files for any reasonCode and reports the code", async () => {
    const { h, base, head } = setup();
    const seen: Seen[] = [];
    h.deps.spawn = fakeSpawn(h, { base: 1, head: 0 }, seen);
    for (const reasonCode of ["unknown_state", "no_test_files", "evaluated", "not_bug"] as const) {
      const r = await runEvidence(h.deps, plan(base, head, { reasonCode, testFiles: [] }));
      expect(r.ok).toBe(false);
      expect(r.reasonCode).toBe(reasonCode);
      expect(renderEvidenceText(r)).toContain(`reasonCode=${reasonCode}`);
    }
    expect(seen).toEqual([]);
  });

  it("refuses unsafe paths that bypassed the schema before running anything", async () => {
    const { h, base, head } = setup();
    const seen: Seen[] = [];
    h.deps.spawn = fakeSpawn(h, { base: 1, head: 0 }, seen);
    for (const bad of ["apps/web/src/-x.test.ts", "apps/web/../../x.test.ts", "notes.md"]) {
      const r = await runEvidence(h.deps, plan(base, head, { testFiles: [TEST, bad] }));
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("안전하지 않은 테스트 파일 경로");
    }
    expect(seen).toEqual([]);
    expect(git(h.dir, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("refuses to judge when the checked-out head is not the planned head", async () => {
    const { h, base } = setup();
    h.deps.spawn = fakeSpawn(h, { base: 1, head: 0 }, []);
    const r = await runEvidence(h.deps, plan(base, base));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("판정 대상");
  });
});
