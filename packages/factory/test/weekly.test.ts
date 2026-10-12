import { describe, expect, it } from "vitest";
import { writeMarker } from "../src/report/text";
import { DATA_BRANCH, type RunRecord } from "../src/runs/store";
import { IMPROVE_MARKER } from "../src/stages/collect";
import { IMPROVEMENTS_PATH, runWeeklyReport } from "../src/stages/weekly";
import { latestReportMarker } from "../src/stages/weekly-marker";
import { BOT, makeTestDeps, type TestHarness } from "./helpers";

const rec = (o: Partial<RunRecord>): RunRecord => ({
  ts: "2026-10-10T00:00:00.000Z",
  issue: 1,
  pr: null,
  role: "review",
  engine: "claude",
  model: "m",
  ok: true,
  turns: 1,
  costUsd: null,
  durationMs: 1,
  failureReason: null,
  round: 0,
  ...o,
});

async function seedFindings(h: TestHarness, message = "use errors.ts") {
  for (const issue of [1, 2, 3])
    await h.deps.runs.append(
      rec({
        issue,
        findings: [{ category: "error-format", file: "apps/api/src/routes/x.ts", message }],
      }),
    );
}

async function mergedImprovePr(h: TestHarness, key: string, mergedAt: string) {
  const branch = `factory/improve-${key}`;
  h.gh.setBranch(branch, "sha-i", ["factory/prompts/review.md"]);
  const n = await h.gh.createPull({
    title: "improve",
    body: `개선\n\n${writeMarker(IMPROVE_MARKER, { key })}`,
    head: branch,
    base: "main",
    draft: false,
  });
  const p = h.gh.pulls.get(n)!;
  Object.assign(p, { state: "closed", merged: true, mergedAt, labels: ["factory:improve"] });
  return n;
}

async function reportIssues(h: TestHarness) {
  return (await h.gh.listOpenIssues()).filter((i) => i.labels.includes("factory:report"));
}

