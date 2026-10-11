import { describe, expect, it } from "vitest";
import { createFakeAdapter, loadFakeScript } from "../src/agents/fake";
import { runPhase } from "../src/stages/phased";
import { triageStage } from "../src/stages/triage";
import { BOT, makeTestDeps } from "./helpers";

describe("triage stage", () => {
  it("comments the triage result, labels the type and moves new → triaged", async () => {
    const pi = createFakeAdapter(loadFakeScript("triage-feature"), "pi");
    const h = makeTestDeps({ adapters: { pi } });
    h.gh.addIssue({ title: "기존 이슈" });
    const issue = h.gh.addIssue({
      title: "태그 목록 API",
      body: "GET /api/tags 구현",
      author: "outsider",
    });
    await runPhase(triageStage, "all", h.deps, { issue: issue.number }, null);
    const after = await h.gh.getIssue(issue.number);
    expect(after.labels.sort()).toEqual(["factory:triaged", "type:feature"]);
    const comment = (await h.gh.listComments(issue.number))[0]!;
    expect(comment.author).toBe(BOT);
    expect(comment.body).toContain("tests/realworld/skip.txt에서 tags.hurl");
    expect(pi.calls[0]?.readOnly).toBe(true);
    expect(pi.calls[0]?.prompt).toContain("#1 기존 이슈");
    expect(pi.calls[0]?.budget).toEqual({ maxTurns: 10, timeoutMs: 300_000, maxUsd: 0.2 });
    const runs = await h.deps.runs.since(new Date(0));
    expect(runs).toMatchObject([
      {
        role: "triage",
        engine: "pi",
        model: "deepseek/deepseek-flash",
        ok: true,
        issue: issue.number,
      },
    ]);
  });

  it("skips issues that are not new, pull requests and issues opened by the bot", async () => {
    const pi = createFakeAdapter([], "pi");
    const h = makeTestDeps({ adapters: { pi } });
    const triaged = h.gh.addIssue({ title: "t", labels: ["factory:triaged"] });
    const alert = h.gh.addIssue({ title: "차단기", author: BOT, labels: ["factory:alert"] });
    for (const n of [triaged.number, alert.number])
      await runPhase(triageStage, "all", h.deps, { issue: n }, null);
    expect(pi.calls).toHaveLength(0);
  });

  it("moves to needs-human with the reason when the output stays invalid", async () => {
    const pi = createFakeAdapter(
      [{ result: { summary: "nope" } }, { result: { summary: "{}" } }],
      "pi",
    );
    const h = makeTestDeps({ adapters: { pi } });
    const issue = h.gh.addIssue({ title: "t" });
    await runPhase(triageStage, "all", h.deps, { issue: issue.number }, null);
    expect((await h.gh.getIssue(issue.number)).labels).toEqual(["factory:needs-human"]);
    expect((await h.gh.listComments(issue.number))[0]?.body).toContain("출력 형식 오류");
    expect((await h.deps.runs.since(new Date(0)))[0]?.failureReason).toBe("invalid_output");
  });

  it("keeps exactly one type label when another type label already exists", async () => {
    const pi = createFakeAdapter(loadFakeScript("triage-feature"), "pi");
    const h = makeTestDeps({ adapters: { pi } });
    const issue = h.gh.addIssue({ title: "t", labels: ["type:bug"] });
    await runPhase(triageStage, "all", h.deps, { issue: issue.number }, null);
    expect((await h.gh.getIssue(issue.number)).labels.sort()).toEqual([
      "factory:triaged",
      "type:feature",
    ]);
  });

  it("does nothing in publish when the state changed after prepare", async () => {
    const pi = createFakeAdapter(loadFakeScript("triage-feature"), "pi");
    const h = makeTestDeps({ adapters: { pi } });
    const issue = h.gh.addIssue({ title: "t" });
    const plan = (await triageStage.prepare(h.deps, { issue: issue.number }))!;
    const outcome = await triageStage.agent(h.deps, plan);
    await h.gh.removeLabel(issue.number, "factory:new").catch(() => {});
    await h.gh.addLabels(issue.number, ["factory:approved"]);
    await triageStage.publish(h.deps, plan, outcome);
    expect((await h.gh.getIssue(issue.number)).labels).toEqual(["factory:approved"]);
    expect(await h.gh.listComments(issue.number)).toEqual([]);
    expect(await h.deps.runs.since(new Date(0))).toEqual([]);
  });
});
