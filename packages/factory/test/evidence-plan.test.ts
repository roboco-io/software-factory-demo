import { describe, expect, it } from "vitest";
import { TooManyFilesError, type ChangedFile } from "../src/github/port";
import { EvidencePlanSchema, runEvidencePlan } from "../src/stages/evidence";
import { makeTestDeps, openBotPr, type TestHarness } from "./helpers";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

async function bugPr(h: TestHarness, files: (string | ChangedFile)[]) {
  const opened = await openBotPr(h, {}, files);
  await h.gh.addLabels(opened.issue, ["type:bug"]);
  h.gh.setBranch(opened.branch, HEAD, files);
  return opened;
}

describe("runEvidencePlan", () => {
  it("does not require evidence for a PR without a factory marker", async () => {
    const h = makeTestDeps();
    h.gh.setBranch("feature/x", HEAD, ["apps/api/test/a.test.ts"]);
    const pr = await h.gh.createPull({
      title: "human",
      body: "사람이 연 PR",
      head: "feature/x",
      base: "main",
      draft: false,
    });
    h.gh.pulls.get(pr)!.author = "serithemage";
    const plan = await runEvidencePlan(h.deps, { pr, baseSha: BASE, headSha: HEAD });
    expect(plan).toMatchObject({ required: false, testFiles: [], reasonCode: "not_bug" });
  });

  it("ignores a human-authored PR even when its body carries a valid marker", async () => {
    const h = makeTestDeps();
    const { pr } = await bugPr(h, ["apps/api/test/a.test.ts"]);
    h.gh.pulls.get(pr)!.author = "serithemage";
    expect(await runEvidencePlan(h.deps, { pr, baseSha: BASE, headSha: HEAD })).toMatchObject({
      required: false,
      testFiles: [],
      reasonCode: "not_bug",
    });
  });

  it("requires evidence with an empty list when more than 200 test files changed", async () => {
    const h = makeTestDeps();
    const files = Array.from({ length: 201 }, (_, i) => `apps/api/test/t${i}.test.ts`);
    const { pr } = await bugPr(h, files);
    const plan = await runEvidencePlan(h.deps, { pr, baseSha: BASE, headSha: HEAD });
    expect(plan).toMatchObject({
      required: true,
      testFiles: [],
      reason: "테스트 파일이 200개를 넘어 확정할 수 없다.",
      reasonCode: "unknown_state",
    });
    EvidencePlanSchema.parse(plan);
  });

  it("requires evidence with an empty list when the head moves while files are listed", async () => {
    const h = makeTestDeps();
    const { pr, branch } = await bugPr(h, ["apps/api/test/a.test.ts"]);
    const list = h.gh.listPullFiles.bind(h.gh);
    h.gh.listPullFiles = async (n: number) => {
      const r = await list(n);
      h.gh.setBranch(branch, "d".repeat(40), ["apps/api/test/a.test.ts"]);
      return r;
    };
    const plan = await runEvidencePlan(h.deps, { pr, baseSha: BASE, headSha: HEAD });
    expect(plan).toMatchObject({ required: true, testFiles: [], reasonCode: "unknown_state" });
    expect(plan.reason).toContain("PR head가");
  });

  it("drops files whose raw name contains a backslash instead of normalizing them", async () => {
    const h = makeTestDeps();
    const { pr } = await bugPr(h, ["apps\\api\\test\\a.test.ts", "apps/api/test/b.test.ts"]);
    const plan = await runEvidencePlan(h.deps, { pr, baseSha: BASE, headSha: HEAD });
    expect(plan.testFiles).toEqual(["apps/api/test/b.test.ts"]);
    expect(plan.reasonCode).toBe("evaluated");
  });

  it("reports no_test_files when a bug PR changes no test file", async () => {
    const h = makeTestDeps();
    const { pr } = await bugPr(h, ["apps/api/src/a.ts"]);
    expect(await runEvidencePlan(h.deps, { pr, baseSha: BASE, headSha: HEAD })).toMatchObject({
      required: true,
      testFiles: [],
      reasonCode: "no_test_files",
    });
  });

  it("does not require evidence when the linked issue is not type:bug", async () => {
    const h = makeTestDeps();
    const { pr, branch } = await openBotPr(h);
    h.gh.setBranch(branch, HEAD, ["apps/api/test/a.test.ts"]);
    expect(await runEvidencePlan(h.deps, { pr, baseSha: BASE, headSha: HEAD })).toMatchObject({
      required: false,
    });
  });

  it("lists added, modified and renamed test files of a bug PR, skipping removed and non-test files", async () => {
    const h = makeTestDeps();
    const { pr, issue } = await bugPr(h, [
      "apps/web/src/components/ArticleList.tsx",
      "apps/web/src/components/ArticleList.test.tsx",
      {
        filename: "apps/api/test/new-name.test.ts",
        previousFilename: "apps/api/test/old-name.test.ts",
        additions: [],
      },
      { filename: "apps/api/test/gone.test.ts", additions: [], removed: true },
      "apps/api/test/helpers.ts",
      "apps/web/e2e/x.spec.ts",
      "README.md",
    ]);
    const plan = await runEvidencePlan(h.deps, { pr, baseSha: BASE, headSha: HEAD });
    expect(plan).toEqual({
      pr,
      required: true,
      reasonCode: "evaluated",
      reason: `연결 이슈 #${issue}가 type:bug다. PR이 추가·수정한 테스트 파일 4개로 판정한다.`,
      baseSha: BASE,
      headSha: HEAD,
      testFiles: [
        "apps/api/test/helpers.ts",
        "apps/api/test/new-name.test.ts",
        "apps/web/e2e/x.spec.ts",
        "apps/web/src/components/ArticleList.test.tsx",
      ],
    });
    expect(EvidencePlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });

  it("requires evidence but lists no files when the PR head moved after the event", async () => {
    const h = makeTestDeps();
    const { pr, branch } = await bugPr(h, ["apps/api/test/a.test.ts"]);
    h.gh.setBranch(branch, "c".repeat(40), ["apps/api/test/a.test.ts"]);
    const plan = await runEvidencePlan(h.deps, { pr, baseSha: BASE, headSha: HEAD });
    expect(plan).toMatchObject({ required: true, testFiles: [] });
    expect(plan.reason).toContain("PR head가");
  });

  it("requires evidence but lists no files when GitHub cannot list every changed file", async () => {
    const h = makeTestDeps();
    const { pr } = await bugPr(h, ["apps/api/test/a.test.ts"]);
    h.gh.listPullFiles = async () => {
      throw new TooManyFilesError("too many");
    };
    expect(await runEvidencePlan(h.deps, { pr, baseSha: BASE, headSha: HEAD })).toMatchObject({
      required: true,
      testFiles: [],
    });
  });
});

describe("EvidencePlanSchema", () => {
  const ok = {
    pr: 1,
    required: true,
    reason: "r",
    reasonCode: "evaluated",
    baseSha: BASE,
    headSha: HEAD,
    testFiles: ["apps/api/test/a.test.ts"],
  };
  it.each([
    ["path traversal", { ...ok, testFiles: ["apps/api/test/../../../etc/passwd"] }],
    ["non-test path", { ...ok, testFiles: ["apps/api/src/index.ts"] }],
    ["short sha", { ...ok, headSha: "abc" }],
    ["unknown reasonCode", { ...ok, reasonCode: "x" }],
    ["missing field", { pr: 1, required: true }],
  ])("rejects %s", (_name, value) => {
    expect(EvidencePlanSchema.safeParse(value).success).toBe(false);
  });
});
