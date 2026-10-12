import { describe, expect, it } from "vitest";
import type { RunRecord } from "../src/runs/store";
import { evaluateBreaker, runGuard } from "../src/stages/guard";
import { makeTestDeps, type TestHarness } from "./helpers";

const run = (ts: string, ok: boolean, role: RunRecord["role"] = "implement"): RunRecord => ({
  ts,
  issue: 1,
  pr: null,
  role,
  engine: "claude",
  model: "m",
  ok,
  turns: 1,
  costUsd: null,
  durationMs: 1,
  failureReason: ok ? null : "timeout",
  round: 0,
});

async function seed(h: TestHarness, records: RunRecord[]) {
  for (const r of records) await h.deps.runs.append(r);
}

const NOW = new Date("2026-10-12T03:00:00.000Z");

describe("evaluateBreaker", () => {
  it("trips at 10+ implement/fix runs in 7 days with a success rate below 50%", () => {
    const runs = [
      ...Array.from({ length: 6 }, () => run("2026-10-10T00:00:00.000Z", false)),
      ...Array.from({ length: 4 }, () => run("2026-10-11T00:00:00.000Z", true, "fix")),
      run("2026-10-11T00:00:00.000Z", false, "review"),
    ];
    expect(evaluateBreaker(runs, NOW)).toEqual({
      total: 10,
      succeeded: 4,
      successRate: 0.4,
      tripped: true,
    });
  });

  it("does not trip with fewer than 10 runs, at exactly 50%, or for runs older than 7 days", () => {
    expect(
      evaluateBreaker(
        Array.from({ length: 9 }, () => run("2026-10-11T00:00:00.000Z", false)),
        NOW,
      ).tripped,
    ).toBe(false);
    const half = [
      ...Array.from({ length: 5 }, () => run("2026-10-11T00:00:00.000Z", false)),
      ...Array.from({ length: 5 }, () => run("2026-10-11T00:00:00.000Z", true)),
    ];
    expect(evaluateBreaker(half, NOW).tripped).toBe(false);
    expect(
      evaluateBreaker(
        Array.from({ length: 12 }, () => run("2026-10-04T00:00:00.000Z", false)),
        NOW,
      ).total,
    ).toBe(0);
  });
});

