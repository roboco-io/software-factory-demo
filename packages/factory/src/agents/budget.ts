import type { z } from "zod";
import {
  failedResult,
  type AgentAdapter,
  type AgentResult,
  type AgentTask,
  type Budget,
} from "./types";

export interface TimedResult extends AgentResult {
  durationMs: number;
}

export interface StructuredRun<T> {
  result: TimedResult;
  value: T | null;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function enforceLimits(r: AgentResult, b: Budget): AgentResult {
  if (!r.ok) return r;
  if (r.turns > b.maxTurns) return { ...r, ok: false, failureReason: "max_turns" };
  if (b.maxUsd !== undefined && r.costUsd !== undefined && r.costUsd > b.maxUsd) {
    return { ...r, ok: false, failureReason: "budget" };
  }
  return r;
}

export async function runWithBudget(
  adapter: AgentAdapter,
  task: AgentTask,
  clock: () => number = Date.now,
): Promise<TimedResult> {
  const started = clock();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<AgentResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("timeout"));
      resolve(failedResult("unknown", "timeout", `timed out after ${task.budget.timeoutMs}ms`));
    }, task.budget.timeoutMs);
  });
  let result: AgentResult;
  try {
    const run = Promise.resolve()
      .then(() => adapter.run({ ...task, signal: controller.signal }))
      .catch((e: unknown) => failedResult("unknown", "engine_error", errorMessage(e)));
    result = await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (controller.signal.aborted && result.ok)
    result = { ...result, ok: false, failureReason: "timeout" };
  return { ...enforceLimits(result, task.budget), durationMs: clock() - started };
}

export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    // 코드 펜스나 앞뒤 설명이 붙은 응답을 아래에서 다시 시도한다.
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  if (fence?.[1] !== undefined) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      // 펜스 안이 JSON이 아니면 중괄호 범위로 다시 시도한다.
    }
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
  throw new SyntaxError("no JSON object found");
}

function combine(a: TimedResult, b: TimedResult): TimedResult {
  const costUsd =
    a.costUsd === undefined && b.costUsd === undefined
      ? undefined
      : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  const merged: TimedResult = {
    ...b,
    turns: a.turns + b.turns,
    durationMs: a.durationMs + b.durationMs,
    usage: {
      inputTokens: a.usage.inputTokens + b.usage.inputTokens,
      outputTokens: a.usage.outputTokens + b.usage.outputTokens,
    },
  };
  if (costUsd !== undefined) merged.costUsd = costUsd;
  return merged;
}

function parseWith<T>(
  schema: z.ZodType<T>,
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: parsed.error.message };
}

export async function runStructured<T>(
  adapter: AgentAdapter,
  task: AgentTask,
  schema: z.ZodType<T>,
  clock?: () => number,
): Promise<StructuredRun<T>> {
  let total: TimedResult | null = null;
  let prompt = task.prompt;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await runWithBudget(adapter, { ...task, prompt }, clock);
    total = total ? combine(total, r) : r;
    if (!r.ok) return { result: total, value: null };
    const parsed = parseWith(schema, r.summary);
    if (parsed.ok) {
      const { failureReason: _ignored, ...rest } = total;
      void _ignored;
      // 재시도 포함 합산 결과가 역할 예산을 넘으면 실패로 본다.
      const limited = enforceLimits({ ...rest, ok: true }, task.budget);
      if (!limited.ok) return { result: { ...total, ...limited }, value: null };
      return { result: { ...rest, ok: true, structured: parsed.value }, value: parsed.value };
    }
    prompt = `${task.prompt}\n\n이전 응답이 요구한 JSON 스키마를 만족하지 않았다(${parsed.error}). 설명 없이 JSON 객체 하나만 다시 출력하라.`;
  }
  return { result: { ...total!, ok: false, failureReason: "invalid_output" }, value: null };
}
