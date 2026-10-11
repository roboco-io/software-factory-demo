import { describe, expect, it } from "vitest";
import { agentRunsOn, blockedReason, moveTo, roundFromLabels } from "../src/stages/common";
import { makeTestDeps } from "./helpers";

describe("moveTo", () => {
  it("replaces the state label and comments the reason", async () => {
    const h = makeTestDeps();
    const issue = h.gh.addIssue({ title: "t", labels: ["factory:triaged", "bug"] });
    expect(await moveTo(h.deps, issue.number, "approved", "command", "승인")).toBe(true);
    expect((await h.gh.getIssue(issue.number)).labels).toEqual(["bug", "factory:approved"]);
    expect((await h.gh.listComments(issue.number))[0]?.body).toBe("승인");
  });

  it("ignores a disallowed transition without changing anything", async () => {
    const h = makeTestDeps();
    const issue = h.gh.addIssue({ title: "t", labels: ["factory:deployed"] });
    expect(await moveTo(h.deps, issue.number, "approved", "command", "x")).toBe(false);
    expect((await h.gh.getIssue(issue.number)).labels).toEqual(["factory:deployed"]);
    expect(await h.gh.listComments(issue.number)).toEqual([]);
  });

  it("removes stale labels left by a human-added approved label", async () => {
    const h = makeTestDeps();
    const issue = h.gh.addIssue({ title: "t", labels: ["factory:triaged", "factory:approved"] });
    await moveTo(h.deps, issue.number, "in-progress", "implement");
    expect((await h.gh.getIssue(issue.number)).labels).toEqual(["factory:in-progress"]);
  });
});

describe("guard helpers", () => {
  it("reads the highest round label", () => {
    expect(roundFromLabels(["factory:round-1", "factory:round-3", "risk:T1"])).toBe(3);
    expect(roundFromLabels([])).toBe(0);
  });

  it("counts only implement and fix runs on the UTC day", () => {
    const base = {
      issue: 1,
      pr: null,
      engine: null,
      model: null,
      ok: true,
      turns: 0,
      costUsd: null,
      durationMs: 0,
      failureReason: null,
      round: 0,
    };
    const runs = [
      { ...base, ts: "2026-10-12T00:00:00.000Z", role: "implement" as const },
      { ...base, ts: "2026-10-12T23:59:59.000Z", role: "fix" as const },
      { ...base, ts: "2026-10-12T05:00:00.000Z", role: "review" as const },
      { ...base, ts: "2026-10-11T23:59:59.000Z", role: "implement" as const },
    ];
    expect(agentRunsOn(runs, "2026-10-12")).toBe(2);
  });

  it("blocks when paused or when the daily limit is reached", async () => {
    expect(await blockedReason(makeTestDeps({ settings: { paused: true } }).deps)).toMatch(
      /FACTORY_PAUSED/,
    );
    const h = makeTestDeps({ settings: { dailyLimit: 2 } });
    expect(await blockedReason(h.deps)).toBeNull();
    for (let i = 0; i < 2; i++) {
      await h.deps.runs.append({
        ts: "2026-10-12T01:00:00.000Z",
        issue: i,
        pr: null,
        role: "implement",
        engine: "claude",
        model: "m",
        ok: false,
        turns: 1,
        costUsd: null,
        durationMs: 1,
        failureReason: "timeout",
        round: 0,
      });
    }
    expect(await blockedReason(h.deps)).toMatch(/일일 상한 2회/);
  });

  it("counts in-progress issues as in-flight runs against the daily limit", async () => {
    const h = makeTestDeps({ settings: { dailyLimit: 1 } });
    expect(await blockedReason(h.deps)).toBeNull();
    h.gh.addIssue({ title: "running", labels: ["factory:in-progress"] });
    expect(await blockedReason(h.deps)).toMatch(/일일 상한 1회/);
  });
});
