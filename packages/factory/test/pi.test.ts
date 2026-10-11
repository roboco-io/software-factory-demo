import { describe, expect, it } from "vitest";
import { createPiAdapter, parsePiJsonl, piArgs } from "../src/agents/pi";
import type { AgentTask } from "../src/agents/types";
import type { SpawnFn } from "../src/exec/process";

const task = (readOnly: boolean): AgentTask => ({
  role: "triage",
  prompt: "# 역할: 트리아지",
  cwd: "/work",
  readOnly,
  budget: { maxTurns: 10, timeoutMs: 300_000, maxUsd: 0.2 },
});

const assistant = (text: string, input: number, output: number, cost: number) => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "..." },
    { type: "text", text },
  ],
  usage: {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { total: cost },
  },
  model: "deepseek-flash",
  provider: "deepseek",
});

const jsonl = [
  { type: "session", id: "s" },
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "tool_execution_start", toolName: "read" },
  { type: "turn_end" },
  { type: "turn_start" },
  { type: "turn_end" },
  {
    type: "agent_end",
    willRetry: false,
    messages: [
      { role: "user", content: "q" },
      assistant("중간", 100, 10, 0.001),
      assistant('{"type":"feature"}', 200, 30, 0.002),
    ],
  },
  { type: "agent_settled", aborted: false },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

describe("piArgs", () => {
  it("runs headless JSON mode without a session and with an explicit tool allowlist", () => {
    expect(piArgs(task(true), "deepseek/deepseek-flash")).toEqual([
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--model",
      "deepseek/deepseek-flash",
      "--tools",
      "read,ls,grep,find",
      "# 역할: 트리아지",
    ]);
    expect(piArgs(task(false), "m")).toContain("read,ls,grep,find,edit,write,bash");
  });
});

describe("parsePiJsonl", () => {
  it("takes the last assistant text, counts turn_end events and sums usage and cost", () => {
    const p = parsePiJsonl(`${jsonl}\nnot json\n`);
    expect(p).toMatchObject({
      ended: true,
      aborted: false,
      text: '{"type":"feature"}',
      turns: 2,
      inputTokens: 300,
      outputTokens: 40,
    });
    expect(p.costUsd).toBeCloseTo(0.003);
  });

  it("reports a missing agent_end and an aborted run", () => {
    expect(parsePiJsonl('{"type":"agent_start"}').ended).toBe(false);
    expect(parsePiJsonl('{"type":"agent_settled","aborted":true}').aborted).toBe(true);
  });
});

describe("createPiAdapter", () => {
  const spawnWith =
    (code: number, stdout: string, seen: string[][] = []): SpawnFn =>
    async (cmd, args) => {
      seen.push([cmd, ...args]);
      return { code, stdout, stderr: code ? "provider error" : "" };
    };

  it("maps a finished run", async () => {
    const seen: string[][] = [];
    const a = createPiAdapter({
      model: "deepseek/deepseek-flash",
      env: {},
      bin: "/bin/pi",
      spawn: spawnWith(0, jsonl, seen),
    });
    const r = await a.run(task(true));
    expect(r).toMatchObject({
      ok: true,
      summary: '{"type":"feature"}',
      turns: 2,
      model: "deepseek/deepseek-flash",
    });
    expect(r.costUsd).toBeCloseTo(0.003);
    expect(seen[0]?.[0]).toBe("/bin/pi");
  });

  it("fails with engine_error on a non-zero exit or a missing agent_end", async () => {
    const bad = createPiAdapter({ model: "m", env: {}, bin: "pi", spawn: spawnWith(1, jsonl) });
    expect(await bad.run(task(true))).toMatchObject({
      ok: false,
      failureReason: "engine_error",
      summary: "provider error",
    });
    const cut = createPiAdapter({
      model: "m",
      env: {},
      bin: "pi",
      spawn: spawnWith(0, '{"type":"turn_end"}'),
    });
    expect((await cut.run(task(true))).failureReason).toBe("engine_error");
  });

  it("maps an aborted spawn to timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const spawn: SpawnFn = () => Promise.reject(new Error("The operation was aborted"));
    const a = createPiAdapter({ model: "m", env: {}, bin: "pi", spawn });
    expect((await a.run({ ...task(true), signal: controller.signal })).failureReason).toBe(
      "timeout",
    );
  });
});
