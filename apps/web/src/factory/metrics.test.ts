import { describe, expect, it } from "vitest";
import type { Run } from "./data";
import {
  activeWeeks,
  categoryTrend,
  engineSummary,
  lastWeeks,
  recentRuns,
  summary,
  weeklyCompletion,
} from "./metrics";

const TS = "2026-10-07T00:00:00Z"; // 2026-W41
const run = (o: Partial<Run> & { issue: number; role: string }): Run => ({
  ts: TS,
  engine: null,
  ok: true,
  costUsd: null,
  failureReason: null,
  ...o,
});

describe("metrics", () => {
  it("lists ISO weeks oldest first", () => {
    expect(lastWeeks(new Date("2026-10-12T00:00:00Z"), 3)).toEqual([
      "2026-W40",
      "2026-W41",
      "2026-W42",
    ]);
  });
  it("counts an issue as complete only with deploy ok and no failed run (2/5)", () => {
    const runs: Run[] = [];
    for (const i of [1, 2, 3, 4, 5]) runs.push(run({ issue: i, role: "implement" }));
    for (const i of [1, 2]) runs.push(run({ issue: i, role: "deploy" }));
    runs.push(run({ issue: 3, role: "deploy" }), run({ issue: 3, role: "fix", ok: false }));
    runs.push(run({ issue: 4, role: "deploy", ok: false }));
    const [w] = weeklyCompletion(runs, ["2026-W41"]);
    expect(w).toEqual({ week: "2026-W41", k: 2, n: 5 });
  });
  it("summarizes agent runs by engine", () => {
    const runs = [
      run({ issue: 1, role: "implement", engine: "claude", costUsd: 0.5 }),
      run({ issue: 1, role: "review", engine: "claude", ok: false, costUsd: 0.25 }),
      run({ issue: 1, role: "deploy", engine: "claude" }),
    ];
    expect(engineSummary(runs)).toEqual([
      { engine: "claude", ok: 1, n: 2, costUsd: 0.75, costRuns: 2 },
    ]);
    expect(engineSummary([run({ issue: 1, role: "review", engine: "codex" })])).toEqual([
      { engine: "codex", ok: 1, n: 1, costUsd: 0, costRuns: 0 },
    ]);
  });
  it("extracts run:, review:, smoke keys and ignores policy holds and improve", () => {
    const runs = [
      run({ issue: 1, role: "implement", ok: false, failureReason: "risk_t2" }),
      run({ issue: 2, role: "implement", ok: false, failureReason: "timeout" }),
      run({ issue: 3, role: "implement", ok: false }),
      run({ issue: 4, role: "smoke", ok: false, failureReason: "x" }),
      run({ issue: 5, role: "improve", ok: false, failureReason: "boom" }),
      run({
        issue: 6,
        role: "review",
        findings: [{ category: "security" }, { category: "security" }],
      }),
    ];
    const t = categoryTrend(runs, ["2026-W41"]);
    const m = Object.fromEntries(t.map((x) => [x.key, x.counts[0]]));
    expect(m).toEqual({
      "review:security": 2,
      "run:timeout": 1,
      "run:unknown": 1,
    });
  });
  it("keeps only the top 3 categories", () => {
    const runs = ["a", "b", "c", "d"].map((r, i) =>
      run({ issue: i, role: "implement", ok: false, failureReason: r }),
    );
    expect(categoryTrend(runs, ["2026-W41"])).toHaveLength(3);
  });
  it("starts the week axis at the first week with any run, keeping at least two weeks", () => {
    const weeks = ["2026-W39", "2026-W40", "2026-W41", "2026-W42"];
    expect(activeWeeks([run({ issue: 1, role: "triage" })], weeks)).toEqual([
      "2026-W41",
      "2026-W42",
    ]);
    expect(
      activeWeeks([run({ issue: 1, role: "triage", ts: "2026-10-12T00:00:00Z" })], weeks),
    ).toEqual(["2026-W41", "2026-W42"]);
    expect(activeWeeks([], weeks)).toEqual(["2026-W41", "2026-W42"]);
    expect(
      activeWeeks([run({ issue: 1, role: "triage", ts: "2026-09-22T00:00:00Z" })], weeks),
    ).toEqual(weeks);
  });
  it("summarizes deployed issues, overall completion, recorded cost and improvements", () => {
    const runs: Run[] = [];
    for (const i of [1, 2, 3, 4, 5])
      runs.push(run({ issue: i, role: "implement", engine: "claude", costUsd: 0.1 }));
    for (const i of [1, 2, 3, 4]) runs.push(run({ issue: i, role: "deploy" }));
    runs.push(
      run({ issue: 4, role: "fix", ok: false }),
      run({ issue: 1, role: "review", engine: "codex" }),
    );
    expect(summary(runs, 2)).toEqual({
      deployed: 4,
      completion: { k: 3, n: 5 },
      costUsd: 0.5,
      uncostedEngines: ["codex"],
      improvements: 2,
    });
  });
  it("lists the most recent runs first", () => {
    const runs = [1, 2, 3].map((i) =>
      run({ issue: i, role: "triage", ts: `2026-10-0${i}T00:00:00Z` }),
    );
    expect(recentRuns(runs, 2).map((r) => r.issue)).toEqual([3, 2]);
  });
});
