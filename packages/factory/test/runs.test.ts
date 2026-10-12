import { describe, expect, it } from "vitest";
import { InMemoryGitHub } from "../src/github/memory";
import {
  DATA_BRANCH,
  createRunStore,
  monthPath,
  monthsBetween,
  parseRecords,
  type RunRecord,
} from "../src/runs/store";

const rec = (ts: string, over: Partial<RunRecord> = {}): RunRecord => ({
  ts,
  issue: 12,
  pr: 34,
  role: "implement",
  engine: "claude",
  model: "claude-sonnet-5-5",
  ok: true,
  turns: 41,
  costUsd: 1.82,
  durationMs: 912_000,
  failureReason: null,
  round: 1,
  ...over,
});

describe("run store on factory-data", () => {
  it("appends JSON lines to runs/YYYY-MM.jsonl in UTC", async () => {
    const gh = new InMemoryGitHub({ botLogin: "bot" });
    const runs = createRunStore(gh, () => new Date("2026-10-31T23:59:00Z"));
    await runs.append(rec("2026-10-31T23:00:00Z"));
    await runs.append(rec("2026-10-31T23:30:00Z", { ok: false, failureReason: "budget" }));
    const file = await gh.readFile(DATA_BRANCH, "runs/2026-10.jsonl");
    expect(file?.content.trim().split("\n")).toHaveLength(2);
    expect(JSON.parse(file!.content.split("\n")[0]!)).toEqual(rec("2026-10-31T23:00:00Z"));
    expect(monthPath(new Date("2026-11-01T00:00:00+09:00"))).toBe("runs/2026-10.jsonl");
  });

  it("creates factory-data on first append when the branch is missing", async () => {
    const gh = new InMemoryGitHub({ botLogin: "bot" });
    const runs = createRunStore(gh);
    await runs.append(rec("2026-10-11T03:00:00Z"));
    expect(gh.branches.has(DATA_BRANCH)).toBe(true);
    expect(
      (await gh.readFile(DATA_BRANCH, "runs/2026-10.jsonl"))?.content.trim().split("\n"),
    ).toHaveLength(1);
  });

  it("retries up to 3 times after conflicts, then gives up", async () => {
    const gh = new InMemoryGitHub({ botLogin: "bot" });
    await gh.createOrphanBranch(DATA_BRANCH, {}, "init");
    const runs = createRunStore(gh);
    gh.injectConflicts = 3;
    await runs.append(rec("2026-10-11T03:00:00Z"));
    gh.injectConflicts = 4;
    await expect(runs.append(rec("2026-10-11T04:00:00Z"))).rejects.toThrow(/changed/);
    expect(
      (await gh.readFile(DATA_BRANCH, "runs/2026-10.jsonl"))?.content.trim().split("\n"),
    ).toHaveLength(1);
  });

  it("reads across months, filters by time and skips broken lines", async () => {
    const gh = new InMemoryGitHub({ botLogin: "bot" });
    await gh.createOrphanBranch(DATA_BRANCH, {}, "init");
    await gh.writeFile(
      DATA_BRANCH,
      "runs/2026-09.jsonl",
      `${JSON.stringify(rec("2026-09-30T10:00:00Z"))}\n{broken\n`,
      null,
      "m",
    );
    await gh.writeFile(
      DATA_BRANCH,
      "runs/2026-10.jsonl",
      `${JSON.stringify(rec("2026-10-02T10:00:00Z"))}\n`,
      null,
      "m",
    );
    const runs = createRunStore(gh, () => new Date("2026-10-03T00:00:00Z"));
    expect((await runs.since(new Date("2026-09-26T00:00:00Z"))).map((r) => r.ts)).toEqual([
      "2026-09-30T10:00:00Z",
      "2026-10-02T10:00:00Z",
    ]);
    expect(await runs.since(new Date("2026-10-01T00:00:00Z"))).toHaveLength(1);
  });

  it("lists months inclusively across a year boundary", () => {
    expect(
      monthsBetween(new Date("2026-11-20T00:00:00Z"), new Date("2027-01-02T00:00:00Z")),
    ).toEqual(["2026-11", "2026-12", "2027-01"]);
  });
});

describe("parseRecords findings", () => {
  it("parses records with and without findings", () => {
    const base = {
      issue: 1,
      pr: 2,
      role: "review",
      engine: "codex",
      model: "m",
      ok: true,
      turns: 1,
      costUsd: null,
      durationMs: 1,
      failureReason: null,
      round: 0,
    };
    const text = [
      JSON.stringify({ ts: "2026-10-01T00:00:00Z", ...base }),
      JSON.stringify({
        ts: "2026-10-02T00:00:00Z",
        ...base,
        findings: [{ category: "style", file: "a", message: "m" }],
      }),
    ].join("\n");
    const rs = parseRecords(text);
    expect(rs[0]?.findings).toBeUndefined();
    expect(rs[1]?.findings).toEqual([{ category: "style", file: "a", message: "m" }]);
  });
});
