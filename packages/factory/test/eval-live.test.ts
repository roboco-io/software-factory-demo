import { appendFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFakeAdapter } from "../src/agents/fake";
import type { SpawnFn } from "../src/exec/process";
import { FACTORY_DIR } from "../src/paths";
import { replaceMeta } from "../src/report/pr";
import { writeMarker } from "../src/report/text";
import { IMPROVE_MARKER } from "../src/stages/collect";
import { evalLiveStage, renderEvalLiveComment } from "../src/stages/eval-live";
import { runPhase } from "../src/stages/phased";
import { BOT, makeTestDeps, type TestHarness } from "./helpers";

const HEAD_SHA = "c".repeat(40);
const MERGE_BASE = "d".repeat(40);
const HEAD_RULE = "HEAD-RULE-MARKER";

const review = (categories: string[]) => ({
  result: {
    summary: JSON.stringify({
      verdict: categories.length > 0 ? "REQUEST_CHANGES" : "APPROVE",
      summary: "리뷰 요약",
      findings: categories.map((category) => ({
        file: "apps/api/src/routes/tags.ts",
        line: 3,
        severity: "major",
        message: "오류 형식이 다르다",
        category,
      })),
    }),
    costUsd: 0.25,
  },
});

// git worktree add는 factory/prompts를 복사한 트리를 만든다. head 트리의 프롬프트에는 표식을 덧붙인다.
function fakeSpawn(calls: string[]): SpawnFn {
  return async (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "git" && args[0] === "worktree" && args[1] === "add") {
      const dir = args.at(-2)!;
      const sha = args.at(-1)!;
      mkdirSync(path.join(dir, "factory"), { recursive: true });
      cpSync(path.join(FACTORY_DIR, "prompts"), path.join(dir, "factory/prompts"), {
        recursive: true,
      });
      if (sha === HEAD_SHA) {
        for (const f of ["implement.md", "review.md"])
          appendFileSync(path.join(dir, "factory/prompts", f), `\n${HEAD_RULE}\n`);
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "git" && args[0] === "merge-base") {
      return { code: 0, stdout: `${MERGE_BASE}\n`, stderr: "" };
    }
    if (cmd === "git" && args[0] === "diff") {
      return { code: 0, stdout: "diff --git a/x.ts b/x.ts\n+++ b/x.ts\n+x", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

async function improvePr(
  h: TestHarness,
  opts: { key?: string; role?: "improve" | "implement" } = {},
): Promise<{ pr: number; issue: number }> {
  const issue = h.gh.addIssue({ title: "태그 목록 API", labels: ["type:feature"] }).number;
  h.gh.setBranch("factory/issue-90", HEAD_SHA, ["AGENTS.md"]);
  const body = replaceMeta(
    `개선\n\n${writeMarker(IMPROVE_MARKER, { key: opts.key ?? "review:error-format" })}`,
    {
      issue: 90,
      role: opts.role ?? "improve",
      implementEngine: "claude",
      implementModel: "claude-sonnet-5-5",
      round: 0,
    },
  );
  const pr = await h.gh.createPull({
    title: "오류 형식 규칙",
    body,
    head: "factory/issue-90",
    base: "main",
    draft: false,
  });
  return { pr, issue };
}

const prComments = async (h: TestHarness, pr: number) =>
  (await h.gh.listComments(pr)).filter((c) => c.author === BOT).map((c) => c.body);

describe("eval-live", () => {
  it("re-runs implement and review on base and head rules and comments the comparison without recording runs", async () => {
    const calls: string[] = [];
    const implement = createFakeAdapter([
      { writeFiles: { "x.ts": "base\n" }, result: { summary: "구현", costUsd: 1 } },
      { writeFiles: { "x.ts": "head\n" }, result: { summary: "구현", costUsd: 1.5 } },
    ]);
    const reviewer = createFakeAdapter([review(["error-format", "style"]), review(["style"])]);
    const h = makeTestDeps({
      adapters: { claude: implement, codex: reviewer },
      spawn: fakeSpawn(calls),
    });
    const { pr, issue } = await improvePr(h);

    await runPhase(evalLiveStage, "all", h.deps, { pr, issue }, null);

    // 사이드마다 자기 트리의 프롬프트로 렌더하고, 그 트리에서 에이전트를 돌린다.
    expect(implement.calls.map((c) => c.prompt.includes(HEAD_RULE))).toEqual([false, true]);
    expect(reviewer.calls.map((c) => c.prompt.includes(HEAD_RULE))).toEqual([false, true]);
    expect(implement.calls.map((c) => c.readOnly)).toEqual([false, false]);
    expect(reviewer.calls.map((c) => c.readOnly)).toEqual([true, true]);
    expect(implement.calls[0]!.cwd).not.toBe(implement.calls[1]!.cwd);
    expect(reviewer.calls[1]!.cwd).toBe(implement.calls[1]!.cwd);
    expect(implement.calls[0]!.prompt).toContain(`이슈 #${issue}`);

    const adds = calls.filter((c) => c.startsWith("git worktree add"));
    expect(adds).toHaveLength(2);
    expect(adds[0]).toContain(MERGE_BASE);
    expect(calls).toContain(`git merge-base origin/main ${HEAD_SHA}`);
    expect(adds[1]).toContain(HEAD_SHA);
    expect(calls.filter((c) => c.startsWith("git worktree remove"))).toHaveLength(2);
    expect(calls.filter((c) => c === "pnpm install --frozen-lockfile")).toHaveLength(2);
    expect(calls.some((c) => /\b(commit|push)\b/.test(c))).toBe(false);
    for (const c of implement.calls) expect(existsSync(c.cwd)).toBe(false);

    const [comment] = await prComments(h, pr);
    expect(comment).toContain(
      "| 사이드 | 구현 완료 | 리뷰 범주 | 목표 범주(`review:error-format`) 재발 |",
    );
    expect(comment).toMatch(/\| base \| 예 \| [^|]*error-format[^|]* \| 예 \|/);
    expect(comment).toMatch(/\| head \| 예 \| [^|]*style[^|]* \| 아니오 \|/);
    expect(comment).toContain("$1.25");
    expect(comment).toContain("$1.75");
    expect(await h.deps.runs.since(new Date(0))).toEqual([]);
  });

  it("reports an undecidable recurrence when a side's review produced no verdict", async () => {
    const h = makeTestDeps({
      adapters: {
        claude: createFakeAdapter([{ writeFiles: { "x.ts": "a\n" } }, { result: { ok: false } }]),
        codex: createFakeAdapter([review(["error-format"])]),
      },
      spawn: fakeSpawn([]),
    });
    const { pr, issue } = await improvePr(h);
    await runPhase(evalLiveStage, "all", h.deps, { pr, issue }, null);
    const [comment] = await prComments(h, pr);
    expect(comment).toMatch(/\| base \| 예 \| [^|]* \| 예 \|/);
    expect(comment).toMatch(/\| head \| 아니오 \| [^|]* \| 판정 불가 \|/);
  });

  it("neutralizes agent-controlled text in the comment", () => {
    const plan = {
      pr: 1,
      issue: 2,
      key: "review:error-format",
      baseSha: "a".repeat(40),
      headSha: HEAD_SHA,
      implementVars: {},
      issueTitle: "t",
      acceptanceCriteria: [],
      implement: { engine: "claude" as const, model: "m", budget: { maxTurns: 1, timeoutMs: 1 } },
      review: { engine: "codex" as const, model: "m", budget: { maxTurns: 1, timeoutMs: 1 } },
    };
    const out = evalLiveStage.parseOutcome({
      baseSha: "a".repeat(40),
      baseIsMergeBase: true,
      sides: [
        {
          side: "base",
          implemented: true,
          reviewed: true,
          categories: ["error-format"],
          costUsd: null,
          note: "fixes #3 @someone | <!-- x -->",
        },
        {
          side: "head",
          implemented: true,
          reviewed: true,
          categories: [],
          costUsd: 0,
          note: "",
        },
      ],
    });
    expect(() =>
      evalLiveStage.parseOutcome({ ...out, sides: [{ ...out.sides[0], side: "other" }] }),
    ).toThrow();
    const md = renderEvalLiveComment(plan, out);
    expect(md).not.toContain("@someone");
    expect(md).not.toContain("<!--");
    expect(md).not.toMatch(/fixes #3/);
  });

  it.each([
    ["an implement PR", { role: "implement" as const }],
    ["an improve PR whose key is not a review category", { key: "check:typecheck" }],
  ])("does nothing but explain itself for %s", async (_name, opts) => {
    const h = makeTestDeps({ spawn: fakeSpawn([]) });
    const { pr, issue } = await improvePr(h, opts);
    expect(await evalLiveStage.prepare(h.deps, { pr, issue })).toBeNull();
    const [comment] = await prComments(h, pr);
    expect(comment).toContain("eval-live");
  });

  it.each([
    ["a human PR", (h: TestHarness, pr: number) => (h.gh.pulls.get(pr)!.author = "someone")],
    ["a closed PR", (h: TestHarness, pr: number) => (h.gh.pulls.get(pr)!.state = "closed")],
  ])("skips with an explanatory comment for %s", async (_name, mutate) => {
    const h = makeTestDeps({ spawn: fakeSpawn([]) });
    const { pr, issue } = await improvePr(h);
    mutate(h, pr);
    expect(await evalLiveStage.prepare(h.deps, { pr, issue })).toBeNull();
    const [comment] = await prComments(h, pr);
    expect(comment).toContain("eval-live를 실행하지 않았다.");
  });

  it("skips with the pause reason and runs no agent when the factory is paused", async () => {
    const implement = createFakeAdapter([]);
    const h = makeTestDeps({
      adapters: { claude: implement, codex: createFakeAdapter([]) },
      spawn: fakeSpawn([]),
      settings: { paused: true },
    });
    const { pr, issue } = await improvePr(h);
    expect(await evalLiveStage.prepare(h.deps, { pr, issue })).toBeNull();
    const [comment] = await prComments(h, pr);
    expect(comment).toContain("eval-live를 실행하지 않았다.");
    expect(comment).toContain("FACTORY_PAUSED");
    expect(implement.calls).toHaveLength(0);
  });

  it("falls back to the prepare-time origin/main and says so when the agent-phase merge-base fails", async () => {
    const calls: string[] = [];
    const inner = fakeSpawn(calls);
    const spawn: SpawnFn = async (cmd, args, o) =>
      cmd === "git" && args[0] === "merge-base"
        ? (calls.push(`git ${args.join(" ")}`), { code: 1, stdout: "", stderr: "bad object" })
        : inner(cmd, args, o);
    const h = makeTestDeps({
      adapters: {
        claude: createFakeAdapter([
          { writeFiles: { "x.ts": "a\n" } },
          { writeFiles: { "x.ts": "b\n" } },
        ]),
        codex: createFakeAdapter([review([]), review([])]),
      },
      spawn,
    });
    const { pr, issue } = await improvePr(h);
    const plan = await evalLiveStage.prepare(h.deps, { pr, issue });
    // prepare는 merge-base를 구하지 않는다.
    expect(calls.some((c) => c.startsWith("git merge-base"))).toBe(false);
    expect(plan).toMatchObject({ baseSha: h.git.baseSha });
    const out = await evalLiveStage.agent(h.deps, plan!);
    expect(out).toMatchObject({ baseSha: h.git.baseSha, baseIsMergeBase: false });
    expect(calls.filter((c) => c.startsWith("git worktree add"))[0]).toContain(h.git.baseSha);
    expect(renderEvalLiveComment(plan!, out)).toContain(
      "merge-base로 구하지 못해 현재 origin/main을 썼다",
    );
  });

  it("records the agent-phase merge-base in the outcome and the comment", async () => {
    const h = makeTestDeps({
      adapters: {
        claude: createFakeAdapter([
          { writeFiles: { "x.ts": "a\n" } },
          { writeFiles: { "x.ts": "b\n" } },
        ]),
        codex: createFakeAdapter([review([]), review([])]),
      },
      spawn: fakeSpawn([]),
    });
    const { pr, issue } = await improvePr(h);
    const plan = await evalLiveStage.prepare(h.deps, { pr, issue });
    const out = await evalLiveStage.agent(h.deps, plan!);
    expect(out).toMatchObject({ baseSha: MERGE_BASE, baseIsMergeBase: true });
    const md = renderEvalLiveComment(plan!, out);
    expect(md).toContain(MERGE_BASE.slice(0, 7));
    expect(md).not.toContain("merge-base로 구하지 못해");
  });
});
