import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ENGINES } from "../src/agents/types";
import { REPO_ROOT } from "../src/paths";

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  "working-directory"?: string;
}
interface Job {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  environment?: string;
  outputs?: Record<string, string>;
  concurrency?: { group: string };
  "timeout-minutes"?: number;
  steps: Step[];
}
interface Workflow {
  "run-name"?: string;
  on: Record<string, unknown>;
  concurrency?: { group: string };
  jobs: Record<string, Job>;
}

const DIR = path.join(REPO_ROOT, ".github/workflows");
const load = (file: string) => parse(readFileSync(path.join(DIR, file), "utf8")) as Workflow;
const ALL = readdirSync(DIR)
  .filter((f) => f.endsWith(".yml"))
  .sort();
const FACTORY = ALL.filter((f) => f.startsWith("factory-"));
const AGENT_WORKFLOWS = [
  "factory-triage.yml",
  "factory-implement.yml",
  "factory-review.yml",
  "factory-fix.yml",
];
const PHASED = /pnpm -s factory (triage|implement|review|fix)\b/;
const text = (step: Step) => JSON.stringify(step);
const steps = (wf: Workflow) => Object.values(wf.jobs).flatMap((j) => j.steps);
const checkouts = (job: Job) => job.steps.filter((s) => s.uses?.startsWith("actions/checkout@"));
const workCheckout = (job: Job) => checkouts(job).find((s) => s.with?.path === "work");
const KEY: Record<(typeof ENGINES)[number], string> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "CODEX_API_KEY",
  pi: "DEEPSEEK_API_KEY",
};

