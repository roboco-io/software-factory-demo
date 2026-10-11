import path from "node:path";
import { runProcess, type ProcessResult, type SpawnFn } from "../exec/process";
import { PACKAGE_ROOT } from "../paths";
import { errorMessage } from "./budget";
import { failedResult, type AgentAdapter, type AgentResult, type AgentTask } from "./types";

export const PI_READ_TOOLS = "read,ls,grep,find";
export const PI_WRITE_TOOLS = "read,ls,grep,find,edit,write,bash";

export const MAX_PROMPT_BYTES = 100_000;

// "--" 뒤의 값은 옵션이 아니라 위치 인자이므로, "-"나 "@"로 시작하는 프롬프트도 옵션·파일로 해석되지 않는다.
export function piArgs(task: AgentTask, model: string): string[] {
  return [
    "-p",
    "--mode",
    "json",
    "--no-session",
    "--no-extensions",
    "--model",
    model,
    "--tools",
    task.readOnly ? PI_READ_TOOLS : PI_WRITE_TOOLS,
    "--",
    task.prompt,
  ];
}

interface PiMessage {
  role?: string;
  stopReason?: string;
  content?: unknown;
  usage?: { input?: number; output?: number; cost?: { total?: number } };
}

interface PiEvent {
  type?: string;
  messages?: PiMessage[];
  willRetry?: boolean;
  aborted?: boolean;
}

export interface PiParsed {
  ended: boolean;
  aborted: boolean;
  willRetry: boolean;
  stopReason?: string;
  text: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

function textOf(m: PiMessage | undefined): string {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return (m.content as { type?: string; text?: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

export function parsePiJsonl(stdout: string): PiParsed {
  let ended = false;
  let aborted = false;
  let willRetry = false;
  let turns = 0;
  let messages: PiMessage[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ev: PiEvent;
    try {
      ev = JSON.parse(t) as PiEvent;
    } catch {
      continue;
    }
    if (ev.type === "turn_end") turns++;
    else if (ev.type === "agent_end") {
      ended = true;
      messages = ev.messages ?? [];
      willRetry = ev.willRetry === true;
    } else if (ev.type === "agent_settled" && ev.aborted === true) aborted = true;
  }
  const assistant = messages.filter((m) => m.role === "assistant");
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let hasCost = false;
  for (const m of assistant) {
    inputTokens += m.usage?.input ?? 0;
    outputTokens += m.usage?.output ?? 0;
    if (typeof m.usage?.cost?.total === "number") {
      cost += m.usage.cost.total;
      hasCost = true;
    }
  }
  const last = assistant.at(-1);
  const parsed: PiParsed = {
    ended,
    aborted,
    willRetry,
    text: textOf(last),
    turns,
    inputTokens,
    outputTokens,
  };
  if (last?.stopReason !== undefined) parsed.stopReason = last.stopReason;
  if (hasCost) parsed.costUsd = cost;
  return parsed;
}

export function defaultPiBin(): string {
  return path.join(PACKAGE_ROOT, "node_modules", ".bin", "pi");
}

export function createPiAdapter(opts: {
  model: string;
  env: Record<string, string>;
  spawn?: SpawnFn;
  bin?: string;
}): AgentAdapter {
  const spawnFn = opts.spawn ?? runProcess;
  return {
    name: "pi",
    async run(task) {
      if (Buffer.byteLength(task.prompt, "utf8") > MAX_PROMPT_BYTES) {
        return failedResult(opts.model, "engine_error", "prompt too large for argv");
      }
      let res: ProcessResult;
      try {
        const signal = task.signal;
        res = await spawnFn(opts.bin ?? defaultPiBin(), piArgs(task, opts.model), {
          cwd: task.cwd,
          env: opts.env,
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        return failedResult(
          opts.model,
          task.signal?.aborted ? "timeout" : "engine_error",
          errorMessage(e),
        );
      }
      const p = parsePiJsonl(res.stdout);
      const badStop = p.stopReason === "error" || p.stopReason === "aborted";
      const result: AgentResult = {
        ok: res.code === 0 && p.ended && !p.aborted && !p.willRetry && !badStop,
        summary: p.text,
        model: opts.model,
        turns: p.turns,
        usage: { inputTokens: p.inputTokens, outputTokens: p.outputTokens },
      };
      if (p.costUsd !== undefined) result.costUsd = p.costUsd;
      if (!result.ok) {
        result.failureReason = p.aborted || p.stopReason === "aborted" ? "timeout" : "engine_error";
        const fallback = res.truncated
          ? "pi: output truncated, no agent_end event"
          : "pi: no agent_end event";
        result.summary = (res.stderr.trim() || p.text || fallback).slice(-2000);
      }
      return result;
    },
  };
}
