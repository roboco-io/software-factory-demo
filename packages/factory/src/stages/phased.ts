import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { StageDeps } from "./deps";

export type Phase = "prepare" | "agent" | "publish" | "all";

export interface PhasedStage<A, P, O> {
  readonly name: string;
  prepare(deps: StageDeps, args: A): Promise<P | null>;
  agent(deps: StageDeps, plan: P): Promise<O>;
  // agent VM이 만든 결과 파일은 신뢰할 수 없다. 형식이 틀리면 throw한다.
  parseOutcome(raw: unknown): O;
  publish(deps: StageDeps, plan: P, outcome: O): Promise<void>;
  crashed(deps: StageDeps, plan: P): Promise<void>;
}

export interface PhaseFiles {
  plan: string | null;
  outcome: string | null;
}

function need(file: string | null, flag: string, stage: string, phase: Phase): string {
  if (!file) throw new Error(`${stage}: ${flag} is required for phase ${phase}`);
  return file;
}

function readPlan<P>(file: string): P | null {
  return (JSON.parse(readFileSync(file, "utf8")) as { plan: P | null }).plan;
}

export async function runPhase<A, P, O>(
  stage: PhasedStage<A, P, O>,
  phase: Phase,
  deps: StageDeps,
  args: A,
  files: PhaseFiles | null,
): Promise<void> {
  if (phase === "all") {
    const plan = await stage.prepare(deps, args);
    if (plan === null) return;
    const outcome = await stage.agent(deps, plan);
    await publishGuarded(stage, deps, plan, () => outcome);
    return;
  }
  const planFile = need(files?.plan ?? null, "--state", stage.name, phase);
  if (phase === "prepare") {
    writeFileSync(planFile, JSON.stringify({ plan: await stage.prepare(deps, args) }));
    return;
  }
  const outcomeFile = need(files?.outcome ?? null, "--outcome", stage.name, phase);
  const plan = readPlan<P>(planFile);
  if (plan === null) {
    deps.log(`${stage.name}: nothing to do`);
    return;
  }
  if (phase === "agent") {
    writeFileSync(outcomeFile, JSON.stringify({ outcome: await stage.agent(deps, plan) }));
    return;
  }
  if (!existsSync(outcomeFile)) {
    await stage.crashed(deps, plan);
    return;
  }
  await publishGuarded(stage, deps, plan, () => {
    const raw = (JSON.parse(readFileSync(outcomeFile, "utf8")) as { outcome?: unknown }).outcome;
    return stage.parseOutcome(raw);
  });
}

// 결과 파일 읽기·검증·publish 중 예외(손상된 파일, push 거부, API 오류)가 나면
// 이슈가 in-progress에 남지 않게 실패 런을 기록하고 needs-human으로 옮긴 뒤(spec 5.7)
// 검증 실패가 아닌 예외는 다시 던진다. 결과 파일이 신뢰할 수 없는 형식이면 crashed()만 부른다.
async function publishGuarded<A, P, O>(
  stage: PhasedStage<A, P, O>,
  deps: StageDeps,
  plan: P,
  load: () => O,
): Promise<void> {
  let outcome: O;
  try {
    outcome = load();
  } catch (err) {
    deps.log(`${stage.name}: invalid outcome: ${String(err)}`);
    await stage.crashed(deps, plan);
    return;
  }
  try {
    await stage.publish(deps, plan, outcome);
  } catch (err) {
    try {
      await stage.crashed(deps, plan);
    } catch (crashErr) {
      deps.log(`${stage.name}: crashed() failed: ${String(crashErr)}`);
    }
    throw err;
  }
}