describe("weekly report", () => {
  it("opens the weekly report issue with a candidates marker and records improvements", async () => {
    const h = makeTestDeps();
    await seedFindings(h);
    const pr = await mergedImprovePr(h, "review:error-format", "2026-10-08T00:00:00.000Z");

    const res = await runWeeklyReport(h.deps);

    expect(res).toEqual({ issue: res.issue, created: true, week: "2026-W42", candidates: 1 });
    const issues = await reportIssues(h);
    expect(issues).toHaveLength(1);
    const issue = issues[0]!;
    expect(issue).toMatchObject({ number: res.issue, title: "주간 리포트 2026-W42", author: BOT });
    for (const h2 of ["요약", "엔진별 성공률과 비용", "병합", "실패 사유 상위", "규칙 효과"])
      expect(issue.body).toContain(`## ${h2}`);
    const marker = latestReportMarker(issue, [], BOT);
    expect(marker?.week).toBe("2026-W42");
    expect(marker?.candidates.map((c) => c.key)).toEqual(["review:error-format"]);

    const file = await h.gh.readFile(DATA_BRANCH, IMPROVEMENTS_PATH);
    expect(JSON.parse(file!.content)).toEqual([
      { pr, key: "review:error-format", mergedAt: "2026-10-08T00:00:00.000Z" },
    ]);
    expect(h.gh.writes.at(-1)?.message).toBe("report: improvements 2026-W42");
  });

  it("comments on this week's issue on a second run, and the last marker wins", async () => {
    const h = makeTestDeps();
    const first = await runWeeklyReport(h.deps);
    expect(first.candidates).toBe(0);
    await seedFindings(h);

    const second = await runWeeklyReport(h.deps);

    expect(second).toMatchObject({ issue: first.issue, created: false, candidates: 1 });
    expect(await reportIssues(h)).toHaveLength(1);
    const comments = await h.gh.listComments(first.issue);
    expect(comments).toHaveLength(1);
    const issue = await h.gh.getIssue(first.issue);
    expect(latestReportMarker(issue, comments, BOT)?.candidates.map((c) => c.key)).toEqual([
      "review:error-format",
    ]);
  });

  it("does not reuse a report issue opened by someone else or for another week", async () => {
    const h = makeTestDeps();
    h.gh.addIssue({ title: "주간 리포트 2026-W42", labels: ["factory:report"], author: "eve" });
    h.gh.addIssue({ title: "주간 리포트 2026-W41", labels: ["factory:report"], author: BOT });
    const res = await runWeeklyReport(h.deps);
    expect(res.created).toBe(true);
    expect(await reportIssues(h)).toHaveLength(3);
  });

  it("says there is no candidate and writes an empty marker", async () => {
    const h = makeTestDeps();
    const res = await runWeeklyReport(h.deps);
    const issue = await h.gh.getIssue(res.issue);
    expect(issue.body).toContain("개선 후보 없음");
    expect(issue.body).toContain("아직 병합된 개선 PR이 없다");
    expect(latestReportMarker(issue, [], BOT)?.candidates).toEqual([]);
  });

  it("caps marker and visible candidates at 5", async () => {
    const h = makeTestDeps();
    for (let c = 0; c < 8; c++)
      for (const issue of [1, 2, 3])
        await h.deps.runs.append(
          rec({
            issue,
            findings: [{ category: `cat${c}`, file: "a.ts", message: "m" }],
          }),
        );
    const res = await runWeeklyReport(h.deps);
    const issue = await h.gh.getIssue(res.issue);
    expect(latestReportMarker(issue, [], BOT)?.candidates).toHaveLength(5);
    expect(issue.body.match(/^### review:/gm)).toHaveLength(5);
  });

  it("neutralizes mentions and closing keywords from failure samples", async () => {
    const h = makeTestDeps();
    await seedFindings(h, "ping @serithemage, fixes #1");
    const res = await runWeeklyReport(h.deps);
    const { body } = await h.gh.getIssue(res.issue);
    expect(body).not.toContain("@serithemage");
    expect(body).not.toMatch(/fixes #1/i);
    expect(body).toContain("@‍serithemage");
  });

  it("keeps the marker readable when neutralizing lengthens a long sample", async () => {
    const h = makeTestDeps();
    await seedFindings(h, "@a ".repeat(400));
    const res = await runWeeklyReport(h.deps);
    const issue = await h.gh.getIssue(res.issue);
    expect(latestReportMarker(issue, [], BOT)?.candidates).toHaveLength(1);
  });

  it("merges improvements.json by pr and retries once on a write conflict", async () => {
    const h = makeTestDeps();
    await h.deps.runs.append(rec({}));
    const old = { pr: 99, key: "smoke", mergedAt: "2026-06-01T00:00:00.000Z" };
    await h.gh.writeFile(DATA_BRANCH, IMPROVEMENTS_PATH, JSON.stringify([old]), null, "seed");
    const pr = await mergedImprovePr(h, "run:timeout", "2026-10-09T00:00:00.000Z");
    h.gh.injectConflicts = 1;

    await runWeeklyReport(h.deps);
    await runWeeklyReport(h.deps);

    const file = await h.gh.readFile(DATA_BRANCH, IMPROVEMENTS_PATH);
    expect(JSON.parse(file!.content)).toEqual([
      { pr, key: "run:timeout", mergedAt: "2026-10-09T00:00:00.000Z" },
      old,
    ]);
  });

  it("fails closed when improvements.json is unreadable and keeps the file", async () => {
    const h = makeTestDeps();
    await h.deps.runs.append(rec({}));
    await h.gh.writeFile(DATA_BRANCH, IMPROVEMENTS_PATH, "{not json", null, "seed");

    await expect(runWeeklyReport(h.deps)).rejects.toThrow(/덮어쓰지 않는다/);

    const file = await h.gh.readFile(DATA_BRANCH, IMPROVEMENTS_PATH);
    expect(file!.content).toBe("{not json");
  });
});
