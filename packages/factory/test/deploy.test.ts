import { describe, expect, it } from "vitest";
import { runDeployFailed, runDeployed } from "../src/stages/deploy";
import { makeTestDeps } from "./helpers";

describe("deploy result", () => {
  it("marks merged issues from Factory-Issue trailers as deployed and closes them", async () => {
    const h = makeTestDeps();
    const merged = h.gh.addIssue({ title: "a", labels: ["factory:merged"] });
    const other = h.gh.addIssue({ title: "b", labels: ["factory:in-review"] });
    h.gh.commitMessages.set(
      "abc1234",
      `feat: a (#9)\n\nFactory-Issue: #${merged.number}\nFactory-Issue: #${other.number}`,
    );
    expect(await runDeployed(h.deps, { sha: "abc1234" })).toEqual([merged.number]);
    const after = await h.gh.getIssue(merged.number);
    expect(after.labels).toEqual(["factory:deployed"]);
    expect(after.state).toBe("closed");
    expect((await h.gh.getIssue(other.number)).labels).toEqual(["factory:in-review"]);
    expect((await h.deps.runs.since(new Date(0)))[0]).toMatchObject({
      role: "deploy",
      ok: true,
      issue: merged.number,
    });
  });

  it("closes an issue that a crashed run left deployed but open", async () => {
    const h = makeTestDeps();
    const i = h.gh.addIssue({ title: "a", labels: ["factory:deployed"] });
    h.gh.commitMessages.set("abc1234", `x\n\nFactory-Issue: #${i.number}`);
    await runDeployed(h.deps, { sha: "abc1234" });
    expect((await h.gh.getIssue(i.number)).state).toBe("closed");
    await runDeployed(h.deps, { sha: "abc1234" });
    expect((await h.gh.getIssue(i.number)).labels).toEqual(["factory:deployed"]);
  });

  it("returns merged issues to a human with source:deploy when deploy or smoke failed", async () => {
    const h = makeTestDeps();
    const merged = h.gh.addIssue({ title: "a", labels: ["factory:merged"] });
    h.gh.commitMessages.set("abc1234", `x\n\nFactory-Issue: #${merged.number}`);
    expect(await runDeployFailed(h.deps, { sha: "abc1234" })).toEqual([merged.number]);
    const after = await h.gh.getIssue(merged.number);
    expect(after.labels.sort()).toEqual(["factory:needs-human", "source:deploy"]);
    expect((await h.gh.listComments(merged.number))[0]?.body).toContain("롤백");
  });
});
