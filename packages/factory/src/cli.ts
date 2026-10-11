import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildDeps } from "./main";
import { runBootstrap } from "./stages/bootstrap";
import { runCommand } from "./stages/command";
import { runEvidencePlan } from "./stages/evidence";
import { runDeployFailed, runDeployed } from "./stages/deploy";
import { fixStage } from "./stages/fix";
import { runGate, runOnClosed } from "./stages/gate";
import { runGuard } from "./stages/guard";
import { implementStage } from "./stages/implement";
import type { StageDeps } from "./stages/deps";
import { runPhase, type Phase, type PhasedStage } from "./stages/phased";
import { reviewStage } from "./stages/review";
import { runRisk } from "./stages/risk";
import { triageStage } from "./stages/triage";

export interface CliContext {
  env: NodeJS.ProcessEnv;
  buildDeps(env: NodeJS.ProcessEnv, phase: Phase): StageDeps;
  stdout(s: string): void;
}

type Values = Record<string, string | boolean | undefined>;
type Handler = (ctx: CliContext, v: Values) => Promise<number>;

class UsageError extends Error {}

const OPTIONS = {
  issue: { type: "string" },
  pr: { type: "string" },
  sha: { type: "string" },
  branch: { type: "string" },
  reason: { type: "string" },
  sender: { type: "string" },
  actor: { type: "string" },
  phase: { type: "string" },
  state: { type: "string" },
  outcome: { type: "string" },
  json: { type: "boolean" },
  check: { type: "boolean" },
  base: { type: "string" },
  result: { type: "string" },
} as const;

const PHASES: readonly Phase[] = ["prepare", "agent", "publish", "all"];

function num(v: Values, name: string): number {
  const raw = v[name];
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
    throw new UsageError(`--${name} <양의 정수>가 필요하다`);
  }
  return Number(raw);
}

function optNum(v: Values, name: string): number | undefined {
  return v[name] === undefined ? undefined : num(v, name);
}

