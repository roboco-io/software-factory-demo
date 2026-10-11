import { describe, expect, it } from "vitest";
import { createFakeAdapter, loadFakeScript } from "../src/agents/fake";
import { main, type CliContext } from "../src/cli";
import type { Phase } from "../src/stages/phased";
import { makeTestDeps, openBotPr } from "./helpers";

function context(
  h: ReturnType<typeof makeTestDeps>,
  phases: Phase[] = [],
  out: string[] = [],
): CliContext {
  return {
    env: {},
    stdout: (s) => out.push(s),
    buildDeps: (_env, phase) => {
      phases.push(phase);
      return h.deps;
    },
  };
}

describe("cli main", () => {
  it("runs the command stage with COMMENT_BODY from env", async () => {
    const h = makeTestDeps();
    const issue = h.gh.addIssue({ title: "t", labels: ["factory:triaged"] });
    const out: string[] = [];
    const ctx = { ...context(h, [], out), env: { COMMENT_BODY: "@factory go" } };
    expect(
      await main(["command", "--issue", String(issue.number), "--actor", "serithemage"], ctx),
    ).toBe(0);
    expect(out).toEqual(["approved"]);
  });

  it("prints usage and returns 2 for an unknown command", async () => {
    const out: string[] = [];
    expect(await main(["nope"], context(makeTestDeps(), [], out))).toBe(2);
    expect(out[0]).toMatch(/usage: pnpm factory <triage/);
  });

  it("returns 2 when a required option is missing or malformed", async () => {
    const out: string[] = [];
    expect(await main(["triage"], context(makeTestDeps(), [], out))).toBe(2);
    expect(await main(["triage", "--issue", "x"], context(makeTestDeps(), [], out))).toBe(2);
    expect(out.join("\n")).toContain("--issue");
  });

  it("validates risk --sha as a 40-hex SHA when provided", async () => {
    const h = makeTestDeps();
    const out: string[] = [];
    for (const sha of ["", "abc", "G".repeat(40), "A".repeat(40)]) {
      out.length = 0;
      expect(await main(["risk", "--pr", "1", "--sha", sha], context(h, [], out))).toBe(2);
      expect(out.join("\n")).toContain("--sha");
    }
  });

  it("runs triage in the requested phase", async () => {
    const h = makeTestDeps({
      adapters: { pi: createFakeAdapter(loadFakeScript("triage-feature"), "pi") },
    });
    const issue = h.gh.addIssue({ title: "t" });
    const phases: Phase[] = [];
    expect(
      await main(["triage", "--issue", String(issue.number), "--phase", "all"], context(h, phases)),
    ).toBe(0);
    expect(phases).toEqual(["all"]);
    expect((await h.gh.getIssue(issue.number)).labels).toContain("factory:triaged");
  });

  it("requires an explicit --phase", async () => {
    const out: string[] = [];
    expect(await main(["triage", "--issue", "1"], context(makeTestDeps(), [], out))).toBe(2);
    expect(out.join("\n")).toContain("--phase");
    expect(
      await main(["triage", "--issue", "1", "--phase", "bogus"], context(makeTestDeps(), [], out)),
    ).toBe(2);
  });

  it("evidence prints the plan as JSON and rejects malformed sha options", async () => {
    const h = makeTestDeps();
    const { pr } = await openBotPr(h);
    const out: string[] = [];
    const head = "a".repeat(40);
    const base = "b".repeat(40);
    expect(
      await main(
        ["evidence", "--pr", String(pr), "--sha", head, "--base", base, "--json"],
        context(h, [], out),
      ),
    ).toBe(0);
    expect(JSON.parse(out[0]!)).toMatchObject({
      pr,
      required: false,
      baseSha: base,
      headSha: head,
      testFiles: [],
    });
    expect(
      await main(["evidence", "--pr", String(pr), "--sha", "HEAD", "--base", base], context(h)),
    ).toBe(2);
  });
});