describe("runGuard", () => {
  it("reconciles the board even while paused and reports the count", async () => {
    const h = makeTestDeps({ now: NOW, settings: { paused: true } });
    const a = await h.gh.createIssue("a", "", ["factory:in-review"]);
    const r = await runGuard(h.deps);
    expect(r.board).toBe(1);
    expect(h.gh.board.get(a)).toBe("in-review");
  });

  it("sets FACTORY_PAUSED and opens one alert issue when the breaker trips", async () => {
    const h = makeTestDeps({ now: NOW });
    await seed(
      h,
      Array.from({ length: 10 }, () => run("2026-10-11T00:00:00.000Z", false)),
    );
    const r = await runGuard(h.deps);
    expect(r).toMatchObject({ paused: true, resumed: [], breaker: { tripped: true } });
    expect(h.gh.variables.get("FACTORY_PAUSED")).toBe("true");
    const alerts = (await h.gh.listOpenIssues()).filter((i) => i.labels.includes("factory:alert"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toContain("성공률 0%");
  });

  it("does not raise a second alert while already paused", async () => {
    const h = makeTestDeps({ now: NOW, settings: { paused: true } });
    await seed(
      h,
      Array.from({ length: 10 }, () => run("2026-10-11T00:00:00.000Z", false)),
    );
    await runGuard(h.deps);
    expect(h.gh.variables.size).toBe(0);
    expect(await h.gh.listOpenIssues()).toHaveLength(0);
  });

  it("re-dispatches approved issues without a PR, up to the remaining daily capacity", async () => {
    const h = makeTestDeps({ now: NOW, settings: { dailyLimit: 3 } });
    await seed(h, [run("2026-10-12T01:00:00.000Z", true), run("2026-10-11T23:00:00.000Z", true)]);
    const a = h.gh.addIssue({ title: "a", labels: ["factory:approved"] });
    const withPr = h.gh.addIssue({ title: "b", labels: ["factory:approved"] });
    const c = h.gh.addIssue({ title: "c", labels: ["factory:approved"] });
    const d = h.gh.addIssue({ title: "d", labels: ["factory:approved"] });
    h.gh.setBranch(`factory/issue-${withPr.number}`, "s", ["x"]);
    await h.gh.createPull({
      title: "p",
      body: "",
      head: `factory/issue-${withPr.number}`,
      base: "main",
      draft: false,
    });
    const r = await runGuard(h.deps);
    expect(r.resumed).toEqual([a.number, c.number]);
    expect(h.gh.dispatches.map((x) => x.inputs.issue)).toEqual([
      String(a.number),
      String(c.number),
    ]);
    expect(r.resumed).not.toContain(d.number);
  });

  it("does not resume anything while paused", async () => {
    const h = makeTestDeps({ now: NOW, settings: { paused: true } });
    h.gh.addIssue({ title: "a", labels: ["factory:approved"] });
    expect((await runGuard(h.deps)).resumed).toEqual([]);
  });

  it("counts in-progress issues against the daily capacity", async () => {
    const h = makeTestDeps({ now: NOW, settings: { dailyLimit: 3 } });
    await seed(h, [run("2026-10-12T01:00:00.000Z", true)]);
    h.gh.addIssue({ title: "running", labels: ["factory:in-progress"] });
    const a = h.gh.addIssue({ title: "a", labels: ["factory:approved"] });
    h.gh.addIssue({ title: "b", labels: ["factory:approved"] });
    expect((await runGuard(h.deps)).resumed).toEqual([a.number]);
  });

  it("is idempotent: a second guard run adds no dispatch beyond capacity and no second alert", async () => {
    const h = makeTestDeps({ now: NOW, settings: { dailyLimit: 2 } });
    h.gh.addIssue({ title: "a", labels: ["factory:approved"] });
    h.gh.addIssue({ title: "b", labels: ["factory:approved"] });
    h.gh.addIssue({ title: "c", labels: ["factory:approved"] });
    await runGuard(h.deps);
    expect(h.gh.dispatches).toHaveLength(2);
    // dispatch된 이슈는 implement가 in-progress로 옮긴다.
    for (const d of h.gh.dispatches) {
      await h.gh.removeLabel(Number(d.inputs.issue), "factory:approved");
      await h.gh.addLabels(Number(d.inputs.issue), ["factory:in-progress"]);
    }
    expect((await runGuard(h.deps)).resumed).toEqual([]);
    expect(h.gh.dispatches).toHaveLength(2);

    const t = makeTestDeps({ now: NOW });
    await seed(
      t,
      Array.from({ length: 10 }, () => run("2026-10-11T00:00:00.000Z", false)),
    );
    await runGuard(t.deps);
    t.deps.settings.paused = true;
    await runGuard(t.deps);
    t.deps.settings.paused = false;
    await runGuard(t.deps);
    const alerts = (await t.gh.listOpenIssues()).filter((i) => i.labels.includes("factory:alert"));
    expect(alerts).toHaveLength(1);
  });

  it("does not re-trip on old failures after a human releases the pause and closes the alert", async () => {
    const h = makeTestDeps({ now: NOW });
    await seed(
      h,
      Array.from({ length: 10 }, () => run("2026-10-11T00:00:00.000Z", false)),
    );
    await runGuard(h.deps);
    const alert = (await h.gh.listOpenIssues()).find((i) => i.labels.includes("factory:alert"))!;
    await h.gh.closeIssue(alert.number);
    h.gh.variables.set("FACTORY_PAUSED", "false");
    h.deps.settings.paused = false;
    h.setNow(new Date("2026-10-12T05:00:00.000Z"));
    const r = await runGuard(h.deps);
    expect(r).toMatchObject({ paused: false, breaker: { total: 0, tripped: false } });
    expect(h.gh.variables.get("FACTORY_PAUSED")).toBe("false");
    // 새 실패 10회는 다시 차단기를 건다.
    await seed(
      h,
      Array.from({ length: 10 }, () => run("2026-10-12T04:00:00.000Z", false)),
    );
    expect((await runGuard(h.deps)).paused).toBe(true);
  });
});