function str(v: Values, name: string): string | null {
  const raw = v[name];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function reqStr(v: Values, name: string): string {
  const s = str(v, name);
  if (!s) throw new UsageError(`--${name} <값>이 필요하다`);
  return s;
}

function sha40(v: Values, name: string): string {
  const s = reqStr(v, name);
  if (!/^[0-9a-f]{40}$/.test(s)) throw new UsageError(`--${name}는 40자리 소문자 16진수여야 한다`);
  return s;
}

function phaseOf(v: Values): Phase {
  // 워크플로가 단계를 명시하도록 기본값을 두지 않는다. all은 명시했을 때만(로컬·테스트) 쓴다.
  const p = str(v, "phase");
  if (!p) throw new UsageError(`--phase <${PHASES.join("|")}>가 필요하다`);
  if (!(PHASES as readonly string[]).includes(p)) {
    throw new UsageError(`--phase는 ${PHASES.join("|")} 중 하나다`);
  }
  return p as Phase;
}

async function phased<A, P, O>(
  ctx: CliContext,
  v: Values,
  stage: PhasedStage<A, P, O>,
  args: A,
): Promise<number> {
  const phase = phaseOf(v);
  await runPhase(stage, phase, ctx.buildDeps(ctx.env, phase), args, {
    plan: str(v, "state"),
    outcome: str(v, "outcome"),
  });
  return 0;
}

export const COMMANDS: Record<string, Handler> = {
  triage: (ctx, v) => phased(ctx, v, triageStage, { issue: num(v, "issue") }),
  command: async (ctx, v) => {
    const outcome = await runCommand(ctx.buildDeps(ctx.env, "all"), {
      issue: num(v, "issue"),
      actor: reqStr(v, "actor"),
      body: ctx.env.COMMENT_BODY ?? "",
    });
    ctx.stdout(outcome);
    return 0;
  },
  review: (ctx, v) => phased(ctx, v, reviewStage, { pr: num(v, "pr") }),
  fix: (ctx, v) => {
    const reason = reqStr(v, "reason");
    if (reason !== "review" && reason !== "ci") {
      throw new UsageError("--reason은 review|ci 중 하나다");
    }
    return phased(ctx, v, fixStage, { pr: num(v, "pr"), sha: reqStr(v, "sha"), reason });
  },
  implement: (ctx, v) => {
    const sender = str(v, "sender");
    return phased(
      ctx,
      v,
      implementStage,
      sender ? { issue: num(v, "issue"), sender } : { issue: num(v, "issue") },
    );
  },
  gate: async (ctx, v) => {
    const pr = optNum(v, "pr");
    const branch = str(v, "branch");
    if (pr === undefined && !branch) throw new UsageError("--pr 또는 --branch가 필요하다");
    ctx.stdout(
      await runGate(ctx.buildDeps(ctx.env, "all"), pr !== undefined ? { pr } : { branch: branch! }),
    );
    return 0;
  },
  "on-closed": async (ctx, v) => {
    ctx.stdout(String(await runOnClosed(ctx.buildDeps(ctx.env, "all"), { pr: num(v, "pr") })));
    return 0;
  },
  risk: async (ctx, v) => {
    const sha = str(v, "sha");
    if (typeof v.sha === "string" && !/^[0-9a-f]{40}$/.test(v.sha)) {
      throw new UsageError("--sha는 40자리 소문자 16진수여야 한다");
    }
    const report = await runRisk(ctx.buildDeps(ctx.env, "all"), {
      pr: num(v, "pr"),
      check: v.check === true,
      ...(sha ? { sha } : {}),
    });
    ctx.stdout(
      v.json === true
        ? JSON.stringify(report)
        : `risk ${report.tier}: ${report.files.map((f) => `${f.file}=${f.tier}`).join(", ")}`,
    );
    if (v.check === true && report.forbidden.length > 0) {
      ctx.stdout(`구현 역할 PR이 T3 경로를 바꿨다: ${report.forbidden.join(", ")}`);
      return 1;
    }
    return 0;
  },
  bootstrap: async (ctx) => {
    ctx.stdout(JSON.stringify(await runBootstrap(ctx.buildDeps(ctx.env, "all"))));
    return 0;
  },
  guard: async (ctx) => {
    ctx.stdout(JSON.stringify(await runGuard(ctx.buildDeps(ctx.env, "all"))));
    return 0;
  },
  deployed: async (ctx, v) => {
    ctx.stdout(
      JSON.stringify(await runDeployed(ctx.buildDeps(ctx.env, "all"), { sha: reqStr(v, "sha") })),
    );
    return 0;
  },
  "deploy-failed": async (ctx, v) => {
    ctx.stdout(
      JSON.stringify(
        await runDeployFailed(ctx.buildDeps(ctx.env, "all"), { sha: reqStr(v, "sha") }),
      ),
    );
    return 0;
  },
  evidence: async (ctx, v) => {
    const plan = await runEvidencePlan(ctx.buildDeps(ctx.env, "all"), {
      pr: num(v, "pr"),
      headSha: sha40(v, "sha"),
      baseSha: sha40(v, "base"),
    });
    ctx.stdout(
      v.json === true
        ? JSON.stringify(plan)
        : `evidence ${plan.required ? "required" : "not required"}: ${plan.reason}`,
    );
    return 0;
  },
};

export async function main(argv: string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = argv;
  const handler = command ? COMMANDS[command] : undefined;
  if (!handler) {
    ctx.stdout(`usage: pnpm factory <${Object.keys(COMMANDS).join("|")}> [options]`);
    return 2;
  }
  try {
    const { values } = parseArgs({
      args: rest,
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    });
    return await handler(ctx, values as Values);
  } catch (e) {
    if (
      e instanceof UsageError ||
      (e instanceof Error && "code" in e && String(e.code).startsWith("ERR_PARSE_ARGS"))
    ) {
      ctx.stdout(`${command}: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

// 이후 Task에서 COMMANDS에 추가하는 핸들러가 쓰는 인자 헬퍼.
export { optNum, reqStr, str, num, sha40 };

// 테스트에서 import할 때는 실행하지 않는다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), { env: process.env, buildDeps, stdout: (s) => console.log(s) }).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
