import { describe, expect, it } from "vitest";
import { DATA_BRANCH } from "../src/runs/store";
import { LABELS, runBootstrap } from "../src/stages/bootstrap";
import { makeTestDeps } from "./helpers";

describe("runBootstrap", () => {
  it("creates every factory label and the factory-data branch, idempotently", async () => {
    const h = makeTestDeps();
    expect(await runBootstrap(h.deps)).toEqual({ labels: 27, branch: DATA_BRANCH });
    await runBootstrap(h.deps);
    expect(h.gh.labels.size).toBe(27);
    for (const name of [
      "factory:new",
      "factory:deployed",
      "factory:round-3",
      "factory:alert",
      "risk:T3",
      "type:feedback",
      "agent:pi",
      "source:deploy",
      "source:error",
      "source:feedback",
      "source:smoke",
    ]) {
      expect(h.gh.labels.has(name)).toBe(true);
    }
    expect(LABELS.every((l) => /^[0-9a-f]{6}$/.test(l.color))).toBe(true);
    expect(h.gh.branches.has(DATA_BRANCH)).toBe(true);
    expect((await h.gh.readFile(DATA_BRANCH, "README.md"))?.content).toContain(
      "runs/YYYY-MM.jsonl",
    );
  });
});
