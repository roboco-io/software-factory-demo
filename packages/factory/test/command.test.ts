import { describe, expect, it } from "vitest";
import { parseCommand, runCommand } from "../src/stages/command";
import { BOT, makeTestDeps } from "./helpers";

describe("parseCommand", () => {
  it.each([
    ["@factory go", "go"],
    ["  @Factory GO please", "go"],
    ["LGTM\n@factory retry", "retry"],
    ["@factory stop", "stop"],
  ])("%j → %s", (body, cmd) => {
    expect(parseCommand(body)).toBe(cmd);
  });

  it.each([
    ["> @factory go"],
    ["please @factory go"],
    ["@factory going"],
    ["@factorygo"],
    ["```\n@factory go\n```"],
    ["~~~\n@factory stop\n~~~"],
    ["    @factory go"],
    ["\t@factory go"],
    ["@factory go-live"],
  ])("ignores %j", (body) => {
    expect(parseCommand(body)).toBeNull();
  });
});

describe("runCommand", () => {
  it("lets a writer approve a triaged issue", async () => {
    const h = makeTestDeps();
    const issue = h.gh.addIssue({ title: "t", labels: ["factory:triaged"] });
    expect(
      await runCommand(h.deps, { issue: issue.number, actor: "serithemage", body: "@factory go" }),
    ).toBe("approved");
    expect((await h.gh.getIssue(issue.number)).labels).toEqual(["factory:approved"]);
    expect((await h.deps.runs.since(new Date(0)))[0]).toMatchObject({ role: "command", ok: true });
  });

  it("rejects a user without write permission with a comment and no state change", async () => {
    const h = makeTestDeps();
    h.gh.permissions.set("jiran-dohyun", "read");
    const issue = h.gh.addIssue({ title: "t", labels: ["factory:triaged"] });
    expect(
      await runCommand(h.deps, { issue: issue.number, actor: "jiran-dohyun", body: "@factory go" }),
    ).toBe("rejected");
    expect((await h.gh.getIssue(issue.number)).labels).toEqual(["factory:triaged"]);
    const comment = (await h.gh.listComments(issue.number))[0]?.body ?? "";
    expect(comment).toContain("@jiran-dohyun");
    expect(comment).toContain("write 이상");
    expect((await h.deps.runs.since(new Date(0)))[0]).toMatchObject({
      role: "command",
      ok: false,
      failureReason: "permission_denied",
    });
  });

  it("treats triage-role users as not allowed", async () => {
    const h = makeTestDeps();
    h.gh.permissions.set("helper", "triage");
    const issue = h.gh.addIssue({ title: "t", labels: ["factory:triaged"] });
    expect(
      await runCommand(h.deps, { issue: issue.number, actor: "helper", body: "@factory go" }),
    ).toBe("rejected");
  });

  it("ignores the bot, other bots and comments without a command", async () => {
    const h = makeTestDeps();
    const issue = h.gh.addIssue({ title: "t", labels: ["factory:triaged"] });
    expect(await runCommand(h.deps, { issue: issue.number, actor: BOT, body: "@factory go" })).toBe(
      "ignored",
    );
    expect(
      await runCommand(h.deps, {
        issue: issue.number,
        actor: "dependabot[bot]",
        body: "@factory go",
      }),
    ).toBe("ignored");
    expect(
      await runCommand(h.deps, {
        issue: issue.number,
        actor: "serithemage",
        body: "> @factory go",
      }),
    ).toBe("ignored");
    expect(await h.gh.listComments(issue.number)).toEqual([]);
  });

  it("ignores a bot-authored triage comment containing a literal @factory go", async () => {
    const h = makeTestDeps();
    const issue = h.gh.addIssue({ title: "t", labels: ["factory:triaged"] });
    const body = "분류 완료.\n@factory go 를 남기면 구현을 시작한다.";
    expect(await runCommand(h.deps, { issue: issue.number, actor: BOT, body })).toBe("ignored");
    expect((await h.gh.getIssue(issue.number)).labels).toEqual(["factory:triaged"]);
    expect(await h.gh.listComments(issue.number)).toEqual([]);
  });

  it("ignores a code-block @factory go from a writer", async () => {
    const h = makeTestDeps();
    const issue = h.gh.addIssue({ title: "t", labels: ["factory:triaged"] });
    const body = "예시:\n```\n@factory go\n```";
    expect(await runCommand(h.deps, { issue: issue.number, actor: "serithemage", body })).toBe(
      "ignored",
    );
    expect((await h.gh.getIssue(issue.number)).labels).toEqual(["factory:triaged"]);
  });

  it("answers commands left on a pull request", async () => {
    const h = makeTestDeps();
    h.gh.setBranch("factory/issue-9", "s", []);
    const pr = await h.gh.createPull({
      title: "p",
      body: "",
      head: "factory/issue-9",
      base: "main",
      draft: false,
    });
    expect(await runCommand(h.deps, { issue: pr, actor: "serithemage", body: "@factory go" })).toBe(
      "pull-request",
    );
    expect((await h.gh.listComments(pr))[0]?.body).toContain("이슈");
  });

  it("stops a running issue, cancelling its runs", async () => {
    const h = makeTestDeps();
    const issue = h.gh.addIssue({ title: "t", labels: ["factory:in-progress"] });
    expect(
      await runCommand(h.deps, {
        issue: issue.number,
        actor: "serithemage",
        body: "@factory stop",
      }),
    ).toBe("stopped");
    expect(h.gh.cancelled).toEqual([issue.number]);
    expect((await h.gh.getIssue(issue.number)).labels).toEqual(["factory:needs-human"]);
  });

  it("refuses stop when nothing is running and does not cancel", async () => {
    const h = makeTestDeps();
    const issue = h.gh.addIssue({ title: "t", labels: ["factory:deployed"] });
    expect(
      await runCommand(h.deps, {
        issue: issue.number,
        actor: "serithemage",
        body: "@factory stop",
      }),
    ).toBe("refused");
    expect(h.gh.cancelled).toEqual([]);
  });

  it("retries a needs-human issue and re-dispatches an already approved one", async () => {
    const h = makeTestDeps();
    const stuck = h.gh.addIssue({ title: "t", labels: ["factory:needs-human"] });
    expect(
      await runCommand(h.deps, {
        issue: stuck.number,
        actor: "serithemage",
        body: "@factory retry",
      }),
    ).toBe("approved");
    expect(
      await runCommand(h.deps, { issue: stuck.number, actor: "serithemage", body: "@factory go" }),
    ).toBe("redispatched");
    expect(h.gh.dispatches).toEqual([
      { file: "factory-implement.yml", inputs: { issue: String(stuck.number) } },
    ]);
  });

  it("refuses go while a PR is in review", async () => {
    const h = makeTestDeps();
    const issue = h.gh.addIssue({ title: "t", labels: ["factory:in-review"] });
    expect(
      await runCommand(h.deps, { issue: issue.number, actor: "serithemage", body: "@factory go" }),
    ).toBe("refused");
    expect((await h.gh.listComments(issue.number))[0]?.body).toContain("factory:in-review");
  });
});