describe("factory workflows", () => {
  it("exist with the expected names", () => {
    expect(FACTORY).toEqual([
      "factory-command.yml",
      "factory-contract.yml",
      "factory-fix.yml",
      "factory-guard.yml",
      "factory-implement.yml",
      "factory-merge.yml",
      "factory-review.yml",
      "factory-triage.yml",
    ]);
  });

  it("never persist checkout credentials and never see Cloudflare secrets", () => {
    for (const file of FACTORY) {
      const raw = readFileSync(path.join(DIR, file), "utf8");
      expect(raw, file).not.toMatch(/CLOUDFLARE|JWT_SECRET/);
      for (const job of Object.values(load(file).jobs)) {
        for (const step of checkouts(job)) {
          expect(step.with?.["persist-credentials"], `${file}: ${text(step)}`).toBe(false);
        }
      }
    }
  });

  it("split agent workflows into prepare, agent and publish jobs, with no GitHub token in the agent job", () => {
    for (const file of AGENT_WORKFLOWS) {
      const wf = load(file);
      expect(Object.keys(wf.jobs), file).toEqual(["prepare", "agent", "publish"]);
      const agent = wf.jobs.agent!;
      expect(
        agent.steps.some((s) => s.run?.includes("--phase agent")),
        file,
      ).toBe(true);
      for (const step of agent.steps) {
        expect(text(step), `${file} agent job`).not.toMatch(
          /FACTORY_TOKEN|GITHUB_TOKEN|FACTORY_APP_|create-github-app-token/,
        );
      }
      expect(agent.permissions, `${file} agent permissions`).toEqual({ contents: "read" });
      expect(agent.environment, file).toBeUndefined();
      for (const job of ["prepare", "publish"] as const) {
        expect(
          wf.jobs[job]!.steps.some((s) => s.run?.includes(`--phase ${job}`)),
          `${file} ${job}`,
        ).toBe(true);
        expect(
          wf.jobs[job]!.steps.some((s) => /ANTHROPIC|CODEX_API|DEEPSEEK/.test(text(s))),
          `${file} ${job} has engine keys`,
        ).toBe(false);
      }
      expect(wf["run-name"], file).toMatch(/\[factory\/issue-\$\{\{/);
    }
  });

  it("give the agent job only the API key of the engine chosen by prepare (F16)", () => {
    for (const file of AGENT_WORKFLOWS) {
      const wf = load(file);
      expect(wf.jobs.prepare!.outputs?.engine, file).toBe("${{ steps.prepare.outputs.engine }}");
      const step = wf.jobs.agent!.steps.find((s) => s.run?.includes("--phase agent"))!;
      for (const engine of ENGINES) {
        expect(step.env?.[KEY[engine]], `${file} ${engine}`).toBe(
          `\${{ needs.prepare.outputs.engine == '${engine}' && secrets.${KEY[engine]} || '' }}`,
        );
      }
      const keys = JSON.stringify(wf.jobs.agent).match(/secrets\.[A-Z_]+/g) ?? [];
      expect([...new Set(keys)].sort(), file).toEqual(
        Object.values(KEY)
          .map((k) => `secrets.${k}`)
          .sort(),
      );
    }
  });

  it("run the factory CLI from a trusted main checkout and hand over the plan from prepare by artifact id", () => {
    for (const file of AGENT_WORKFLOWS) {
      const wf = load(file);
      expect(wf.jobs.prepare!.outputs?.["plan-artifact-id"], file).toBe(
        "${{ steps.plan.outputs.artifact-id }}",
      );
      for (const [name, job] of Object.entries(wf.jobs)) {
        const runtime = checkouts(job).find((s) => s.with?.path === "runtime");
        expect(runtime?.with?.ref, `${file} ${name}`).toBe("main");
        for (const step of job.steps.filter((s) => s.run?.includes("pnpm -s factory"))) {
          expect(step["working-directory"], `${file} ${name}`).toBe("runtime");
        }
        const uploads = job.steps.filter((s) => s.uses?.startsWith("actions/upload-artifact@"));
        const plans = uploads.filter((s) => s.with?.name === "factory-plan");
        expect(plans.length, `${file} ${name} uploads factory-plan`).toBe(
          name === "prepare" ? 1 : 0,
        );
        if (name === "prepare") continue;
        const download = job.steps.find(
          (s) =>
            s.uses?.startsWith("actions/download-artifact@") &&
            s.with?.path === "${{ runner.temp }}/in",
        );
        expect(download?.with?.["artifact-ids"], `${file} ${name}`).toBe(
          "${{ needs.prepare.outputs.plan-artifact-id }}",
        );
        expect(download?.with?.name, `${file} ${name}`).toBeUndefined();
      }
    }
  });

  it("check out agent and publish work trees with full history (T13-a)", () => {
    for (const file of ["factory-implement.yml", "factory-fix.yml", "factory-review.yml"]) {
      const wf = load(file);
      expect(workCheckout(wf.jobs.agent!)?.with?.["fetch-depth"], `${file} agent`).toBe(0);
    }
    for (const file of ["factory-implement.yml", "factory-fix.yml"]) {
      expect(workCheckout(load(file).jobs.publish!)?.with?.["fetch-depth"], `${file} publish`).toBe(
        0,
      );
    }
  });

  it("give the implement agent job 75 minutes (F10)", () => {
    expect(load("factory-implement.yml").jobs.agent!["timeout-minutes"]).toBe(75);
  });

  it("review the head SHA that prepare judged (F17)", () => {
    const wf = load("factory-review.yml");
    expect(wf.jobs.prepare!.outputs?.["head-sha"]).toBe("${{ steps.prepare.outputs.head-sha }}");
    expect(workCheckout(wf.jobs.agent!)?.with?.ref).toBe("${{ needs.prepare.outputs.head-sha }}");
  });

  it("calls the factory CLI instead of embedding logic", () => {
    for (const file of FACTORY) {
      const runs = steps(load(file)).map((s) => s.run ?? "");
      expect(
        runs.some((r) => r.includes("pnpm -s factory") || r.includes("pnpm --filter factory")),
        file,
      ).toBe(true);
    }
  });

  it("pass an explicit --phase prepare|agent|publish on every phased CLI call, never all (F11)", () => {
    for (const file of ALL) {
      const raw = readFileSync(path.join(DIR, file), "utf8");
      expect(raw, file).not.toMatch(/--phase all/);
      for (const step of steps(load(file))) {
        for (const line of (step.run ?? "").split("\n").filter((l) => PHASED.test(l))) {
          expect(line, file).toMatch(/--phase (prepare|agent|publish)\b/);
        }
      }
    }
  });

  it("keep shell glue to at most one conditional line per run script (F11)", () => {
    for (const file of [...FACTORY, "ci.yml", "preview.yml", "deploy.yml"]) {
      for (const step of steps(load(file))) {
        if (!step.run?.includes("factory")) continue;
        const conditionals = step.run
          .split("\n")
          .filter((l) => /^\s*(if|for|while|case)\b/.test(l));
        expect(conditionals.length, `${file}: ${step.run}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("never interpolate event data into run scripts (T12-a)", () => {
    for (const file of ALL) {
      for (const step of steps(load(file))) {
        expect(step.run ?? "", `${file}: ${step.run}`).not.toContain("${{ github.event.");
      }
    }
    for (const file of FACTORY) {
      for (const step of steps(load(file)))
        expect(step.run ?? "", `${file}: ${step.run}`).not.toContain("${{");
    }
  });

  it("trigger commands only on newly created comments and read the body from env (T12-a)", () => {
    const wf = load("factory-command.yml");
    expect(wf.on).toEqual({ issue_comment: { types: ["created"] } });
    const step = steps(wf).find((s) => s.run?.includes("factory command"))!;
    expect(step.env?.COMMENT_BODY).toBe("${{ github.event.comment.body }}");
    expect(step.env?.ACTOR).toBe("${{ github.event.comment.user.login }}");
  });

  it("serialize gate runs per PR for both workflow_run and dispatch (F7)", () => {
    expect(load("factory-merge.yml").jobs.gate!.concurrency?.group).toBe(
      "factory-gate-${{ github.event.workflow_run.pull_requests[0].number || inputs.pr }}",
    );
  });
});

describe("modified P1 workflows", () => {
  it("ci.yml judges risk-tier with the base commit's factory code", () => {
    const job = load("ci.yml").jobs["risk-tier"]!;
    const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"))!;
    expect(checkouts(job)).toHaveLength(1);
    expect(checkout.with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(checkout.with?.["persist-credentials"]).toBe(false);
    const run = job.steps.find((s) => s.run?.includes("factory risk --pr"))!;
    expect(run.run).toContain("--check");
    expect(run["working-directory"]).toBe(checkout.with?.path);
    expect(checkout.with?.path).toBe("base");
  });

  it("preview.yml deploys only when the policy job allows it", () => {
    const wf = load("preview.yml");
    expect(wf.jobs.deploy!.needs).toBe("policy");
    expect(wf.jobs.deploy!.if).toContain("needs.policy.outputs.allowed == 'true'");
    const checkout = wf.jobs.policy!.steps.find((s) => s.uses?.startsWith("actions/checkout@"))!;
    expect(checkout.with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
    expect(
      wf.jobs.policy!.steps.some(
        (s) => s.run?.includes("factory risk --pr") && s.run.includes("--json"),
      ),
    ).toBe(true);
    expect(JSON.stringify(wf.jobs.policy)).not.toMatch(/CLOUDFLARE/);
  });

  it("deploy.yml reports deploy results back to factory issues", () => {
    const job = load("deploy.yml").jobs["factory-report"]!;
    expect(job.needs).toEqual(["api", "web", "smoke"]);
    expect(
      job.steps.some(
        (s) => s.run?.includes("factory deployed") && s.run.includes("factory deploy-failed"),
      ),
    ).toBe(true);
    expect(job.environment).toBeUndefined();
    expect(JSON.stringify(job)).not.toMatch(/CLOUDFLARE/);
  });

  it("declare an environment on every job that uses Cloudflare secrets", () => {
    for (const file of ALL) {
      for (const [name, job] of Object.entries(load(file).jobs)) {
        if (/secrets\.CLOUDFLARE/.test(JSON.stringify(job))) {
          expect(["production", "preview"], `${file} ${name}`).toContain(job.environment);
        }
      }
    }
  });
});
