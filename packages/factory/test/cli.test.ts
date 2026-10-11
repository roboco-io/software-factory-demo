import { describe, expect, it } from "vitest";
import { createFakeAdapter, loadFakeScript } from "../src/agents/fake";
import { main, type CliContext } from "../src/cli";
import type { Phase } from "../src/stages/phased";
import { makeTestDeps } from "./helpers";

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

  it("runs triage in the requested phase", async () => {
    const h = makeTestDeps({
      adapters: { pi: createFakeAdapter(loadFakeScript("triage-feature"), "pi") },
    });
    const issue = h.gh.addIssue({ title: "t" });
    const phases: Phase[] = [];
    expect(await main(["triage", "--issue", String(issue.number)], context(h, phases))).toBe(0);
    expect(phases).toEqual(["all"]);
    expect((await h.gh.getIssue(issue.number)).labels).toContain("factory:triaged");
  });
});
