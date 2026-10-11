import { describe, expect, it } from "vitest";
import {
  STATES,
  TransitionError,
  canTransition,
  stateFromLabels,
  stateLabel,
  transition,
  type Actor,
} from "../src/state/machine";

describe("transition", () => {
  it.each([
    ["new", "triaged", "triage"],
    ["triaged", "approved", "command"],
    ["needs-human", "approved", "command"],
    ["approved", "in-progress", "implement"],
    ["in-progress", "in-review", "implement"],
    ["in-review", "in-progress", "fix"],
    ["in-progress", "in-review", "fix"],
    ["in-review", "needs-human", "gate"],
    ["in-review", "merged", "github"],
    ["needs-human", "merged", "github"],
    ["merged", "deployed", "deploy"],
    ["merged", "needs-human", "deploy"],
  ] as const)("%s → %s by %s is allowed", (from, to, actor) => {
    expect(transition(from, to, actor)).toBe(to);
  });

  it("rejects transitions outside the table with TransitionError", () => {
    expect(() => transition("triaged", "in-progress", "implement")).toThrow(TransitionError);
    expect(() => transition("new", "approved", "triage")).toThrow(/new → approved/);
    expect(() => transition("deployed", "approved", "command")).toThrow(TransitionError);
  });

  it("never lets an agent role or the gate create merged or deployed", () => {
    const agents: Actor[] = ["triage", "implement", "review", "fix", "gate", "command"];
    for (const from of STATES) {
      for (const actor of agents) {
        expect(canTransition(from, "merged", actor)).toBe(false);
        expect(canTransition(from, "deployed", actor)).toBe(false);
      }
    }
  });

  it("lets a writer stop any running state, but not finished ones", () => {
    for (const from of ["new", "triaged", "approved", "in-progress", "in-review"] as const) {
      expect(canTransition(from, "needs-human", "command")).toBe(true);
    }
    expect(canTransition("merged", "needs-human", "command")).toBe(false);
    expect(canTransition("deployed", "needs-human", "command")).toBe(false);
  });
});

describe("stateFromLabels", () => {
  it("treats no state label as new and ignores other factory labels", () => {
    expect(stateFromLabels(["bug", "factory:round-2", "factory:alert"])).toEqual({
      state: "new",
      stale: [],
    });
  });

  it("reads a single state label", () => {
    expect(stateFromLabels([stateLabel("in-review"), "risk:T1"]).state).toBe("in-review");
  });

  it("accepts a human-added approved label next to an earlier state", () => {
    expect(stateFromLabels(["factory:triaged", "factory:approved"])).toEqual({
      state: "approved",
      stale: ["triaged"],
    });
  });

  it("throws on other conflicting labels", () => {
    expect(() => stateFromLabels(["factory:in-review", "factory:approved"])).toThrow(/conflicting/);
    expect(() => stateFromLabels(["factory:merged", "factory:deployed"])).toThrow(/conflicting/);
  });
});
